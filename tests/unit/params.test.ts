import { describe, expect, it } from 'vitest';
import {
  clampInt, maxDoyFor, normalizeImportedParams, normalizeMapParams, normalizeTrendParams, normalizeVectorParams,
  oneOf, serializeImportedParams, serializeMapParams, serializeTrendParams,
} from '../../src/lib/params';

const ctx = { years: [2015, 2023, 2024, 2025, 2026], latestOnset: '2026-10-14', counties: new Set(['64000', '67000']) };

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
  it('defaults to the latest year and its full range', () => {
    const p = normalizeMapParams({}, ctx);
    expect(p).toEqual({ year: 2026, type: 'local', county: null, from: 1, to: 287, mode: 'points', ns1: false, color: 'recency', mv: false });
    expect(maxDoyFor(2026, ctx.latestOnset)).toBe(287);
    expect(maxDoyFor(2024, ctx.latestOnset)).toBe(366);
  });
  it('clamps day ranges to the year and swaps reversed ranges', () => {
    expect(normalizeMapParams({ year: '2025', from: '0', to: '999' }, ctx)).toMatchObject({ year: 2025, from: 1, to: 365 });
    expect(normalizeMapParams({ from: '200', to: '100' }, ctx)).toMatchObject({ from: 100, to: 200 });
    expect(normalizeMapParams({ to: '300' }, ctx)).toMatchObject({ to: 287 });
  });
  it('rejects years without data, unknown counties and bad enums', () => {
    expect(normalizeMapParams({ year: '2019' }, ctx).year).toBe(2026);
    expect(normalizeMapParams({ year: '1800' }, ctx).year).toBe(2015); // clamped to the earliest year
    expect(normalizeMapParams({ county: '99999' }, ctx).county).toBeNull();
    expect(normalizeMapParams({ county: '64000' }, ctx).county).toBe('64000');
    expect(normalizeMapParams({ type: 'evil', mode: 'x', ns1: 'yes' }, ctx)).toMatchObject({ type: 'local', mode: 'points', ns1: false });
  });
  it('serialises without defaults and round-trips', () => {
    expect(serializeMapParams(normalizeMapParams({}, ctx), ctx)).toEqual({});
    const p = normalizeMapParams({ year: '2015', type: 'all', county: '67000', from: '150', to: '300', mode: 'towns', ns1: '1', color: 'type', mv: '1' }, ctx);
    const s = serializeMapParams(p, ctx);
    expect(normalizeMapParams(s, ctx)).toEqual(p);
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
