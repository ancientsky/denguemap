// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildTravel, buildTravelSource, mosquitoKeys, normalizeAlerts, normalizeNews,
} from '../../scripts/data/sources/travel.mjs';
import { createHttp } from '../../scripts/data/http.mjs';
import { validateFileShape, validateTravel } from '../../scripts/data/validate.mjs';
import { travelAlerts } from './helpers/mock-server.mjs';

const load = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const alerts = () => load('travel-alerts.sample.json');
const epi = () => load('travel-epidemics.sample.json');
const TODAY = '2026-10-17';
const item = (over = {}) => ({
  id: 'abc_DEF-1', date: '2026-10-10', disease_zh: '登革熱', headline_zh: '標題', headline_en: 'Headline',
  summary_zh: '摘要', summary_en: 'Summary', countries: ['VN'], url: 'https://www.cdc.gov.tw/x', ...over,
});

describe('travel alerts', () => {
  it('keeps mosquito-borne advice per country, max level over all diseases', () => {
    const a = normalizeAlerts(alerts());
    expect(a.updated).toBe('2026-10-16T21:17:38+08:00');
    expect(Object.keys(a.countries)).toEqual(['ad', 'br', 'cu', 'id', 'sg', 'th', 'vn']);
    expect(a.countries.vn).toEqual({
      zh: '越南', en: 'Vietnam', level: 2,
      vb: [
        { d: 'dengue', level: 2, since: '2026-02-03', areaZh: '', areaEn: '' },
        { d: 'zika', level: 1, since: '2022-04-12', areaZh: '', areaEn: '' },
      ],
    });
    // global-only advice (COVID) counts for the level but is not a vb entry
    expect(a.countries.ad).toMatchObject({ level: 1, vb: [] });
    // diseases in the fixed order
    expect(a.countries.br.vb.map((v) => `${v.d}${v.level}`)).toEqual(['dengue2', 'chikungunya2', 'zika1', 'yellowFever1']);
    expect(a.countries.id.vb.map((v) => v.d)).toEqual(['dengue', 'chikungunya', 'zika', 'malaria']);
  });

  it('level labels: NFKC, English suffix dropped from the Chinese name', () => {
    const { levels } = normalizeAlerts(alerts());
    expect(Object.keys(levels)).toEqual(['1', '2', '3']);
    expect(levels[1]).toEqual({ zh: '第一級:注意', en: 'Level 1: Watch', adviceZh: '提醒遵守當地的一般預防措施', adviceEn: 'Practice usual precautions' });
  });

  it('whitelists, validates and sanitises untrusted input', () => {
    const raw = alerts();
    raw.countries.VN.alerts.push(
      { disease: '登革熱', level: 4, effective: '2026-01-01' }, // bad level
      { disease: '登革熱', level: '2', effective: '2026-01-01' }, // level must be a number
      { disease: '瘧疾', level: 3, effective: 'yesterday', area_zh: '<b>北部</b><script>x()</script>⾰', area_en: 'North', evil: 'x' }, // bad date -> null
      { disease: '瘧疾', level: 3, effective: 'yesterday', area_zh: '<b>北部</b><script>x()</script>⾰', area_en: 'North' }, // duplicate
      null, 'x', { disease: 5, level: 1 },
    );
    raw.countries.xx = { name_zh: 'x', alerts: [{ disease: '登革熱', level: 1, effective: '2026-01-01' }] }; // not an ISO2 key
    raw.countries.ZZZ = { alerts: [{ disease: '登革熱', level: 1 }] };
    raw.countries.QQ = { name_zh: '空', name_en: 'Empty', alerts: [] }; // no advice -> dropped
    raw.countries.WW = 'nope';
    const a = normalizeAlerts(raw);
    expect(Object.keys(a.countries)).toEqual(['ad', 'br', 'cu', 'id', 'sg', 'th', 'vn']);
    expect(a.countries.vn.level).toBe(3);
    expect(a.countries.vn.vb.map((v) => [v.d, v.level, v.since, v.areaZh])).toEqual([
      ['dengue', 2, '2026-02-03', ''], ['zika', 1, '2022-04-12', ''], ['malaria', 3, null, '北部 革'],
    ]);
    expect(JSON.stringify(a)).not.toContain('evil');
    expect(JSON.stringify(a)).not.toMatch(/<|script/);
  });

  it('rejects structurally broken files', () => {
    expect(() => normalizeAlerts(null)).toThrow(/object/);
    expect(() => normalizeAlerts([])).toThrow(/object/);
    expect(() => normalizeAlerts({ ...alerts(), generated_at: '2026-10-16' })).toThrow(/generated_at/);
    expect(() => normalizeAlerts({ ...alerts(), generated_at: 5 })).toThrow(/generated_at/);
    const noLevel = alerts(); delete noLevel.levels['2'];
    expect(() => normalizeAlerts(noLevel)).toThrow(/level 2/);
    const emptyLevel = alerts(); emptyLevel.levels['3'].instruction_en = '';
    expect(() => normalizeAlerts(emptyLevel)).toThrow(/level 3/);
    expect(() => normalizeAlerts({ ...alerts(), countries: [] })).toThrow(/countries/);
  });
});

describe('travel news', () => {
  it('maps disease names, including comma separated lists', () => {
    expect(mosquitoKeys('登革熱')).toEqual(['dengue']);
    expect(mosquitoKeys('瘧疾,登革熱,麻疹')).toEqual(['dengue', 'malaria']); // canonical order, non-mosquito dropped
    expect(mosquitoKeys('登革熱，屈公病、西尼羅熱')).toEqual(['dengue', 'chikungunya', 'westNile']);
    expect(mosquitoKeys('日本腦炎')).toEqual(['japaneseEncephalitis']);
    expect(mosquitoKeys('黃熱病 , 茲卡病毒感染症')).toEqual(['zika', 'yellowFever']);
    expect(mosquitoKeys('白喉')).toEqual([]);
    expect(mosquitoKeys('')).toEqual([]);
    expect(mosquitoKeys(null)).toEqual([]);
  });

  it('keeps mosquito-borne items only, newest first, countries lower-cased', () => {
    const news = normalizeNews(epi(), TODAY);
    expect(news.map((n) => n.date)).toEqual(['2026-10-13', '2026-09-29', '2026-09-22', '2026-07-02']);
    expect(news.map((n) => n.d)).toEqual([['dengue'], ['dengue'], ['chikungunya'], ['dengue', 'chikungunya', 'zika', 'yellowFever', 'malaria']]);
    expect(news).toHaveLength(4); // diphtheria and the item without a disease are gone
    const first = news[0];
    expect(Object.keys(first)).toEqual(['id', 'date', 'd', 'countries', 'headlineZh', 'headlineEn', 'summaryZh', 'summaryEn', 'url']);
    expect(first.countries).toEqual(['bd', 'cu', 'us']);
    expect(first.url).toMatch(/^https:\/\/www\.cdc\.gov\.tw\//);
  });

  it('sanitises text, drops unsafe urls, bad ids/dates/countries, duplicates and old items', () => {
    const items = [
      item({ id: 'a1', headline_zh: '⾰<b>粗</b><img src=x onerror=1>', summary_en: `<script>alert(1)</script>${'x'.repeat(700)}`, url: 'javascript:alert(1)' }),
      item({ id: 'a2', url: 'https://evil.example/https://www.cdc.gov.tw/' }),
      item({ id: 'a3', url: 'http://www.cdc.gov.tw/x' }),
      item({ id: 'a4', countries: ['vn', 'VN', 'V1', 'USA', 5, 'TH', 'TH'] }),
      item({ id: 'bad id!' }), item({ id: '' }), item({ id: 5 }),
      item({ id: 'b1', date: '2026-02-30' }), item({ id: 'b2', date: 'soon' }), item({ id: 'b3', date: '2026-10-18' }), // impossible / future
      item({ id: 'old', date: '2024-10-16' }), // outside the 730 day window
      item({ id: 'edge', date: '2024-10-17' }),
      item({ id: 'a1' }), // duplicate id
      item({ id: 'nohead', headline_zh: '', headline_en: '<i></i>' }),
      item({ id: 'nodisease', disease_zh: '麻疹' }),
      null, 'str', 7,
    ];
    const news = normalizeNews({ items }, TODAY);
    expect(news.map((n) => n.id).sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'edge']);
    const by = Object.fromEntries(news.map((n) => [n.id, n]));
    expect(by.a1.headlineZh).toBe('革粗');
    expect(by.a1.summaryEn).toHaveLength(600);
    expect(by.a1.summaryEn).not.toContain('<');
    expect(by.a1.url).toBeNull();
    expect(by.a2.url).toBeNull();
    expect(by.a3.url).toBeNull();
    expect(by.a4.countries).toEqual(['vn', 'th']);
    expect(() => normalizeNews({}, TODAY)).toThrow(/items/);
    expect(() => normalizeNews({ items: 'x' }, TODAY)).toThrow(/items/);
  });

  it('caps at 300 and orders by date desc then id', () => {
    const items = Array.from({ length: 350 }, (_, i) => item({ id: `id${String(i).padStart(3, '0')}`, date: `2026-0${1 + (i % 9)}-1${i % 9}` }));
    const news = normalizeNews({ items }, TODAY);
    expect(news).toHaveLength(300);
    for (let i = 1; i < news.length; i++) {
      const [p, c] = [news[i - 1], news[i]];
      expect(p.date > c.date || (p.date === c.date && p.id < c.id)).toBe(true);
    }
  });
});

describe('travel.json', () => {
  it('is deterministic and passes the file-shape check', () => {
    const a = buildTravel(alerts(), epi(), TODAY);
    const b = buildTravel(JSON.parse(JSON.stringify(alerts())), JSON.parse(JSON.stringify(epi())), TODAY);
    expect(a.json).toBe(b.json);
    expect(a.records).toBe(4);
    expect(Object.keys(a.data)).toEqual(['updated', 'levels', 'diseases', 'countries', 'news']);
    expect(Object.keys(a.data.diseases)).toEqual(['dengue', 'chikungunya', 'zika', 'yellowFever', 'malaria', 'japaneseEncephalitis', 'westNile']);
    expect(a.data.diseases.dengue).toEqual({ zh: '登革熱', en: 'Dengue' });
    validateFileShape('travel.json', a.json);
  });

  it('file-shape check rejects malformed output', () => {
    const base = buildTravel(alerts(), epi(), TODAY).data;
    const shape = (mut) => { const d = structuredClone(base); mut(d); return () => validateFileShape('travel.json', JSON.stringify(d)); };
    expect(shape(() => {})).not.toThrow();
    expect(shape((d) => { d.updated = 'x'; })).toThrow(/updated/);
    expect(shape((d) => { delete d.levels['2']; })).toThrow(/level 2/);
    expect(shape((d) => { d.countries.vn.level = 4; })).toThrow(/bad country/);
    expect(shape((d) => { d.countries.vn.vb[0].d = 'covid'; })).toThrow(/vb alert/);
    expect(shape((d) => { d.news[0].url = 'https://evil.example/'; })).toThrow(/url/);
    expect(shape((d) => { d.news.reverse(); })).toThrow(/order/);
    expect(shape((d) => { d.news[0].countries = ['VN']; })).toThrow(/countries/);
    expect(shape((d) => { d.diseases.extra = {}; })).toThrow(/diseases/);
  });

  it('guard: fewer than 150 countries or a missing level is a failure', () => {
    const full = buildTravel(travelAlerts(160), epi(), TODAY).data;
    expect(Object.keys(full.countries)).toHaveLength(160);
    expect(() => validateTravel(full)).not.toThrow();
    const small = buildTravel(alerts(), epi(), TODAY).data;
    expect(() => validateTravel(small)).toThrow(/only 7 countries/);
    const noLevels = { ...full, levels: { 1: full.levels[1], 2: full.levels[2] } };
    expect(() => validateTravel(noLevels)).toThrow(/level 3/);
    const trimmed = structuredClone(full);
    for (const k of Object.keys(trimmed.countries).slice(0, 10)) delete trimmed.countries[k];
    expect(() => validateTravel(trimmed)).not.toThrow(); // exactly 150
    delete trimmed.countries[Object.keys(trimmed.countries)[0]];
    expect(() => validateTravel(trimmed)).toThrow(/only 149 countries/);
  });

  it('fetches both files through the capped client', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      const body = String(url).endsWith('alerts.json') ? travelAlerts(160) : epi();
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const travelHttp = createHttp({ baseUrl: 'https://example.test/web/data/', fetchImpl, backoffMs: 0 });
    const out = await buildTravelSource({ travelHttp, todayIso: TODAY, log: () => {} });
    expect(calls.sort()).toEqual(['https://example.test/web/data/alerts.json', 'https://example.test/web/data/epidemics.json']);
    expect(out.meta).toMatchObject({ records: 4, updated: '2026-10-16T21:17:38+08:00', countries: 160, vb: { dengue: 6, zika: 6 } });
    expect(out.meta.news).toEqual({ dengue: 3, chikungunya: 2, zika: 1, yellowFever: 1, malaria: 1 });
    // an oversized upstream response is rejected
    const big = createHttp({ baseUrl: 'https://example.test/', fetchImpl: async () => new Response('x'.repeat(2000)), maxBytes: 1000, backoffMs: 0 });
    await expect(buildTravelSource({ travelHttp: big, todayIso: TODAY, log: () => {} })).rejects.toThrow(/exceeded|too large/);
  });
});
