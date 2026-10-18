// Forecast scoring for the backtest: weighted interval score (Bracher et al. 2021) on the 5 published
// quantiles, interval coverage, and the flat baseline the model must beat (COVID-19 Forecast Hub style:
// last complete week plus resampled, symmetrised week-to-week changes).
import { QUANTILE_LEVELS, quantiles, type Quantiles } from './model';
import { rng } from './random';

/** WIS for the 50 % and 90 % central intervals plus the median. */
export function wis(q: Quantiles, y: number): number {
  const is = (lo: number, hi: number, alpha: number) =>
    hi - lo + (2 / alpha) * Math.max(0, lo - y) + (2 / alpha) * Math.max(0, y - hi);
  const K = 2;
  return (0.5 * Math.abs(y - q.q50) + (0.1 / 2) * is(q.q05, q.q95, 0.1) + (0.5 / 2) * is(q.q25, q.q75, 0.5)) / (K + 0.5);
}

export const covers = (q: Quantiles, y: number, level: 50 | 90): boolean =>
  level === 50 ? y >= q.q25 && y <= q.q75 : y >= q.q05 && y <= q.q95;

/**
 * Flat baseline: the last complete weekly count `history.at(-1)`, plus the sum of `steps` week-to-week changes
 * drawn from the symmetrised changes of `history` (≥ 0). Quantiles from 1000 seeded samples.
 */
export function flatBaseline(history: readonly number[], steps: number, seed = 1): Quantiles {
  const last = history.at(-1) ?? 0;
  const diffs: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const d = history[i]! - history[i - 1]!;
    diffs.push(d, -d);
  }
  if (!diffs.length) diffs.push(0);
  const r = rng(seed);
  const s = new Float64Array(1000);
  for (let i = 0; i < s.length; i++) {
    let v = last;
    for (let k = 0; k < steps; k++) v += diffs[Math.floor(r() * diffs.length)]!;
    s[i] = Math.max(0, v);
  }
  return quantiles(s);
}

export { QUANTILE_LEVELS };
