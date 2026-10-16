// @ts-check
/**
 * Mosquito-vector risk by village (cdcdengueVillagePoint.json, weekly)
 * -> vector.json + geo/vector-villages.topo.json
 */
import { BBOX, VECTOR_PATH } from '../config.mjs';
import {
  cleanLabel, cmp, normTai, parseMdy, round5, roundTo, toJson, twDate,
} from '../util.mjs';

/** @type {Record<string, number>} */
export const COLOR_CODE = { gray: 0, grey: 0, yellow: 1, orange: 2, red: 3 };
const WEEKS = 5;

/** @param {unknown} v */
function colorCode(v) {
  const k = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return k in COLOR_CODE ? COLOR_CODE[k] : null;
}

/** @param {unknown} v @param {number} lo @param {number} hi */
function numOrNull(v, lo, hi) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return roundTo(Math.min(hi, Math.max(lo, n)), 1);
}

/**
 * Parse the raw FeatureCollection into normalised village records
 * (no geography matching yet).
 * @param {unknown} raw
 */
export function parseVectorSource(raw) {
  const fc = /** @type {any} */ (raw);
  if (!fc || typeof fc !== 'object' || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('vector: expected a FeatureCollection');
  }
  const stats = { input: fc.features.length, badGeometry: 0, badNames: 0, badWeeks: 0, unknownColor: 0 };
  /** @type {Array<{county:string,town:string,village:string,lng:number,lat:number,overall:number,weeks:Array<{dS:string,dE:string,color:number,m:number|null,b:number|null,g:number|null}>}>} */
  const items = [];
  for (const f of fc.features) {
    const c = f?.geometry?.coordinates;
    const lng = Array.isArray(c) ? Number(c[0]) : NaN;
    const lat = Array.isArray(c) ? Number(c[1]) : NaN;
    if (f?.geometry?.type !== 'Point' || !Number.isFinite(lng) || !Number.isFinite(lat)
      || lng < BBOX.minLng || lng > BBOX.maxLng || lat < BBOX.minLat || lat > BBOX.maxLat) { stats.badGeometry++; continue; }
    const p = f.properties;
    const county = normTai(cleanLabel(p?.COUNTY, 20));
    const town = normTai(cleanLabel(p?.TOWN, 20));
    const village = normTai(cleanLabel(p?.VILLAGE, 30));
    if (!county || !town || !village) { stats.badNames++; continue; }
    if (!Array.isArray(p.weeks) || p.weeks.length !== WEEKS) { stats.badWeeks++; continue; }
    /** @type {typeof items[number]['weeks']} */
    const weeks = [];
    let ok = true;
    for (const w of p.weeks) {
      const dS = parseMdy(w?.dS), dE = parseMdy(w?.dE);
      let color = colorCode(w?.color);
      if (color === null) { stats.unknownColor++; color = 0; }
      if (!dS || !dE || dE < dS) { ok = false; break; }
      weeks.push({ dS, dE, color, m: numOrNull(w.m_level, 0, 99), b: numOrNull(w.b_pos, 0, 100), g: numOrNull(w.g_pos, 0, 100) });
    }
    if (!ok) { stats.badWeeks++; continue; }
    let overall = colorCode(p.background_color);
    if (overall === null) overall = weeks[0].color;
    items.push({ county, town, village, lng: round5(lng), lat: round5(lat), overall, weeks });
  }
  return { items, stats, timestamp: typeof fc.timestamp === 'string' ? fc.timestamp : null };
}

/**
 * @param {ReturnType<typeof parseVectorSource>} parsed
 * @param {{
 *   match:(lng:number,lat:number,county:string,town:string,village:string)=>{code:string|null,how:string},
 *   countyCodeByName:(name:string)=>string|undefined
 * }} geoV
 */
export function buildVector(parsed, geoV) {
  const { items, stats } = parsed;
  // reference weeks = the most common 5-week signature (guards against a stray feature)
  /** @type {Map<string, number>} */
  const sigs = new Map();
  for (const it of items) {
    const sig = JSON.stringify(it.weeks.map((w) => [w.dS, w.dE]));
    sigs.set(sig, (sigs.get(sig) ?? 0) + 1);
  }
  const best = [...sigs.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0];
  if (!best) throw new Error('vector: no usable villages');
  const weeks = /** @type {string[][]} */ (JSON.parse(best[0]));

  const match = { both: 0, name: 0, pipOnlyMismatch: 0, none: 0 };
  /** @type {Record<string, {villages:number,total:number}>} */
  const surveyedRaw = {};
  let skippedWeeks = 0, unknownCounty = 0;
  const rows = [];
  for (const it of items) {
    if (JSON.stringify(it.weeks.map((w) => [w.dS, w.dE])) !== best[0]) { skippedWeeks++; continue; }
    const cc = geoV.countyCodeByName(it.county);
    const nonGray = it.overall !== 0 || it.weeks.some((w) => w.color !== 0);
    if (cc) {
      const s = (surveyedRaw[cc] ??= { villages: 0, total: 0 });
      s.total++;
      if (nonGray) s.villages++;
    } else unknownCounty++;
    if (!nonGray) continue;
    const m = geoV.match(it.lng, it.lat, it.county, it.town, it.village);
    match[/** @type {keyof typeof match} */ (m.how)]++;
    rows.push({
      it,
      code: m.code,
    });
  }
  rows.sort((a, b) => cmp(a.it.county, b.it.county) || cmp(a.it.town, b.it.town) || cmp(a.it.village, b.it.village) || a.it.lng - b.it.lng || a.it.lat - b.it.lat);
  const villages = rows.map(({ it, code }) => [
    it.county, it.town, it.village, it.lng, it.lat, code, it.overall,
    it.weeks.map((w) => [w.color, w.m, w.b, w.g]),
  ]);
  const surveyed = Object.fromEntries(Object.keys(surveyedRaw).sort(cmp).map((k) => [k, surveyedRaw[k]]));

  let updated = weeks[0][1];
  if (parsed.timestamp) {
    const t = Date.parse(parsed.timestamp);
    if (Number.isFinite(t)) updated = twDate(new Date(t));
  }
  const data = { updated, weeks, villages, surveyed };
  const matchedCodes = [...new Set(rows.map((r) => r.code).filter((c) => c !== null))].sort(cmp);
  return {
    json: toJson(data),
    data,
    matchedCodes,
    periodStart: weeks[WEEKS - 1][0],
    periodEnd: weeks[0][1],
    stats: { ...stats, skippedWeeks, unknownCounty, match, outVillages: villages.length, matched: matchedCodes.length, sourceVillages: items.length },
  };
}

/**
 * @param {import('../run.mjs').Ctx} ctx
 */
export async function buildVectorSource(ctx) {
  const raw = await ctx.http.getJson(VECTOR_PATH);
  const parsed = parseVectorSource(raw);
  const gv = await ctx.geo.villages();
  const out = buildVector(parsed, {
    match: gv.match,
    countyCodeByName: (n) => ctx.geo.countyByName.get(normTai(n))?.code,
  });
  const topo = gv.buildVillageTopo(out.matchedCodes);
  const m = out.stats.match;
  ctx.log(`vector: ${out.stats.outVillages} villages out of ${out.stats.sourceVillages}; match both=${m.both} name=${m.name} pipOnlyMismatch=${m.pipOnlyMismatch} none=${m.none}`);
  return {
    files: { 'vector.json': out.json, 'geo/vector-villages.topo.json': toJson(topo) },
    meta: {
      records: out.stats.outVillages,
      periodStart: out.periodStart,
      periodEnd: out.periodEnd,
      updated: out.data.updated,
      stats: out.stats,
    },
  };
}
