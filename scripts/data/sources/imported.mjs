// @ts-check
/**
 * Imported cases by country of infection (GetImportedData, 2023 onwards)
 * -> imported.json
 */
import {
  cleanLabel, cmp, daysFromIso, isoFromDays, parseYmd, roundTo, toJson,
} from '../util.mjs';
import { ShrinkError, shrinksBelow } from '../validate.mjs';

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

/** @typedef {{day:number, cc:string, n:number}} Ev  absolute day (days since 1970-01-01), country, cases that day */

const yearOfDay = (/** @type {number} */ d) => Number(isoFromDays(d).slice(0, 4));

/**
 * One event per (day, country), cases summed; sorted by day then country.
 * @param {ImportedRow[]} rows @returns {Ev[]}
 */
export function eventsOfRows(rows) {
  /** @type {Map<string, Ev>} */
  const m = new Map();
  for (const r of rows) {
    const day = daysFromIso(r.date);
    const k = `${day}|${r.cc}`;
    const e = m.get(k);
    if (e) e.n += r.count; else m.set(k, { day, cc: r.cc, n: r.count });
  }
  return [...m.values()].sort((a, b) => a.day - b.day || cmp(a.cc, b.cc));
}

/**
 * Display name and centroid per country: the most frequent name / (rounded) position.
 * @param {ImportedRow[]} rows @returns {Map<string, {zh:string, lat:number|null, lng:number|null}>}
 */
function metaOfRows(rows) {
  /** @type {Map<string, {zh:Map<string,number>, ll:Map<string,number>}>} */
  const by = new Map();
  for (const r of rows) {
    let e = by.get(r.cc);
    if (!e) { e = { zh: new Map(), ll: new Map() }; by.set(r.cc, e); }
    e.zh.set(r.zh, (e.zh.get(r.zh) ?? 0) + r.count);
    if (r.lat !== null && r.lng !== null) {
      const k = `${roundTo(r.lat, 2)},${roundTo(r.lng, 2)}`;
      e.ll.set(k, (e.ll.get(k) ?? 0) + r.count);
    }
  }
  const top = (/** @type {Map<string,number>} */ m) => [...m.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]?.[0];
  /** @type {Map<string, {zh:string, lat:number|null, lng:number|null}>} */
  const out = new Map();
  for (const [cc, e] of by) {
    const ll = top(e.ll);
    const [lat, lng] = ll ? ll.split(',').map(Number) : [null, null];
    out.set(cc, { zh: /** @type {string} */ (top(e.zh)), lat, lng });
  }
  return out;
}

/**
 * Serialise events + country meta into imported.json.
 * @param {Ev[]} events non-empty
 * @param {(cc:string)=>{zh:string, lat:number|null, lng:number|null}} metaOf
 * @param {string} todayIso
 */
function buildFile(events, metaOf, todayIso) {
  const today = daysFromIso(todayIso);
  const fromDay = events[0].day, toDay = events[events.length - 1].day;
  /** @type {Map<string, {byYear:Map<string,number>, byMonth:Map<string,number>, recent:number}>} */
  const by = new Map();
  for (const e of events) {
    let c = by.get(e.cc);
    if (!c) { c = { byYear: new Map(), byMonth: new Map(), recent: 0 }; by.set(e.cc, c); }
    const iso = isoFromDays(e.day);
    const y = iso.slice(0, 4), m = iso.slice(0, 7);
    c.byYear.set(y, (c.byYear.get(y) ?? 0) + e.n);
    c.byMonth.set(m, (c.byMonth.get(m) ?? 0) + e.n);
    const age = today - e.day;
    if (age >= 0 && age < 365) c.recent += e.n;
  }
  const sorted = (/** @type {Map<string,number>} */ m) => Object.fromEntries([...m.entries()].sort((a, b) => cmp(a[0], b[0])));
  /** @type {Record<string, any>} */
  const countries = {};
  /** @type {Array<{cc:string, zh:string}>} */
  const recent = [];
  let records = 0;
  for (const cc of [...by.keys()].sort(cmp)) {
    const c = /** @type {NonNullable<ReturnType<typeof by.get>>} */ (by.get(cc));
    const m = metaOf(cc);
    countries[cc] = { zh: m.zh, lat: m.lat, lng: m.lng, byYear: sorted(c.byYear), byMonth: sorted(c.byMonth) };
    for (const v of c.byYear.values()) records += v;
    if (c.recent > 0) recent.push({ cc, zh: m.zh });
  }
  // one entry per (day, country): [dayIndex since `from`, cc, cases that day]
  const data = {
    from: isoFromDays(fromDay),
    to: isoFromDays(toDay),
    countries,
    events: events.map((e) => [e.day - fromDay, e.cc, e.n]),
  };
  return { json: toJson(data), data, records, recent };
}

/**
 * @param {ImportedRow[]} rows
 * @param {string} todayIso
 */
export function buildImported(rows, todayIso) {
  if (rows.length === 0) throw new Error('GetImportedData returned no usable records');
  const meta = metaOfRows(rows);
  return buildFile(eventsOfRows(rows), (cc) => /** @type {NonNullable<ReturnType<typeof meta.get>>} */ (meta.get(cc)), todayIso);
}

/**
 * What the committed imported.json offers for a per-year merge.
 * @param {any} file parsed imported.json (or null)
 * @returns {{countries:Record<string,any>, yearCounts:Map<number,number>, events:Ev[]|null}|null}
 */
export function readCommittedImported(file) {
  if (!file || typeof file !== 'object' || !file.countries || typeof file.countries !== 'object') return null;
  /** @type {Map<number, number>} */
  const yearCounts = new Map();
  /** @type {Ev[]|null} */
  let events = null;
  const base = parseYmd(file.from) ? daysFromIso(file.from) : null;
  if (Array.isArray(file.events) && base !== null) {
    events = [];
    for (const e of file.events) {
      if (Array.isArray(e) && Number.isInteger(e[0]) && typeof e[1] === 'string' && Number.isInteger(e[2])) events.push({ day: base + e[0], cc: e[1], n: e[2] });
    }
    for (const e of events) yearCounts.set(yearOfDay(e.day), (yearCounts.get(yearOfDay(e.day)) ?? 0) + e.n);
  } else {
    // pre-v2 file: per-year totals only, so a rejected year cannot be kept
    for (const c of Object.values(file.countries)) {
      for (const [y, n] of Object.entries(/** @type {any} */ (c).byYear ?? {})) yearCounts.set(Number(y), (yearCounts.get(Number(y)) ?? 0) + Number(n));
    }
  }
  return { countries: file.countries, yearCounts, events };
}

/**
 * @typedef {object} ImportedOptions
 * @property {any} [committed]           parsed committed imported.json (or null)
 * @property {boolean} [allowShrink]
 * @property {readonly number[]} [retryDelays]
 * @property {(ms:number)=>Promise<void>} [sleep]
 */

/**
 * Fetch GetImportedData (everything at once) and merge per onset year: a year takes the new events when its
 * case count is not lower than the committed one (within the shrink tolerance); otherwise the committed
 * events of that year are kept.  Rejected years are re-fetched (the whole call) after each retry delay.
 * @param {import('../run.mjs').Ctx} ctx
 * @param {ImportedOptions} [opts]
 */
export async function buildImportedSource(ctx, opts = {}) {
  const com = readCommittedImported(opts.committed);
  const retryDelays = opts.retryDelays ?? [];
  const sleep = opts.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => { setTimeout(r, ms); }));
  const curYear = /** @type {{y:number}} */ (parseYmd(ctx.todayIso)).y;
  const maxAttempts = 1 + retryDelays.length;
  /** @type {Map<number, ImportedRow[]>} */
  const accepted = new Map();
  /** @type {Map<number, {got:number, committed:number}>} */
  let rejected = new Map();
  let dropped = 0, input = 0;
  for (let attempt = 1; ; attempt++) {
    const raw = await ctx.http.asmx('GetImportedData', {});
    const norm = normalizeImported(raw);
    if (norm.rows.length === 0) throw new Error('GetImportedData returned no usable records');
    dropped = norm.dropped;
    input = Array.isArray(raw) ? raw.length : 0;
    /** @type {Map<number, ImportedRow[]>} */
    const byYear = new Map();
    for (const r of norm.rows) {
      const y = Number(r.date.slice(0, 4));
      const l = byYear.get(y);
      if (l) l.push(r); else byYear.set(y, [r]);
    }
    rejected = new Map();
    for (const y of new Set([...byYear.keys(), ...(com?.yearCounts.keys() ?? [])])) {
      if (accepted.has(y)) continue;
      const rows = byYear.get(y) ?? [];
      const got = rows.reduce((a, r) => a + r.count, 0);
      const was = com?.yearCounts.get(y) ?? 0;
      if (!opts.allowShrink && shrinksBelow(got, was)) rejected.set(y, { got, committed: was });
      else accepted.set(y, rows);
    }
    const rej = [...rejected].sort((a, b) => a[0] - b[0]).map(([y, v]) => `${y}: ${v.got} < ${v.committed}`);
    ctx.log(`imported: attempt ${attempt}/${maxAttempts}: ${norm.rows.length} usable row(s), ${rejected.size} year(s) below the committed counts${rej.length ? ` [${rej.join('; ')}]` : ''}`);
    if (rejected.size === 0 || attempt >= maxAttempts) break;
    const wait = retryDelays[attempt - 1];
    ctx.log(`imported: re-fetching in ${wait} ms`);
    if (wait > 0) await sleep(wait);
  }

  const keptYears = [...rejected.keys()].sort((a, b) => a - b);
  if (keptYears.length && !com?.events) {
    throw new ShrinkError(`imported shrank: ${keptYears.map((y) => `${y}: ${/** @type {any} */ (rejected.get(y)).got} < ${/** @type {any} */ (rejected.get(y)).committed}`).join('; ')} (committed file has no events to keep)`);
  }
  const newRows = [...accepted.values()].flat();
  /** @type {Ev[]} */
  const events = eventsOfRows(newRows);
  if (keptYears.length) {
    const keep = new Set(keptYears);
    for (const e of /** @type {Ev[]} */ (com?.events)) if (keep.has(yearOfDay(e.day))) events.push(e);
    events.sort((a, b) => a.day - b.day || cmp(a.cc, b.cc));
  }
  if (events.length === 0) throw new Error('GetImportedData returned no usable records');
  const fresh = metaOfRows(newRows);
  // untouched meta for countries that exist in the committed file when part of it was kept (stable output)
  const metaOf = (/** @type {string} */ cc) => {
    const c = com?.countries[cc];
    if (keptYears.length && c && typeof c.zh === 'string') return { zh: c.zh, lat: typeof c.lat === 'number' ? c.lat : null, lng: typeof c.lng === 'number' ? c.lng : null };
    return fresh.get(cc) ?? { zh: cc, lat: null, lng: null };
  };
  const out = buildFile(events, metaOf, ctx.todayIso);

  // which years differ from the committed events (for the manifest's per-year fetch times)
  const yearEvents = (/** @type {Ev[]} */ list) => {
    /** @type {Map<number, string>} */
    const m = new Map();
    /** @type {Map<number, Ev[]>} */
    const g = new Map();
    for (const e of list) { const y = yearOfDay(e.day); const a = g.get(y); if (a) a.push(e); else g.set(y, [e]); }
    for (const [y, a] of g) m.set(y, JSON.stringify(a.map((e) => [e.day, e.cc, e.n])));
    return m;
  };
  const mine = yearEvents(events), was = com?.events ? yearEvents(com.events) : new Map();
  const acceptedYears = [...mine.keys()].filter((y) => !rejected.has(y)).sort((a, b) => a - b);
  const changedYears = acceptedYears.filter((y) => mine.get(y) !== was.get(y));
  return {
    files: { 'imported.json': out.json },
    meta: {
      records: out.records,
      events: out.data.events.length,
      dropped,
      input,
      countries: Object.keys(out.data.countries).length,
      recent: out.recent,
      keptYears,
      acceptedYears,
      changedYears,
      currentYearOk: !rejected.has(curYear),
      rejected: keptYears.map((y) => ({ year: y, ...(/** @type {any} */ (rejected.get(y))) })),
    },
  };
}
