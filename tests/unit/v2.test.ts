import { describe, expect, it } from 'vitest';
import { recencyBucket } from '../../src/lib/aggregate';
import { greatCircle, TAIWAN } from '../../src/lib/geo';
import { advisoryLevel, eventRange, filterNews, importedEvents, levelHistogram, levelsByCountry, vbLevel } from '../../src/lib/travel';
import type { Imported, Travel } from '../../src/lib/types';
import { validateImported, validateTravel } from '../../src/lib/validate';
import { interp } from '../../src/views/importedAnim';
import { dangerTriggers } from '../../src/views/vectorData';

describe('recencyBucket', () => {
  it('uses the old CDC map boundaries (≤7, 8–14, 15–30, >30 days)', () => {
    const cases: [number, number][] = [[-1, 0], [0, 0], [7, 0], [8, 1], [14, 1], [15, 2], [30, 2], [31, 3], [400, 3]];
    for (const [d, b] of cases) expect(recencyBucket(d), `day ${d}`).toBe(b);
  });
});

describe('great-circle interpolation', () => {
  it('interp walks along the polyline', () => {
    const line: [number, number][] = [[0, 0], [10, 0], [10, 10]];
    expect(interp(line, 0)).toEqual([0, 0]);
    expect(interp(line, 0.5)).toEqual([5, 0]);
    expect(interp(line, 1.5)).toEqual([10, 5]);
    expect(interp(line, 2)).toEqual([10, 10]);
    expect(interp(line, 9)).toEqual([10, 10]); // clamped
  });
  it('arc from Vietnam to Taiwan has the requested segments and bends poleward', () => {
    const arc = greatCircle([108.28, 14.06], TAIWAN, 64);
    expect(arc).toHaveLength(65);
    expect(arc[64]![0]).toBeCloseTo(TAIWAN[0], 4);
    const mid = arc[32]!;
    // great circle lies north of the straight lng/lat chord in the northern hemisphere
    expect(mid[1]).toBeGreaterThan((14.06 + TAIWAN[1]) / 2);
  });
});

const travelRaw = {
  updated: '2026-10-16T21:17:38+08:00',
  levels: { 1: { zh: '第一級:注意', en: 'Level 1: Watch', adviceZh: 'a', adviceEn: 'b' }, 2: { zh: '第二級:警示', en: 'Level 2: Alert' }, 3: { zh: '第三級:警告', en: 'Level 3: Warning' } },
  diseases: { dengue: { zh: '登革熱', en: 'Dengue' } },
  countries: {
    vn: { zh: '越南', en: 'Vietnam', level: 2, vb: [{ d: 'dengue', level: 2, since: '2026-02-03', areaZh: '', areaEn: '' }, { d: 'zika', level: 1, since: null }] },
    jp: { zh: '日本', en: 'Japan', level: 1, vb: [] },
    br: { zh: '巴西', en: 'Brazil', level: 3, vb: [{ d: 'chikungunya', level: 1 }, { d: 'covid', level: 3 }] },
    XX: { zh: 'bad' },
  },
  news: [
    { id: 'a', date: '2026-10-01', d: ['dengue'], countries: ['vn', 'th'], headlineZh: '越南-登革熱', url: 'https://www.cdc.gov.tw/x' },
    { id: 'b', date: '2026-10-05', d: ['chikungunya', 'measles'], countries: ['br'], url: 'javascript:alert(1)' },
    { id: 'c', date: '2026-09-01', d: ['measles'], countries: ['us'] },
  ],
};

describe('travel.json', () => {
  const t: Travel = validateTravel(travelRaw);
  it('validates: drops unknown diseases/countries, null since, unsafe URLs; sorts news', () => {
    expect(Object.keys(t.countries).sort()).toEqual(['br', 'jp', 'vn']);
    expect(t.countries.vn!.vb[1]).toEqual({ d: 'zika', level: 1, since: '', areaZh: '', areaEn: '' });
    expect(t.countries.br!.vb.map((a) => a.d)).toEqual(['chikungunya']);
    expect(t.news.map((n) => n.id)).toEqual(['b', 'a']);
    expect(t.news[0]!.d).toEqual(['chikungunya']);
    expect(t.news[0]!.url).toBeNull();
    expect(t.diseases.malaria.en).toBe('malaria'); // missing → key fallback
  });
  it('aggregates advisory levels (mosquito-borne max vs overall)', () => {
    expect(vbLevel(t.countries.vn)).toBe(2);
    expect(vbLevel(t.countries.jp)).toBe(0);
    expect(advisoryLevel(t.countries.br, 'vb')).toBe(1);
    expect(advisoryLevel(t.countries.br, 'all')).toBe(3);
    expect(advisoryLevel(undefined, 'all')).toBe(0);
    expect(levelHistogram(levelsByCountry(t, 'vb'))).toEqual([1, 1, 1, 0]);
    expect(levelHistogram(levelsByCountry(t, 'all'))).toEqual([0, 1, 1, 1]);
  });
  it('filters news by disease and country', () => {
    expect(filterNews(t.news, {}).length).toBe(2);
    expect(filterNews(t.news, { diseases: new Set(['dengue']) }).map((n) => n.id)).toEqual(['a']);
    expect(filterNews(t.news, { diseases: new Set() }).length).toBe(2);
    expect(filterNews(t.news, { country: 'br' }).map((n) => n.id)).toEqual(['b']);
    expect(filterNews(t.news, { country: 'th', diseases: new Set(['chikungunya']) })).toEqual([]);
  });
});

describe('imported events', () => {
  const base = { from: '2026-01-01', to: '2026-03-31', countries: { vn: { zh: '越南', lat: 14, lng: 108, byYear: { 2026: 3 }, byMonth: { '2026-01': 2, '2026-02': 1 } } } };
  it('validates events and drops unknown countries / bad rows', () => {
    const v = validateImported({ ...base, events: [[3, 'vn', 2], [1, 'vn', 1], [2, 'xx', 1], [-1, 'vn', 1], [5, 'vn', 0]] });
    expect(v.events).toEqual([[1, 'vn', 1], [3, 'vn', 2]]);
    expect(validateImported(base).events).toBeNull();
  });
  it('falls back to spreading monthly counts deterministically', () => {
    const imp: Imported = validateImported(base);
    const { events, approximate } = importedEvents(imp);
    expect(approximate).toBe(true);
    expect(events.reduce((s, e) => s + e[2], 0)).toBe(3);
    expect(events.map((e) => e[0])).toEqual([7, 23, 45]); // Jan: days 7 & 23; Feb: mid-month (31 + 14)
    expect(importedEvents({ ...imp, events: [[0, 'vn', 1]] })).toEqual({ events: [[0, 'vn', 1]], approximate: false });
  });
  it('eventRange finds the slice for a day window', () => {
    const ev: [number, string, number][] = [[0, 'a', 1], [2, 'a', 1], [2, 'b', 1], [5, 'a', 1]];
    expect(eventRange(ev, 1, 2)).toEqual([1, 3]);
    expect(eventRange(ev, 6, 9)).toEqual([4, 4]);
  });
});

describe('vector danger triggers', () => {
  it('lists every indicator at danger level', () => {
    expect(dangerTriggers([3, 3, 60, 30])).toEqual(['bi', 'ovi', 'gra']);
    expect(dangerTriggers([3, 2, 59, 29])).toEqual([]);
    expect(dangerTriggers([3, null, 66, 10])).toEqual(['ovi']);
  });
});
