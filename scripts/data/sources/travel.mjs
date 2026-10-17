// @ts-check
/**
 * Travel health notices from the public ancientsky/safetravel repository
 * (web/data/alerts.json + epidemics.json) -> travel.json.
 *
 * The upstream files are untrusted: only whitelisted fields survive, every
 * type is checked, all free text goes through cleanText, URLs through
 * safeCdcUrl.  Mosquito-borne diseases only.
 */
import { MOSQUITO_DISEASES, TRAVEL_MAX_NEWS, TRAVEL_NEWS_DAYS } from '../config.mjs';
import {
  cleanText, cmp, daysFromIso, isValidYmd, isoFromDays, safeCdcUrl, toJson,
} from '../util.mjs';

const MAX_TEXT = 600;
const MAX_AREA = 200;
const MAX_NEWS_COUNTRIES = 20;

/** safetravel Chinese disease name -> contract key. */
const ZH_TO_KEY = new Map(Object.entries(MOSQUITO_DISEASES).map(([k, v]) => [v.zh, k]));
const KEY_ORDER = Object.keys(MOSQUITO_DISEASES);

const isObj = (/** @type {unknown} */ v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Strict YYYY-MM-DD (a trailing time part is ignored). @param {unknown} s @returns {string|null} */
function ymdOf(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(s.trim());
  return m && isValidYmd(+m[1], +m[2], +m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** ISO-8601 timestamp with offset, e.g. 2026-10-16T21:17:38+08:00. @param {unknown} s */
function isoTimestamp(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(t) || !Number.isFinite(Date.parse(t))) return null;
  return t;
}

/** Level labels carry the English name in trailing brackets ("第一級：注意（Watch）"). @param {unknown} s */
const levelZh = (s) => cleanText(s, 60).replace(/\s*[(][A-Za-z][A-Za-z \-]*[)]$/, '');

/**
 * @typedef {{zh:string, en:string, adviceZh:string, adviceEn:string}} Level
 * @typedef {{d:string, level:number, since:string|null, areaZh:string, areaEn:string}} VbAlert
 * @typedef {{zh:string, en:string, level:number, vb:VbAlert[]}} TravelCountry
 */

/**
 * @param {unknown} raw parsed alerts.json
 * @returns {{updated:string, levels:Record<string,Level>, countries:Record<string,TravelCountry>}}
 */
export function normalizeAlerts(raw) {
  if (!isObj(raw)) throw new Error('alerts.json: expected an object');
  const r = /** @type {any} */ (raw);
  const updated = isoTimestamp(r.generated_at);
  if (!updated) throw new Error('alerts.json: bad generated_at');

  /** @type {Record<string, Level>} */
  const levels = {};
  for (const k of ['1', '2', '3']) {
    const l = isObj(r.levels) ? r.levels[k] : null;
    const out = isObj(l)
      ? { zh: levelZh(l.zh), en: cleanText(l.en, 80), adviceZh: cleanText(l.instruction_zh, 120), adviceEn: cleanText(l.instruction_en, 120) }
      : null;
    if (!out || !out.zh || !out.en || !out.adviceZh || !out.adviceEn) throw new Error(`alerts.json: level ${k} missing`);
    levels[k] = out;
  }

  if (!isObj(r.countries)) throw new Error('alerts.json: countries missing');
  /** @type {Record<string, TravelCountry>} */
  const countries = {};
  for (const cc2 of Object.keys(r.countries).sort(cmp)) {
    if (!/^[A-Z]{2}$/.test(cc2)) continue;
    const c = r.countries[cc2];
    if (!isObj(c) || !Array.isArray(c.alerts)) continue;
    let level = 0;
    /** @type {VbAlert[]} */
    const vb = [];
    const seen = new Set();
    for (const a of c.alerts) {
      if (!isObj(a)) continue;
      const lv = a.level;
      if (lv !== 1 && lv !== 2 && lv !== 3) continue;
      level = Math.max(level, lv);
      const d = typeof a.disease === 'string' ? ZH_TO_KEY.get(a.disease.normalize('NFKC').trim()) : undefined;
      if (!d) continue;
      const since = ymdOf(a.effective);
      const areaZh = cleanText(a.area_zh, MAX_AREA);
      const areaEn = cleanText(a.area_en, MAX_AREA);
      const key = `${d}|${lv}|${since}|${areaZh}|${areaEn}`;
      if (seen.has(key)) continue;
      seen.add(key);
      vb.push({ d, level: lv, since, areaZh, areaEn });
    }
    if (level === 0) continue; // no valid advice at all
    vb.sort((a, b) => KEY_ORDER.indexOf(a.d) - KEY_ORDER.indexOf(b.d) || b.level - a.level
      || cmp(a.since ?? '', b.since ?? '') || cmp(a.areaZh, b.areaZh) || cmp(a.areaEn, b.areaEn));
    const zh = cleanText(c.name_zh, 60), en = cleanText(c.name_en, 80);
    countries[cc2.toLowerCase()] = { zh: zh || en || cc2, en: en || zh || cc2, level, vb };
  }
  return { updated, levels, countries };
}

/**
 * @typedef {{id:string, date:string, d:string[], countries:string[], headlineZh:string, headlineEn:string, summaryZh:string, summaryEn:string, url:string|null}} NewsItem
 */

/**
 * Mosquito-borne keys named in a (possibly comma separated) disease_zh.
 * @param {unknown} s @returns {string[]} in canonical order
 */
export function mosquitoKeys(s) {
  if (typeof s !== 'string') return [];
  const found = new Set();
  for (const part of s.normalize('NFKC').split(/[,，、;；/]/)) {
    const k = ZH_TO_KEY.get(part.trim());
    if (k) found.add(k);
  }
  return KEY_ORDER.filter((k) => found.has(k));
}

/**
 * @param {unknown} raw parsed epidemics.json
 * @param {string} todayIso Taiwan date; items older than TRAVEL_NEWS_DAYS are dropped
 * @returns {NewsItem[]}
 */
export function normalizeNews(raw, todayIso) {
  if (!isObj(raw) || !Array.isArray(/** @type {any} */ (raw).items)) throw new Error('epidemics.json: items missing');
  const cutoff = isoFromDays(daysFromIso(todayIso) - TRAVEL_NEWS_DAYS);
  /** @type {NewsItem[]} */
  const out = [];
  const seen = new Set();
  for (const it of /** @type {any} */ (raw).items) {
    if (!isObj(it)) continue;
    const d = mosquitoKeys(it.disease_zh);
    if (d.length === 0) continue;
    const id = typeof it.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(it.id) ? it.id : null;
    const date = ymdOf(it.date);
    if (!id || !date || date < cutoff || date > todayIso || seen.has(id)) continue;
    const headlineZh = cleanText(it.headline_zh, MAX_TEXT), headlineEn = cleanText(it.headline_en, MAX_TEXT);
    const summaryZh = cleanText(it.summary_zh, MAX_TEXT), summaryEn = cleanText(it.summary_en, MAX_TEXT);
    if (!headlineZh && !headlineEn) continue;
    /** @type {string[]} */
    const countries = [];
    if (Array.isArray(it.countries)) {
      for (const c of it.countries) {
        if (typeof c !== 'string' || !/^[A-Z]{2}$/.test(c)) continue;
        const cc = c.toLowerCase();
        if (!countries.includes(cc) && countries.length < MAX_NEWS_COUNTRIES) countries.push(cc);
      }
    }
    seen.add(id);
    out.push({ id, date, d, countries, headlineZh, headlineEn, summaryZh, summaryEn, url: safeCdcUrl(it.url) });
  }
  out.sort((a, b) => cmp(b.date, a.date) || cmp(a.id, b.id));
  return out.slice(0, TRAVEL_MAX_NEWS);
}

/**
 * Build travel.json from the two parsed upstream files.
 * @param {unknown} alerts @param {unknown} epidemics @param {string} todayIso
 */
export function buildTravel(alerts, epidemics, todayIso) {
  const a = normalizeAlerts(alerts);
  const news = normalizeNews(epidemics, todayIso);
  const data = {
    updated: a.updated,
    levels: a.levels,
    diseases: MOSQUITO_DISEASES,
    countries: a.countries,
    news,
  };
  return { json: toJson(data), data, records: news.length };
}

/**
 * @param {import('../run.mjs').Ctx} ctx
 */
export async function buildTravelSource(ctx) {
  const [alerts, epidemics] = await Promise.all([ctx.travelHttp.getJson('alerts.json'), ctx.travelHttp.getJson('epidemics.json')]);
  const out = buildTravel(alerts, epidemics, ctx.todayIso);
  const vb = {}, news = {};
  for (const c of Object.values(out.data.countries)) for (const x of c.vb) vb[x.d] = (vb[x.d] ?? 0) + 1;
  for (const n of out.data.news) for (const k of n.d) news[k] = (news[k] ?? 0) + 1;
  return {
    files: { 'travel.json': out.json },
    meta: { records: out.records, updated: out.data.updated, countries: Object.keys(out.data.countries).length, vb, news },
  };
}
