import { describe, expect, it } from 'vitest';
import {
  clampInt, normalizeImportedParams, normalizeMapParams, normalizeTrendParams, normalizeVectorParams,
  oneOf, serializeImportedParams, serializeMapParams, serializeTrendParams,
} from '../../src/lib/params';

const ctx = { years: [2015, 2023, 2024, 2025, 2026], latestOnset: '2026-10-14', today: '2026-10-17', counties: new Set(['64000', '67000']) };

describe('clampInt / oneOf', () => {
  it('clamps and defaults', () => {
    expect(clampInt('5', 1, 10, 3)).toBe(5);
    expect(clampInt('50', 1, 10, 3)).toBe(10);
    expect(clampInt('-4', 1, 10, 3)).toBe(1);
    expect(clampInt('abc', 1, 10, 3)).toBe(3);
    expect(clampInt('1e3', 1, 10, 3)).toBe(3);
    expect(clampInt(undefined, 1, 10, 3)).toBe(3);
    expect(oneOf('heat', ['points', 'heat'] as const, 'points')).toBe('heat');
    expect(oneOf('x', ['points', 'heat'] as const, 'points')).toBe('points');
  });
});

describe('map params', () => {
  const ytd = { preset: 'ytd', year: 2026, start: '2026-01-01', end: '2026-10-17', capped: false };
  it('defaults to this year up to today (Taiwan)', () => {
    const p = normalizeMapParams({}, ctx);
    expect(p).toEqual({ period: ytd, from: '2026-01-01', to: '2026-10-17', type: 'local', county: null, mode: 'points', ns1: false, color: 'recency', mv: false });
  });
  it('translates old year/day-of-year links to dates', () => {
    expect(normalizeMapParams({ year: '2025', from: '0', to: '999' }, ctx)).toMatchObject({ period: { preset: 'year', year: 2025, start: '2025-01-01', end: '2025-12-31' }, from: '2025-01-01', to: '2025-12-31' });
    expect(normalizeMapParams({ year: '2015', from: '150', to: '300' }, ctx)).toMatchObject({ period: { preset: 'year', year: 2015 }, from: '2015-05-30', to: '2015-10-27' });
    // no year: the newest year (old default), reversed ranges swapped
    expect(normalizeMapParams({ from: '200', to: '100' }, ctx)).toMatchObject({ period: { preset: 'year', year: 2026 }, from: '2026-04-10', to: '2026-07-19' });
    expect(normalizeMapParams({ to: '300' }, ctx)).toMatchObject({ from: '2026-01-01', to: '2026-10-17' }); // clamped to the data end
    // an old link re-serialises in the new form
    expect(serializeMapParams(normalizeMapParams({ year: '2015', from: '150', to: '300' }, ctx), ctx)).toEqual({ p: 'year', year: '2015', from: '2015-05-30', to: '2015-10-27' });
  });
  it('rejects years without data, unknown counties and bad enums', () => {
    expect(normalizeMapParams({ year: '2019' }, ctx).period.year).toBe(2026);
    expect(normalizeMapParams({ year: '1800' }, ctx).period.year).toBe(2015); // clamped to the earliest year
    expect(normalizeMapParams({ year: '<b>' }, ctx).period).toEqual(ytd);
    expect(normalizeMapParams({ p: 'evil', start: 'x', end: '2026-13-01' }, ctx).period).toEqual(ytd);
    expect(normalizeMapParams({ county: '99999' }, ctx).county).toBeNull();
    expect(normalizeMapParams({ county: '64000' }, ctx).county).toBe('64000');
    expect(normalizeMapParams({ type: 'evil', mode: 'x', ns1: 'yes' }, ctx)).toMatchObject({ type: 'local', mode: 'points', ns1: false });
  });
  it('accepts presets and custom cross-year periods', () => {
    expect(normalizeMapParams({ p: '90d' }, ctx).period).toMatchObject({ start: '2026-07-20', end: '2026-10-17' });
    expect(normalizeMapParams({ p: '12m' }, ctx).period).toMatchObject({ start: '2025-10-18', end: '2026-10-17' });
    expect(normalizeMapParams({ p: 'py' }, ctx).period).toMatchObject({ start: '2025-01-01', end: '2026-10-17' });
    const c = normalizeMapParams({ p: 'custom', start: '2025-12-01', end: '2026-01-31', from: '2025-12-20' }, ctx);
    expect(c).toMatchObject({ period: { preset: 'custom', start: '2025-12-01', end: '2026-01-31' }, from: '2025-12-20', to: '2026-01-31' });
    // start/end without p means custom
    expect(normalizeMapParams({ start: '2015-06-01', end: '2016-12-31' }, ctx).period).toMatchObject({ preset: 'custom', start: '2015-06-01', end: '2016-12-31', capped: false });
    // longer than 3 years: the start moves (capped); before the first data year: clamped
    expect(normalizeMapParams({ start: '2015-01-01', end: '2024-12-31' }, ctx).period).toMatchObject({ start: '2022-01-01', end: '2024-12-31', capped: true });
    expect(normalizeMapParams({ start: '1990-01-01', end: '2015-03-01' }, ctx).period).toMatchObject({ start: '2015-01-01', end: '2015-03-01', capped: false });
    // sub-range outside the period is clamped
    expect(normalizeMapParams({ p: 'custom', start: '2025-12-01', end: '2026-01-31', from: '2020-01-01', to: '2027-01-01' }, ctx)).toMatchObject({ from: '2025-12-01', to: '2026-01-31' });
  });
  it('serialises without defaults and round-trips', () => {
    expect(serializeMapParams(normalizeMapParams({}, ctx), ctx)).toEqual({});
    for (const raw of <Record<string, string>[]>[
      { p: 'year', year: '2015', type: 'all', county: '67000', from: '2015-05-30', to: '2015-10-27', mode: 'towns', ns1: '1', color: 'type', mv: '1' },
      { p: 'custom', start: '2025-12-01', end: '2026-01-31', to: '2026-01-10' },
      { p: '90d' }, { p: 'py' }, { p: '12m', from: '2026-01-01' },
    ]) {
      const p = normalizeMapParams(raw, ctx);
      const s = serializeMapParams(p, ctx);
      expect(s).toEqual(raw);
      expect(normalizeMapParams(s, ctx)).toEqual(p);
    }
  });
});

describe('other views', () => {
  it('vector week is clamped to available weeks', () => {
    expect(normalizeVectorParams({ week: '9' }, 5, new Set(['10013']))).toEqual({ week: 4, county: null });
    expect(normalizeVectorParams({ week: '-1', county: '10013' }, 5, new Set(['10013']))).toEqual({ week: 0, county: '10013' });
  });
  it('trend years are filtered, de-duplicated and capped', () => {
    const p = normalizeTrendParams({ years: '2015,2015,1990,2026,abc,2023', gran: 'day', type: 'all' }, 1998, 2026, new Set());
    expect(p).toEqual({ county: null, gran: 'day', type: 'all', years: [2026, 2023, 2015] });
    const many = Array.from({ length: 12 }, (_, i) => 2000 + i).join(',');
    expect(normalizeTrendParams({ years: many }, 1998, 2026, new Set()).years.length).toBeLessThanOrEqual(8);
    const def = normalizeTrendParams({}, 1998, 2026, new Set());
    expect(serializeTrendParams(def, 1998, 2026)).toEqual({});
  });
  it('imported year accepts "all" and valid years only', () => {
    const years = [2026, 2025, 2024, 2023];
    const cc = new Set(['vn', 'id']);
    const d = { tab: 'rank', adv: 'vb' };
    expect(normalizeImportedParams({}, years, cc)).toEqual({ year: 2026, country: null, ...d });
    expect(normalizeImportedParams({ year: 'all', country: 'vn', tab: 'news', adv: 'all' }, years, cc)).toEqual({ year: null, country: 'vn', tab: 'news', adv: 'all' });
    expect(normalizeImportedParams({ year: '1999', country: 'VN', tab: 'x', adv: 'y' }, years, cc)).toEqual({ year: 2026, country: null, ...d });
    expect(serializeImportedParams({ year: null, country: 'id', tab: 'rank', adv: 'off' }, years)).toEqual({ year: 'all', country: 'id', adv: 'off' });
  });
});
