import { describe, expect, it } from 'vitest';
import { aggregateSet, dailyCountsSet, mergeCaseYears, SetAggregator } from '../../src/lib/aggregate';
import { epochDay, recencyRef } from '../../src/lib/dates';
import { normalizeMapParams, serializeMapParams } from '../../src/lib/params';
import { dataRange, defaultPreset, MAX_PERIOD_DAYS, resolvePeriod, sameDayPrevYear, spanDays, yearsTouched } from '../../src/lib/period';
import type { CasesYear } from '../../src/lib/types';

const yearsTo = (last: number) => Array.from({ length: last - 1998 + 1 }, (_, i) => 1998 + i);
const counties = new Set(['64000', '67000']);

describe('period: data range and defaults', () => {
  it('ends today, clamped to the newest data year and never before the latest onset', () => {
    expect(dataRange({ years: yearsTo(2026), latestOnset: '2026-10-14', today: '2026-10-17' })).toEqual({ min: '1998-01-01', max: '2026-10-17' });
    // browser clock behind the data
    expect(dataRange({ years: yearsTo(2026), latestOnset: '2026-10-14', today: '2026-10-10' }).max).toBe('2026-10-14');
    // the pipeline has not produced next year's file yet
    expect(dataRange({ years: yearsTo(2026), latestOnset: '2026-12-29', today: '2027-01-02' }).max).toBe('2026-12-31');
  });
  it('defaults to this year, except in January (from Jan 1 of the previous year, as the old CDC map)', () => {
    const at = (today: string, last = +today.slice(0, 4)) => defaultPreset({ years: yearsTo(last), latestOnset: '2026-12-30', today });
    expect(at('2026-10-17')).toBe('ytd');
    expect(at('2027-01-01')).toBe('py');
    expect(at('2027-01-31')).toBe('py');
    expect(at('2027-02-01')).toBe('ytd');
    expect(at('2027-01-02', 2026)).toBe('ytd'); // stale manifest without 2027: show all of 2026
  });
  it('resolves presets', () => {
    const ctx = { years: yearsTo(2026), latestOnset: '2026-10-14', today: '2026-10-17' };
    expect(resolvePeriod('ytd', {}, ctx)).toEqual({ preset: 'ytd', year: 2026, start: '2026-01-01', end: '2026-10-17', capped: false });
    expect(resolvePeriod('90d', {}, ctx)).toMatchObject({ start: '2026-07-20', end: '2026-10-17' });
    expect(spanDays('2026-07-20', '2026-10-17')).toBe(90);
    expect(resolvePeriod('12m', {}, ctx)).toMatchObject({ start: '2025-10-18', end: '2026-10-17' });
    expect(resolvePeriod('year', { year: 2015 }, ctx)).toMatchObject({ year: 2015, start: '2015-01-01', end: '2015-12-31' });
    expect(resolvePeriod('year', { year: 1990 }, ctx)).toMatchObject({ year: 2026, start: '2026-01-01', end: '2026-10-17' });
    expect(resolvePeriod('custom', { start: '2014-01-01', end: '2015-12-31' }, ctx)).toMatchObject({ start: '2014-01-01', end: '2015-12-31', capped: false });
    expect(resolvePeriod('custom', { start: '2026-03-01', end: '2025-12-01' }, ctx)).toMatchObject({ start: '2025-12-01', end: '2026-03-01' });
    const long = resolvePeriod('custom', { start: '2010-01-01', end: '2026-12-31' }, ctx);
    expect(long).toMatchObject({ end: '2026-10-17', capped: true });
    expect(spanDays(long.start, long.end)).toBe(MAX_PERIOD_DAYS);
    expect(sameDayPrevYear('2028-02-29')).toBe('2027-02-28');
    expect(yearsTouched('2025-12-01', '2026-01-31', yearsTo(2026))).toEqual([2025, 2026]);
    expect(yearsTouched('2014-01-01', '2015-12-31', [2015, 2014, 2016])).toEqual([2014, 2015]);
  });
});

describe('year rollover: today = 2027-01-03 (Taipei), latest onset still in 2026', () => {
  const ctx = { years: yearsTo(2027), latestOnset: '2026-12-30', today: '2027-01-03', counties };
  it('defaults to Jan 1 of the previous year through today and loads both files', () => {
    const p = normalizeMapParams({}, ctx);
    expect(p.period).toEqual({ preset: 'py', year: 2027, start: '2026-01-01', end: '2027-01-03', capped: false });
    expect([p.from, p.to]).toEqual(['2026-01-01', '2027-01-03']);
    expect(serializeMapParams(p, ctx)).toEqual({});
    expect(yearsTouched(p.period.start, p.period.end, ctx.years)).toEqual([2026, 2027]);
    // colours are measured from today, so a 2026-12-30 onset is 4 days old (≤ 7: may still be viraemic)
    expect(recencyRef(p.to, ctx.latestOnset, ctx.today)).toBe('2027-01-03');
  });
  it('"this year" is the (still empty) new year; explicit choices serialise', () => {
    const p = normalizeMapParams({ p: 'ytd' }, ctx);
    expect(p.period).toMatchObject({ start: '2027-01-01', end: '2027-01-03' });
    expect(serializeMapParams(p, ctx)).toEqual({ p: 'ytd' });
    expect(normalizeMapParams({ p: 'year' }, ctx).period).toMatchObject({ year: 2027, start: '2027-01-01', end: '2027-01-03' });
    expect(normalizeMapParams({ p: 'year', year: '2026' }, ctx).period).toMatchObject({ start: '2026-01-01', end: '2026-12-31' });
    // an old link to late December 2026
    expect(normalizeMapParams({ year: '2026', from: '350' }, ctx)).toMatchObject({ from: '2026-12-16', to: '2026-12-31' });
    expect(normalizeMapParams({ p: '90d' }, ctx).period).toMatchObject({ start: '2026-10-06', end: '2027-01-03' });
  });
  it('in February the default is this year again', () => {
    const feb = { ...ctx, today: '2027-02-01', latestOnset: '2027-01-29' };
    expect(normalizeMapParams({}, feb).period).toMatchObject({ preset: 'ytd', start: '2027-01-01', end: '2027-02-01' });
  });
});

describe('multi-year case sets', () => {
  const y2025: CasesYear = { year: 2025, pts: [[120.3, 22.6, '64000010'], [121.5, 25.0, null]], c: [[1, 0, 0, 2], [335, 1, 1, 1], [365, 0, 0, 3]] };
  const y2026: CasesYear = { year: 2026, pts: [[121.5, 25.0, '63000010'], [120.3, 22.6, '64000010']], c: [[1, 1, 0, 1], [5, 0, 0, 4], [40, 1, 1, 2]] };
  const y2027: CasesYear = { year: 2027, pts: [], c: [] };
  const set = mergeCaseYears([y2027, y2026, y2025]);
  it('merges files in date order, de-duplicating points across years', () => {
    expect(set.pts).toEqual([[120.3, 22.6, '64000010'], [121.5, 25.0, '63000010']]);
    expect(set.length).toBe(6);
    expect([...set.day]).toEqual(['2025-01-01', '2025-12-01', '2025-12-31', '2026-01-01', '2026-01-05', '2026-02-09'].map(epochDay));
    expect([...set.pt]).toEqual([0, 1, 0, 0, 1, 0]);
    expect(mergeCaseYears([y2027]).length).toBe(0);
  });
  it('aggregates across the year boundary', () => {
    const a = aggregateSet(set, { from: epochDay('2025-12-01'), to: epochDay('2026-01-31'), type: 'all', county: null });
    expect(a.total).toEqual({ local: 8, imported: 1 });
    expect(a.byPt.get(0)).toEqual([4, 0]);
    expect(a.byPt.get(1)).toEqual([4, 1]);
    expect(a.lastDay.get(0)).toBe(epochDay('2026-01-01'));
    expect(a.lastDay.get(1)).toBe(epochDay('2026-01-05'));
    expect(aggregateSet(set, { from: epochDay('2025-01-01'), to: epochDay('2026-12-31'), type: 'local', county: '64000' }).total).toEqual({ local: 6, imported: 0 });
  });
  it('extends incrementally with the same result as a full scan', () => {
    const inc = new SetAggregator(set);
    const from = epochDay('2025-06-01');
    for (let d = from; d <= epochDay('2026-03-01'); d++) {
      const f = { from, to: d, type: 'all' as const, county: null };
      const a = inc.update(f);
      const b = aggregateSet(set, f);
      expect(a.total).toEqual(b.total);
      expect([...a.byPt]).toEqual([...b.byPt]);
      expect([...a.lastDay]).toEqual([...b.lastDay]);
    }
    // going back (or changing the filter) restarts
    expect(inc.update({ from, to: epochDay('2025-12-31'), type: 'all', county: null }).total).toEqual({ local: 3, imported: 1 });
  });
  it('daily counts are indexed from the period start', () => {
    const d = dailyCountsSet(set, epochDay('2025-12-30'), 10, 'local');
    expect([...d]).toEqual([0, 3, 1, 0, 0, 0, 4, 0, 0, 0]);
  });
});
