// @ts-check
/**
 * Weather for the internal forecast page (weather.json): weekly mean temperature and rainfall per county
 * station, 2001 → now.
 *
 *  - Live: CWA open data (key in env CWA_KEY, sent in the Authorization header, never logged).
 *      C-B0074-001  staffed-station list (coordinates, status)
 *      C-B0024-001  hourly observations, rolling ~31 days (with Date=…) → daily mean temperature / rainfall
 *      C-B0027-001  1991–2020 monthly normals (temperature mean, rainfall accumulation)
 *  - History: CWA keeps no multi-year daily archive in the API, so 2001 → last year comes from NASA POWER
 *    (daily T2M / PRECTOTCORR, MERRA-2 based, public), bias-corrected to each station with the monthly normals:
 *    T + (CWA normal − POWER normal), rain × (CWA normal / POWER normal). Fetched on the first run and when
 *    DATA_WEATHER_HISTORY=1; afterwards weeks are filled from CWA as they complete.
 *
 * Weeks are Monday-based blocks from 2001-01-01 (a Monday). Values: t = °C × 10, r = mm, s = source per week
 * ('c' CWA, 'p' POWER bias-corrected, '-' missing).
 */
import { daysFromIso, isoFromDays, parseYmd, roundTo, toJson } from '../util.mjs';

export const WEEK0 = '2001-01-01';
const CWA_BASE = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/';
const POWER_BASE = 'https://power.larc.nasa.gov/api/temporal/daily/point';
const MAX_BYTES = 8 * 1024 * 1024;
const DAILY_KEEP = 60;

/** County → CWA staffed station (counties without one use the nearest comparable lowland station). */
export const COUNTY_STATION = /** @type {const} */ ({
  '67000': '467410', // 臺南
  '64000': '467440', // 高雄
  '10013': '467440', // 屏東 → 高雄
  '10010': '467480', // 嘉義縣 → 嘉義
  '10020': '467480', // 嘉義市
  '10009': '467480', // 雲林 → 嘉義
  '66000': '467490', // 臺中
  '10007': '467490', // 彰化 → 臺中
  '10008': '467490', // 南投 → 臺中
  '10005': '467490', // 苗栗 → 臺中
  '63000': '466920', // 臺北
  '65000': '466880', // 新北 → 板橋
  '68000': '467050', // 桃園 → 新屋
  '10004': '467571', // 新竹縣 → 新竹
  '10018': '467571', // 新竹市
  '10017': '466940', // 基隆
  '10002': '467080', // 宜蘭
  '10015': '466990', // 花蓮
  '10014': '467660', // 臺東
  '10016': '467350', // 澎湖
  '09020': '467110', // 金門
  '09007': '467990', // 馬祖
});

/** @param {unknown} v */
function num(v) {
  if (v === 'T') return 0; // trace rainfall
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n > -90 ? n : null; // CWA uses -99.x / 'X' for missing
}

/**
 * @param {typeof fetch} fetchImpl @param {string} url @param {Record<string,string>} headers
 * @param {(m:string)=>void} log @param {string} tag
 */
async function getJson(fetchImpl, url, headers, log, tag, attempts = 3, backoffMs = 3000) {
  let last = /** @type {unknown} */ (null);
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json', ...headers }, redirect: 'error', signal: AbortSignal.timeout(60_000) });
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error(`${tag}: response too large`);
      if (!res.ok) throw new Error(`${tag}: HTTP ${res.status}`);
      return JSON.parse(text);
    } catch (e) {
      last = e;
      log(`[weather] ${tag} attempt ${i + 1} failed: ${e instanceof Error ? e.message : String(e)}`);
      if (i < attempts - 1 && backoffMs) await new Promise((r) => setTimeout(r, backoffMs * 2 ** i));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Monday-block index of an ISO date. @param {string} iso */
export const weekIndex = (iso) => Math.floor((daysFromIso(iso) - daysFromIso(WEEK0)) / 7);

/**
 * Daily mean temperature / rain sum from CWA hourly observations (Taiwan time; an observation stamped hh:00 covers
 * the hour before it). Days with fewer than 20 valid hours are dropped.
 * @param {any[]} obs
 */
export function dailyFromHourly(obs) {
  /** @type {Map<string, {t:number[], r:number[]}>} */
  const days = new Map();
  for (const o of obs) {
    const dt = typeof o?.DateTime === 'string' ? o.DateTime : null;
    const m = dt ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):/.exec(dt) : null;
    if (!m) continue;
    let day = m[1];
    if (m[2] === '00') day = isoFromDays(daysFromIso(day) - 1);
    const e = days.get(day) ?? { t: [], r: [] };
    days.set(day, e);
    const t = num(o.weatherElements?.AirTemperature), r = num(o.weatherElements?.Precipitation);
    if (t !== null && t > -20 && t < 45) e.t.push(t);
    if (r !== null && r >= 0 && r < 300) e.r.push(r);
  }
  /** @type {Map<string, {t:number|null, r:number|null}>} */
  const out = new Map();
  for (const [d, e] of days) {
    out.set(d, {
      t: e.t.length >= 20 ? roundTo(e.t.reduce((a, b) => a + b, 0) / e.t.length, 2) : null,
      r: e.r.length >= 20 ? roundTo(e.r.reduce((a, b) => a + b, 0), 1) : null,
    });
  }
  return out;
}

/**
 * Bias-corrected weekly series from POWER daily values.
 * @param {Record<string, number>} T2M @param {Record<string, number>} PREC  keys YYYYMMDD, fill -999
 * @param {{t:number[], r:number[]}} normals  CWA monthly normals (12 each)
 * @param {number} weeks number of weeks to produce
 */
export function powerWeeks(T2M, PREC, normals, weeks) {
  /** @type {Map<string, {t:number|null, r:number|null}>} */
  const daily = new Map();
  for (const [k, v] of Object.entries(T2M)) {
    if (!/^\d{8}$/.test(k)) continue;
    const iso = `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`;
    const p = PREC[k];
    daily.set(iso, { t: Number.isFinite(v) && v > -90 ? v : null, r: Number.isFinite(p) && p >= 0 ? p : null });
  }
  // POWER monthly normals over 2002–2020 (inside the CWA 1991–2020 normal period).
  const tSum = new Array(12).fill(0), tN = new Array(12).fill(0), rSum = new Array(12).fill(0), rN = new Array(12).fill(0);
  for (const [iso, d] of daily) {
    const y = +iso.slice(0, 4), m = +iso.slice(5, 7) - 1;
    if (y < 2002 || y > 2020) continue;
    if (d.t !== null) { tSum[m] += d.t; tN[m]++; }
    if (d.r !== null) { rSum[m] += d.r; rN[m]++; }
  }
  const dim = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const dT = tSum.map((s, m) => (tN[m] ? normals.t[m] - s / tN[m] : 0));
  const rk = rSum.map((s, m) => {
    const powerMonthly = rN[m] ? (s / rN[m]) * dim[m] : 0;
    return powerMonthly > 1 ? Math.min(3, Math.max(0.33, normals.r[m] / powerMonthly)) : 1;
  });
  const t = /** @type {(number|null)[]} */ (new Array(weeks).fill(null)), r = /** @type {(number|null)[]} */ (new Array(weeks).fill(null));
  const w0 = daysFromIso(WEEK0);
  for (let w = 0; w < weeks; w++) {
    let ts = 0, tn = 0, rs = 0, rn = 0;
    for (let k = 0; k < 7; k++) {
      const iso = isoFromDays(w0 + 7 * w + k);
      const d = daily.get(iso);
      if (!d) continue;
      const m = +iso.slice(5, 7) - 1;
      if (d.t !== null) { ts += d.t + dT[m]; tn++; }
      if (d.r !== null) { rs += d.r * rk[m]; rn++; }
    }
    if (tn >= 5) t[w] = Math.round((ts / tn) * 10);
    if (rn >= 5) r[w] = Math.round((rs * 7) / rn);
  }
  return { t, r };
}

/**
 * @param {{todayIso:string, log:(m:string)=>void}} ctx
 * @param {{key:string|undefined, committed:any, history:boolean, fetchImpl?:typeof fetch, backoffMs?:number}} opts
 */
export async function buildWeatherSource(ctx, opts) {
  const { log, todayIso } = ctx;
  const key = opts.key ?? '';
  if (!key) throw new Error('CWA key not configured (env CWA_KEY)');
  const committedFile = opts.committed && typeof opts.committed === 'object' ? opts.committed : null;
  // Daily data: one refresh per Taiwan day is enough (the pipeline runs every 3 hours).
  if (!opts.history && committedFile?.updated === todayIso) {
    return { files: { 'weather.json': toJson(committedFile) }, meta: { records: Object.keys(committedFile.series ?? {}).length, skipped: 'updated today' } };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const backoff = opts.backoffMs ?? 3000;
  const auth = { Authorization: key };
  const cwa = (/** @type {string} */ path, /** @type {string} */ tag) => getJson(fetchImpl, CWA_BASE + path, auth, log, tag, 3, backoff);
  const yesterday = isoFromDays(daysFromIso(todayIso) - 1);
  const ids = [...new Set(Object.values(COUNTY_STATION))].sort();

  // ---- station list
  const list = await cwa('C-B0074-001', 'C-B0074-001');
  /** @type {Map<string, any>} */
  const meta = new Map();
  for (const s of list?.records?.data?.stationStatus?.station ?? []) {
    if (ids.includes(s?.StationID) && s?.status === '現存測站') meta.set(s.StationID, s);
  }
  const committed = committedFile;
  const weeksNow = weekIndex(todayIso) + 1;
  const stations = [];
  /** @type {Record<string, any>} */
  const series = {};
  const missing = [];
  let historyFetched = 0, cwaWeeks = 0;
  for (const id of ids) {
    const s = meta.get(id);
    const prev = committed?.series?.[id] ?? null;
    const lat = Number(s?.StationLatitude ?? prev?.lat), lng = Number(s?.StationLongitude ?? prev?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      missing.push(id);
      continue;
    }
    // ---- normals (kept from the committed file when the request fails)
    /** @type {{t:number[], r:number[]}|null} */
    let normals = prev?.normals ?? null;
    try {
      const n = await cwa(`C-B0027-001?StationID=${id}`, `C-B0027-001 ${id}`);
      const st = n?.records?.data?.surfaceObs?.location?.[0]?.stationObsStatistics;
      const t = (st?.AirTemperature?.monthly ?? []).map((/** @type {any} */ m) => num(m?.Mean));
      const r = (st?.Precipitation?.monthly ?? []).map((/** @type {any} */ m) => num(m?.Accumulation));
      if (t.length === 12 && r.length === 12 && t.every((/** @type {any} */ v) => v !== null) && r.every((/** @type {any} */ v) => v !== null)) {
        normals = { t: /** @type {number[]} */ (t), r: /** @type {number[]} */ (r) };
      }
    } catch { /* keep previous */ }
    if (!normals) {
      missing.push(id);
      continue;
    }
    // ---- weekly arrays: committed (or POWER history), extended to the current week
    let t = /** @type {(number|null)[]} */ ([...(prev?.t ?? [])]), r = /** @type {(number|null)[]} */ ([...(prev?.r ?? [])]);
    let src = String(prev?.s ?? '');
    if (opts.history || !t.length) {
      try {
        const end = `${parseYmd(yesterday)?.y}${yesterday.slice(5, 7)}${yesterday.slice(8, 10)}`;
        const url = `${POWER_BASE}?parameters=T2M,PRECTOTCORR&community=AG&longitude=${lng.toFixed(4)}&latitude=${lat.toFixed(4)}&start=20010101&end=${end}&format=JSON`;
        const p = await getJson(fetchImpl, url, {}, log, `POWER ${id}`, 3, backoff);
        const par = p?.properties?.parameter;
        if (!par?.T2M || !par?.PRECTOTCORR) throw new Error('POWER: no T2M/PRECTOTCORR');
        const hw = powerWeeks(par.T2M, par.PRECTOTCORR, normals, weeksNow);
        // keep CWA weeks already recorded; history fills the rest
        const keepC = (/** @type {number} */ w) => src[w] === 'c';
        t = hw.t.map((v, w) => (keepC(w) ? t[w] ?? v : v));
        r = hw.r.map((v, w) => (keepC(w) ? r[w] ?? v : v));
        src = hw.t.map((v, w) => (keepC(w) ? 'c' : v === null ? '-' : 'p')).join('');
        historyFetched++;
      } catch (e) {
        log(`[weather] POWER history for ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    while (t.length < weeksNow) t.push(null);
    while (r.length < weeksNow) r.push(null);
    src = src.padEnd(weeksNow, '-').slice(0, weeksNow);
    t = t.slice(0, weeksNow);
    r = r.slice(0, weeksNow);
    // ---- live CWA daily (rolling ~31 days), merged into the kept daily window, then complete weeks
    /** @type {Map<string, {t:number|null, r:number|null}>} */
    const daily = new Map();
    const pd = prev?.daily;
    if (pd && typeof pd.start === 'string') {
      const d0 = daysFromIso(pd.start);
      (pd.t ?? []).forEach((/** @type {any} */ v, /** @type {number} */ i) => daily.set(isoFromDays(d0 + i), { t: v === null ? null : v / 10, r: pd.r?.[i] ?? null }));
    }
    try {
      const h = await cwa(`C-B0024-001?StationID=${id}&Date=${yesterday}`, `C-B0024-001 ${id}`);
      const obs = h?.records?.location?.[0]?.stationObsTimes?.stationObsTime ?? [];
      for (const [d, v] of dailyFromHourly(obs)) if (d <= yesterday) daily.set(d, v);
    } catch { /* keep the daily window as is */ }
    const dStart = daysFromIso(yesterday) - DAILY_KEEP + 1;
    const dailyT = [], dailyR = [];
    for (let d = dStart; d <= daysFromIso(yesterday); d++) {
      const v = daily.get(isoFromDays(d));
      dailyT.push(v?.t == null ? null : Math.round(v.t * 10));
      dailyR.push(v?.r == null ? null : roundTo(v.r, 1));
    }
    const w0 = daysFromIso(WEEK0);
    for (let w = Math.max(0, Math.floor((dStart - w0) / 7)); w < weeksNow; w++) {
      let ts = 0, rs = 0, ok = true;
      for (let k = 0; k < 7; k++) {
        const v = daily.get(isoFromDays(w0 + 7 * w + k));
        if (!v || v.t === null || v.r === null) { ok = false; break; }
        ts += v.t;
        rs += v.r;
      }
      if (!ok) continue;
      t[w] = Math.round((ts / 7) * 10);
      r[w] = Math.round(rs);
      src = `${src.slice(0, w)}c${src.slice(w + 1)}`;
      cwaWeeks++;
    }
    series[id] = {
      name: String(s?.StationName ?? prev?.name ?? id), lat: roundTo(lat, 4), lng: roundTo(lng, 4),
      normals: { t: normals.t.map((v) => roundTo(v, 1)), r: normals.r.map((v) => roundTo(v, 1)) },
      t, r, s: src,
      daily: { start: isoFromDays(dStart), t: dailyT, r: dailyR },
    };
    stations.push(id);
  }
  if (!stations.length) throw new Error('no weather station could be built');
  if (missing.length) log(`[weather] stations skipped: ${missing.join(', ')}`);
  const county = Object.fromEntries(Object.entries(COUNTY_STATION).filter(([, id]) => series[id]));
  const out = { updated: todayIso, week0: WEEK0, weeks: weeksNow, county, series };
  return {
    files: { 'weather.json': toJson(out) },
    meta: { records: stations.length, stations: stations.length, historyFetched, cwaWeeks, missing },
  };
}
