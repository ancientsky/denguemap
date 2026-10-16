// @ts-check
/**
 * NS1 rapid-test hospitals (LZString UTF-16 compressed GeoJSON) -> ns1.json
 */
import lz from 'lz-string';
import { BBOX, CDC_TO_MOI, NS1_PATH } from '../config.mjs';
import { cleanLabel, round5, toJson } from '../util.mjs';

const MAX_DECOMPRESSED = 20 * 1024 * 1024;

/**
 * The body is either the raw compressed text or a JSON string literal of it.
 * @param {string} body
 * @returns {string} decompressed JSON text
 */
export function decodeNs1Body(body) {
  let s = body;
  const trimmed = body.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const v = JSON.parse(trimmed);
      if (typeof v === 'string') s = v;
    } catch { /* not a JSON literal; use as is */ }
  }
  const out = lz.decompressFromUTF16(s);
  if (!out) throw new Error('ns1: LZString decompression failed');
  if (out.length > MAX_DECOMPRESSED) throw new Error('ns1: decompressed payload too large');
  return out;
}

/**
 * @param {unknown} fc GeoJSON FeatureCollection
 * @returns {{hospitals:Array<[string,string,string,number,number,string,string|null]>, dropped:number}}
 */
export function normalizeNs1(fc) {
  const c = /** @type {any} */ (fc);
  if (!c || c.type !== 'FeatureCollection' || !Array.isArray(c.features)) throw new Error('ns1: expected a FeatureCollection');
  const hospitals = [];
  let dropped = 0;
  for (const f of c.features) {
    const p = f?.properties ?? {};
    const coords = f?.geometry?.coordinates;
    const lng = Number(p.longitude ?? (Array.isArray(coords) ? coords[0] : NaN));
    const lat = Number(p.latitude ?? (Array.isArray(coords) ? coords[1] : NaN));
    const name = cleanLabel(p.hospName, 80);
    if (!name || !Number.isFinite(lng) || !Number.isFinite(lat)
      || lng < BBOX.minLng || lng > BBOX.maxLng || lat < BBOX.minLat || lat > BBOX.maxLat) { dropped++; continue; }
    const code = typeof p.code === 'string' ? p.code.trim() : String(p.code ?? '');
    hospitals.push(/** @type {[string,string,string,number,number,string,string|null]} */ ([
      name,
      cleanLabel(p.hospAddress, 120),
      cleanLabel(p.hospTel, 40),
      round5(lng),
      round5(lat),
      cleanLabel(String(p.hospID ?? ''), 20),
      /** @type {any} */ (CDC_TO_MOI)[code] ?? null,
    ]));
  }
  return { hospitals, dropped };
}

/**
 * @param {import('../run.mjs').Ctx} ctx
 */
export async function buildNs1Source(ctx) {
  const body = await ctx.http.getText(NS1_PATH);
  const fc = JSON.parse(decodeNs1Body(body));
  const { hospitals, dropped } = normalizeNs1(fc);
  const sourceDate = (/ns1hosp_(\d{4})(\d{2})(\d{2})/.exec(NS1_PATH) ?? []).slice(1, 4).join('-');
  const data = { sourceDate, h: hospitals };
  const noCounty = hospitals.filter((h) => h[6] === null).length;
  return {
    files: { 'ns1.json': toJson(data) },
    meta: { records: hospitals.length, sourceDate, dropped, noCounty },
  };
}
