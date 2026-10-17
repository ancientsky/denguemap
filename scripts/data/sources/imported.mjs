// @ts-check
/**
 * Imported cases by country of infection (GetImportedData, 2023 onwards)
 * -> imported.json
 */
import { cleanLabel, daysFromIso, parseYmd, roundTo, toJson, cmp } from '../util.mjs';

/**
 * @typedef {object} ImportedRow
 * @property {string} date @property {string} cc @property {string} zh
 * @property {number|null} lat @property {number|null} lng @property {number} count
 */

/**
 * Whitelist and type-check raw records.
 * @param {unknown} raw
 * @returns {{rows:ImportedRow[], dropped:number}}
 */
export function normalizeImported(raw) {
  if (!Array.isArray(raw)) throw new Error('GetImportedData: expected an array');
  /** @type {ImportedRow[]} */
  const rows = [];
  let dropped = 0;
  for (const r of raw) {
    const rec = /** @type {any} */ (r);
    const p = rec && typeof rec === 'object' ? parseYmd(rec.sickdate) : null;
    const cc = rec && typeof rec.country_code === 'string' ? rec.country_code.trim().toLowerCase() : '';
    const zh = rec && typeof rec.country_name === 'string' ? cleanLabel(rec.country_name, 40) : '';
    const count = rec && rec.count !== undefined ? Number(rec.count) : 1;
    if (!p || !/^[a-z]{2}$/.test(cc) || !zh || !Number.isInteger(count) || count < 1 || count > 100000) {
      dropped++;
      continue;
    }
    const lat = Number(rec.country_lat), lng = Number(rec.country_lng);
    const ok = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && rec.country_lat !== null && rec.country_lng !== null;
    rows.push({
      date: `${String(p.y).padStart(4, '0')}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`,
      cc,
      zh,
      lat: ok ? lat : null,
      lng: ok ? lng : null,
      count,
    });
  }
  return { rows, dropped };
}

/**
 * @param {ImportedRow[]} rows
 * @param {string} todayIso
 */
export function buildImported(rows, todayIso) {
  if (rows.length === 0) throw new Error('GetImportedData returned no usable records');
  const today = daysFromIso(todayIso);
  const dates = rows.map((r) => r.date).sort();
  /** @type {Map<string, {zh:Map<string,number>, ll:Map<string,number>, byYear:Map<string,number>, byMonth:Map<string,number>, recent:number}>} */
  const by = new Map();
  for (const r of rows) {
    let e = by.get(r.cc);
    if (!e) { e = { zh: new Map(), ll: new Map(), byYear: new Map(), byMonth: new Map(), recent: 0 }; by.set(r.cc, e); }
    e.zh.set(r.zh, (e.zh.get(r.zh) ?? 0) + r.count);
    if (r.lat !== null && r.lng !== null) {
      const k = `${roundTo(r.lat, 2)},${roundTo(r.lng, 2)}`;
      e.ll.set(k, (e.ll.get(k) ?? 0) + r.count);
    }
    const y = r.date.slice(0, 4), m = r.date.slice(0, 7);
    e.byYear.set(y, (e.byYear.get(y) ?? 0) + r.count);
    e.byMonth.set(m, (e.byMonth.get(m) ?? 0) + r.count);
    const age = today - daysFromIso(r.date);
    if (age >= 0 && age < 365) e.recent += r.count;
  }
  const top = (/** @type {Map<string,number>} */ m) => [...m.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]?.[0];
  /** @type {Record<string, any>} */
  const countries = {};
  /** @type {Array<{cc:string, zh:string}>} */
  const recent = [];
  let records = 0;
  for (const cc of [...by.keys()].sort(cmp)) {
    const e = /** @type {NonNullable<ReturnType<typeof by.get>>} */ (by.get(cc));
    const zh = /** @type {string} */ (top(e.zh));
    const ll = top(e.ll);
    const [lat, lng] = ll ? ll.split(',').map(Number) : [null, null];
    const sorted = (/** @type {Map<string,number>} */ m) => Object.fromEntries([...m.entries()].sort((a, b) => cmp(a[0], b[0])));
    countries[cc] = { zh, lat, lng, byYear: sorted(e.byYear), byMonth: sorted(e.byMonth) };
    for (const v of e.byYear.values()) records += v;
    if (e.recent > 0) recent.push({ cc, zh });
  }
  // one entry per (day, country): [dayIndex since `from`, cc, cases that day]
  const from = dates[0];
  const fromDay = daysFromIso(from);
  /** @type {Map<string, number>} */
  const perDay = new Map();
  for (const r of rows) {
    const k = `${String(daysFromIso(r.date) - fromDay).padStart(6, '0')}|${r.cc}`;
    perDay.set(k, (perDay.get(k) ?? 0) + r.count);
  }
  const events = [...perDay.entries()]
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([k, n]) => { const [d, cc] = k.split('|'); return [Number(d), cc, n]; });
  const data = { from, to: dates[dates.length - 1], countries, events };
  return { json: toJson(data), data, records, recent };
}

/**
 * @param {import('../run.mjs').Ctx} ctx
 */
export async function buildImportedSource(ctx) {
  const raw = await ctx.http.asmx('GetImportedData', {});
  const { rows, dropped } = normalizeImported(raw);
  const out = buildImported(rows, ctx.todayIso);
  return {
    files: { 'imported.json': out.json },
    meta: { records: out.records, events: out.data.events.length, dropped, input: Array.isArray(raw) ? raw.length : 0, countries: Object.keys(out.data.countries).length, recent: out.recent },
  };
}
