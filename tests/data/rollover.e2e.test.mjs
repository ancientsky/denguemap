// @vitest-environment node
// Year rollover (2026 → 2027) with the mock backend and an injected clock: the pipeline must derive the
// new year from the Taiwan date and write cases/2027.json (even when empty), the manifest must list it,
// summary/trend must roll over, and the frontend's validators + period defaults must accept the result.
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REFERENCE_COUNTS } from '../../scripts/data/config.mjs';
import { clockFromEnv, run } from '../../scripts/data/run.mjs';
import { checkShrink, computeWarnings, validateCases as pipelineValidateCases } from '../../scripts/data/validate.mjs';
import { mergeCaseYears } from '../../src/lib/aggregate';
import { normalizeMapParams } from '../../src/lib/params';
import { yearsTouched } from '../../src/lib/period';
import { validateCases, validateManifest, validateSummary, validateTrend } from '../../src/lib/validate';
import { startMockServer } from './helpers/mock-server.mjs';

const DEC31 = new Date('2026-12-31T04:00:00Z'); // 12:00 Taiwan
const JAN3 = new Date('2027-01-03T04:00:00Z');
const JAN1_EARLY = new Date('2026-12-31T16:30:00Z'); // 00:30 on 2027-01-01 in Taiwan (still Dec 31 in UTC)

let server, seeded;
const common = (outDir) => ({ retryDelaysMs: [0, 0], baseUrl: server.baseUrl, travelBaseUrl: `${server.baseUrl}travel/`, outDir, backoffMs: 0, log: () => {}, reference: null, summaryPath: null });
const readIn = async (dir, p) => JSON.parse(await readFile(join(dir, p), 'utf8'));
const copyOf = async (src) => {
  const d = await mkdtemp(join(tmpdir(), 'dengue-rollover-'));
  await cp(src, d, { recursive: true });
  return d;
};
/** Sum of a cases file's rows (by type) for days of year within [a, b]. */
const sumDoy = (file, a, b) => file.c.filter((r) => r[0] >= a && r[0] <= b).reduce((s, r) => (r[2] ? { ...s, imported: s.imported + r[3] } : { ...s, local: s.local + r[3] }), { local: 0, imported: 0 });

beforeAll(async () => {
  server = await startMockServer({ todayIso: '2026-12-31' });
  // the committed state on the last day of 2026
  seeded = await mkdtemp(join(tmpdir(), 'dengue-rollover-seed-'));
  const r = await run({ ...common(seeded), now: DEC31 });
  expect(r.exitCode).toBe(0);
});
afterAll(async () => {
  await server.close();
  await rm(seeded, { recursive: true, force: true });
});

describe('year rollover: 2027-01-03 (Taiwan)', () => {
  it('DATA_TODAY injects the clock (noon Taiwan time) and rejects junk', () => {
    expect(clockFromEnv('2027-01-03')?.toISOString()).toBe('2027-01-03T04:00:00.000Z');
    expect(clockFromEnv(undefined)).toBeNull();
    expect(() => clockFromEnv('2027/1/3')).toThrow(/DATA_TODAY/);
    expect(() => clockFromEnv('2027-02-30')).toThrow(/DATA_TODAY/);
  });

  it('writes cases/2027.json, lists 2027 in the manifest and rolls summary/trend over', async () => {
    const dir = await copyOf(seeded);
    try {
      const before = { trend: await readIn(dir, 'trend.json'), manifest: await readIn(dir, 'manifest.json') };
      expect(before.manifest.years.at(-1)).toBe(2026);
      server.state.todayIso = '2027-01-03';
      server.state.calls.length = 0;
      const before2025 = await readFile(join(dir, 'cases/2025.json'), 'utf8');
      const r = await run({ ...common(dir), now: JAN3 });
      expect(r.exitCode).toBe(0);
      expect(r.results.cases.ok).toBe(true);
      // year rollover freezes 2025: only 2026 and 2027 are active (13+ months of data in January), 2025 is reused as it is
      const asked = server.state.calls.filter((c) => c.method === 'GetDengueLocation').map((c) => Number(c.body.startDate.slice(0, 4)));
      expect([...new Set(asked)].sort()).toEqual([2026, 2027]);
      expect(asked).toHaveLength(4);
      expect(await readFile(join(dir, 'cases/2025.json'), 'utf8')).toBe(before2025);
      expect(r.results.cases.meta).toMatchObject({ fetchedYears: [2026, 2027], keptYears: [] });
      expect(r.results.cases.meta.years).toEqual(Array.from({ length: 30 }, (_, i) => 1998 + i));

      const m = await readIn(dir, 'manifest.json');
      expect(m.years).toHaveLength(30);
      expect(m.years.at(-1)).toBe(2027);
      expect(m.files['cases/2027.json']).toMatch(/^[0-9a-f]+$/);
      expect(m.sources.cases).toMatchObject({ ok: true, stale: false });
      expect(m.warnings.some((w) => w.year === 2027)).toBe(false); // no reference for the new year → no warning

      const f2026 = await readIn(dir, 'cases/2026.json');
      const f2027 = await readIn(dir, 'cases/2027.json');
      expect(f2027.year).toBe(2027);
      expect(f2027.c.every((row) => row[0] >= 1 && row[0] <= 3)).toBe(true); // only Jan 1–3
      const s = await readIn(dir, 'summary.json');
      expect(s).toMatchObject({ asOf: '2027-01-03', year: 2027, latestOnset: m.latestOnset });
      expect(s.ytd).toEqual(sumDoy(f2027, 1, 3));
      expect(s.prevYtd).toEqual(sumDoy(f2026, 1, 3)); // 2026-01-01..2026-01-03
      // last 14 days cross the year boundary: Dec 21 2026 .. Jan 3 2027
      const last14 = [sumDoy(f2026, 355, 365), sumDoy(f2027, 1, 3)].reduce((a, b) => ({ local: a.local + b.local, imported: a.imported + b.imported }));
      expect(s.last14).toEqual(last14);

      const tr = await readIn(dir, 'trend.json');
      expect(tr.end).toBe('2027-01-03');
      expect(tr.national.local.length).toBe(before.trend.national.local.length + 3);
      expect(tr.national.local.slice(0, before.trend.national.local.length)).toEqual(before.trend.national.local);

      // the frontend accepts every file and picks the January default (Jan 1 of the previous year → today)
      const fm = validateManifest(m);
      expect(validateSummary(s).year).toBe(2027);
      expect(validateTrend(tr).end).toBe('2027-01-03');
      const files = [validateCases(f2026, 2026), validateCases(f2027, 2027)];
      const p = normalizeMapParams({}, { years: fm.years, latestOnset: fm.latestOnset, today: '2027-01-03', counties: new Set() });
      expect(p.period).toMatchObject({ preset: 'py', start: '2026-01-01', end: '2027-01-03' });
      expect(yearsTouched(p.period.start, p.period.end, fm.years)).toEqual([2026, 2027]);
      expect(mergeCaseYears(files).length).toBe(f2026.c.length + f2027.c.length);
    } finally {
      server.state.todayIso = '2026-12-31';
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a new year without any case yet (00:30 on Jan 1) still gets an empty cases/2027.json', async () => {
    const dir = await copyOf(seeded);
    server.state.todayIso = '2027-01-01';
    server.state.mutate = (method, body, data) => (method === 'GetDengueLocation' && String(body.startDate).startsWith('2027') ? [] : data);
    try {
      const r = await run({ ...common(dir), now: JAN1_EARLY });
      expect(r.exitCode).toBe(0);
      expect(r.results.cases.ok).toBe(true);
      const f = await readIn(dir, 'cases/2027.json');
      expect(f).toEqual({ year: 2027, pts: [], c: [] });
      const m = await readIn(dir, 'manifest.json');
      expect(m.years.at(-1)).toBe(2027);
      expect(m.latestOnset.startsWith('2026-')).toBe(true);
      const s = await readIn(dir, 'summary.json');
      expect(s).toMatchObject({ asOf: '2027-01-01', year: 2027, ytd: { local: 0, imported: 0 } });
      expect(s.byCounty).toEqual({});
      // frontend: valid empty file; "this year" is a one-day period with no cases
      expect(validateCases(f, 2027)).toEqual({ year: 2027, pts: [], c: [] });
      const fm = validateManifest(m);
      const ctx = { years: fm.years, latestOnset: fm.latestOnset, today: '2027-01-01', counties: new Set() };
      expect(normalizeMapParams({ p: 'ytd' }, ctx).period).toMatchObject({ start: '2027-01-01', end: '2027-01-01' });
      expect(normalizeMapParams({}, ctx).period).toMatchObject({ preset: 'py', start: '2026-01-01', end: '2027-01-01' });
    } finally {
      server.state.mutate = null;
      server.state.todayIso = '2026-12-31';
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('if the cases source fails on Jan 1 the manifest keeps 2026 as the newest year (frontend shows all of 2026)', async () => {
    const dir = await copyOf(seeded);
    server.state.todayIso = '2027-01-01';
    server.state.fail.add('GetDengueLocation');
    try {
      const r = await run({ ...common(dir), now: JAN1_EARLY });
      expect(r.exitCode).toBe(0);
      expect(r.results.cases.ok).toBe(false);
      const m = await readIn(dir, 'manifest.json');
      expect(m.years.at(-1)).toBe(2026);
      expect(m.sources.cases).toMatchObject({ ok: false, stale: true });
      const fm = validateManifest(m);
      const p = normalizeMapParams({}, { years: fm.years, latestOnset: fm.latestOnset, today: '2027-01-01', counties: new Set() });
      expect(p.period).toMatchObject({ preset: 'ytd', start: '2026-01-01', end: '2026-12-31' });
    } finally {
      server.state.fail.clear();
      server.state.todayIso = '2026-12-31';
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('shrink guard and warnings have no reference for the new year and do not trip on it', () => {
    expect(REFERENCE_COUNTS.local.length).toBe(29); // 1998..2026
    expect(checkShrink({ 2027: { local: 0, imported: 0 } }, { 2027: null }, REFERENCE_COUNTS)).toEqual([]);
    expect(checkShrink({ 2028: { local: 0, imported: 0 } }, { 2028: { local: 0, imported: 0 } }, REFERENCE_COUNTS)).toEqual([]);
    expect(computeWarnings({ casesTotals: { 2027: { local: 0, imported: 0 } }, imported: null })).toEqual([]);
    const years = Array.from({ length: 30 }, (_, i) => 1998 + i);
    const meta = { records: 10, input: 10, dropped: 0, uniquePts: 3, nullTown: 0 };
    const totals = { 2027: { local: 0, imported: 0 } };
    expect(() => pipelineValidateCases({ totals, meta, years }, { prevTotals: { 2027: null }, currentYear: 2027 })).not.toThrow();
    expect(() => pipelineValidateCases({ totals, meta, years: years.slice(0, 29) }, { prevTotals: {}, currentYear: 2027 })).toThrow(/expected 30 years/);
  });
});
