// @ts-check
/**
 * Reporting delay of local dengue cases from the Taiwan CDC open data (Dengue_Daily.csv):
 * days from onset (發病日) to confirmation (個案研判日), when a case appears in the published data.
 *
 *   node scripts/forecast/fit-delay.mjs <Dengue_Daily.csv[.gz]>
 *
 * Writes tests/backtest/delay.json: the pooled distribution (2010+; the confirmation dates of earlier years are
 * back-filled entry dates, e.g. 2002 ≈ 1,300 days) and the distribution of every (year, month of onset) and year
 * with enough cases.  The backtests thin the final data with these real delays ("what was published by then");
 * the model's own delay assumption is chosen by the backtest among candidates (tests/backtest/backtest.run.mjs).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseOpendataCsv } from '../data/sources/opendata.mjs';

const MAX = 28; // the model's delay support (days); later confirmations count as day MAX
const FIRST_YEAR = 2010;
const MIN_N = 50;

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/forecast/fit-delay.mjs <Dengue_Daily.csv[.gz]>');
  process.exit(2);
}
const buf = readFileSync(path);
const text = (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8');
const od = parseOpendataCsv(text);

const day = (/** @type {string} */ iso) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
/** @type {Map<string, number[]>} */
const groups = new Map();
const add = (/** @type {string} */ k, /** @type {number} */ lag, /** @type {number} */ n) => {
  let h = groups.get(k);
  if (!h) { h = new Array(MAX + 1).fill(0); groups.set(k, h); }
  h[Math.min(lag, MAX)] += n;
};
let negative = 0;
for (const c of od.cases) {
  if (c.imp || !c.judged) continue;
  const onset = c.onset.replaceAll('/', '-');
  const y = Number(onset.slice(0, 4));
  if (y < FIRST_YEAR) continue;
  const lag = day(c.judged) - day(onset);
  if (lag < 0) { negative++; continue; }
  add('pooled', lag, c.count);
  add(String(y), lag, c.count);
  add(onset.slice(0, 7), lag, c.count);
}

const describe = (/** @type {number[]} */ h) => {
  const n = h.reduce((a, b) => a + b, 0);
  const mean = h.reduce((a, v, i) => a + i * v, 0) / n;
  const sd = Math.sqrt(h.reduce((a, v, i) => a + v * (i - mean) ** 2, 0) / n);
  const pmf = h.map((v) => Math.round((v / n) * 1e5) / 1e5);
  return { n, mean: Math.round(mean * 100) / 100, sd: Math.round(sd * 100) / 100, pmf };
};
const out = {
  source: 'Taiwan CDC open data Dengue_Daily.csv: local cases, confirmation date − onset date (days)',
  newestConfirmation: od.newestJudged,
  max: MAX,
  firstYear: FIRST_YEAR,
  pooled: describe(/** @type {number[]} */ (groups.get('pooled'))),
  byYear: /** @type {Record<string, ReturnType<typeof describe>>} */ ({}),
  byMonth: /** @type {Record<string, ReturnType<typeof describe>>} */ ({}),
};
for (const [k, h] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (k === 'pooled' || h.reduce((a, b) => a + b, 0) < MIN_N) continue;
  (k.length === 4 ? out.byYear : out.byMonth)[k] = describe(h);
}
writeFileSync(new URL('../../tests/backtest/delay.json', import.meta.url), `${JSON.stringify(out)}\n`);
console.log(`pooled ${FIRST_YEAR}+: n=${out.pooled.n} mean=${out.pooled.mean} sd=${out.pooled.sd}; ${Object.keys(out.byYear).length} years, ${Object.keys(out.byMonth).length} months with ≥ ${MIN_N} cases; ${negative} negative delays skipped`);
for (const [y, d] of Object.entries(out.byYear)) console.log(`  ${y}: n=${d.n} mean=${d.mean} sd=${d.sd}`);
