import { describe, expect, it } from 'vitest';
import { aggregateSet, annualTotals, dailyCountsSet, expandSparse, isoWeekMatrix, lowerBoundSet, mergeCaseYears, niceBreaks, topEntries, trendSeries, weeklyBins } from '../../src/lib/aggregate';
import { addDays, dateFromDoy, dayOfYear, epochDayOfDoy, isISODate, isoWeek, parseISO } from '../../src/lib/dates';
import { greatCircle } from '../../src/lib/geo';
import type { CasesYear, Trend } from '../../src/lib/types';

const file: CasesYear = {
  year: 2026,
  pts: [[120.3, 22.6, '64000090'], [120.2, 23.0, '67000010'], [121.5, 25.0, null]],
  c: [[10, 0, 0, 2], [10, 1, 1, 1], [20, 0, 0, 1], [20, 2, 1, 4], [30, 1, 0, 3]],
};
const set = mergeCaseYears([file]);
const E = (doy: number) => epochDayOfDoy(2026, doy);

describe('aggregateSet (single year)', () => {
  it('filters by range and type', () => {
    const a = aggregateSet(set, { from: E(10), to: E(20), type: 'local', county: null });
    expect(a.total).toEqual({ local: 3, imported: 0 });
    expect(a.byPt.get(0)).toEqual([3, 0]);
    expect(a.byTown.get('64000090')).toEqual([3, 0]);
    const all = aggregateSet(set, { from: E(1), to: E(366), type: 'all', county: null });
    expect(all.total).toEqual({ local: 6, imported: 5 });
    expect(all.byTown.size).toBe(2); // null-town point counted in total, not in towns
  });
  it('filters by county (null towns excluded)', () => {
    const a = aggregateSet(set, { from: E(1), to: E(366), type: 'all', county: '67000' });
    expect(a.total).toEqual({ local: 3, imported: 1 });
    expect([...a.byPt.keys()]).toEqual([1]);
  });
  it('lowerBound / dailyCounts / topEntries', () => {
    expect(lowerBoundSet(set, E(20))).toBe(2);
    expect(lowerBoundSet(set, E(31))).toBe(5);
    const d = dailyCountsSet(set, E(1), 365, 'imported');
    expect(d[9]).toBe(1);
    expect(d[19]).toBe(4);
    expect(topEntries(new Map([['a', [1, 0]], ['b', [5, 1]], ['c', [2, 2]]]), 2).map((r) => r[0])).toEqual(['b', 'c']);
  });
});

describe('dates', () => {
  it('validates and converts', () => {
    expect(isISODate('2026-02-29')).toBe(false);
    expect(isISODate('2024-02-29')).toBe(true);
    expect(dayOfYear('2026-10-14')).toBe(287);
    expect(dateFromDoy(2024, 366)).toBe('2024-12-31');
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
  });
  it('computes ISO weeks across year boundaries', () => {
    expect(isoWeek(parseISO('2025-12-29'))).toEqual({ year: 2026, week: 1 });
    expect(isoWeek(parseISO('2021-01-03'))).toEqual({ year: 2020, week: 53 });
    expect(isoWeek(parseISO('2026-10-14'))).toEqual({ year: 2026, week: 42 });
  });
});

describe('trend helpers', () => {
  const start = '2020-12-28'; // a Monday
  const n = 14;
  const trend: Trend = {
    start, end: addDays(start, n - 1),
    national: { local: Array.from({ length: n }, (_, i) => i), imported: Array.from({ length: n }, () => 1) },
    county: { '64000': { local: [[0, 5], [13, 2]], imported: [] } },
  };
  it('expands sparse county series', () => {
    expect(Array.from(expandSparse([[1, 2], [3, 4], [99, 1]], 5))).toEqual([0, 2, 0, 4, 0]);
    expect(Array.from(trendSeries(trend, '64000').local).reduce((a, b) => a + b)).toBe(7);
    expect(Array.from(trendSeries(trend, '99999').local).every((v) => v === 0)).toBe(true);
  });
  it('bins weeks starting Monday', () => {
    const w = weeklyBins(start, trend.national);
    expect(w.dates).toEqual(['2020-12-28', '2021-01-04']);
    expect(w.local).toEqual([0 + 1 + 2 + 3 + 4 + 5 + 6, 7 + 8 + 9 + 10 + 11 + 12 + 13]);
    expect(w.imported).toEqual([7, 7]);
  });
  it('totals per calendar year', () => {
    const a = annualTotals(start, trend.national);
    expect(a.years).toEqual([2020, 2021]);
    expect(a.local[0]).toBe(0 + 1 + 2 + 3);
    expect(a.imported).toEqual([4, 10]);
  });
  it('builds an ISO-week matrix keyed by ISO year', () => {
    const m = isoWeekMatrix(start, trend.national, 'imported', [2020, 2021]);
    expect(m.get(2020)![52]).toBe(7); // 2020-W53
    expect(m.get(2021)![0]).toBe(7); // 2021-W01
    expect(m.get(2021)![1]).toBeNull();
  });
});

describe('niceBreaks / greatCircle', () => {
  it('produces increasing breaks', () => {
    expect(niceBreaks(0)).toEqual([1]);
    const b = niceBreaks(5000);
    expect(b[0]).toBe(1);
    for (let i = 1; i < b.length; i++) expect(b[i]!).toBeGreaterThan(b[i - 1]!);
    expect(Math.max(...b)).toBeLessThanOrEqual(5000);
  });
  it('great circle starts/ends at endpoints and stays continuous', () => {
    const line = greatCircle([-51.9, -14.2], [120.98, 23.97], 32);
    expect(line[0]).toEqual([-51.9, -14.2]);
    const last = line[line.length - 1]!;
    expect(((last[0] - 120.98) % 360 + 360) % 360).toBeCloseTo(0, 3);
    for (let i = 1; i < line.length; i++) expect(Math.abs(line[i]![0] - line[i - 1]![0])).toBeLessThan(180);
  });
});
