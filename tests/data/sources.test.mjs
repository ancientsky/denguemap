// @vitest-environment node
import lz from 'lz-string';
import { describe, expect, it } from 'vitest';
import { buildClustersSource, cleanGeometry, normalizeClusterDate, normalizeClusterFeatures, sortAndDedupe } from '../../scripts/data/sources/clusters.mjs';
import { buildImported, normalizeImported } from '../../scripts/data/sources/imported.mjs';
import { decodeNs1Body, normalizeNs1 } from '../../scripts/data/sources/ns1.mjs';
import {
  buildCountryNotices, normalizeNotice, recentCountriesFromImportedJson, serializeNotices,
} from '../../scripts/data/sources/notices.mjs';
import { buildVector, parseVectorSource } from '../../scripts/data/sources/vector.mjs';
import { validateFileShape } from '../../scripts/data/validate.mjs';
import {
  CLUSTER_FEATURE, GRAY_WEEKS, IMPORTED_RECORDS, NOTICE_RECORDS, NS1_PROPS, VECTOR_GRAY, VECTOR_RED,
} from './fixtures/samples.mjs';

describe('imported', () => {
  const today = '2026-10-16';
  it('aggregates by country / year / month with recent-365d countries', () => {
    const { rows, dropped } = normalizeImported([...IMPORTED_RECORDS, { sickdate: 'bad', country_code: 'xx' }, { sickdate: '2026/01/01', country_code: 'VN1', country_name: 'x' }]);
    expect(dropped).toBe(2);
    const out = buildImported(rows, today);
    expect(out.data.from).toBe('2023-01-01');
    expect(out.data.to).toBe('2026-09-20');
    expect(Object.keys(out.data.countries)).toEqual(['id', 'ph', 'vn']);
    expect(out.data.countries.vn).toEqual({
      zh: '越南', lat: 14.06, lng: 108.28, byYear: { 2026: 3 }, byMonth: { '2026-03': 1, '2026-09': 2 },
    });
    expect(out.records).toBe(5);
    expect(out.recent).toEqual([{ cc: 'vn', zh: '越南' }]); // ph 2023 and id 2024 are older than 365 days
    validateFileShape('imported.json', out.json);
  });
  it('emits per-day events [dayIndex from `from`, cc, cases], merged, sorted and deterministic', () => {
    const extra = [
      { sickdate: '2026/03/02', country_code: 'vn', country_name: '越南', count: 3 }, // same day+country as a fixture row -> merged
      { sickdate: '2026/03/02', country_code: 'ph', country_name: '菲律賓', count: 1 },
      { sickdate: '2023/01/01', country_code: 'id', country_name: '印尼', count: 2 },
    ];
    const run = (recs) => buildImported(normalizeImported(recs).rows, today);
    const out = run([...IMPORTED_RECORDS, ...extra]);
    const day = (iso) => Math.round((Date.parse(iso) - Date.parse('2023-01-01')) / 86400000);
    expect(out.data.events).toEqual([
      [0, 'id', 2], [0, 'ph', 1], [day('2024-05-02'), 'id', 1], [day('2026-03-02'), 'ph', 1], [day('2026-03-02'), 'vn', 4], [day('2026-09-20'), 'vn', 2],
    ]);
    expect(out.data.events.reduce((a, e) => a + e[2], 0)).toBe(out.records);
    expect(out.data.events.at(-1)[0]).toBe(day(out.data.to));
    expect(out.json).toBe(run([...extra, ...[...IMPORTED_RECORDS].reverse()]).json); // input order does not matter
    expect(Object.keys(out.data)).toEqual(['from', 'to', 'countries', 'events']);
    validateFileShape('imported.json', out.json);
  });
  it('validateFileShape rejects bad events', () => {
    const ok = { from: '2023-01-01', to: '2023-01-10', countries: { vn: { zh: 'x' } } };
    const shape = (events) => () => validateFileShape('imported.json', JSON.stringify({ ...ok, events }));
    expect(shape([[0, 'vn', 1], [3, 'vn', 2]])).not.toThrow();
    expect(shape([[3, 'vn', 1], [0, 'vn', 1]])).toThrow(/sorted/);
    expect(shape([[0, 'vn', 1], [0, 'vn', 1]])).toThrow(/sorted/);
    expect(shape([[10, 'vn', 1]])).toThrow(/bad event/);
    expect(shape([[0, 'VN', 1]])).toThrow(/bad event/);
    expect(shape([[0, 'th', 1]])).toThrow(/unknown country/);
    expect(shape([[0, 'vn', 0]])).toThrow(/bad event/);
  });
  it('rejects non-arrays and empty results', () => {
    expect(() => normalizeImported({})).toThrow();
    expect(() => buildImported([], today)).toThrow(/no usable/);
  });
});

describe('notices', () => {
  it('sanitises the verbatim sample', () => {
    const n = normalizeNotice(NOTICE_RECORDS[0]);
    expect(n.date).toBe('2026-09-29');
    expect(n.headline).toBe('越南-登革熱'); // NFKC fixes the compatibility glyph
    expect(n.text).toBe('越南胡志明市今年截至第38週(9/20)累計報告34,161例病例,較去年同期增加。');
    expect(n.url).toMatch(/^https:\/\/www\.cdc\.gov\.tw\/TravelEpidemic\/Detail\//);
    expect(n.text).not.toMatch(/[<>]|alert/);
  });
  it('nulls foreign urls and caps length', () => {
    const n = normalizeNotice({ effective: '2026-09-29T08:25:50+08:00', headline: 'h', description: 'x'.repeat(2000), web: 'https://evil.example/' });
    expect(n.url).toBeNull();
    expect(Array.from(n.text)).toHaveLength(600);
  });
  it('converts the effective timestamp to a Taiwan date', () => {
    expect(normalizeNotice({ effective: '2026-09-29T17:00:00Z', headline: 'h', description: '' }).date).toBe('2026-09-30');
    expect(normalizeNotice({ effective: 'garbage', headline: 'h' })).toBeNull();
    expect(normalizeNotice({ effective: '2026-09-29T00:00:00+08:00' })).toBeNull();
  });
  it('orders newest first, dedupes, keeps at most 5', () => {
    const mk = (d, h) => ({ effective: `2026-0${d}-01T00:00:00+08:00`, headline: h, description: 'd' });
    const raw = [mk(1, 'a'), mk(2, 'b'), mk(3, 'c'), mk(4, 'd'), mk(5, 'e'), mk(6, 'f'), mk(6, 'f')];
    const list = buildCountryNotices(raw);
    expect(list.map((x) => x.headline)).toEqual(['f', 'e', 'd', 'c', 'b']);
    expect(buildCountryNotices(null)).toEqual([]);
    const { json, records } = serializeNotices({ vn: list, th: [] });
    expect(records).toBe(5);
    expect(Object.keys(JSON.parse(json))).toEqual(['vn']);
    validateFileShape('notices.json', json);
  });
  it('derives recent countries from a previous imported.json', () => {
    const prev = { countries: { vn: { zh: '越南', byMonth: { '2026-03': 1 } }, ph: { zh: '菲律賓', byMonth: { '2023-01': 1 } } } };
    expect(recentCountriesFromImportedJson(prev, '2026-10-16')).toEqual([{ cc: 'vn', zh: '越南' }]);
  });
});

describe('clusters', () => {
  const names = new Map([['68000', '桃園市']]);
  it('handles the empty collection', () => {
    expect(normalizeClusterFeatures({ type: 'FeatureCollection', features: [] }, '31', names).features).toEqual([]);
    expect(normalizeClusterFeatures(null, '31', names).features).toEqual([]);
    expect(() => normalizeClusterFeatures({ type: 'nope' }, '31', names)).toThrow();
  });
  it('whitelists properties and derives missing fields from the inline sample', () => {
    const { features } = normalizeClusterFeatures({ type: 'FeatureCollection', features: [CLUSTER_FEATURE] }, '32', names);
    expect(features).toHaveLength(1);
    expect(features[0].properties).toEqual({ county: '桃園市', town: '桃園區', village: '', code1: 'A6801-57-009', count: 2, lastOnset: '2020-07-21' });
    expect(features[0].geometry.coordinates[0][0]).toEqual([121.30268, 25.00339]);
  });
  it('prefers COUNT / sick_date_last when present and normalises 台', () => {
    const f = { ...CLUSTER_FEATURE, properties: { CODE1: 'A', COUNTY: '台南市', TOWN: '東區', COUNT: 3, ttl_determined_cnt: 9, sick_date: '20200101', sick_date_last: '20200801' } };
    const { features } = normalizeClusterFeatures({ type: 'FeatureCollection', features: [f] }, '05', names);
    expect(features[0].properties).toEqual({ county: '臺南市', town: '東區', village: '', code1: 'A', count: 3, lastOnset: '2020-08-01' });
  });
  it('drops features with bad geometry or no code', () => {
    const bad = [
      { ...CLUSTER_FEATURE, geometry: { type: 'Point', coordinates: [121, 25] } },
      { ...CLUSTER_FEATURE, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
      { ...CLUSTER_FEATURE, properties: { TOWN: 'x' } },
    ];
    const r = normalizeClusterFeatures({ type: 'FeatureCollection', features: bad }, '32', names);
    expect(r.features).toHaveLength(0);
    expect(r.dropped).toBe(3);
    expect(cleanGeometry(null)).toBeNull();
  });
  it('parses dates', () => {
    expect(normalizeClusterDate('20200721')).toBe('2020-07-21');
    expect(normalizeClusterDate('2020/07/21')).toBe('2020-07-21');
    expect(normalizeClusterDate('20201301')).toBeNull();
    expect(normalizeClusterDate(undefined)).toBeNull();
  });
  it('keeps fetchedAt stable while features are unchanged (empty and non-empty)', async () => {
    const geo = { counties: [{ code: '68000', zh: '桃園市', en: 'x' }] };
    const calls = [];
    const http = { asmx: async (m, b) => { calls.push(b.citycode); return b.citycode === '32' ? { type: 'FeatureCollection', features: [CLUSTER_FEATURE] } : b.citycode === '31' ? null : { type: 'FeatureCollection', features: [] }; } };
    const ctx = { http, geo, log: () => {} };
    const first = await buildClustersSource(ctx, null, '2026-10-16T12:00:00Z');
    expect(calls).toHaveLength(16);
    const a = JSON.parse(first.files['clusters.json']);
    expect(a.fetchedAt).toBe('2026-10-16T12:00:00Z');
    expect(a.features).toHaveLength(1);
    validateFileShape('clusters.json', first.files['clusters.json']);
    const second = await buildClustersSource(ctx, a, '2026-10-16T15:00:00Z');
    expect(second.files['clusters.json']).toBe(first.files['clusters.json']);
    const emptyCtx = { http: { asmx: async () => ({ type: 'FeatureCollection', features: [] }) }, geo, log: () => {} };
    const e = await buildClustersSource(emptyCtx, a, '2026-10-16T18:00:00Z');
    expect(JSON.parse(e.files['clusters.json'])).toEqual({ type: 'FeatureCollection', fetchedAt: '2026-10-16T18:00:00Z', features: [] });
    expect(e.meta.records).toBe(0);
    expect(sortAndDedupe([])).toEqual([]);
  });
});

describe('vector', () => {
  const fc = (features, extra = {}) => ({ type: 'FeatureCollection', timestamp: '2026-10-11T20:00:02.534Z', features, ...extra });
  const geoV = {
    match: (lng, lat, county, town, village) => (village === '大同里' ? { code: '10013010025', how: 'both' } : { code: null, how: 'none' }),
    countyCodeByName: (n) => ({ 屏東縣: '10013', 臺北市: '63000' })[n],
  };
  it('converts the red sample and keeps only non-gray villages', () => {
    const parsed = parseVectorSource(fc([VECTOR_RED, VECTOR_GRAY]));
    const out = buildVector(parsed, geoV);
    expect(out.data.updated).toBe('2026-10-12');
    expect(out.data.weeks[0]).toEqual(['2026-10-04', '2026-10-10']);
    expect(out.data.weeks[4]).toEqual(['2026-09-06', '2026-09-12']);
    expect(out.data.villages).toEqual([[
      '屏東縣', '屏東市', '大同里', 120.48788, 22.66994, '10013010025', 3,
      [[3, null, 60, null], [0, null, null, null], [2, 2, 30, 12.5], [0, null, null, null], [1, null, 10, null]],
    ]]);
    expect(out.data.surveyed).toEqual({ 10013: { villages: 1, total: 1 }, 63000: { villages: 0, total: 1 } });
    expect(out.periodStart).toBe('2026-09-06');
    expect(out.periodEnd).toBe('2026-10-10');
    expect(out.matchedCodes).toEqual(['10013010025']);
    expect(out.stats.match).toEqual({ both: 1, name: 0, pipOnlyMismatch: 0, none: 0 });
    validateFileShape('vector.json', out.json);
  });
  it('maps colours, tolerates unknown ones, rejects bad weeks and geometry', () => {
    const odd = JSON.parse(JSON.stringify(VECTOR_RED));
    odd.properties.weeks[1].color = 'purple';
    odd.properties.background_color = 'yellow';
    const noWeeks = { ...VECTOR_RED, properties: { ...VECTOR_RED.properties, weeks: GRAY_WEEKS.slice(0, 3) } };
    const badGeom = { ...VECTOR_RED, geometry: { type: 'Point', coordinates: [0, 0] } };
    const badDate = JSON.parse(JSON.stringify(VECTOR_RED));
    badDate.properties.weeks[0].dS = '2026-10-04';
    const parsed = parseVectorSource(fc([odd, noWeeks, badGeom, badDate]));
    expect(parsed.items).toHaveLength(1);
    expect(parsed.stats).toMatchObject({ badWeeks: 2, badGeometry: 1, unknownColor: 1 });
    expect(parsed.items[0].overall).toBe(1);
    expect(parsed.items[0].weeks[1].color).toBe(0);
    expect(() => parseVectorSource({ type: 'x' })).toThrow();
  });
  it('is deterministic and skips villages with misaligned weeks', () => {
    const shifted = JSON.parse(JSON.stringify(VECTOR_RED));
    shifted.properties.VILLAGE = '別里';
    shifted.properties.weeks.forEach((w) => { w.dS = '1/1/2020'; w.dE = '1/7/2020'; });
    const parsed = parseVectorSource(fc([VECTOR_RED, VECTOR_RED, shifted]));
    const a = buildVector(parsed, geoV);
    expect(a.stats.skippedWeeks).toBe(1);
    expect(a.data.villages).toHaveLength(2);
    expect(buildVector(parseVectorSource(fc([shifted, VECTOR_RED, VECTOR_RED])), geoV).json).toBe(a.json);
  });
});

describe('ns1', () => {
  const geojson = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: NS1_PROPS, geometry: { type: 'Point', coordinates: [121.549618, 25.055508] } }, { type: 'Feature', properties: { ...NS1_PROPS, hospName: '', hospID: 'x' } }, { type: 'Feature', properties: { ...NS1_PROPS, latitude: '0', longitude: '0', hospID: 'y' } }] };
  const compressed = lz.compressToUTF16(JSON.stringify(geojson));
  it('decodes both raw and JSON-string-literal bodies', () => {
    expect(JSON.parse(decodeNs1Body(compressed))).toEqual(geojson);
    expect(JSON.parse(decodeNs1Body(JSON.stringify(compressed)))).toEqual(geojson);
    expect(JSON.parse(decodeNs1Body(`  ${JSON.stringify(compressed)}\n`))).toEqual(geojson);
  });
  it('fails on garbage', () => {
    expect(() => decodeNs1Body('not compressed at all \u0001')).toThrow();
  });
  it('maps the CDC city code to the MOI county code and drops bad rows', () => {
    const { hospitals, dropped } = normalizeNs1(geojson);
    expect(dropped).toBe(2);
    expect(hospitals).toEqual([['長庚紀念醫院', '臺北市松山區敦化北路199號', '02-27135211', 121.54962, 25.05551, '1101010012', '63000']]);
    validateFileShape('ns1.json', JSON.stringify({ sourceDate: '2016-06-03', h: hospitals }));
  });
  it('falls back to the address prefix when the CDC city code is unknown', () => {
    const one = (props) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { ...NS1_PROPS, ...props }, geometry: null }] });
    const byName = (n) => ({ 臺東縣: '10014' })[n];
    const r = normalizeNs1(one({ code: '99', hospAddress: '台東縣臺東市五權街1號' }), byName);
    expect(r.hospitals[0][6]).toBe('10014');
    expect(r.unmappedCodes).toEqual({ 99: 1 });
    expect(normalizeNs1(one({ code: '99', hospAddress: '某地' }), byName).hospitals[0][6]).toBeNull();
  });
});

describe('clusters: real upstream shape (2026-10-19) and derived lastOnset', async () => {
  const { normalizeClusterFeatures, deriveLastOnset, recentLocalPoints, inGeometry } = await import('../../scripts/data/sources/clusters.mjs');
  const ring = [[120.470, 22.668], [120.474, 22.668], [120.474, 22.671], [120.470, 22.671], [120.470, 22.668]];
  const raw = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { CODE1: 'A1301-59-004', COUNTY: '屏東縣', TOWN: '屏東市', VILLAGE: '長安里', COUNT: 2, lon: 120.4719, lat: 22.6688 } }] };

  it('keeps the village; there is no onset date upstream', () => {
    const { features } = normalizeClusterFeatures(raw, '43', new Map());
    expect(features[0].properties).toEqual({ county: '屏東縣', town: '屏東市', village: '長安里', code1: 'A1301-59-004', count: 2, lastOnset: null });
  });
  it('takes lastOnset from local cases inside the polygon (imported and outside cases ignored)', () => {
    const { features } = normalizeClusterFeatures(raw, '43', new Map());
    const files = [{ year: 2026, pts: [[120.47177, 22.66924, '10013010'], [120.48, 22.68, '10013010']],
      c: [[278, 0, 0, 1], [282, 0, 0, 1], [285, 0, 1, 1], [290, 1, 0, 1]] }];
    const pts = recentLocalPoints(files, '2026-10-19');
    expect(pts.map((p) => p.date)).toEqual(['2026-10-05', '2026-10-09', '2026-10-17']);
    expect(deriveLastOnset(features, pts)[0].properties.lastOnset).toBe('2026-10-09');
    expect(inGeometry({ type: 'MultiPolygon', coordinates: [[ring]] }, 120.472, 22.669)).toBe(true);
    expect(inGeometry({ type: 'Polygon', coordinates: [ring, [[120.471, 22.6685], [120.473, 22.6685], [120.473, 22.6700], [120.471, 22.6700], [120.471, 22.6685]]] }, 120.472, 22.669)).toBe(false);
  });
});
