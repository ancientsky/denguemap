import { describe, expect, it } from 'vitest';
import { validateCases, validateClusters, validateManifest, validateNotices, validateVector, ValidationError } from '../../src/lib/validate';
import { casesShortfalls, importedShortfall, shortfallYears, sourceState } from '../../src/lib/warnings';

const manifest = {
  schema: 1, generatedAt: '2026-10-16T12:00:00Z', latestOnset: '2026-10-14', years: [2026, 2015, 'x', 1500],
  sources: { cases: { ok: true, stale: false, fetchedAt: '2026-10-16T12:00:00Z', records: 5 }, clusters: { ok: false, stale: true, fetchedAt: '2026-10-15T00:00:00Z' }, ns1: { ok: false, stale: false, fetchedAt: null, records: 0 } },
  warnings: [
    { code: 'cases-shortfall', year: 2023, type: 'local', got: 951, expected: 24794 },
    { code: 'imported-shortfall', got: 294, expected: 894 },
    { code: 'imported-shortfall', year: 2024, got: 2, expected: 203 },
    { code: 'bad code!', got: 1, expected: 2 },
  ],
  files: { 'summary.json': 'a1b2c3d4', 'cases/2026.json': 'zz' },
};

describe('validateManifest', () => {
  it('normalises years, sources, warnings and files', () => {
    const m = validateManifest(manifest);
    expect(m.years).toEqual([2015, 2026]);
    expect(m.files).toEqual({ 'summary.json': 'a1b2c3d4' });
    expect(m.warnings).toHaveLength(3);
    expect(m.warnings[1]).toEqual({ code: 'imported-shortfall', year: null, type: null, got: 294, expected: 894 });
    expect(sourceState(m.sources.cases)).toBe('fresh');
    expect(sourceState(m.sources.clusters)).toBe('stale');
    expect(sourceState(m.sources.ns1)).toBe('unavailable');
    expect(sourceState(undefined)).toBe('unavailable');
  });
  it('accepts a manifest without warnings', () => {
    const { warnings: _w, ...rest } = manifest;
    expect(validateManifest(rest).warnings).toEqual([]);
  });
  it('rejects broken manifests', () => {
    expect(() => validateManifest(null)).toThrow(ValidationError);
    expect(() => validateManifest({ ...manifest, schema: 2 })).toThrow(ValidationError);
    expect(() => validateManifest({ ...manifest, years: [] })).toThrow(ValidationError);
  });
  it('warning helpers', () => {
    const w = validateManifest(manifest).warnings;
    expect(casesShortfalls(w, 2023)).toHaveLength(1);
    expect(casesShortfalls(w, 2023, 'imported')).toHaveLength(0);
    expect(shortfallYears(w)).toEqual(new Set([2023]));
    expect(importedShortfall(w, null)?.got).toBe(294);
    expect(importedShortfall(w, 2024)?.expected).toBe(203);
    expect(importedShortfall(w, 2026)).toBeNull();
  });
});

describe('validateCases', () => {
  it('drops malformed rows and points outside Taiwan, keeps indices stable', () => {
    const v = validateCases({
      year: 2026,
      pts: [[120.5, 23.1, '64000090'], [0, 0, null], [121, 24, 'bogus']],
      c: [[5, 0, 0, 1], [6, 1, 0, 1], [7, 2, 1, 2], [0, 0, 0, 1], [8, 9, 0, 1], [9, 0, 2, 1], [10, 0, 0, -1], 'x'],
    }, 2026);
    expect(v.c).toEqual([[5, 0, 0, 1], [7, 2, 1, 2]]);
    expect(v.pts[2]![2]).toBeNull();
    expect(() => validateCases({ year: 2025, pts: [], c: [] }, 2026)).toThrow(ValidationError);
  });
  it('sorts unsorted rows', () => {
    const v = validateCases({ year: 2026, pts: [[120.5, 23.1, null]], c: [[9, 0, 0, 1], [3, 0, 0, 1]] });
    expect(v.c.map((r) => r[0])).toEqual([3, 9]);
  });
});

describe('other validators', () => {
  it('notices: only https://www.cdc.gov.tw/ URLs survive', () => {
    const n = validateNotices({ vn: [
      { date: '2026-09-29', headline: '越南-登革熱', text: 'x', url: 'https://www.cdc.gov.tw/Bulletin/Detail/abc' },
      { date: '2026-09-01', headline: 'h', text: 'y', url: 'javascript:alert(1)' },
      { date: '2026-08-01', headline: 'h2', text: 'z', url: 'https://www.cdc.gov.tw.evil.com/' },
    ], XX: [{ headline: 'bad key' }] });
    expect(Object.keys(n)).toEqual(['vn']);
    expect(n.vn!.map((x) => x.url)).toEqual(['https://www.cdc.gov.tw/Bulletin/Detail/abc', null, null]);
  });
  it('clusters: keeps only whitelisted properties and valid polygons', () => {
    const c = validateClusters({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[120, 23], [120.01, 23], [120.01, 23.01], [120, 23]]] }, properties: { county: '臺南市', town: '東區', code1: 'A', count: 3, lastOnset: '2026-08-01', secret: 'x' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [120, 23] }, properties: {} },
    ] });
    expect(c.features).toHaveLength(1);
    expect(Object.keys(c.features[0]!.properties).sort()).toEqual(['code1', 'count', 'county', 'lastOnset', 'town', 'village']);
    expect(c.features[0]!.properties.village).toBe(''); // older files have no village
  });
  it('vector: aligns week data and clamps risk codes', () => {
    const v = validateVector({ updated: '2026-10-12', weeks: [['2026-10-04', '2026-10-10'], ['2026-09-27', '2026-10-03']],
      villages: [['屏東縣', '屏東市', '大同里', 120.48, 22.67, '10013010025', 9, [[3, null, 60, null]]], ['x']], surveyed: { '10013': { villages: 1, total: 400 } } });
    expect(v.villages).toHaveLength(1);
    expect(v.villages[0]![6]).toBe(0);
    expect(v.villages[0]![7]).toEqual([[3, null, 60, null], [0, null, null, null]]);
  });
});
