import { describe, expect, it } from 'vitest';
import { buildHash, isRouterHash, parseHash } from '../../src/lib/router';

describe('parseHash', () => {
  it('parses route and params', () => {
    expect(parseHash('#/map?year=2026&type=local&county=64000&from=1&to=289')).toEqual({
      route: 'map', params: { year: '2026', type: 'local', county: '64000', from: '1', to: '289' },
    });
  });
  it('falls back to map for empty/unknown routes', () => {
    expect(parseHash('').route).toBe('map');
    expect(parseHash('#').route).toBe('map');
    expect(parseHash('#/nope?x=1').route).toBe('map');
    expect(parseHash('#/TRENDS/').route).toBe('trends');
  });
  it('drops malformed keys, overlong values and duplicates', () => {
    const { params } = parseHash(`#/map?ok=1&bad-key=2&<script>=3&long=${'x'.repeat(200)}&ok=9`);
    expect(params).toEqual({ ok: '1' });
  });
  it('round-trips through buildHash', () => {
    const h = buildHash('vector', { week: '2', county: '10013', empty: '' });
    expect(h).toBe('#/vector?week=2&county=10013');
    expect(parseHash(h)).toEqual({ route: 'vector', params: { week: '2', county: '10013' } });
    expect(buildHash('about')).toBe('#/about');
  });
  it('ignores in-page anchors', () => {
    expect(isRouterHash('#main')).toBe(false);
    expect(isRouterHash('#/map')).toBe(true);
    expect(isRouterHash('')).toBe(true);
  });
});
