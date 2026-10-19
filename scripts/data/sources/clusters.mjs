// @ts-check
/**
 * Official dengue cluster polygons (GetDengueCluster_New per city)
 * -> clusters.json.  Field names are not fully verified live, so every
 * lookup is defensive and properties are whitelisted.
 */
import { BBOX, CDC_TO_MOI, CLUSTER_CITY_CODES, CONCURRENCY } from '../config.mjs';
import {
  cleanLabel, cmp, daysFromIso, daysFromYmd, isoFromDays, jsonEqual, mapLimit, normTai, parseYmd, round5, toJson, ymd,
} from '../util.mjs';

const MAX_VERTICES = 20000;

/** first defined, non-null value among keys (case-insensitive key match) */
function pick(/** @type {any} */ obj, /** @type {string[]} */ keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const key of keys) {
    const real = lower.get(key.toLowerCase());
    if (real !== undefined && obj[real] !== null && obj[real] !== undefined && obj[real] !== '') return obj[real];
  }
  return undefined;
}

/** `yyyymmdd`, `yyyy/mm/dd` or ISO -> YYYY-MM-DD | null */
export function normalizeClusterDate(/** @type {unknown} */ v) {
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (compact) {
    const p = parseYmd(`${compact[1]}-${compact[2]}-${compact[3]}`);
    return p ? ymd(p.y, p.m, p.d) : null;
  }
  const p = parseYmd(s);
  return p ? ymd(p.y, p.m, p.d) : null;
}

/** @param {any} ring */
function cleanRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const out = [];
  for (const pt of ring) {
    if (!Array.isArray(pt) || pt.length < 2) return null;
    const lng = Number(pt[0]), lat = Number(pt[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    if (lng < BBOX.minLng || lng > BBOX.maxLng || lat < BBOX.minLat || lat > BBOX.maxLat) return null;
    out.push([round5(lng), round5(lat)]);
  }
  return out;
}

/**
 * Validate and round a Polygon/MultiPolygon geometry; null if unusable.
 * @param {any} g
 */
export function cleanGeometry(g) {
  if (!g || typeof g !== 'object') return null;
  let vertices = 0;
  /** @param {any} poly */
  const cleanPoly = (poly) => {
    if (!Array.isArray(poly) || poly.length === 0) return null;
    const rings = [];
    for (const r of poly) {
      const c = cleanRing(r);
      if (!c) return null;
      vertices += c.length;
      rings.push(c);
    }
    return rings;
  };
  let out = null;
  if (g.type === 'Polygon') {
    const p = cleanPoly(g.coordinates);
    if (p) out = { type: 'Polygon', coordinates: p };
  } else if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates) && g.coordinates.length > 0) {
    const polys = g.coordinates.map(cleanPoly);
    if (polys.every(Boolean)) out = { type: 'MultiPolygon', coordinates: polys };
  }
  return out && vertices <= MAX_VERTICES ? out : null;
}

/**
 * @param {unknown} raw FeatureCollection from one city call (or null)
 * @param {string} cityCode CDC city code, used to derive a missing county name
 * @param {Map<string,string>} countyNameByMoi MOI county code -> 臺 form name
 */
export function normalizeClusterFeatures(raw, cityCode, countyNameByMoi) {
  if (raw === null || raw === undefined) return { features: [], dropped: 0, sampleProps: null };
  const fc = /** @type {any} */ (raw);
  if (typeof fc !== 'object' || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    throw new Error('cluster: expected a FeatureCollection');
  }
  /** @type {any[]} */
  const features = [];
  let dropped = 0;
  const fallbackCounty = countyNameByMoi.get(/** @type {string} */ (/** @type {any} */ (CDC_TO_MOI)[cityCode])) ?? '';
  for (const f of fc.features) {
    const geometry = cleanGeometry(f?.geometry);
    const props = f?.properties;
    const code1 = cleanLabel(String(pick(props, ['CODE1', 'code1']) ?? ''), 40);
    if (!geometry || !code1) { dropped++; continue; }
    const countRaw = Number(pick(props, ['COUNT', 'ttl_determined_cnt', 'count']));
    const count = Number.isFinite(countRaw) ? Math.max(0, Math.min(100000, Math.round(countRaw))) : 0;
    const county = normTai(cleanLabel(String(pick(props, ['COUNTY']) ?? ''), 20)) || fallbackCounty;
    const town = normTai(cleanLabel(String(pick(props, ['TOWN']) ?? ''), 20));
    const village = normTai(cleanLabel(String(pick(props, ['VILLAGE']) ?? ''), 20));
    const lastOnset = normalizeClusterDate(pick(props, ['sick_date_last', 'sick_date']));
    features.push({
      type: 'Feature',
      geometry,
      properties: { county, town, village, code1, count, lastOnset },
    });
  }
  const first = fc.features[0]?.properties;
  const sampleProps = first && typeof first === 'object'
    ? Object.entries(first).map(([k, v]) => `${cleanLabel(k, 40)}=${cleanLabel(String(v), 40)}`).join(', ').slice(0, 600)
    : null;
  return { features, dropped, sampleProps };
}

/**
 * @param {any[]} features
 */
export function sortAndDedupe(features) {
  const seen = new Set();
  const out = [];
  for (const f of features) {
    const k = `${f.properties.code1}|${JSON.stringify(f.geometry)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  out.sort((a, b) => cmp(a.properties.county, b.properties.county) || cmp(a.properties.town, b.properties.town) || cmp(a.properties.code1, b.properties.code1));
  return out;
}

/** Ray casting on one ring of [lng, lat]. @param {number[][]} ring @param {number} x @param {number} y */
function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point in a cleaned Polygon / MultiPolygon (holes excluded). @param {any} g @param {number} x @param {number} y */
export function inGeometry(g, x, y) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.some((/** @type {number[][][]} */ poly) => inRing(poly[0], x, y) && !poly.slice(1).some((hole) => inRing(hole, x, y)));
}

/**
 * Local cases of the last `days` days as points with an onset date, from cases/{year}.json contents.
 * @param {any[]} files cases files (current and previous year) @param {string} todayIso @param {number} [days]
 */
export function recentLocalPoints(files, todayIso, days = 60) {
  const from = daysFromIso(todayIso) - days;
  /** @type {{lng:number, lat:number, date:string}[]} */
  const out = [];
  for (const f of files) {
    if (!f || !Array.isArray(f.c) || !Array.isArray(f.pts)) continue;
    const base = daysFromYmd(f.year, 1, 1) - 1;
    for (const [doy, p, imp] of f.c) {
      const d = base + doy;
      const pt = f.pts[p];
      if (imp || d < from || !pt) continue;
      out.push({ lng: pt[0], lat: pt[1], date: isoFromDays(d) });
    }
  }
  return out;
}

/**
 * The upstream polygons carry no onset date: take the latest onset of this site's local cases inside the polygon.
 * @param {any[]} features @param {{lng:number, lat:number, date:string}[]} points
 */
export function deriveLastOnset(features, points) {
  for (const f of features) {
    if (f.properties.lastOnset) continue;
    let last = null;
    for (const p of points) if ((!last || p.date > last) && inGeometry(f.geometry, p.lng, p.lat)) last = p.date;
    f.properties.lastOnset = last;
  }
  return features;
}

/**
 * @param {import('../run.mjs').Ctx} ctx
 * @param {{features:any[], fetchedAt:string}|null} prev previous clusters.json (to keep fetchedAt stable)
 * @param {string} nowIso
 * @param {{lng:number, lat:number, date:string}[]} [recentPoints] local cases of the last 60 days (for lastOnset)
 */
export async function buildClustersSource(ctx, prev, nowIso, recentPoints = []) {
  const countyNameByMoi = new Map(ctx.geo.counties.map((c) => [c.code, c.zh]));
  const parts = await mapLimit([...CLUSTER_CITY_CODES], CONCURRENCY, async (city) => {
    const raw = await ctx.http.asmx('GetDengueCluster_New', { citycode: city });
    return normalizeClusterFeatures(raw, city, countyNameByMoi);
  });
  const features = deriveLastOnset(sortAndDedupe(parts.flatMap((p) => p.features)), recentPoints);
  // Upstream field names were never seen on a non-empty answer before; log them (public cluster attributes).
  for (const p of parts) if (p.sampleProps) ctx.log(`[clusters] upstream properties: ${p.sampleProps}`);
  const dropped = parts.reduce((a, p) => a + p.dropped, 0);
  // fetchedAt only moves when the content changes, so unchanged data stays byte-identical
  const unchanged = prev && Array.isArray(prev.features) && typeof prev.fetchedAt === 'string' && jsonEqual(prev.features, features);
  const fetchedAt = unchanged ? /** @type {string} */ (prev.fetchedAt) : nowIso;
  const fc = { type: 'FeatureCollection', fetchedAt, features };
  return { files: { 'clusters.json': toJson(fc) }, meta: { records: features.length, dropped } };
}
