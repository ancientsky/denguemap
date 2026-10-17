// @vitest-environment node
// Per-year acceptance, frozen history, per-year imported merge, manifest stability and upstream diagnostics
// (mock backend).  Normal runs fetch only the active years (current + previous); `full` verifies everything.
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeUpstream, verdictOf } from '../../scripts/data/diagnostics.mjs';
import { createHttp } from '../../scripts/data/http.mjs';
import { run } from '../../scripts/data/run.mjs';
import { buildImportedSource, readCommittedImported } from '../../scripts/data/sources/imported.mjs';
import { sha8 } from '../../scripts/data/util.mjs';
import { IMPORTED_RECORDS } from './fixtures/samples.mjs';
import { startMockServer } from './helpers/mock-server.mjs';

const T0 = new Date('2026-10-16T04:00:00Z');
const T1 = new Date('2026-10-16T05:00:00Z');
const T2 = new Date('2026-10-16T06:00:00Z');
const T3 = new Date('2026-10-16T07:00:00Z');
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

let server, seeded;
const common = (outDir, over = {}) => ({
  retryDelaysMs: [0, 0], baseUrl: server.baseUrl, travelBaseUrl: `${server.baseUrl}travel/`, outDir, backoffMs: 0, log: () => {}, reference: null, summaryPath: null, ...over,
});
const readIn = async (dir, p) => JSON.parse(await readFile(join(dir, p), 'utf8'));
const textIn = (dir, p) => readFile(join(dir, p), 'utf8');
const snapshot = async (root, prefix = '') => {
  const out = {};
  for (const e of await readdir(root, { withFileTypes: true })) {
    const rel = prefix + e.name;
    if (e.isDirectory()) Object.assign(out, await snapshot(join(root, e.name), `${rel}/`));
    else out[rel] = await readFile(join(root, e.name), 'utf8');
  }
  return out;
};
const copyOf = async (src) => {
  const d = await mkdtemp(join(tmpdir(), 'dengue-hist-'));
  await cp(src, d, { recursive: true });
  return d;
};
/** the pipeline's own GetDengueLocation requests (the diagnostics probe uses `Connection: close`) */
const locCalls = () => server.state.calls.filter((c) => c.method === 'GetDengueLocation' && c.connection !== 'close');
const yearsRequested = () => [...new Set(locCalls().map((c) => Number(c.body.startDate.slice(0, 4))))].sort((a, b) => a - b);
const reset = () => { server.state.calls.length = 0; server.state.mutate = null; server.state.instanceFor = null; };

const ll = { lat: '22.6', lng: '120.3', country_lat: 14.06, country_lng: 108.28 };
const impRows = (year, n) => Array.from({ length: n }, (_, i) => ({ sickdate: `${year}/06/${String(1 + (i % 27)).padStart(2, '0')}`, country_code: 'vn', country_name: '越南', count: 1, ...ll }));
/** The "full" upstream answer for GetImportedData: 30 cases in each of 2023..2025 on top of the sample. */
const fullImported = [...IMPORTED_RECORDS, ...impRows(2023, 30), ...impRows(2024, 30), ...impRows(2025, 30)];
const caseRow = (date, count) => ({ sickdate: date, lat: '22.6', lng: '120.3', count });
/** mutate helper: full imported data on every call unless overridden */
const withImported = (rows, inner) => (method, body, data, ctx) => {
  if (method === 'GetImportedData') return rows;
  return inner ? inner(method, body, data, ctx) : data;
};
const isLoc = (method, body, year, imm) => method === 'GetDengueLocation' && String(body.startDate).startsWith(String(year)) && (imm === undefined || body.immigration === String(imm));

beforeAll(async () => {
  server = await startMockServer({ todayIso: '2026-10-14' });
  seeded = await mkdtemp(join(tmpdir(), 'dengue-hist-seed-'));
  server.state.mutate = withImported(fullImported);
  const r = await run({ ...common(seeded), now: T0 });
  expect(r.exitCode).toBe(0);
  reset();
}, 60_000);
afterAll(async () => {
  await server.close();
  await rm(seeded, { recursive: true, force: true });
});

describe('bootstrap and normal runs', () => {
  it('the first run on an empty directory fetches every year and records each year in the manifest', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'dengue-hist-boot-'));
    try {
      server.state.mutate = withImported(fullImported);
      const r = await run({ ...common(fresh), now: T0, only: ['cases', 'imported'] });
      expect(r.exitCode).toBe(0);
      expect(yearsRequested()).toEqual(Array.from({ length: 29 }, (_, i) => 1998 + i));
      expect(locCalls()).toHaveLength(58);
      const m = await readIn(fresh, 'manifest.json');
      expect(m.sources.cases).toMatchObject({ ok: true, stale: false, keptYears: [] });
      expect(Object.keys(m.sources.cases.yearsFetchedAt)).toHaveLength(29);
      expect(Object.values(m.sources.cases.yearsFetchedAt).every((t) => t === iso(T0))).toBe(true);
      expect(m.sources.imported).toMatchObject({ ok: true, stale: false, keptYears: [], yearsFetchedAt: { 2023: iso(T0), 2024: iso(T0), 2025: iso(T0), 2026: iso(T0) } });
    } finally { reset(); await rm(fresh, { recursive: true, force: true }); }
  });

  it('a normal run fetches only the current and the previous year and changes nothing when the data is the same', async () => {
    const dir = await copyOf(seeded);
    try {
      const before = await snapshot(dir);
      server.state.mutate = withImported(fullImported);
      const r = await run({ ...common(dir), now: T1 });
      expect(r.exitCode).toBe(0);
      expect(yearsRequested()).toEqual([2025, 2026]);
      expect(locCalls()).toHaveLength(4); // 2 years x (local, imported) - nothing else
      expect(server.state.calls.filter((c) => c.method === 'GetImportedData')).toHaveLength(1);
      expect(r.changed).toEqual([]);
      expect(await snapshot(dir)).toEqual(before); // trend/summary rebuilt from committed + fresh rows are byte-identical
      expect(r.results.cases.meta).toMatchObject({ fetchedYears: [2025, 2026], keptYears: [], requests: 4 });
    } finally { reset(); await rm(dir, { recursive: true, force: true }); }
  });

  it('a missing frozen file is fetched again (bootstrap) and restored byte for byte', async () => {
    const dir = await copyOf(seeded);
    try {
      const orig = await textIn(dir, 'cases/2012.json');
      await rm(join(dir, 'cases/2012.json'));
      server.state.mutate = withImported(fullImported);
      const r = await run({ ...common(dir), now: T1 });
      expect(yearsRequested()).toEqual([2012, 2025, 2026]);
      expect(await textIn(dir, 'cases/2012.json')).toBe(orig);
      expect(r.changed).toContain('cases/2012.json');
      expect((await readIn(dir, 'manifest.json')).sources.cases.yearsFetchedAt['2012']).toBe(iso(T1)); // the file was (re)written: new time
    } finally { reset(); await rm(dir, { recursive: true, force: true }); }
  });

  it('a corrupt frozen file counts as missing', async () => {
    const dir = await copyOf(seeded);
    try {
      await writeFile(join(dir, 'cases/2005.json'), '{"year":2005,"pts":"x"');
      server.state.mutate = withImported(fullImported);
      await run({ ...common(dir), now: T1 });
      expect(yearsRequested()).toEqual([2005, 2025, 2026]);
      expect(await textIn(dir, 'cases/2005.json')).toBe(await textIn(seeded, 'cases/2005.json'));
    } finally { reset(); await rm(dir, { recursive: true, force: true }); }
  });
});

describe('per-year acceptance', () => {
  it('truncated 2025 + imported 2023-2025, fresh 2026: 2026 is written, the rest is kept, ok stays true', async () => {
    const dir = await copyOf(seeded);
    try {
      const before = await snapshot(dir);
      const logs = [];
      const truncatedImported = [...IMPORTED_RECORDS, ...impRows(2026, 2)]; // 2023..2025 almost gone, 2026 +2
      server.state.mutate = withImported(truncatedImported, (method, body, data) => {
        if (isLoc(method, body, 2025, 0)) return data.slice(0, 1);
        if (isLoc(method, body, 2026, 0)) return [...data, caseRow('2026/10/10', 3)];
        return data;
      });
      const r = await run({ ...common(dir), now: T2, log: (m) => logs.push(m) });
      expect(r.exitCode).toBe(0);
      const after = await snapshot(dir);

      // 2026 written, 2025 untouched, frozen years untouched, trend/summary rebuilt with the new case
      expect(after['cases/2026.json']).not.toBe(before['cases/2026.json']);
      expect(after['cases/2025.json']).toBe(before['cases/2025.json']);
      expect(after['cases/2023.json']).toBe(before['cases/2023.json']);
      expect(JSON.parse(after['summary.json']).ytd.local).toBe(JSON.parse(before['summary.json']).ytd.local + 3);
      expect(JSON.parse(after['summary.json']).prevYtd).toEqual(JSON.parse(before['summary.json']).prevYtd);
      expect(JSON.parse(after['trend.json']).national.local.reduce((a, b) => a + b, 0)).toBe(JSON.parse(before['trend.json']).national.local.reduce((a, b) => a + b, 0) + 3);

      const m = JSON.parse(after['manifest.json']);
      expect(m.sources.cases).toMatchObject({ ok: true, stale: false, keptYears: [2025] });
      expect(m.sources.cases.fetchedAt).toBe(iso(T2));
      expect(m.sources.cases.yearsFetchedAt['2026']).toBe(iso(T2)); // data changed
      expect(m.sources.cases.yearsFetchedAt['2025']).toBe(iso(T0)); // kept: time stays
      expect(m.sources.imported).toMatchObject({ ok: true, stale: false, keptYears: [2023, 2024, 2025] });
      expect(m.sources.imported.yearsFetchedAt['2026']).toBe(iso(T2));
      expect(m.sources.imported.yearsFetchedAt['2025']).toBe(iso(T0));

      // imported: kept years keep their events, 2026 got the two new ones, countries rebuilt from the merge
      const a = JSON.parse(before['imported.json']), b = JSON.parse(after['imported.json']);
      const absEvents = (f) => f.events.map(([d, cc, n]) => [Date.parse(f.from) / 86400000 + d, cc, n]);
      const year = (d) => new Date(d * 86400000).getUTCFullYear();
      expect(absEvents(b).filter((e) => year(e[0]) <= 2025)).toEqual(absEvents(a).filter((e) => year(e[0]) <= 2025));
      expect(b.events.reduce((s, e) => s + e[2], 0)).toBe(a.events.reduce((s, e) => s + e[2], 0) + 2);
      expect(b.countries.vn.byYear).toEqual({ ...a.countries.vn.byYear, 2026: a.countries.vn.byYear[2026] + 2 });
      expect(b.countries.vn.zh).toBe(a.countries.vn.zh);
      expect(b.from).toBe(a.from);
      expect(logs.some((l) => /kept the committed data of year\(s\) 2025/.test(l))).toBe(true);
      expect(r.probe).not.toBeNull(); // a rejection triggers the diagnostics probe

      // an identical second run changes nothing, not even the manifest
      reset();
      server.state.mutate = withImported(truncatedImported, (method, body, data) => {
        if (isLoc(method, body, 2025, 0)) return data.slice(0, 1);
        if (isLoc(method, body, 2026, 0)) return [...data, caseRow('2026/10/10', 3)];
        return data;
      });
      const snap2 = await snapshot(dir);
      const r2 = await run({ ...common(dir), now: T3 });
      expect(r2.changed).toEqual([]);
      expect(await snapshot(dir)).toEqual(snap2);

      // upstream recovers (2026 keeps its new case): kept years return, and only they get a new fetch time
      reset();
      server.state.mutate = withImported(fullImported, (method, body, data) => (isLoc(method, body, 2026, 0) ? [...data, caseRow('2026/10/10', 3)] : data));
      const r3 = await run({ ...common(dir), now: new Date('2026-10-16T08:00:00Z') });
      const m3 = await readIn(dir, 'manifest.json');
      expect(m3.sources.cases).toMatchObject({ ok: true, stale: false, keptYears: [] });
      expect(m3.sources.cases.yearsFetchedAt['2025']).toBe('2026-10-16T08:00:00Z'); // kept → accepted
      expect(m3.sources.cases.yearsFetchedAt['2026']).toBe(iso(T2)); // unchanged data: not bumped
      expect(m3.sources.imported).toMatchObject({ keptYears: [] });
      expect(r3.results.imported.meta.currentYearOk).toBe(true);
      expect(r3.probe).toBeNull();
    } finally { reset(); await rm(dir, { recursive: true, force: true }); }
  }, 30_000);

  it('only the shrunk (year, type) is re-fetched; a type that is fine is accepted on its own', async () => {
    const dir = await copyOf(seeded);
    try {
      const oldFile = await readIn(dir, 'cases/2025.json');
      server.state.mutate = withImported(fullImported, (method, body, data) => (isLoc(method, body, 2025, 0) ? data.slice(0, 1) : isLoc(method, body, 2025, 1) ? [...data, caseRow('2025/03/03', 9)] : data));
      const r = await run({ ...common(dir), now: T2, only: ['cases'] });
      expect(r.results.cases.meta.keptYears).toEqual([2025]); // the local half was kept ...
      // ... the retries re-requested only 2025/local: 1 + 2 requests, the other pairs once
      expect(locCalls().filter((c) => c.body.startDate.startsWith('2025') && c.body.immigration === '0')).toHaveLength(3);
      expect(locCalls().filter((c) => c.body.startDate.startsWith('2025') && c.body.immigration === '1')).toHaveLength(1);
      expect(locCalls().filter((c) => c.body.startDate.startsWith('2026'))).toHaveLength(2);
      // ... and the imported half of 2025 was taken, the local rows of the committed file were kept
      const f = await readIn(dir, 'cases/2025.json');
      const sum = (file, imp) => file.c.filter((x) => x[2] === imp).reduce((s, x) => s + x[3], 0);
      expect(sum(f, 0)).toBe(sum(oldFile, 0));
      expect(sum(f, 1)).toBe(sum(oldFile, 1) + 9);
    } finally { reset(); await rm(dir, { recursive: true, force: true }); }
  });

  it('a current-year shrink keeps the current year: stale, trend/summary untouched, older years still update', async () => {
    const dir = await copyOf(seeded);
    try {
      const before = await snapshot(dir);
      server.state.mutate = withImported(fullImported, (method, body, data) => {
        if (isLoc(method, body, 2026, 0)) return data.slice(0, 1);
        if (isLoc(method, body, 2025, 0)) return [...data, caseRow('2025/04/04', 4)];
        return data;
      });
      const r = await run({ ...common(dir), now: T2 });
      const after = await snapshot(dir);
      expect(r.exitCode).toBe(0);
      expect(after['cases/2026.json']).toBe(before['cases/2026.json']);
      expect(after['cases/2025.json']).not.toBe(before['cases/2025.json']);
      expect(after['trend.json']).toBe(before['trend.json']);
      expect(after['summary.json']).toBe(before['summary.json']);
      const m = JSON.parse(after['manifest.json']);
      expect(m.sources.cases).toMatchObject({ ok: false, stale: true, keptYears: [2026], fetchedAt: iso(T0) });
      expect(m.sources.cases.yearsFetchedAt['2025']).toBe(iso(T2));
      expect(m.latestOnset).toBe(JSON.parse(before['manifest.json']).latestOnset);
    } finally { reset(); await rm(dir, { recursive: true, force: true }); }
  });

  it('a year without a committed file that comes back below the reference fails the source (nothing to keep)', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'dengue-hist-ref-'));
    try {
      const r = await run({ ...common(fresh), reference: undefined, now: T0, only: ['cases'] });
      expect(r.results.cases.ok).toBe(false);
      expect(r.results.cases.error).toMatch(/case counts shrank/);
      expect(await readdir(fresh)).toEqual([]);
    } finally { reset(); await rm(fresh, { recursive: true, force: true }); }
  });
});

describe('full verify run', () => {
  it('fetches every year; frozen years grow or stay, but never shrink', async () => {
    const dir = await copyOf(seeded);
    try {
      const before = await snapshot(dir);
      const logs = [];
      server.state.mutate = withImported(fullImported, (method, body, data) => {
        if (isLoc(method, body, 2015, 0)) return data.slice(0, 1); // truncated frozen year
        if (isLoc(method, body, 2010, 0)) return [...data, ...Array.from({ length: 12 }, () => caseRow('2010/03/03', 5))]; // frozen year that grew
        return data;
      });
      const r = await run({ ...common(dir), now: T2, full: true, log: (m) => logs.push(m) });
      expect(r.exitCode).toBe(0);
      expect(yearsRequested()).toEqual(Array.from({ length: 29 }, (_, i) => 1998 + i));
      expect(locCalls().filter((c) => c.body.startDate.startsWith('2015') && c.body.immigration === '0')).toHaveLength(3); // + 2 retries
      expect(locCalls()).toHaveLength(58 + 2);
      const after = await snapshot(dir);
      expect(after['cases/2015.json']).toBe(before['cases/2015.json']);
      expect(after['cases/2010.json']).not.toBe(before['cases/2010.json']);
      expect(r.results.cases.meta.keptYears).toEqual([2015]);
      expect(r.results.cases.meta.currentYearOk).toBe(true);
      expect(logs.some((l) => /FULL verify/.test(l))).toBe(true);
      const m = JSON.parse(after['manifest.json']);
      expect(m.sources.cases).toMatchObject({ ok: true, stale: false, keptYears: [2015] });
      expect(m.sources.cases.yearsFetchedAt['2010']).toBe(iso(T2));
      expect(m.sources.cases.yearsFetchedAt['2015']).toBe(iso(T0));
      // trend/summary are rebuilt from the merged rows (2015 from the committed file) and include the 2010 growth
      const trend = (t) => t.national.local.reduce((a, b) => a + b, 0);
      expect(trend(JSON.parse(after['trend.json']))).toBe(trend(JSON.parse(before['trend.json'])) + 60);
    } finally { reset(); await rm(dir, { recursive: true, force: true }); }
  });

  it('DATA_FULL=1 selects the full mode; a normal run does not', async () => {
    const dir = await copyOf(seeded);
    try {
      server.state.mutate = withImported(fullImported);
      process.env.DATA_FULL = '1';
      try {
        await run({ ...common(dir), now: T2, only: ['cases'] });
      } finally { delete process.env.DATA_FULL; }
      expect(yearsRequested()).toHaveLength(29);
    } finally { reset(); await rm(dir, { recursive: true, force: true }); }
  });

  it('the workflow wires the full input, the weekly cron and DATA_FULL', async () => {
    const y = await readFile(new URL('../../.github/workflows/data.yml', import.meta.url), 'utf8');
    expect(y).toMatch(/cron: "23 \*\/3 \* \* \*"/);
    expect(y).toMatch(/cron: "41 19 \* \* 6"/);
    expect(y).toMatch(/\n {6}full:\n[\s\S]*?type: boolean/);
    expect(y).toMatch(/DATA_FULL: \$\{\{[^}]*inputs\.full[^}]*github\.event\.schedule == '41 19 \* \* 6'[^}]*\}\}/);
    expect(y).toContain('npm ci --ignore-scripts');
    expect(y).toMatch(/actions\/checkout@[0-9a-f]{40}/);
  });
});

describe('imported: per-year merge', () => {
  const ctx = (rows) => ({
    todayIso: '2026-10-16',
    log: () => {},
    http: { asmx: async () => rows },
  });
  const baseCommitted = async () => {
    const out = await buildImportedSource(ctx(fullImported), {});
    return JSON.parse(out.files['imported.json']);
  };

  it('a first build (nothing committed) equals the plain build; events carry day indexes from `from`', async () => {
    const c = await baseCommitted();
    expect(c.events[0][0]).toBe(0);
    expect(c.events.reduce((a, e) => a + e[2], 0)).toBe(Object.values(c.countries).reduce((a, x) => a + Object.values(x.byYear).reduce((p, q) => p + q, 0), 0));
  });

  it('keeps a shrunk year from the committed events, accepts the others, rebuilds countries from the merge', async () => {
    const committed = await baseCommitted();
    const rows = [...IMPORTED_RECORDS, ...impRows(2023, 30), ...impRows(2024, 3) /* shrunk */, ...impRows(2025, 40) /* grown */];
    const out = await buildImportedSource(ctx(rows), { committed });
    const f = JSON.parse(out.files['imported.json']);
    expect(out.meta).toMatchObject({ keptYears: [2024], acceptedYears: [2023, 2025, 2026], currentYearOk: true });
    expect(f.countries.vn.byYear).toEqual({ ...committed.countries.vn.byYear, 2025: committed.countries.vn.byYear[2025] + 10 });
    expect(out.meta.changedYears).toEqual([2025]);
  });

  it('retries the call and accepts a year as soon as one attempt has it', async () => {
    const committed = await baseCommitted();
    const answers = [[...IMPORTED_RECORDS], [...IMPORTED_RECORDS, ...impRows(2023, 30), ...impRows(2024, 30)], fullImported];
    let n = 0;
    const c = { ...ctx([]), http: { asmx: async () => answers[Math.min(n++, 2)] } };
    const out = await buildImportedSource(c, { committed, retryDelays: [0, 0] });
    expect(n).toBe(3);
    expect(out.meta.keptYears).toEqual([]);
  });

  it('a committed file without events cannot keep a year: the source fails (as before v2)', async () => {
    const committed = await baseCommitted();
    delete committed.events;
    expect(readCommittedImported(committed)?.events).toBeNull();
    await expect(buildImportedSource(ctx(IMPORTED_RECORDS), { committed })).rejects.toThrow(/imported shrank/);
    // ... but without any shrink it simply produces the v2 file
    const ok = await buildImportedSource(ctx(fullImported), { committed });
    expect(ok.meta.keptYears).toEqual([]);
    expect(JSON.parse(ok.files['imported.json']).events.length).toBeGreaterThan(0);
  });

  it('allowShrink accepts everything', async () => {
    const committed = await baseCommitted();
    const out = await buildImportedSource(ctx(IMPORTED_RECORDS), { committed, allowShrink: true });
    expect(out.meta.keptYears).toEqual([]);
    expect(out.meta.records).toBe(5);
  });
});

describe('upstream diagnostics', () => {
  const instA = 'AAAA-instance-secret-value-1', instB = 'BBBB-instance-secret-value-2';

  it('records status, ms, bytes, Date, Server and a hash of the instance cookie, never the cookie', async () => {
    server.state.instanceFor = () => instA;
    const logs = [];
    try {
      const http = createHttp({ baseUrl: server.baseUrl, backoffMs: 0, log: (m) => logs.push(m) });
      await http.asmx('GetDengueLocation', { citycode: 'all', immigration: '0', startDate: '2025/01/01', endDate: '2025/12/31' });
      const [e] = http.diag;
      expect(e).toMatchObject({ tag: 'GetDengueLocation 2025/0', status: 200, inst: sha8(instA), instSS: sha8(instA), attempt: 1 });
      expect(e.records).toBeGreaterThan(0);
      expect(e.total).toBeGreaterThanOrEqual(e.records);
      expect(e.bytes).toBeGreaterThan(0);
      expect(e.date).toMatch(/GMT$/);
      expect(http.instances()).toEqual([sha8(instA)]);
      expect(http.cookieForInstance(sha8(instA))).toBe(`ARRAffinity=${instA}; ARRAffinitySameSite=${instA}`);
      const text = logs.join('\n') + JSON.stringify(http.diag);
      expect(text).toContain(sha8(instA));
      expect(text).not.toContain(instA);
      expect(text).not.toMatch(/ARRAffinity/);
    } finally { reset(); }
  });

  it('verdictOf: instance correlation / all truncated / full / mixed', () => {
    const r = (inst, truncated) => ({ inst, truncated });
    expect(verdictOf([r('a', true), r('b', false), r('a', true), r('b', false)])).toMatch(/truncation correlates with instance a/);
    expect(verdictOf([r('a', true), r('b', true)])).toMatch(/all instances truncated .*data-state issue upstream/);
    expect(verdictOf([r('a', false), r('b', false)])).toMatch(/probe returned full data/);
    expect(verdictOf([r('a', true), r('a', false)])).toMatch(/mixed results .*within one instance/);
    expect(verdictOf([r(null, true), r('b', false)])).toMatch(/mixed results/);
    expect(verdictOf([r('a', null)])).toBe('no usable probe result');
  });

  it('a rejection runs the probe: fresh connections without cookies, then one pinned call per instance', async () => {
    const dir = await copyOf(seeded);
    const sum = join(dir, '..', `summary-${Date.now()}.md`);
    const logs = [];
    let fresh = 0;
    try {
      // the pipeline's own (keep-alive) requests land on instance B; fresh probe connections alternate A, B, A, B
      server.state.instanceFor = (n, { connection }) => (connection === 'close' ? [instA, instB][fresh++ % 2] : instB);
      server.state.mutate = withImported(fullImported, (method, body, data, ctx) => (isLoc(method, body, 2025, 0) && ctx.instance === instB ? data.slice(0, 1) : data));
      const r = await run({ ...common(dir), now: T2, only: ['cases'], summaryPath: sum, log: (m) => logs.push(m) });
      expect(r.results.cases.meta.keptYears).toEqual([2025]);
      expect(r.probe).not.toBeNull();
      const probes = server.state.calls.filter((c) => c.connection === 'close');
      expect(probes.length).toBeGreaterThanOrEqual(4 + 2); // 4 fresh + one per instance
      expect(probes.every((c) => c.body.startDate.startsWith('2025') && c.body.immigration === '0')).toBe(true);
      expect(probes.slice(0, 4).every((c) => c.cookie === '')).toBe(true); // fresh: no cookie
      expect(probes.slice(4).every((c) => /^ARRAffinity=/.test(c.cookie))).toBe(true); // pinned: cookie sent back
      expect(r.probe.verdict).toBe(`truncation correlates with instance ${sha8(instB)} (${r.probe.rows.filter((x) => x.truncated).length}/${r.probe.rows.length} requests truncated)`);
      const text = await readFile(sum, 'utf8');
      expect(text).toContain('#### Upstream probe');
      expect(text).toContain('| attempt | instance | year | records | cases | truncated |');
      expect(text).toContain(`Verdict: **truncation correlates with instance ${sha8(instB)}`);
      expect(text).toMatch(/Upstream health:\n```json\n\{"at":"2026-10-16T06:00:00Z","mode":"normal"/);
      for (const blob of [text, logs.join('\n')]) {
        expect(blob).not.toContain(instA);
        expect(blob).not.toContain(instB);
        expect(blob).not.toMatch(/ARRAffinity/);
      }
    } finally { reset(); await rm(sum, { force: true }); await rm(dir, { recursive: true, force: true }); }
  });

  it('all instances truncated → data-state verdict', async () => {
    const dir = await copyOf(seeded);
    try {
      server.state.instanceFor = (n) => (n % 2 ? instA : instB);
      server.state.mutate = withImported(fullImported, (method, body, data) => (isLoc(method, body, 2025, 0) ? data.slice(0, 1) : data));
      const r = await run({ ...common(dir), now: T2, only: ['cases'] });
      expect(r.probe.verdict).toMatch(/^all instances truncated .*data-state issue upstream$/);
    } finally { reset(); await rm(dir, { recursive: true, force: true }); }
  });

  it('is polite: no probe on a clean run, and a bounded number of requests on a rejection', async () => {
    const dir = await copyOf(seeded);
    try {
      server.state.mutate = withImported(fullImported);
      const clean = await run({ ...common(dir), now: T2, only: ['cases', 'imported'] });
      expect(clean.probe).toBeNull();
      expect(server.state.calls.some((c) => c.connection === 'close')).toBe(false);
      reset();
      server.state.mutate = withImported(fullImported, (method, body, data) => (isLoc(method, body, 2025, 0) ? data.slice(0, 1) : data));
      await run({ ...common(dir), now: T3, only: ['cases'] });
      expect(server.state.calls.filter((c) => c.connection === 'close').length).toBeLessThanOrEqual(8);
    } finally { reset(); await rm(dir, { recursive: true, force: true }); }
  });

  it('probeUpstream waits between requests (configurable)', async () => {
    const http = createHttp({ baseUrl: server.baseUrl, backoffMs: 0 });
    const waits = [];
    await probeUpstream({
      baseUrl: server.baseUrl, http, year: 2025, expected: 0, todayIso: '2026-10-16', delayMs: 7, sleep: async (ms) => { waits.push(ms); }, log: () => {},
    });
    expect(waits).toEqual([7, 7, 7]); // between the 4 fresh requests; no instance was seen, so no pinned calls
    reset();
  });
});
