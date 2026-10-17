// @vitest-environment node
import { cp, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../scripts/data/run.mjs';
import { startMockServer, travelAlerts } from './helpers/mock-server.mjs';

const NOW = new Date('2026-10-16T04:00:00Z'); // 12:00 Taiwan
const LATER = new Date('2026-10-16T07:00:00Z'); // same Taiwan day

let server, dir;
const common = () => ({ retryDelaysMs: [0, 0], baseUrl: server.baseUrl, travelBaseUrl: `${server.baseUrl}travel/`, outDir: dir, backoffMs: 0, log: () => {}, reference: null, summaryPath: null });
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
      'clusters.json', ...years, 'geo/admin.topo.json', 'geo/vector-villages.topo.json', 'geo/world.topo.json', 'imported.json',
      'manifest.json', 'notices.json', 'ns1.json', 'summary.json', 'travel.json', 'trend.json', 'vector.json',
    ].sort());

    const m = await read('manifest.json');
    expect(m.schema).toBe(1);
    expect(m.years).toHaveLength(29);
    for (const n of ['cases', 'imported', 'notices', 'clusters', 'vector', 'ns1', 'travel']) {
      expect(m.sources[n]).toMatchObject({ ok: true, stale: false });
    }
    expect(m.sources.vector).toMatchObject({ periodStart: '2026-09-06', periodEnd: '2026-10-10' });
    expect(m.sources.ns1.sourceDate).toBe('2016-06-03');
    expect(m.sources.ns1.records).toBe(1100);
    expect(m.sources.travel).toMatchObject({ ok: true, stale: false, records: 4, updated: '2026-10-16T21:17:38+08:00' });
    const imp = await read('imported.json');
    expect(imp.events.reduce((a, e) => a + e[2], 0)).toBe(m.sources.imported.records);
    expect(imp.events.length).toBeGreaterThan(0);
    const travel = await read('travel.json');
    expect(Object.keys(travel.countries).length).toBeGreaterThanOrEqual(150);
    expect(travel.countries.vn.vb.map((v) => v.d)).toEqual(['dengue', 'zika']);
    const world = await read('geo/world.topo.json');
    expect(world.objects.countries.geometries.map((g) => g.properties.iso2)).toEqual(expect.arrayContaining(['sg', 'mv', 'tw']));
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

  it('a broken travel source (too few countries) is stale and keeps travel.json', async () => {
    const before = await snapshot();
    const bad = travelAlerts(20);
    const bad2 = await startMockServer({ travelAlerts: bad });
    try {
      const r = await run({ ...common(), travelBaseUrl: `${bad2.baseUrl}travel/`, now: new Date('2026-10-16T08:00:00Z') });
      expect(r.results.travel.ok).toBe(false);
      expect(r.results.travel.error).toMatch(/only 20 countries/);
      expect(r.exitCode).toBe(0);
    } finally { await bad2.close(); }
    const after = await snapshot();
    expect(after['travel.json']).toBe(before['travel.json']);
    expect(JSON.parse(after['manifest.json']).sources.travel).toMatchObject({ ok: false, stale: true, updated: '2026-10-16T21:17:38+08:00' });
    // heal: the next run with a good upstream clears the flag
    const r2 = await run({ ...common(), now: new Date('2026-10-16T08:30:00Z') });
    expect(r2.results.travel.ok).toBe(true);
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
    expect(server.state.requests.filter((q) => q.includes('GetDengueLocation')).length).toBeGreaterThan(0);
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

describe('retry when the backend answers with truncated history', () => {
  let rdir;
  const extra = Array.from({ length: 20 }, () => ({ sickdate: '2026/05/01', country_code: 'vn', country_name: '越南', count: 1, country_lat: 14.06, country_lng: 108.28 }));
  const fullImported = (method, _body, data) => (method === 'GetImportedData' ? [...data, ...extra] : data);
  const callsOf = (method, pred = () => true) => server.state.requests.filter((q) => q.includes(method) && pred(q)).length;
  const opts = (over = {}) => ({ ...common(), outDir: rdir, retryDelaysMs: [0, 0], ...over });

  it('seeds a fresh directory from full data', { timeout: 30_000 }, async () => {
    rdir = await mkdtemp(join(tmpdir(), 'dengue-e2e-retry-'));
    server.state.mutate = fullImported;
    const r = await run(opts({ now: NOW }));
    server.state.mutate = null;
    expect(r.exitCode).toBe(0);
    expect(r.results.imported.ok).toBe(true);
    expect(r.results.imported.meta.records).toBe(25);
  });

  it('truncated twice, full on the third attempt: both sources succeed', { timeout: 30_000 }, async () => {
    const logs = [];
    let importedCalls = 0, locCalls = 0;
    server.state.mutate = (method, body, data) => {
      if (method === 'GetImportedData') return ++importedCalls <= 2 ? data : fullImported(method, body, data); // 5 rows < 25 - 5
      if (method === 'GetDengueLocation' && body.startDate.startsWith('2015') && body.immigration === '0') return ++locCalls <= 2 ? data.slice(0, 1) : data;
      return data;
    };
    const r = await run(opts({ now: new Date('2026-10-16T05:00:00Z'), log: (m) => logs.push(m) }));
    server.state.mutate = null;
    expect(r.exitCode).toBe(0);
    expect(r.results.imported.ok).toBe(true);
    expect(r.results.cases.ok).toBe(true);
    expect(importedCalls).toBe(3);
    expect(locCalls).toBe(3);
    expect(logs.filter((m) => /^\[(imported|cases)\] attempt \d\/3 below the committed counts/.test(m))).toHaveLength(4);
    expect(logs.some((m) => /^\[imported\] ok .*\(attempt 3\/3\)/.test(m))).toBe(true);
    const imp = JSON.parse(await readFile(join(rdir, 'imported.json'), 'utf8'));
    expect(imp.events.reduce((a, e) => a + e[2], 0)).toBe(25);
    const m = JSON.parse(await readFile(join(rdir, 'manifest.json'), 'utf8'));
    expect(m.sources.imported).toMatchObject({ ok: true, stale: false, records: 25 });
  });

  it('still truncated after 3 attempts: stale, previous files kept', async () => {
    const before = await snapshot(rdir);
    const imp0 = callsOf('GetImportedData');
    server.state.mutate = (method, body, data) => data;
    const logs = [];
    const r = await run(opts({ now: new Date('2026-10-16T06:00:00Z'), log: (m) => logs.push(m) }));
    server.state.mutate = null;
    expect(r.exitCode).toBe(0);
    expect(r.results.imported.ok).toBe(false);
    expect(r.results.imported.error).toMatch(/imported shrank: 5 < 25/);
    expect(callsOf('GetImportedData') - imp0).toBe(3);
    expect(logs.some((m) => /^\[imported\] FAILED after 3\/3 attempt/.test(m))).toBe(true);
    const after = await snapshot(rdir);
    expect(after['imported.json']).toBe(before['imported.json']);
    expect(JSON.parse(after['manifest.json']).sources.imported).toMatchObject({ ok: false, stale: true, records: 25 });
  });

  it('does not retry other failures (e.g. HTTP errors)', async () => {
    const n0 = callsOf('GetImportedData');
    server.state.fail.add('GetImportedData');
    const r = await run(opts({ now: new Date('2026-10-16T07:00:00Z'), backoffMs: 0 }));
    server.state.fail.clear();
    expect(r.results.imported.ok).toBe(false);
    // http-level retries (4 attempts) only; no extra shrink-retry rounds
    expect(callsOf('GetImportedData') - n0).toBe(4);
  });

  it('waits the configured delays between attempts', async () => {
    server.state.mutate = null; // imported has 5 rows < 25 - 5
    const t0 = Date.now();
    await run(opts({ now: new Date('2026-10-16T08:00:00Z'), retryDelaysMs: [60, 60], only: ['imported'] }));
    server.state.mutate = null;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
  });

  it('cleanup', async () => { await rm(rdir, { recursive: true, force: true }); });
});
