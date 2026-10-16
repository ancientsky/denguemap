// @ts-check
/**
 * Validation gates.  Every function throws an Error describing the problem;
 * a throw makes the whole source "stale" (previous files are kept).
 */
import {
  BBOX, FIRST_YEAR, IMPORTED_REFERENCE, REFERENCE_COUNTS, SHRINK_TOLERANCE, WARN_RATIO,
} from './config.mjs';
import { daysFromIso } from './util.mjs';

/** @param {boolean} cond @param {string} msg */
function ensure(cond, msg) {
  if (!cond) throw new Error(msg);
}
const isInt = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isInteger(v);
const isNum = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v);
const isDate = (/** @type {unknown} */ v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const inBbox = (/** @type {number} */ lng, /** @type {number} */ lat) => lng >= BBOX.minLng && lng <= BBOX.maxLng && lat >= BBOX.minLat && lat <= BBOX.maxLat;

/**
 * How much a count may shrink compared with the baseline.
 * @param {number} base
 */
export function allowedShrink(base) {
  return Math.max(SHRINK_TOLERANCE.abs, Math.floor(base * SHRINK_TOLERANCE.rel));
}

/**
 * Compare new per-year totals with the previously committed ones (or the
 * reference counts when a year has no committed file yet).
 * @param {Record<number, {local:number, imported:number}>} totals
 * @param {Record<number, {local:number, imported:number}|null>} prevTotals
 * @param {{local:readonly number[], imported:readonly number[]}|null} reference indexed from FIRST_YEAR
 * @returns {string[]} problems
 */
export function checkShrink(totals, prevTotals, reference) {
  /** @type {string[]} */
  const problems = [];
  for (const [ys, t] of Object.entries(totals)) {
    const y = Number(ys);
    const prev = prevTotals[y];
    const ref = reference && y - FIRST_YEAR < reference.local.length
      ? { local: reference.local[y - FIRST_YEAR], imported: reference.imported[y - FIRST_YEAR] }
      : null;
    const base = prev ?? ref;
    if (!base) continue;
    for (const k of /** @type {const} */ (['local', 'imported'])) {
      if (t[k] < base[k] - allowedShrink(base[k])) {
        problems.push(`${y} ${k}: ${t[k]} < ${prev ? 'previous' : 'reference'} ${base[k]}`);
      }
    }
  }
  return problems;
}

/**
 * @param {{totals:Record<number,{local:number,imported:number}>, meta:any, years:number[]}} res
 * @param {{prevTotals:Record<number,{local:number,imported:number}|null>, reference?:{local:readonly number[], imported:readonly number[]}|null, allowShrink?:boolean, currentYear:number}} opts
 */
export function validateCases(res, opts) {
  const { meta } = res;
  const expectYears = opts.currentYear - FIRST_YEAR + 1;
  ensure(res.years.length === expectYears, `expected ${expectYears} years, got ${res.years.length}`);
  ensure(meta.records > 0, 'no case records');
  ensure(meta.input > 0, 'no input records');
  ensure(meta.dropped <= Math.max(5, meta.input * 0.01), `too many invalid records dropped: ${meta.dropped}/${meta.input}`);
  ensure(meta.uniquePts > 0 && meta.nullTown <= meta.uniquePts * 0.25, `too many points without a town: ${meta.nullTown}/${meta.uniquePts}`);
  if (!opts.allowShrink) {
    const reference = opts.reference === undefined ? REFERENCE_COUNTS : opts.reference;
    const problems = checkShrink(res.totals, opts.prevTotals, reference);
    ensure(problems.length === 0, `case counts shrank: ${problems.join('; ')}`);
  }
}

/**
 * @param {{records:number}} meta
 * @param {number|null} prevRecords
 */
export function validateImported(meta, prevRecords) {
  ensure(meta.records > 0, 'no imported records');
  if (prevRecords) ensure(meta.records >= prevRecords - allowedShrink(prevRecords), `imported shrank: ${meta.records} < ${prevRecords}`);
}

/** @param {{records:number}} meta */
export function validateNs1(meta) {
  ensure(meta.records >= 1000, `ns1: only ${meta.records} hospitals`);
}

/**
 * @param {{stats:any}} meta
 */
export function validateVector(meta) {
  const s = meta.stats;
  ensure(s.input >= 1000, `vector: only ${s.input} source villages`);
  ensure(s.sourceVillages >= s.input * 0.95, `vector: ${s.input - s.sourceVillages} of ${s.input} villages unusable`);
  ensure(s.skippedWeeks <= s.sourceVillages * 0.02, `vector: ${s.skippedWeeks} villages have misaligned weeks`);
  if (s.outVillages >= 20) ensure(s.matched >= s.outVillages * 0.5, `vector: only ${s.matched}/${s.outVillages} villages matched to boundaries`);
}

/**
 * Structural check of a generated file (string contents) by path.
 * @param {string} path
 * @param {string} text
 */
export function validateFileShape(path, text) {
  /** @type {any} */
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`${path}: not valid JSON`); }
  const err = (/** @type {string} */ m) => { throw new Error(`${path}: ${m}`); };
  let m;
  if ((m = /^cases\/(\d{4})\.json$/.exec(path))) {
    if (j.year !== Number(m[1])) err('year mismatch');
    if (!Array.isArray(j.pts) || !Array.isArray(j.c)) err('pts/c missing');
    for (const p of j.pts) {
      if (!Array.isArray(p) || p.length !== 3 || !isNum(p[0]) || !isNum(p[1]) || !inBbox(p[0], p[1])) err('bad point');
      if (p[2] !== null && !(typeof p[2] === 'string' && /^\d{8}$/.test(p[2]))) err('bad townCode');
    }
    let last = 0;
    for (const r of j.c) {
      if (!Array.isArray(r) || r.length !== 4 || !r.every(isInt)) err('bad case row');
      if (r[0] < 1 || r[0] > 366 || r[1] < 0 || r[1] >= j.pts.length || (r[2] !== 0 && r[2] !== 1) || r[3] < 1) err('case row out of range');
      if (r[0] < last) err('c not sorted by day');
      last = r[0];
    }
  } else if (path === 'trend.json') {
    if (!isDate(j.start) || !isDate(j.end)) err('bad dates');
    const n = daysFromIso(j.end) - daysFromIso(j.start) + 1;
    for (const k of ['local', 'imported']) {
      if (!Array.isArray(j.national?.[k]) || j.national[k].length !== n || !j.national[k].every(isInt)) err(`national.${k} length != ${n}`);
    }
    for (const [cc, v] of Object.entries(j.county ?? {})) {
      if (!/^\d{5}$/.test(cc)) err('bad county code');
      for (const k of ['local', 'imported']) {
        for (const e of /** @type {any} */ (v)[k]) if (!Array.isArray(e) || !isInt(e[0]) || !isInt(e[1]) || e[0] < 0 || e[0] >= n) err('bad sparse entry');
      }
    }
  } else if (path === 'summary.json') {
    if (!isDate(j.asOf) || !isInt(j.year)) err('bad header');
    if (j.latestOnset !== '' && !isDate(j.latestOnset)) err('bad latestOnset');
    for (const k of ['ytd', 'last7', 'last14', 'last30', 'prevYtd']) if (!isInt(j[k]?.local) || !isInt(j[k]?.imported)) err(`bad ${k}`);
    if (!Array.isArray(j.topTowns14) || j.topTowns14.length > 20) err('bad topTowns14');
  } else if (path === 'imported.json') {
    if (!isDate(j.from) || !isDate(j.to) || typeof j.countries !== 'object') err('bad header');
    for (const [cc, c] of Object.entries(j.countries)) {
      if (!/^[a-z]{2}$/.test(cc) || typeof (/** @type {any} */ (c)).zh !== 'string') err(`bad country ${cc}`);
    }
  } else if (path === 'notices.json') {
    for (const [cc, list] of Object.entries(j)) {
      if (!/^[a-z]{2}$/.test(cc) || !Array.isArray(list) || list.length > 5) err(`bad country ${cc}`);
      for (const n of list) {
        if (!isDate(n.date) || typeof n.headline !== 'string' || typeof n.text !== 'string') err('bad notice');
        if (n.url !== null && !(typeof n.url === 'string' && n.url.startsWith('https://www.cdc.gov.tw/'))) err('bad notice url');
      }
    }
  } else if (path === 'clusters.json') {
    if (j.type !== 'FeatureCollection' || !Array.isArray(j.features)) err('not a FeatureCollection');
    for (const f of j.features) {
      if (!['Polygon', 'MultiPolygon'].includes(f.geometry?.type)) err('bad geometry');
      const p = f.properties;
      if (typeof p?.county !== 'string' || typeof p.town !== 'string' || typeof p.code1 !== 'string' || !isInt(p.count)) err('bad properties');
      if (Object.keys(p).length !== 5) err('unexpected properties');
    }
  } else if (path === 'vector.json') {
    if (!isDate(j.updated) || !Array.isArray(j.weeks) || j.weeks.length !== 5) err('bad header');
    for (const v of j.villages) {
      if (!Array.isArray(v) || v.length !== 8 || !isNum(v[3]) || !isNum(v[4]) || !inBbox(v[3], v[4])) err('bad village');
      if (v[5] !== null && !/^\d{11}$/.test(v[5])) err('bad villCode');
      if (![0, 1, 2, 3].includes(v[6]) || !Array.isArray(v[7]) || v[7].length !== 5) err('bad village colors');
      for (const w of v[7]) if (!Array.isArray(w) || w.length !== 4 || ![0, 1, 2, 3].includes(w[0])) err('bad week entry');
    }
  } else if (path === 'ns1.json') {
    if (!isDate(j.sourceDate) || !Array.isArray(j.h)) err('bad header');
    for (const h of j.h) if (!Array.isArray(h) || h.length !== 7 || !isNum(h[3]) || !isNum(h[4]) || !inBbox(h[3], h[4])) err('bad hospital');
  } else if (path.endsWith('.topo.json')) {
    if (j.type !== 'Topology' || typeof j.objects !== 'object' || !Array.isArray(j.arcs)) err('not a topology');
  } else {
    err('unknown file');
  }
}

/**
 * Data-quality warnings for the manifest: counts of the currently committed
 * data that fall below WARN_RATIO of the fixed historical reference.
 * Deterministic (no timestamps); sorted by code, year, type.
 * @param {object} p
 * @param {Record<number, {local:number, imported:number}>} p.casesTotals per-year totals of cases/{year}.json that exist
 * @param {{total:number, byYear:Record<number, number>}|null} p.imported totals of imported.json (null when absent)
 * @param {{local:readonly number[], imported:readonly number[]}} [p.reference]
 * @param {{total:number, byYear:Readonly<Record<number, number>>}} [p.importedReference]
 * @returns {Array<{code:string, year?:number, type?:string, got:number, expected:number}>}
 */
export function computeWarnings({ casesTotals, imported, reference = REFERENCE_COUNTS, importedReference = IMPORTED_REFERENCE }) {
  /** @type {Array<{code:string, year?:number, type?:string, got:number, expected:number}>} */
  const out = [];
  const low = (/** @type {number} */ got, /** @type {number} */ expected) => expected > 0 && got < expected * WARN_RATIO;
  for (let i = 0; i < reference.local.length; i++) {
    const year = FIRST_YEAR + i;
    const t = casesTotals[year];
    if (!t) continue;
    for (const type of /** @type {const} */ (['local', 'imported'])) {
      const expected = reference[type][i];
      if (low(t[type], expected)) out.push({ code: 'cases-shortfall', year, type, got: t[type], expected });
    }
  }
  if (imported) {
    if (low(imported.total, importedReference.total)) out.push({ code: 'imported-shortfall', got: imported.total, expected: importedReference.total });
    for (const [ys, expected] of Object.entries(importedReference.byYear)) {
      const got = imported.byYear[Number(ys)] ?? 0;
      if (low(got, expected)) out.push({ code: 'imported-shortfall', year: Number(ys), got, expected });
    }
  }
  const key = (/** @type {any} */ w) => `${w.code}|${String(w.year ?? 0).padStart(5, '0')}|${w.type ?? ''}`;
  return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
