// Measured onset → confirmation delays of local cases (scripts/forecast/fit-delay.mjs on the Taiwan CDC open data),
// shared by the temporal and the spatial backtest.
import { readFileSync } from 'node:fs';
import { isoFromEpochDay } from '../../src/lib/dates';

export const DELAY = JSON.parse(readFileSync(new URL('./delay.json', import.meta.url), 'utf8'));

const cdfs = new Map();
const cdfOf = (key) => {
  if (!cdfs.has(key)) {
    const d = DELAY.byMonth[key] ?? DELAY.byYear[key.slice(0, 4)] ?? DELAY.pooled;
    let acc = 0;
    cdfs.set(key, d.pmf.map((v) => (acc += v)));
  }
  return cdfs.get(key);
};

/** Share of the cases with onset on `day` (epoch day) confirmed `lag` days later: real delay of that month,
 * else of that year, else pooled 2010+ (earlier confirmation dates are back-filled entry dates). */
export const realCompleteness = (day, lag) => (lag >= DELAY.max ? 1 : Math.min(1, cdfOf(isoFromEpochDay(day).slice(0, 7))[lag]));
