// @ts-check
/**
 * 防疫公告 (health-bureau dengue notices): validation of the hand-maintained content/alerts/*.json files and
 * the build of public/data/alerts.json (village polygons and names from the MOI village boundaries in
 * taiwan-atlas). Shared by the build (npm run build → prebuild), the issue-form workflow and the tests.
 * See docs/alerts.md.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);

/** Hosts a notice may cite as its source: government sites, official social pages, major news outlets. */
const SOURCE_HOSTS = ['www.facebook.com', 'facebook.com', 'www.mnews.tw', 'www.cna.com.tw', 'news.pts.org.tw', 'udn.com', 'news.ltn.com.tw'];
export const isSourceUrl = (/** @type {unknown} */ u) => {
  if (typeof u !== 'string' || u.length > 300) return false;
  let url;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return url.hostname.endsWith('.gov.tw') || SOURCE_HOSTS.includes(url.hostname);
};

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isDate(/** @type {unknown} */ s) {
  if (typeof s !== 'string') return false;
  const m = ISO.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === s;
}
const dayNum = (/** @type {string} */ s) => Date.parse(`${s}T00:00:00Z`) / 86_400_000;
const HOURS = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
/** Plain text: no markup characters, no control characters. */
const isText = (/** @type {unknown} */ s, /** @type {number} */ min, /** @type {number} */ max) =>
  typeof s === 'string' && s.trim() === s && s.length >= min && s.length <= max && !/[<>\u0000-\u001f\u007f]/.test(s);

let villagesP = /** @type {Promise<Map<string, any>>|null} */ (null);
/** Village features by code (MOI 2021 boundaries, 10% simplified). */
export function loadVillages() {
  villagesP ??= readFile(require.resolve('taiwan-atlas/villages-10t.json'), 'utf8').then((text) => {
    const topo = JSON.parse(text);
    const fc = /** @type {any} */ (feature(topo, topo.objects.villages));
    return new Map(fc.features.map((/** @type {any} */ f) => [String(f.properties.VILLCODE), f]));
  });
  return villagesP;
}

/** [minLng, minLat, maxLng, maxLat] of a geometry. @param {any} g */
function bboxOf(g) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (/** @type {any} */ c) => {
    if (typeof c[0] === 'number') {
      b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]);
    } else for (const x of c) walk(x);
  };
  walk(g.coordinates);
  return b;
}

const KEYS = ['id', 'title', 'titleEn', 'county', 'town', 'issuedAt', 'validUntil', 'issuer', 'sourceUrl', 'villages', 'exposureSites', 'screeningStations', 'note', 'noteEn'];
const SITE_KEYS = ['name', 'address', 'from', 'to', 'note', 'lng', 'lat'];
const STATION_KEYS = ['name', 'address', 'dates', 'hours', 'lng', 'lat'];

/**
 * Validate one content file. Returns a list of problems (empty = valid), in Chinese for the editors.
 * @param {any} a @param {Map<string, any>} villages @param {string} [fileId] id expected from the file name
 */
export function validateAlert(a, villages, fileId) {
  /** @type {string[]} */
  const errs = [];
  const err = (/** @type {string} */ m) => errs.push(m);
  if (!a || typeof a !== 'object' || Array.isArray(a)) return ['不是 JSON 物件'];
  for (const k of Object.keys(a)) if (!KEYS.includes(k)) err(`不認得的欄位：${k}`);
  if (typeof a.id !== 'string' || !/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/.test(a.id) || a.id.length > 80) err('id 格式應為 YYYY-MM-DD-英文小寫與連字號');
  if (fileId && a.id !== fileId) err(`id（${a.id}）與檔名（${fileId}）不同`);
  if (!isText(a.title, 2, 60)) err('標題需 2–60 字，不可含 < > 或控制字元');
  if (a.titleEn !== undefined && !isText(a.titleEn, 2, 120)) err('英文標題需 2–120 字');
  if (!isText(a.issuer, 2, 40)) err('發布單位需 2–40 字');
  if (!isSourceUrl(a.sourceUrl)) err('來源網址需為 https，且限政府網站（*.gov.tw）、官方臉書或主要新聞網站');
  if (a.note !== undefined && !isText(a.note, 0, 400)) err('說明最多 400 字');
  if (a.noteEn !== undefined && !isText(a.noteEn, 0, 600)) err('英文說明最多 600 字');
  if (!isDate(a.issuedAt)) err('發布日期需為 YYYY-MM-DD');
  if (!isDate(a.validUntil)) err('有效期限需為 YYYY-MM-DD');
  if (isDate(a.issuedAt) && isDate(a.validUntil)) {
    const span = dayNum(a.validUntil) - dayNum(a.issuedAt);
    if (span < 0 || span > 60) err('有效期限需在發布日期之後 60 天內');
  }
  if (typeof a.county !== 'string' || !/^\d{5}$/.test(a.county)) err('縣市代碼需為 5 位數字');
  if (typeof a.town !== 'string' || !/^\d{8}$/.test(a.town) || !a.town.startsWith(String(a.county))) err('鄉鎮市區代碼需為 8 位數字，且屬於該縣市');
  /** @type {number[]|null} */
  let box = null;
  if (!Array.isArray(a.villages) || !a.villages.length || a.villages.length > 60) err('警戒範圍需列 1–60 個村里');
  else {
    const seen = new Set();
    for (const code of a.villages) {
      const f = typeof code === 'string' ? villages.get(code) : undefined;
      if (!f) { err(`找不到村里代碼：${code}`); continue; }
      if (String(f.properties.COUNTYCODE) !== a.county) err(`村里 ${code}（${f.properties.VILLNAME}）不在該縣市`);
      if (seen.has(code)) err(`村里重複：${code}`);
      seen.add(code);
      const b = bboxOf(f.geometry);
      box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
    }
  }
  // Places must be in or near the warning area (≈ 0.1° margin: stations can be just outside it).
  const place = (/** @type {any} */ p, /** @type {string} */ what) => {
    if (!isText(p.name, 1, 40)) err(`${what}名稱需 1–40 字`);
    if (!isText(p.address, 0, 80)) err(`${what}地址最多 80 字`);
    const hasLng = p.lng !== null && p.lng !== undefined, hasLat = p.lat !== null && p.lat !== undefined;
    if (hasLng !== hasLat) err(`${what}座標需同時填經緯度`);
    else if (hasLng) {
      if (typeof p.lng !== 'number' || typeof p.lat !== 'number' || !Number.isFinite(p.lng) || !Number.isFinite(p.lat)) err(`${what}座標需為數字`);
      else if (box && (p.lng < box[0] - 0.1 || p.lng > box[2] + 0.1 || p.lat < box[1] - 0.1 || p.lat > box[3] + 0.1)) err(`${what}座標離警戒範圍太遠（經緯度是否填反？）`);
    }
  };
  if (!Array.isArray(a.exposureSites) || a.exposureSites.length > 10) err('曾至地點最多 10 處（沒有請填空陣列）');
  else for (const s of a.exposureSites) {
    if (!s || typeof s !== 'object') { err('曾至地點格式錯誤'); continue; }
    for (const k of Object.keys(s)) if (!SITE_KEYS.includes(k)) err(`曾至地點不認得的欄位：${k}`);
    place(s, '曾至地點');
    if (!isDate(s.from) || !isDate(s.to) || dayNum(s.to) < dayNum(s.from)) err('曾至地點的期間需為 YYYY-MM-DD，且結束不早於開始');
    if (s.note !== undefined && !isText(s.note, 0, 120)) err('曾至地點說明最多 120 字');
  }
  if (!Array.isArray(a.screeningStations) || a.screeningStations.length > 20) err('採檢站最多 20 處（沒有請填空陣列）');
  else for (const s of a.screeningStations) {
    if (!s || typeof s !== 'object') { err('採檢站格式錯誤'); continue; }
    for (const k of Object.keys(s)) if (!STATION_KEYS.includes(k)) err(`採檢站不認得的欄位：${k}`);
    place(s, '採檢站');
    if (!Array.isArray(s.dates) || !s.dates.length || s.dates.length > 14 || !s.dates.every(isDate)) err('採檢站日期需為 1–14 個 YYYY-MM-DD');
    if (!Array.isArray(s.hours) || !s.hours.length || s.hours.length > 4 || !s.hours.every((/** @type {unknown} */ x) => {
      const m = typeof x === 'string' ? HOURS.exec(x) : null;
      return !!m && +m[1] * 60 + +m[2] < +m[3] * 60 + +m[4];
    })) err('採檢站時段需為 1–4 個 HH:MM-HH:MM');
  }
  return errs;
}

const round5 = (/** @type {number} */ v) => Math.round(v * 1e5) / 1e5;
/** @param {any} g */
const roundGeom = (g) => ({ type: g.type, coordinates: JSON.parse(JSON.stringify(g.coordinates), (_k, v) => (typeof v === 'number' ? round5(v) : v)) });

/**
 * The published form of a valid notice: village names (zh/en) and polygons resolved from the codes.
 * @param {any} a @param {Map<string, any>} villages
 */
export function publishAlert(a, villages) {
  const vs = a.villages.map((/** @type {string} */ code) => villages.get(code));
  const town = vs[0]?.properties;
  return {
    id: a.id, title: a.title, titleEn: a.titleEn ?? '', county: a.county, town: a.town,
    countyZh: String(town?.COUNTYNAME ?? ''), countyEn: String(town?.COUNTYENG ?? ''),
    townZh: String(vs.find((/** @type {any} */ f) => String(f.properties.TOWNCODE) === a.town)?.properties.TOWNNAME ?? town?.TOWNNAME ?? ''),
    townEn: String(vs.find((/** @type {any} */ f) => String(f.properties.TOWNCODE) === a.town)?.properties.TOWNENG ?? town?.TOWNENG ?? ''),
    issuedAt: a.issuedAt, validUntil: a.validUntil, issuer: a.issuer, sourceUrl: a.sourceUrl, note: a.note ?? '', noteEn: a.noteEn ?? '',
    villages: vs.map((/** @type {any} */ f) => ({ code: String(f.properties.VILLCODE), zh: String(f.properties.VILLNAME), en: String(f.properties.VILLENG ?? ''), town: String(f.properties.TOWNNAME) })),
    exposureSites: a.exposureSites.map((/** @type {any} */ s) => ({ name: s.name, address: s.address ?? '', from: s.from, to: s.to, note: s.note ?? '', lng: s.lng ?? null, lat: s.lat ?? null })),
    screeningStations: a.screeningStations.map((/** @type {any} */ s) => ({ name: s.name, address: s.address ?? '', dates: [...s.dates].sort(), hours: s.hours, lng: s.lng ?? null, lat: s.lat ?? null })),
    area: { type: 'FeatureCollection', features: vs.map((/** @type {any} */ f) => ({ type: 'Feature', properties: { code: String(f.properties.VILLCODE) }, geometry: roundGeom(f.geometry) })) },
  };
}
