// @ts-check
/**
 * Taiwan CDC open data: Dengue_Daily.csv (one row per confirmed case since 1998, updated daily).
 *
 * More complete than the dengue-map backend, which loses blocks of dates while it reloads (and lost them when
 * this site first copied the history: e.g. 1,627 local cases of September 2023).  From 2021 on its coordinates
 * are the same 最小統計區 centre points as the backend's, so the two can be merged point by point; before 2021
 * it has no coordinates.  It also has the report and confirmation dates (not published here; used for the
 * forecast's reporting-delay estimate).
 *
 * od.cdc.gov.tw only answers Taiwanese IPs, so a computer in Taiwan uploads a gzipped copy to a GitHub release
 * (tools/opendata-uploader) and the pipeline reads it from there (OPENDATA_URL), or from a local file
 * (OPENDATA_FILE).  Anything wrong with it (missing, broken, stale) only means it is not used.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import {
  OPENDATA_ALLOWED_HOSTS, OPENDATA_MAX_AGE_DAYS, OPENDATA_MAX_BYTES, OPENDATA_MAX_CONTENT_AGE_DAYS, OPENDATA_MAX_TEXT_BYTES,
  OPENDATA_MIN_ROWS,
} from '../config.mjs';
import { readCappedBytes } from '../http.mjs';
import { daysFromIso, parseYmd } from '../util.mjs';

/**
 * @typedef {object} OdCase
 * @property {string} onset   YYYY/MM/DD (the backend's sickdate format)
 * @property {string|null} judged  YYYY-MM-DD confirmation date
 * @property {string|null} report  YYYY-MM-DD report date
 * @property {0|1} imp
 * @property {string|null} lat  as in the file (null: no coordinates)
 * @property {string|null} lng
 * @property {number} count
 * @property {string} country  country of infection (imported cases)
 */

/**
 * @typedef {object} Opendata
 * @property {OdCase[]} cases
 * @property {string} newestJudged  YYYY-MM-DD: newest confirmation date in the file (its freshness)
 * @property {string} source        URL or file name (for the log)
 * @property {string|null} downloadedAt  when the uploader fetched it from od.cdc.gov.tw (null for a local file)
 */

const REQUIRED = ['發病日', '個案研判日', '通報日', '是否境外移入', '確定病例數', '最小統計區中心點X', '最小統計區中心點Y', '感染國家'];

/** YYYY/MM/DD or empty → YYYY-MM-DD | null */
const isoOf = (/** @type {string} */ s) => {
  const p = parseYmd(s);
  return p ? `${String(p.y).padStart(4, '0')}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}` : null;
};

/**
 * Parse and check the CSV (UTF-8 with BOM, no quoted fields).
 * @param {string} text
 * @param {number} [minRows] fewer rows = broken download
 * @returns {{cases:OdCase[], newestJudged:string, dropped:number}}
 */
export function parseOpendataCsv(text, minRows = OPENDATA_MIN_ROWS) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const header = (lines[0] ?? '').split(',');
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const missing = REQUIRED.filter((h) => !(h in col));
  if (missing.length) throw new Error(`Dengue_Daily.csv: missing column(s) ${missing.join(', ')}`);
  /** @type {OdCase[]} */
  const cases = [];
  let newestJudged = '', dropped = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = lines[i].split(',');
    if (f.length !== header.length) { dropped++; continue; }
    const onset = f[col['發病日']];
    const count = Number(f[col['確定病例數']]);
    const impText = f[col['是否境外移入']];
    if (!parseYmd(onset) || !Number.isInteger(count) || count < 1 || count > 1000 || (impText !== '是' && impText !== '否')) { dropped++; continue; }
    const judged = isoOf(f[col['個案研判日']]);
    if (judged && judged > newestJudged) newestJudged = judged;
    const x = f[col['最小統計區中心點X']], y = f[col['最小統計區中心點Y']];
    cases.push({
      onset,
      judged,
      report: isoOf(f[col['通報日']]),
      imp: impText === '是' ? 1 : 0,
      lng: x || null,
      lat: y || null,
      count,
      country: f[col['感染國家']].trim(),
    });
  }
  if (cases.length < minRows) throw new Error(`Dengue_Daily.csv: only ${cases.length} rows (expected ≥ ${minRows})`);
  if (!newestJudged) throw new Error('Dengue_Daily.csv: no confirmation dates');
  return { cases, newestJudged, dropped };
}

/** gunzip when the bytes start with the gzip magic number */
function plainOf(/** @type {Buffer} */ buf) {
  return buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf, { maxOutputLength: OPENDATA_MAX_TEXT_BYTES }) : buf;
}

/**
 * GET one release file (redirects only to GitHub's own hosts).
 * @param {string} url @param {typeof fetch} fetchImpl @param {number} maxBytes
 * @returns {Promise<Buffer|null>} null = 404
 */
async function getAsset(url, fetchImpl, maxBytes) {
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  const host = new URL(res.url || url).hostname;
  if (!OPENDATA_ALLOWED_HOSTS.includes(host)) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`unexpected host ${host}`);
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return readCappedBytes(res, maxBytes);
}

/**
 * Load the open data from OPENDATA_FILE or OPENDATA_URL.  Returns null (and logs why) when it is not configured,
 * not published yet, broken or stale.  With a URL, the uploader's Dengue_Daily.meta.json next to it says when the
 * file was downloaded (freshness) and its SHA-256 (the CSV must match it: no half-replaced pair).
 * @param {{url?:string|null, file?:string|null, fetchImpl?:typeof fetch, todayIso:string, log:(m:string)=>void, minRows?:number}} p
 * @returns {Promise<Opendata|null>}
 */
export async function loadOpendata(p) {
  if (!p.url && !p.file) return null;
  const source = p.file ?? /** @type {string} */ (p.url);
  try {
    let plain;
    /** @type {string|null} */
    let downloadedAt = null;
    if (p.file) plain = plainOf(await readFile(p.file));
    else {
      const url = /** @type {string} */ (p.url);
      const fetchImpl = p.fetchImpl ?? fetch;
      const metaBuf = await getAsset(new URL('Dengue_Daily.meta.json', url).href, fetchImpl, 64 * 1024);
      if (!metaBuf) {
        p.log(`::notice::open data not published yet (${source}): see tools/opendata-uploader`);
        return null;
      }
      const meta = JSON.parse(metaBuf.toString('utf8'));
      const at = typeof meta?.downloadedAt === 'string' ? Date.parse(meta.downloadedAt) : NaN;
      if (!Number.isFinite(at) || typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256)) throw new Error('Dengue_Daily.meta.json: bad downloadedAt / sha256');
      downloadedAt = new Date(at).toISOString();
      const ageDays = (Date.parse(`${p.todayIso}T23:59:59+08:00`) - at) / 86_400_000;
      if (ageDays > OPENDATA_MAX_AGE_DAYS) {
        p.log(`::warning::open data is stale: last downloaded ${downloadedAt} (${Math.floor(ageDays)} days ago). Is the uploader in Taiwan still running? Not used.`);
        return null;
      }
      const buf = await getAsset(url, fetchImpl, OPENDATA_MAX_BYTES);
      if (!buf) throw new Error('Dengue_Daily.csv.gz missing next to its meta file');
      plain = plainOf(buf);
      const sum = createHash('sha256').update(plain).digest('hex');
      if (sum !== meta.sha256) throw new Error('the CSV does not match the SHA-256 in Dengue_Daily.meta.json (upload in progress?)');
    }
    const od = parseOpendataCsv(plain.toString('utf8'), p.minRows);
    const contentAge = daysFromIso(p.todayIso) - daysFromIso(od.newestJudged);
    if (contentAge > OPENDATA_MAX_CONTENT_AGE_DAYS) {
      p.log(`::warning::open data looks frozen (newest confirmation ${od.newestJudged}, ${contentAge} days old). Not used.`);
      return null;
    }
    p.log(`open data: ${od.cases.length} rows, newest confirmation ${od.newestJudged}${downloadedAt ? `, downloaded ${downloadedAt}` : ''}${od.dropped ? `, ${od.dropped} malformed row(s) skipped` : ''} (${source})`);
    return { cases: od.cases, newestJudged: od.newestJudged, source, downloadedAt };
  } catch (e) {
    p.log(`::warning::open data unusable (${source}): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * The open data's case points of one (year, type) in the backend's record shape (fed to normalizeRecords).
 * @param {Opendata} od @param {number} year @param {0|1} imp
 */
export function opendataLocationRecords(od, year, imp) {
  const prefix = `${year}/`;
  return od.cases
    .filter((c) => c.imp === imp && c.lat !== null && c.lng !== null && c.onset.startsWith(prefix))
    .map((c) => ({ sickdate: c.onset, lat: c.lat, lng: c.lng, count: c.count }));
}

/**
 * Imported cases from `fromYear` on, in GetImportedData's record shape (country code / coordinates are filled in
 * by the imported source from the backend's own country list).
 * @param {Opendata} od @param {number} fromYear
 */
export function opendataImportedRecords(od, fromYear) {
  return od.cases
    .filter((c) => c.imp === 1 && Number(c.onset.slice(0, 4)) >= fromYear && c.country)
    .map((c) => ({ sickdate: c.onset, country_name: c.country, count: c.count }));
}
