// @ts-check
/**
 * Travel epidemic notices per country (GetIntEicdemic) -> notices.json.
 * Only countries with imported cases in the last 365 days are queried.
 */
import { CONCURRENCY } from '../config.mjs';
import {
  cleanText, cmp, daysFromIso, isoFromDays, mapLimitSettled, safeCdcUrl, toJson, twDate,
} from '../util.mjs';

const MAX_PER_COUNTRY = 5;
const MAX_TEXT = 600;

/**
 * @typedef {{date:string, headline:string, text:string, url:string|null}} Notice
 */

/**
 * @param {unknown} rec raw record
 * @returns {Notice|null}
 */
export function normalizeNotice(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const r = /** @type {any} */ (rec);
  let date = null;
  if (typeof r.effective === 'string') {
    const t = Date.parse(r.effective);
    if (Number.isFinite(t)) date = twDate(new Date(t));
  }
  if (!date) return null;
  const headline = cleanText(r.headline, MAX_TEXT);
  const text = cleanText(r.description, MAX_TEXT);
  if (!headline && !text) return null;
  return { date, headline, text, url: safeCdcUrl(r.web) };
}

/**
 * Normalise + dedupe + order + cap the raw notices of one country.
 * @param {unknown} raw
 * @returns {Notice[]}
 */
export function buildCountryNotices(raw) {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('GetIntEicdemic: expected an array');
  const seen = new Set();
  /** @type {Notice[]} */
  const list = [];
  for (const rec of raw) {
    const n = normalizeNotice(rec);
    if (!n) continue;
    const k = `${n.date}|${n.headline}|${n.text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    list.push(n);
  }
  list.sort((a, b) => cmp(b.date, a.date) || cmp(a.headline, b.headline) || cmp(a.text, b.text));
  return list.slice(0, MAX_PER_COUNTRY);
}

/**
 * @param {Record<string, Notice[]>} byCountry
 * @returns {{json:string, records:number}}
 */
export function serializeNotices(byCountry) {
  /** @type {Record<string, Notice[]>} */
  const out = {};
  let records = 0;
  for (const cc of Object.keys(byCountry).sort(cmp)) {
    if (!/^[a-z]{2}$/.test(cc) || byCountry[cc].length === 0) continue;
    out[cc] = byCountry[cc];
    records += byCountry[cc].length;
  }
  return { json: toJson(out), records };
}

/**
 * @param {import('../run.mjs').Ctx} ctx
 * @param {Array<{cc:string, zh:string}>} countries countries with recent imported cases
 * @param {Record<string, Notice[]>|null} prev previously committed notices.json (fallback per country)
 */
export async function buildNoticesSource(ctx, countries, prev) {
  const settled = await mapLimitSettled(countries, CONCURRENCY, async (c) => {
    const raw = await ctx.http.asmx('GetIntEicdemic', { countrycode: c.cc, countryname: c.zh });
    return buildCountryNotices(raw);
  });
  /** @type {Record<string, Notice[]>} */
  const byCountry = {};
  let failed = 0, fellBack = 0;
  settled.forEach((r, i) => {
    const cc = countries[i].cc;
    if (r.ok) { byCountry[cc] = r.value; return; }
    failed++;
    ctx.log(`notices: ${cc} failed: ${r.error.message}`);
    const old = prev?.[cc];
    if (Array.isArray(old)) { byCountry[cc] = old; fellBack++; }
  });
  if (countries.length > 0 && failed * 2 > countries.length) {
    throw new Error(`notices: ${failed}/${countries.length} countries failed`);
  }
  const { json, records } = serializeNotices(byCountry);
  return { files: { 'notices.json': json }, meta: { records, countries: countries.length, failed, fellBack } };
}

/**
 * Fallback when the imported source failed: derive "countries with recent
 * imported cases" from the previously committed imported.json (month
 * granularity, so slightly generous).
 * @param {any} imported parsed imported.json
 * @param {string} todayIso
 * @returns {Array<{cc:string, zh:string}>}
 */
export function recentCountriesFromImportedJson(imported, todayIso) {
  const cutoffMonth = isoFromDays(daysFromIso(todayIso) - 365).slice(0, 7);
  /** @type {Array<{cc:string, zh:string}>} */
  const out = [];
  for (const [cc, c] of Object.entries(imported?.countries ?? {})) {
    const byMonth = /** @type {any} */ (c)?.byMonth ?? {};
    if (typeof /** @type {any} */ (c)?.zh === 'string' && Object.entries(byMonth).some(([m, n]) => m >= cutoffMonth && Number(n) > 0)) {
      out.push({ cc, zh: /** @type {any} */ (c).zh });
    }
  }
  return out.sort((a, b) => cmp(a.cc, b.cc));
}
