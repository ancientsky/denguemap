// @ts-check
/**
 * Upstream diagnostics.  The CDC backend sometimes answers GetDengueLocation / GetImportedData with
 * truncated history (always the same years) and recovers minutes later.  To find out whether that is tied to
 * one backend instance (Azure App Service "ARRAffinity" cookie) or to the data itself, a rejected year
 * triggers a small probe: a few requests on fresh connections without cookies, plus one request per instance
 * seen, sending that instance's cookie back.  Only 8-hex hashes of the cookie values are ever reported.
 */
import { createHttp } from './http.mjs';
import { normalizeRecords } from './sources/cases.mjs';
import { shrinksBelow } from './validate.mjs';

export const PROBE_FRESH_REQUESTS = 4;
export const PROBE_MAX_INSTANCES = 4;
export const PROBE_DELAY_MS = 5000;

/**
 * @typedef {object} ProbeRow
 * @property {string} attempt  "run" for the pipeline's own requests, otherwise the probe kind
 * @property {string|null} inst  8-hex hash of the instance cookie
 * @property {number} year
 * @property {number|null} records  rows returned
 * @property {number|null} total    cases (sum of counts)
 * @property {boolean|null} truncated  below the committed count (null = request failed)
 * @property {string} [error]
 */

/**
 * One-line verdict from the per-request outcomes of one year.
 * @param {Array<{inst:string|null, truncated:boolean|null}>} rows
 */
export function verdictOf(rows) {
  const known = rows.filter((r) => r.truncated !== null);
  if (known.length === 0) return 'no usable probe result';
  const bad = known.filter((r) => r.truncated);
  if (bad.length === 0) return `probe returned full data (${known.length}/${known.length} requests) → transient, not reproducible now`;
  if (bad.length === known.length) {
    const insts = new Set(known.map((r) => r.inst ?? '-'));
    return `all instances truncated (${known.length}/${known.length} requests, ${insts.size} instance(s) seen) → data-state issue upstream`;
  }
  /** @type {Map<string, {bad:number, good:number}>} */
  const by = new Map();
  for (const r of known) {
    const k = r.inst ?? '-';
    const e = by.get(k) ?? { bad: 0, good: 0 };
    if (r.truncated) e.bad++; else e.good++;
    by.set(k, e);
  }
  const mixed = [...by].filter(([, e]) => e.bad && e.good);
  const onlyBad = [...by].filter(([, e]) => e.bad && !e.good).map(([k]) => k);
  if (!mixed.length && by.has('-') === false && onlyBad.length) return `truncation correlates with instance ${onlyBad.join(', ')} (${bad.length}/${known.length} requests truncated)`;
  return `mixed results (${bad.length}/${known.length} truncated)${mixed.length ? ' even within one instance' : ''} → intermittent, no clean instance correlation`;
}

/**
 * The pipeline's own GetDengueLocation requests for (year, local) as probe rows.
 * @param {ReturnType<typeof createHttp>} http @param {number} year @param {number|null} expected committed local total
 * @returns {ProbeRow[]}
 */
export function ownAttempts(http, year, expected) {
  return http.diag
    .filter((e) => e.tag === `GetDengueLocation ${year}/0`)
    .map((e) => ({
      attempt: 'run', inst: e.inst, year, records: e.records, total: e.total,
      truncated: e.records === null || e.total === null ? null : shrinksBelow(e.total, expected),
    }));
}

/**
 * @param {object} p
 * @param {string} p.baseUrl
 * @param {typeof fetch} [p.fetchImpl]
 * @param {ReturnType<typeof createHttp>} p.http  the pipeline's client (instances seen so far)
 * @param {number} p.year  a year that was truncated
 * @param {number|null} p.expected committed local total of that year
 * @param {string} p.todayIso
 * @param {number} [p.delayMs]
 * @param {(ms:number)=>Promise<void>} [p.sleep]
 * @param {(m:string)=>void} p.log
 * @returns {Promise<{rows:ProbeRow[], verdict:string}>}
 */
export async function probeUpstream(p) {
  const delay = p.delayMs ?? PROBE_DELAY_MS;
  const sleep = p.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => { setTimeout(r, ms); }));
  const probe = createHttp({ baseUrl: p.baseUrl, fetchImpl: p.fetchImpl, maxAttempts: 1, backoffMs: 0, timeoutMs: 60_000, log: p.log });
  /** @type {ProbeRow[]} */
  const rows = ownAttempts(p.http, p.year, p.expected);

  /** @param {string} attempt @param {Record<string,string>} headers */
  const one = async (attempt, headers) => {
    /** @type {ProbeRow} */
    let row = { attempt, inst: null, year: p.year, records: null, total: null, truncated: null };
    try {
      const raw = await probe.asmx('GetDengueLocation', {
        citycode: 'all', immigration: '0', startDate: `${p.year}/01/01`, endDate: `${p.year}/12/31`,
      }, { headers });
      const e = probe.diag[probe.diag.length - 1];
      const n = normalizeRecords(raw, { year: p.year, imp: 0, todayIso: p.todayIso });
      const total = n.rows.reduce((a, r) => a + r.count, 0);
      row = { ...row, inst: e.inst, records: e.records, total, truncated: shrinksBelow(total, p.expected) };
    } catch (e) {
      row = { ...row, inst: probe.diag[probe.diag.length - 1]?.inst ?? null, error: e instanceof Error ? e.message : String(e) };
    }
    p.log(`probe ${attempt}: year ${p.year} local → inst=${row.inst ?? '-'} records=${row.records ?? '-'} cases=${row.total ?? '-'} truncated=${row.truncated ?? 'n/a'}${row.error ? ` error=${row.error}` : ''}`);
    rows.push(row);
  };

  // 1. fresh connections, no cookie (undici sends `Connection: close`, so every call opens a new socket)
  for (let i = 1; i <= PROBE_FRESH_REQUESTS; i++) {
    if (i > 1 && delay > 0) await sleep(delay);
    await one(`fresh-${i}`, { Connection: 'close' });
  }
  // 2. one call per instance seen, with its cookie sent back
  const seen = [...new Set([...p.http.instances(), ...probe.instances()])].slice(0, PROBE_MAX_INSTANCES);
  for (const inst of seen) {
    const cookie = p.http.cookieForInstance(inst) ?? probe.cookieForInstance(inst);
    if (!cookie) continue;
    if (delay > 0) await sleep(delay);
    await one(`pinned-${inst}`, { Connection: 'close', Cookie: cookie });
  }
  return { rows, verdict: verdictOf(rows) };
}

/**
 * Markdown for the step summary.
 * @param {ProbeRow[]} rows @param {string} verdict
 */
export function renderProbe(rows, verdict) {
  const lines = ['', '#### Upstream probe', '', '| attempt | instance | year | records | cases | truncated |', '|---|---|---:|---:|---:|---|'];
  for (const r of rows) {
    lines.push(`| ${r.attempt} | ${r.inst ?? '-'} | ${r.year} | ${r.records ?? '-'} | ${r.total ?? '-'} | ${r.truncated === null ? (r.error ? 'error' : '-') : r.truncated ? 'yes' : 'no'} |`);
  }
  lines.push('', `Verdict: **${verdict}**`);
  return lines.join('\n');
}
