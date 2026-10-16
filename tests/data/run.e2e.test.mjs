// @vitest-environment node
import { cp, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../scripts/data/run.mjs';
import { startMockServer } from './helpers/mock-server.mjs';

const NOW = new Date('2026-10-16T04:00:00Z'); // 12:00 Taiwan
const LATER = new Date('2026-10-16T07:00:00Z'); // same Taiwan day

let server, dir;
const common = () => ({ baseUrl: server.baseUrl, outDir: dir, backoffMs: 0, log: () => {}, reference: null, summaryPath: null });
const read = async (p) => JSON.parse(await readFile(join(dir, p), 'utf8'));
const snapshot = async (root = dir, prefix = '') => {
  const out = {};
  for (const e of await readdir(root, { withFileTypes: true })) {
    const rel = prefix + e.name;
    if (e.isDirectory()) Object.assign(out, await snapshot(join(root, e.name), `${rel}/`));
    else out[rel] = await readFile(join(root, e.name), 'utf8');
  }
  return out;
};

beforeAll(async () => { server = await startMockServer(); });
afterAll(async () => { await server.close(); });

describe('pipeline end to end (mock backend)', () => {
  it('first run writes exactly the contract files', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dengue-e2e-'));
    const r = await run({ ...common(), now: NOW });
    expect(r.exitCode).toBe(0);
    const files = Object.keys(await snapshot()).sort();
    const years = Array.from({ length: 29 }, (_, i) => `cases/${1998 + i}.json`);
    expect(files).toEqual([
      'clusters.json', ...years, 'geo/admin.topo.json', 'geo/vector-villages.topo.json', 'imported.json',
      'manifest.json', 'notices.json', 'ns1.json', 'summary.json', 'trend.json', 'vector.json',
    ].sort());

    const m = await read('manifest.json');
    expect(m.schema).toBe(1);
    expect(m.years).toHaveLength(29);
    for (const n of ['cases', 'imported', 'notices', 'clusters', 'vector', 'ns1']) {
      expect(m.sources[n]).toMatchObject({ ok: true, stale: false });
    }
    expect(m.sources.vector).toMatchObject({ periodStart: '2026-09-06', periodEnd: '2026-10-10' });
    expect(m.sources.ns1.sourceDate).toBe('2016-06-03');
    expect(m.sources.ns1.records).toBe(1100);
    expect(Object.keys(m.files)).toHaveLength(files.length - 1);
    expect(m.latestOnset).toBe((await read('summary.json')).latestOnset);
    // the mock data is far below the historical reference -> warnings, in deterministic order
    expect(m.warnings.length).toBeGreaterThan(10);
    expect(m.warnings).toContainEqual({ code: 'cases-shortfall', year: 2015, type: 'local', got: expect.any(Number), expected: 43181 });
    expect(m.warnings).toContainEqual({ code: 'imported-shortfall', got: 5, expected: 894 });
    expect(Object.keys(m)).toEqual(['schema', 'generatedAt', 'latestOnset', 'years', 'sources', 'warnings', 'files']);

    const c = await read('cases/2026.json');
    expect(c.pts.every((p) => p.length === 3 && p[2] !== undefined)).toBe(true);
    expect(c.pts.length).toBeGreaterThan(0);
    const clusters = await read('clusters.json');
    expect(clusters.features).toHaveLength(1);
    expect(clusters.features[0].properties).toEqual({ county: '桃園市', town: '桃園區', code1: 'A6801-57-009', count: 2, lastOnset: '2020-07-21' });
    const notices = await read('notices.json');
    expect(Object.keys(notices)).toEqual(['vn']);
    const vec = await read('vector.json');
    expect(vec.villages.length).toBe(1 + 48); // sample red + every 25th of 1200
    expect(vec.villages.every((v) => v[5] === null || /^\d{11}$/.test(v[5]))).toBe(true);
    expect(vec.villages.filter((v) => v[5]).length).toBeGreaterThan(40);
    const topo = await read('geo/vector-villages.topo.json');
    expect(topo.objects.villages.geometries.length).toBe(vec.villages.filter((v) => v[5]).length);
  });

  it('a second run with unchanged data is byte-identical and leaves the manifest alone', async () => {
    const before = await snapshot();
    const r = await run({ ...common(), now: LATER });
    expect(r.exitCode).toBe(0);
    expect(r.changed).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it('a failing source is marked stale and its files are untouched', async () => {
    const before = await snapshot();
    server.state.fail.add('cdcdengueVillagePoint');
    server.state.fail.add('GetDengueCluster_New');
    const r = await run({ ...common(), now: new Date('2026-10-16T09:00:00Z') });
    server.state.fail.clear();
    expect(r.exitCode).toBe(0);
    const after = await snapshot();
    expect(after['vector.json']).toBe(before['vector.json']);
    expect(after['geo/vector-villages.topo.json']).toBe(before['geo/vector-villages.topo.json']);
    expect(after['clusters.json']).toBe(before['clusters.json']);
    const m = JSON.parse(after['manifest.json']);
    const m0 = JSON.parse(before['manifest.json']);
    expect(m.sources.vector).toEqual({ ...m0.sources.vector, ok: false, stale: true });
    expect(m.sources.clusters).toMatchObject({ ok: false, stale: true, fetchedAt: m0.sources.clusters.fetchedAt });
    expect(m.sources.cases.stale).toBe(false);
    expect(m.files).toEqual(m0.files);
  });

  it('recovers on the next good run', async () => {
    const r = await run({ ...common(), now: new Date('2026-10-16T10:00:00Z') });
    expect(r.exitCode).toBe(0);
    const m = await read('manifest.json');
    expect(Object.values(m.sources).every((s) => s.ok && !s.stale)).toBe(true);
  });

  it('a shrinking case count makes only the cases source stale', async () => {
    const before = await snapshot();
    server.state.mutate = (method, body, data) => (method === 'GetDengueLocation' && body.startDate.startsWith('2015') && body.immigration === '0' ? data.slice(0, 1) : data);
    const r = await run({ ...common(), now: new Date('2026-10-16T11:00:00Z') });
    server.state.mutate = null;
    expect(r.results.cases.ok).toBe(false);
    expect(r.results.cases.error).toMatch(/shrank/);
    const after = await snapshot();
    for (const k of Object.keys(before)) if (k.startsWith('cases/') || k === 'trend.json' || k === 'summary.json') expect(after[k]).toBe(before[k]);
    expect(JSON.parse(after['manifest.json']).sources.cases).toMatchObject({ ok: false, stale: true });
  });

  it('passes the reference check on a fresh directory when counts are not lower', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'dengue-e2e-ref-'));
    try {
      // mock counts are far below the real reference counts -> cases must be rejected, others succeed
      const r = await run({ ...common(), outDir: fresh, reference: undefined, now: NOW });
      expect(r.results.cases.ok).toBe(false);
      expect(r.exitCode).toBe(0);
      const m = JSON.parse(await readFile(join(fresh, 'manifest.json'), 'utf8'));
      expect(m.sources.cases).toEqual({ ok: false, stale: false, fetchedAt: null, records: 0 });
      await expect(stat(join(fresh, 'trend.json'))).rejects.toThrow();
      expect(m.sources.ns1.ok).toBe(true);
    } finally { await rm(fresh, { recursive: true, force: true }); }
  });

  it('exits non-zero and writes nothing when every source fails', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'dengue-e2e-fail-'));
    const keep = await mkdtemp(join(tmpdir(), 'dengue-e2e-keep-'));
    try {
      await cp(dir, keep, { recursive: true });
      const before = await snapshot(keep);
      server.state.fail.add('/'); // everything 500s
      const r1 = await run({ ...common(), outDir: fresh, now: NOW });
      const r2 = await run({ ...common(), outDir: keep, now: NOW });
      server.state.fail.clear();
      expect(r1.exitCode).toBe(1);
      expect(r2.exitCode).toBe(1);
      expect(await readdir(fresh)).toEqual([]);
      expect(await snapshot(keep)).toEqual(before);
    } finally {
      await rm(fresh, { recursive: true, force: true });
      await rm(keep, { recursive: true, force: true });
    }
  });

  it('cleanup', async () => { await rm(dir, { recursive: true, force: true }); });
});
