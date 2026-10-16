// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  allowedShrink, checkShrink, computeWarnings, validateCases, validateFileShape, validateImported, validateNs1, validateVector,
} from '../../scripts/data/validate.mjs';
import { buildManifest, hashFiles, manifestChanged, writeIfChanged } from '../../scripts/data/write.mjs';
import { IMPORTED_REFERENCE, REFERENCE_COUNTS } from '../../scripts/data/config.mjs';

describe('shrink guard', () => {
  const totals = { 2015: { local: 43181, imported: 332 }, 2026: { local: 14, imported: 185 } };
  it('accepts equal or grown counts', () => {
    expect(checkShrink(totals, { 2015: { local: 43181, imported: 332 }, 2026: { local: 10, imported: 180 } }, null)).toEqual([]);
  });
  it('rejects shrinks beyond the tolerance, tolerates tiny ones', () => {
    expect(allowedShrink(43181)).toBe(863);
    expect(allowedShrink(10)).toBe(5);
    expect(checkShrink({ 2015: { local: 43181 - 800, imported: 332 } }, { 2015: { local: 43181, imported: 332 } }, null)).toEqual([]);
    const p = checkShrink({ 2015: { local: 40000, imported: 332 } }, { 2015: { local: 43181, imported: 332 } }, null);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/2015 local/);
    expect(checkShrink({ 2015: { local: 43181, imported: 100 } }, { 2015: null }, REFERENCE_COUNTS)[0]).toMatch(/imported.*reference/);
  });
  it('previous file wins over the reference', () => {
    expect(checkShrink({ 2015: { local: 100, imported: 0 } }, { 2015: { local: 100, imported: 0 } }, REFERENCE_COUNTS)).toEqual([]);
  });
  it('reference counts cover every year 1998..2026', () => {
    expect(REFERENCE_COUNTS.local).toHaveLength(29);
    expect(REFERENCE_COUNTS.imported).toHaveLength(29);
    expect(REFERENCE_COUNTS.local[2015 - 1998]).toBe(43181);
  });
});

describe('source validators', () => {
  const years = Array.from({ length: 29 }, (_, i) => 1998 + i);
  const good = { totals: {}, years, meta: { records: 10, input: 10, dropped: 0, uniquePts: 100, nullTown: 3 } };
  it('validateCases', () => {
    const o = { prevTotals: {}, reference: null, currentYear: 2026 };
    expect(() => validateCases(good, o)).not.toThrow();
    expect(() => validateCases({ ...good, years: years.slice(1) }, o)).toThrow(/expected 29 years/);
    expect(() => validateCases({ ...good, meta: { ...good.meta, records: 0 } }, o)).toThrow(/no case records/);
    expect(() => validateCases({ ...good, meta: { ...good.meta, input: 10000, dropped: 500 } }, o)).toThrow(/invalid records/);
    expect(() => validateCases({ ...good, meta: { ...good.meta, nullTown: 60 } }, o)).toThrow(/without a town/);
    const shrunk = { ...good, totals: { 2015: { local: 1, imported: 0 } } };
    expect(() => validateCases(shrunk, { ...o, prevTotals: { 2015: { local: 100, imported: 0 } } })).toThrow(/shrank/);
    expect(() => validateCases(shrunk, { ...o, prevTotals: { 2015: { local: 100, imported: 0 } }, allowShrink: true })).not.toThrow();
  });
  it('validateImported / Ns1 / Vector', () => {
    expect(() => validateImported({ records: 0 }, null)).toThrow();
    expect(() => validateImported({ records: 800 }, 894)).toThrow(/shrank/);
    expect(() => validateImported({ records: 900 }, 894)).not.toThrow();
    expect(() => validateNs1({ records: 10 })).toThrow();
    expect(() => validateNs1({ records: 2316 })).not.toThrow();
    const stats = { input: 7760, sourceVillages: 7760, skippedWeeks: 0, outVillages: 318, matched: 310 };
    expect(() => validateVector({ stats })).not.toThrow();
    expect(() => validateVector({ stats: { ...stats, input: 10 } })).toThrow();
    expect(() => validateVector({ stats: { ...stats, matched: 100 } })).toThrow(/matched/);
    expect(() => validateVector({ stats: { ...stats, skippedWeeks: 500 } })).toThrow(/misaligned/);
  });
});

describe('validateFileShape', () => {
  it('rejects malformed output', () => {
    expect(() => validateFileShape('cases/2026.json', '{"year":2025,"pts":[],"c":[]}')).toThrow(/year mismatch/);
    expect(() => validateFileShape('cases/2026.json', '{"year":2026,"pts":[[0,0,null]],"c":[]}')).toThrow(/bad point/);
    expect(() => validateFileShape('cases/2026.json', '{"year":2026,"pts":[[121,25,null]],"c":[[1,5,0,1]]}')).toThrow(/out of range/);
    expect(() => validateFileShape('cases/2026.json', '{"year":2026,"pts":[[121,25,"abc"]],"c":[]}')).toThrow(/townCode/);
    expect(() => validateFileShape('clusters.json', '{"type":"FeatureCollection","features":[{"geometry":{"type":"Polygon"},"properties":{"county":"a","town":"b","code1":"c","count":1,"lastOnset":null,"extra":1}}]}')).toThrow(/unexpected properties/);
    expect(() => validateFileShape('notices.json', '{"vn":[{"date":"2026-01-01","headline":"h","text":"t","url":"http://evil/"}]}')).toThrow(/url/);
    expect(() => validateFileShape('unknown.json', '{}')).toThrow(/unknown file/);
    expect(() => validateFileShape('ns1.json', 'nope')).toThrow(/not valid JSON/);
  });
  it('accepts empty collections', () => {
    validateFileShape('clusters.json', '{"type":"FeatureCollection","fetchedAt":"x","features":[]}');
    validateFileShape('notices.json', '{}');
    validateFileShape('geo/vector-villages.topo.json', '{"type":"Topology","objects":{"villages":{"type":"GeometryCollection","geometries":[]}},"arcs":[]}');
  });
});

describe('manifest + writes', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const sources = (over = {}) => ({
    cases: { ok: true, records: 105232 }, imported: { ok: true, records: 894 }, notices: { ok: true, records: 40 },
    clusters: { ok: true, records: 0 }, vector: { ok: true, records: 318, extra: { periodStart: '2026-09-06', periodEnd: '2026-10-10' } },
    ns1: { ok: true, records: 2316, extra: { sourceDate: '2016-06-03' } }, ...over,
  });
  const base = buildManifest({ now, prev: null, sources: sources(), latestOnset: '2026-10-14', years: ['1998', '1999'], files: { 'a.json': '11111111' } });

  it('matches the contract shape', () => {
    expect(base.schema).toBe(1);
    expect(base.generatedAt).toBe('2026-10-16T12:00:00Z');
    expect(base.years).toEqual([1998, 1999]);
    expect(base.sources.vector).toEqual({ ok: true, stale: false, fetchedAt: '2026-10-16T12:00:00Z', records: 318, periodStart: '2026-09-06', periodEnd: '2026-10-10' });
    expect(Object.keys(base.sources)).toEqual(['cases', 'imported', 'notices', 'clusters', 'vector', 'ns1']);
  });
  it('failed sources keep their old fetchedAt/records and become stale', () => {
    const later = new Date('2026-10-16T15:00:00Z');
    const next = buildManifest({ now: later, prev: base, sources: sources({ vector: { ok: false }, ns1: { ok: false } }), latestOnset: '2026-10-14', years: ['1998'], files: { 'a.json': '11111111' } });
    expect(next.sources.vector).toEqual({ ...base.sources.vector, ok: false, stale: true });
    expect(next.sources.cases.fetchedAt).toBe('2026-10-16T15:00:00Z');
    const never = buildManifest({ now, prev: null, sources: sources({ ns1: { ok: false } }), latestOnset: '', years: [], files: {} });
    expect(never.sources.ns1).toEqual({ ok: false, stale: false, fetchedAt: null, records: 0 });
  });
  it('only asks for a rewrite when a hash or flag changed', () => {
    const later = buildManifest({ now: new Date('2026-10-16T15:00:00Z'), prev: base, sources: sources(), latestOnset: '2026-10-14', years: ['1998', '1999'], files: { 'a.json': '11111111' } });
    expect(manifestChanged(base, later)).toBe(false); // timestamps alone never trigger
    expect(manifestChanged(null, later)).toBe(true);
    expect(manifestChanged(base, { ...later, files: { 'a.json': '22222222' } })).toBe(true);
    expect(manifestChanged(base, { ...later, files: { 'a.json': '11111111', 'b.json': '3' } })).toBe(true);
    const stale = buildManifest({ now, prev: base, sources: sources({ vector: { ok: false } }), latestOnset: '', years: [], files: { 'a.json': '11111111' } });
    expect(manifestChanged(base, stale)).toBe(true);
  });
  it('writeIfChanged leaves identical files alone and hashes contract files only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-'));
    try {
      expect(await writeIfChanged(dir, 'cases/2026.json', '{"a":1}')).toBe(true);
      expect(await writeIfChanged(dir, 'cases/2026.json', '{"a":1}')).toBe(false);
      expect(await writeIfChanged(dir, 'cases/2026.json', '{"a":2}')).toBe(true);
      await writeFile(join(dir, 'README.txt'), 'x');
      const h = await hashFiles(dir);
      expect(Object.keys(h)).toEqual(['cases/2026.json']);
      expect(h['cases/2026.json']).toMatch(/^[0-9a-f]{8}$/);
      expect(await readFile(join(dir, 'cases/2026.json'), 'utf8')).toBe('{"a":2}');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('computeWarnings', () => {
  const full = {};
  for (let i = 0; i < 29; i++) full[1998 + i] = { local: REFERENCE_COUNTS.local[i], imported: REFERENCE_COUNTS.imported[i] };
  const impOk = { total: 894, byYear: { 2023: 271, 2024: 203, 2025: 229, 2026: 191 } };

  it('is empty when counts meet the reference', () => {
    expect(computeWarnings({ casesTotals: full, imported: impOk })).toEqual([]);
  });
  it('flags years below 80% of the fixed reference, for local and imported', () => {
    const cur = { ...full, 2023: { local: 951, imported: 53 }, 2024: { local: 2, imported: 198 }, 2022: { local: 20 * 0.8, imported: 68 } };
    const w = computeWarnings({ casesTotals: cur, imported: { total: 294, byYear: { 2023: 53, 2024: 2, 2025: 47, 2026: 185 } } });
    expect(w).toEqual([
      { code: 'cases-shortfall', year: 2023, type: 'imported', got: 53, expected: 271 },
      { code: 'cases-shortfall', year: 2023, type: 'local', got: 951, expected: 24794 },
      { code: 'cases-shortfall', year: 2024, type: 'local', got: 2, expected: 232 },
      { code: 'imported-shortfall', got: 294, expected: 894 },
      { code: 'imported-shortfall', year: 2023, got: 53, expected: 271 },
      { code: 'imported-shortfall', year: 2024, got: 2, expected: 203 },
      { code: 'imported-shortfall', year: 2025, got: 47, expected: 229 },
    ]);
  });
  it('exactly 80% is fine, zero references never warn, missing files are skipped', () => {
    expect(computeWarnings({ casesTotals: { 2015: { local: 43181 * 0.8, imported: 332 * 0.8 }, 2021: { local: 0, imported: 10 } }, imported: null })).toEqual([]);
    expect(computeWarnings({ casesTotals: {}, imported: null })).toEqual([]);
    expect(IMPORTED_REFERENCE.total).toBe(894);
  });
  it('is deterministic', () => {
    const a = computeWarnings({ casesTotals: { 2023: { local: 1, imported: 1 } }, imported: { total: 1, byYear: {} } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(computeWarnings({ casesTotals: { 2023: { local: 1, imported: 1 } }, imported: { total: 1, byYear: {} } })));
  });
  it('a change in warnings is a manifest change; timestamps alone are not', () => {
    const src = { cases: { ok: true, records: 1 }, imported: { ok: true, records: 1 }, notices: { ok: true, records: 1 }, clusters: { ok: true, records: 0 }, vector: { ok: true, records: 1 }, ns1: { ok: true, records: 1 } };
    const w1 = [{ code: 'imported-shortfall', got: 1, expected: 894 }];
    const mk = (now, warnings) => buildManifest({ now: new Date(now), prev: null, sources: src, latestOnset: '', years: [], files: {}, warnings });
    const a = mk('2026-10-16T12:00:00Z', w1);
    expect(a.warnings).toEqual(w1);
    expect(manifestChanged(a, mk('2026-10-16T15:00:00Z', w1))).toBe(false);
    expect(manifestChanged(a, mk('2026-10-16T15:00:00Z', []))).toBe(true);
    expect(manifestChanged(mk('2026-10-16T12:00:00Z', []), mk('2026-10-16T15:00:00Z', w1))).toBe(true);
    const legacy = { ...mk('2026-10-16T12:00:00Z', []) };
    delete legacy.warnings;
    expect(manifestChanged(legacy, mk('2026-10-16T15:00:00Z', []))).toBe(false);
  });
});
