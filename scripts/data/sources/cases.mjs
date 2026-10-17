// @ts-check
/**
 * Case points (GetDengueLocation), fetched per calendar year and per
 * local/imported flag, aggregated into cases/{year}.json + trend.json +
 * summary.json.
 */
import { BBOX, CONCURRENCY, FIRST_YEAR } from '../config.mjs';
import {
  cmp, dayOfYear, daysFromIso, daysFromYmd, mapLimit, parseYmd, round5, sameDayLastYear, toJson, ymd,
} from '../util.mjs';

/**
 * @typedef {{county:string, countyZh:string, countyEn:string, zh:string, en:string}} TownName
 */

/**
 * Town-name lookup from the admin geography (MOI names, 臺 form; English from taiwan-atlas).
 * @param {{towns: Array<{code:string, county:string, zh:string, en:string}>, counties: Array<{code:string, zh:string, en:string}>}} geo
 * @returns {(code:string)=>TownName|null}
 */
export function townNameLookup(geo) {
  const counties = new Map(geo.counties.map((c) => [c.code, c]));
  const towns = new Map(geo.towns.map((t) => [t.code, t]));
  return (code) => {
    const t = towns.get(code);
    const c = t && counties.get(t.county);
    return t && c ? { county: c.code, countyZh: c.zh, countyEn: c.en, zh: t.zh, en: t.en } : null;
  };
}

/**
 * @typedef {object} CaseRow
 * @property {string} date  YYYY-MM-DD
 * @property {number} doy   1-366
 * @property {number} lng   rounded to 5 dp
 * @property {number} lat
 * @property {0|1} imp      1 = imported
 * @property {number} count
 */

/**
 * @typedef {object} DropStats
 * @property {number} shape @property {number} date @property {number} year @property {number} future
 * @property {number} coord @property {number} bbox @property {number} count
 */

const emptyDrops = () => ({ shape: 0, date: 0, year: 0, future: 0, coord: 0, bbox: 0, count: 0 });

/**
 * Whitelist + type-check one year's raw records.
 * @param {unknown} raw  parsed `d` payload
 * @param {{year:number, imp:0|1, todayIso:string}} opts
 * @returns {{rows:CaseRow[], drops:DropStats, input:number}}
 */
export function normalizeRecords(raw, opts) {
  const drops = emptyDrops();
  /** @type {CaseRow[]} */
  const rows = [];
  if (raw === null || raw === undefined) return { rows, drops, input: 0 };
  if (!Array.isArray(raw)) throw new Error('GetDengueLocation: expected an array');
  const todayDays = daysFromIso(opts.todayIso);
  for (const r of raw) {
    if (!r || typeof r !== 'object') { drops.shape++; continue; }
    const p = parseYmd(/** @type {any} */ (r).sickdate);
    if (!p) { drops.date++; continue; }
    if (p.y !== opts.year) { drops.year++; continue; }
    if (daysFromYmd(p.y, p.m, p.d) > todayDays) { drops.future++; continue; }
    const lat = Number(/** @type {any} */ (r).lat);
    const lng = Number(/** @type {any} */ (r).lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || /** @type {any} */ (r).lat === '' || /** @type {any} */ (r).lng === '') { drops.coord++; continue; }
    if (lng < BBOX.minLng || lng > BBOX.maxLng || lat < BBOX.minLat || lat > BBOX.maxLat) { drops.bbox++; continue; }
    const c = /** @type {any} */ (r).count === undefined ? 1 : Number(/** @type {any} */ (r).count);
    if (!Number.isInteger(c) || c < 1 || c > 100000) { drops.count++; continue; }
    rows.push({
      date: ymd(p.y, p.m, p.d),
      doy: dayOfYear(p.y, p.m, p.d),
      lng: round5(lng),
      lat: round5(lat),
      imp: opts.imp,
      count: c,
    });
  }
  return { rows, drops, input: raw.length };
}

/**
 * @param {CaseRow[]} rows rows of a single year
 * @param {number} year
 * @param {(lng:number, lat:number)=>string|null} locateTown
 */
export function buildYearFile(rows, year, locateTown) {
  /** @type {Map<string, {lng:number,lat:number}>} */
  const pts = new Map();
  /** @type {Map<string, {doy:number, pk:string, imp:number, count:number}>} */
  const agg = new Map();
  for (const r of rows) {
    const pk = `${r.lng},${r.lat}`;
    if (!pts.has(pk)) pts.set(pk, { lng: r.lng, lat: r.lat });
    const k = `${r.doy}|${r.imp}|${pk}`;
    const a = agg.get(k);
    if (a) a.count += r.count; else agg.set(k, { doy: r.doy, pk, imp: r.imp, count: r.count });
  }
  const ptList = [...pts.entries()].sort((a, b) => a[1].lng - b[1].lng || a[1].lat - b[1].lat);
  /** @type {Map<string, number>} */
  const idx = new Map(ptList.map(([pk], i) => [pk, i]));
  const c = [...agg.values()]
    .map((a) => /** @type {[number, number, number, number]} */ ([a.doy, /** @type {number} */ (idx.get(a.pk)), a.imp, a.count]))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  let nullTown = 0;
  const outPts = ptList.map(([, p]) => {
    const t = locateTown(p.lng, p.lat);
    if (t === null) nullTown++;
    return [p.lng, p.lat, t];
  });
  return { file: { year, pts: outPts, c }, nullTown, uniquePts: outPts.length };
}

/**
 * Sum counts of a parsed cases/{year}.json by type.
 * @param {any} file
 */
export function yearTotals(file) {
  let local = 0, imported = 0;
  if (file && Array.isArray(file.c)) {
    for (const row of file.c) {
      if (row[2] === 1) imported += row[3]; else local += row[3];
    }
  }
  return { local, imported };
}

/**
 * Derive trend.json and summary.json from all aggregated rows.
 * @param {Map<number, CaseRow[]>} rowsByYear
 * @param {(lng:number, lat:number)=>string|null} locateTown
 * @param {string} todayIso
 * @param {(code:string)=>TownName|null} [townName] names for summary.townNames (optional)
 */
export function buildTrendAndSummary(rowsByYear, locateTown, todayIso, townName) {
  const startIso = `${FIRST_YEAR}-01-01`;
  const startDays = daysFromIso(startIso);
  const todayDays = daysFromIso(todayIso);
  const n = todayDays - startDays + 1;
  const nat = { local: new Array(n).fill(0), imported: new Array(n).fill(0) };
  /** @type {Map<string, {local:Map<number,number>, imported:Map<number,number>}>} */
  const county = new Map();

  const today = /** @type {{y:number,m:number,d:number}} */ (parseYmd(todayIso));
  const year = today.y;
  const yStart = daysFromYmd(year, 1, 1);
  const pyStart = daysFromYmd(year - 1, 1, 1);
  const pyEnd = daysFromIso(sameDayLastYear(todayIso));

  const zero = () => ({ local: 0, imported: 0 });
  const ytd = zero(), prevYtd = zero();
  const last = { 7: zero(), 14: zero(), 30: zero() };
  /** @type {Map<string, {local:number, imported:number}>} */
  const byCounty = new Map();
  /** @type {Map<string, {local:number, imported:number}>} */
  const towns14 = new Map();
  let latestOnset = '';

  for (const rows of rowsByYear.values()) {
    for (const r of rows) {
      const key = r.imp ? 'imported' : 'local';
      const di = daysFromIso(r.date);
      const dayIndex = di - startDays;
      if (dayIndex < 0 || dayIndex >= n) continue;
      nat[key][dayIndex] += r.count;
      if (r.date > latestOnset) latestOnset = r.date;
      const town = locateTown(r.lng, r.lat);
      const cc = town ? town.slice(0, 5) : null;
      if (cc) {
        let e = county.get(cc);
        if (!e) { e = { local: new Map(), imported: new Map() }; county.set(cc, e); }
        e[key].set(dayIndex, (e[key].get(dayIndex) ?? 0) + r.count);
      }
      if (di >= yStart && di <= todayDays) {
        ytd[key] += r.count;
        if (cc) {
          const b = byCounty.get(cc) ?? zero();
          b[key] += r.count;
          byCounty.set(cc, b);
        }
      }
      if (di >= pyStart && di <= pyEnd) prevYtd[key] += r.count;
      for (const w of /** @type {const} */ ([7, 14, 30])) if (di > todayDays - w && di <= todayDays) last[w][key] += r.count;
      if (town && di > todayDays - 14 && di <= todayDays) {
        const t = towns14.get(town) ?? zero();
        t[key] += r.count;
        towns14.set(town, t);
      }
    }
  }

  const countyOut = Object.fromEntries(
    [...county.keys()].sort(cmp).map((cc) => {
      const e = /** @type {NonNullable<ReturnType<typeof county.get>>} */ (county.get(cc));
      const sparse = (/** @type {Map<number,number>} */ m) => [...m.entries()].sort((a, b) => a[0] - b[0]).map(([d, v]) => [d, v]);
      return [cc, { local: sparse(e.local), imported: sparse(e.imported) }];
    }),
  );
  const trend = { start: startIso, end: todayIso, national: nat, county: countyOut };

  const topTowns14 = [...towns14.entries()]
    .sort((a, b) => b[1].local - a[1].local || b[1].imported - a[1].imported || cmp(a[0], b[0]))
    .slice(0, 20)
    .map(([code, v]) => [code, v.local, v.imported]);
  // Names for the towns listed above, so consumers (e.g. the new CDC site's card) need no code list.
  /** @type {Record<string, TownName>} */
  const townNames = {};
  if (townName) {
    for (const [code] of topTowns14) {
      const nm = townName(/** @type {string} */ (code));
      if (nm) townNames[/** @type {string} */ (code)] = nm;
    }
  }
  const summary = {
    asOf: todayIso,
    latestOnset,
    year,
    ytd,
    last7: last[7],
    last14: last[14],
    last30: last[30],
    prevYtd,
    byCounty: Object.fromEntries([...byCounty.keys()].sort(cmp).map((k) => [k, byCounty.get(k)])),
    topTowns14,
    townNames,
  };
  return { trend, summary, latestOnset };
}

/**
 * Pure assembly of all outputs of the cases source.
 * @param {Map<number, CaseRow[]>} rowsByYear
 * @param {(lng:number, lat:number)=>string|null} locateTown
 * @param {string} todayIso
 */
export function buildCasesOutputs(rowsByYear, locateTown, todayIso, townName) {
  /** @type {Record<string,string>} */
  const files = {};
  /** @type {Record<number, {local:number, imported:number}>} */
  const totals = {};
  let nullTown = 0, uniquePts = 0, records = 0;
  const years = [...rowsByYear.keys()].sort((a, b) => a - b);
  for (const y of years) {
    const { file, nullTown: nt, uniquePts: up } = buildYearFile(/** @type {CaseRow[]} */ (rowsByYear.get(y)), y, locateTown);
    files[`cases/${y}.json`] = toJson(file);
    totals[y] = yearTotals(file);
    records += totals[y].local + totals[y].imported;
    nullTown += nt;
    uniquePts += up;
  }
  const { trend, summary, latestOnset } = buildTrendAndSummary(rowsByYear, locateTown, todayIso, townName);
  files['trend.json'] = toJson(trend);
  files['summary.json'] = toJson(summary);
  return { files, totals, nullTown, uniquePts, records, latestOnset, years };
}

/**
 * Fetch every year x flag and build the outputs.
 * @param {import('../run.mjs').Ctx} ctx
 */
export async function buildCases(ctx) {
  const { http, geo, todayIso, log } = ctx;
  const curYear = /** @type {{y:number}} */ (parseYmd(todayIso)).y;
  const years = Array.from({ length: curYear - FIRST_YEAR + 1 }, (_, i) => FIRST_YEAR + i);
  const jobs = years.flatMap((y) => /** @type {const} */ ([0, 1]).map((imp) => ({ y, imp })));
  const t0 = Date.now();
  const results = await mapLimit(jobs, CONCURRENCY, async ({ y, imp }) => {
    const end = y === curYear ? todayIso.replaceAll('-', '/') : `${y}/12/31`;
    const raw = await http.asmx('GetDengueLocation', {
      citycode: 'all', immigration: String(imp), startDate: `${y}/01/01`, endDate: end,
    });
    return { y, imp, ...normalizeRecords(raw, { year: y, imp: /** @type {0|1} */ (imp), todayIso }) };
  });
  /** @type {Map<number, CaseRow[]>} */
  const rowsByYear = new Map(years.map((y) => [y, []]));
  const drops = emptyDrops();
  let input = 0;
  for (const r of results) {
    const list = /** @type {CaseRow[]} */ (rowsByYear.get(r.y));
    for (const row of r.rows) list.push(row);
    for (const k of /** @type {Array<keyof DropStats>} */ (Object.keys(drops))) drops[k] += r.drops[k];
    input += r.input;
  }
  log(`cases: fetched ${input} records in ${Date.now() - t0} ms`);
  const out = buildCasesOutputs(rowsByYear, geo.locateTown, todayIso, townNameLookup(geo));
  const dropped = Object.values(drops).reduce((a, b) => a + b, 0);
  return {
    files: out.files,
    meta: {
      records: out.records,
      latestOnset: out.latestOnset,
      years: out.years,
      totals: out.totals,
      input,
      dropped,
      drops,
      nullTown: out.nullTown,
      uniquePts: out.uniquePts,
      townMatch: { ...geo.townStats },
    },
  };
}

