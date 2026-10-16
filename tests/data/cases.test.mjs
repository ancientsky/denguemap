// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildCasesOutputs, buildYearFile, normalizeRecords, yearTotals,
} from '../../scripts/data/sources/cases.mjs';
import { validateFileShape } from '../../scripts/data/validate.mjs';
import { LOCATION_RECORDS } from './fixtures/samples.mjs';

const today = '2026-10-16';
const norm = (raw, year = 2026, imp = 0) => normalizeRecords(raw, { year, imp, todayIso: today });

describe('normalizeRecords', () => {
  it('whitelists, rounds to 5 dp and computes day of year', () => {
    const { rows, drops } = norm(LOCATION_RECORDS);
    expect(drops).toMatchObject({ shape: 0, date: 0, year: 0, coord: 0, bbox: 0, count: 0 });
    expect(rows[0]).toEqual({ date: '2026-09-26', doy: 269, lng: 120.5464, lat: 24.07601, imp: 0, count: 1 });
    expect(rows[1].count).toBe(2);
    expect(rows[2].count).toBe(1); // "1" string
    expect(rows).toHaveLength(3);
  });

  it('drops and counts invalid records', () => {
    const bad = [
      null, 'x', 5,
      { sickdate: '2026/13/01', lat: '24', lng: '121', count: 1 },
      { sickdate: '2025/12/31', lat: '24', lng: '121', count: 1 }, // wrong year
      { sickdate: '2026/12/31', lat: '24', lng: '121', count: 1 }, // future
      { sickdate: '2026/05/01', lat: 'abc', lng: '121', count: 1 },
      { sickdate: '2026/05/01', lat: '', lng: '121', count: 1 },
      { sickdate: '2026/05/01', lat: '0', lng: '0', count: 1 }, // outside Taiwan
      { sickdate: '2026/05/01', lat: '27', lng: '121', count: 1 },
      { sickdate: '2026/05/01', lat: '24', lng: '121', count: 0 },
      { sickdate: '2026/05/01', lat: '24', lng: '121', count: 1.5 },
      { sickdate: '2026/05/01', lat: '24', lng: '121', count: 1 }, // the only good one
      { sickdate: '2026/05/01', lat: '21.9', lng: '118.2', count: 1 }, // bbox edge but valid (Kinmen/Matsu envelope)
    ];
    const { rows, drops, input } = norm(bad);
    expect(rows).toHaveLength(2);
    expect(input).toBe(bad.length);
    expect(drops).toEqual({ shape: 3, date: 1, year: 1, future: 1, coord: 2, bbox: 2, count: 2 });
  });

  it('treats null as empty and rejects non-arrays', () => {
    expect(norm(null).rows).toEqual([]);
    expect(() => norm({ d: 1 })).toThrow(/expected an array/);
  });
});

describe('buildYearFile', () => {
  const locate = (lng, lat) => (lng < 121 ? '64000090' : null);
  const rows = [
    { date: '2026-01-02', doy: 2, lng: 121.5, lat: 25, imp: 0, count: 1 },
    { date: '2026-01-02', doy: 2, lng: 121.5, lat: 25, imp: 0, count: 2 }, // merged
    { date: '2026-01-02', doy: 2, lng: 121.5, lat: 25, imp: 1, count: 1 }, // same point, other class
    { date: '2026-01-01', doy: 1, lng: 120.3, lat: 22.6, imp: 0, count: 1 },
  ];
  it('dedupes points, merges counts and sorts by day', () => {
    const { file, nullTown, uniquePts } = buildYearFile(rows, 2026, locate);
    expect(file.year).toBe(2026);
    expect(file.pts).toEqual([[120.3, 22.6, '64000090'], [121.5, 25, null]]);
    expect(file.c).toEqual([[1, 0, 0, 1], [2, 1, 0, 3], [2, 1, 1, 1]]);
    expect(nullTown).toBe(1);
    expect(uniquePts).toBe(2);
    expect(yearTotals(file)).toEqual({ local: 4, imported: 1 });
    validateFileShape('cases/2026.json', JSON.stringify(file));
  });
  it('is deterministic regardless of input order', () => {
    const a = buildYearFile(rows, 2026, locate).file;
    const b = buildYearFile([...rows].reverse(), 2026, locate).file;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('buildCasesOutputs: trend + summary', () => {
  const town = { '120.3,22.6': '64000090', '121.5,25': '63000030' };
  const locate = (lng, lat) => town[`${lng},${lat}`] ?? null;
  const R = (date, lng, lat, imp, count = 1) => {
    const [y, m, d] = date.split('-').map(Number);
    return { date, doy: Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1, lng, lat, imp, count };
  };
  const byYear = new Map();
  for (let y = 1998; y <= 2026; y++) byYear.set(y, []);
  byYear.get(1998).push(R('1998-01-01', 120.3, 22.6, 0, 5));
  byYear.get(2025).push(R('2025-10-15', 120.3, 22.6, 0, 4), R('2025-10-17', 120.3, 22.6, 0, 9), R('2025-03-01', 121.5, 25, 1, 2));
  byYear.get(2026).push(
    R('2026-01-05', 121.5, 25, 1, 3),
    R('2026-10-16', 120.3, 22.6, 0, 2), // today
    R('2026-10-10', 120.3, 22.6, 0, 1), // within 7 days
    R('2026-10-01', 120.3, 22.6, 1, 1), // within 30 but not 14
    R('2026-09-01', 120.3, 22.6, 0, 7),
    R('2026-10-12', 9.9 && 119.9, 23, 0, 1), // no town
  );
  const out = buildCasesOutputs(byYear, locate, today);
  const trend = JSON.parse(out.files['trend.json']);
  const summary = JSON.parse(out.files['summary.json']);

  it('emits one file per year plus trend and summary, all shape-valid', () => {
    expect(out.years).toHaveLength(29);
    for (const [p, t] of Object.entries(out.files)) validateFileShape(p, t);
    expect(Object.keys(out.files)).toContain('cases/2021.json'); // empty years still get a file
    expect(JSON.parse(out.files['cases/2021.json'])).toEqual({ year: 2021, pts: [], c: [] });
  });

  it('trend has dense national arrays and sparse county series', () => {
    expect(trend.start).toBe('1998-01-01');
    expect(trend.end).toBe(today);
    const n = trend.national.local.length;
    expect(n).toBe(Math.round((Date.UTC(2026, 9, 16) - Date.UTC(1998, 0, 1)) / 86400000) + 1);
    expect(trend.national.local[0]).toBe(5);
    expect(trend.national.local[n - 1]).toBe(2);
    expect(trend.national.imported.reduce((a, b) => a + b, 0)).toBe(6);
    expect(trend.county['64000'].local[0]).toEqual([0, 5]);
    expect(trend.county['63000'].imported).toEqual([[Math.round((Date.UTC(2025, 2, 1) - Date.UTC(1998, 0, 1)) / 86400000), 2], [Math.round((Date.UTC(2026, 0, 5) - Date.UTC(1998, 0, 1)) / 86400000), 3]]);
    expect(Object.keys(trend.county)).toEqual(['63000', '64000']);
  });

  it('summary windows', () => {
    expect(summary.asOf).toBe(today);
    expect(summary.latestOnset).toBe('2026-10-16');
    expect(summary.year).toBe(2026);
    expect(summary.ytd).toEqual({ local: 2 + 1 + 7 + 1, imported: 3 + 1 });
    expect(summary.last7).toEqual({ local: 2 + 1 + 1, imported: 0 }); // 10-10..10-16, incl. the no-town point
    expect(summary.last14).toEqual({ local: 2 + 1 + 1, imported: 0 });
    expect(summary.last30).toEqual({ local: 2 + 1 + 1, imported: 1 });
    // last year same period: 2025-01-01..2025-10-16 (the 10-17 point excluded)
    expect(summary.prevYtd).toEqual({ local: 4, imported: 2 });
    expect(summary.byCounty).toEqual({ '63000': { local: 0, imported: 3 }, '64000': { local: 10, imported: 1 } });
    expect(summary.topTowns14).toEqual([['64000090', 3, 0]]);
  });

  it('is byte-identical for identical input', () => {
    const again = buildCasesOutputs(byYear, locate, today);
    expect(again.files).toEqual(out.files);
  });
});
