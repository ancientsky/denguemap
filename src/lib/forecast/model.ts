// Temporal forecast for one area (Taiwan or a county): nowcast of the latest, still-incomplete days,
// the instantaneous reproduction number Rt, and a 4-week projection with uncertainty.
//
// Renewal model on onset dates (Cori et al. 2013, with imported cases as infectors only, Thompson et al. 2019):
//   local_t ~ Poisson-gamma(R_t · Λ_t),  Λ_t = Σ_s w_s · (local_{t−s} + α · imported_{t−s})
// where w is the generation (onset-to-onset) interval. Reporting delay: a case with onset t is published by
// day T with probability F(T − t), so observed_t ~ Poisson(R · Λ_t · F(T − t)) and the Rt posterior stays a
// conjugate gamma. Projection: R is drawn from that posterior per simulated path, damped towards 1
// (seasonal decline, control measures) and given a weekly log random walk; the latest days are completed
// with the unobserved part of the renewal process (Poisson thinning). Everything is seeded (deterministic).
import { cumulative, discreteGamma, gammaQuantile } from './dist';
import { gamma, negbin, normal, poisson, quantileSorted, rng } from './random';

export interface ForecastParams {
  /** Generation (onset-to-onset) interval, days. */
  gi: { mean: number; sd: number; max: number };
  /** Onset-to-publication delay, days (an assumption until report dates are available). */
  delay: { mean: number; sd: number; max: number };
  /** Rt estimation window, days. */
  rtWindow: number;
  /** Gamma prior on R (Cori default: shape 1, scale 5). */
  prior: { shape: number; scale: number };
  /** Negative-binomial dispersion k of daily incidence (smaller = more clustered / overdispersed). */
  dispersion: number;
  /** Weekly factor φ pulling R towards 1 over the horizon: R(h) = 1 + (R − 1) · φ^(h/7). */
  damping: number;
  /** Standard deviation of the weekly log-R random walk. */
  rwSd: number;
  /** Relative infectiousness α of imported cases (many are isolated early). */
  importedWeight: number;
  /** Forecast horizon, days (whole weeks). */
  horizon: number;
  sims: number;
  /** Local cases (observed) in the last 28 days below which no forecast is shown. */
  minCases: number;
  seed: number;
}

export interface Quantiles {
  q05: number;
  q25: number;
  q50: number;
  q75: number;
  q95: number;
}
export const QUANTILE_LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95] as const;

export interface WeekForecast {
  /** Last day of the 7-day block (epoch day); blocks are aligned to the as-of day. */
  end: number;
  /** Observed (as known at the as-of day) local cases. */
  observed: number;
  /** past: complete enough to take as is; nowcast: still filling in; future: projection. */
  kind: 'past' | 'nowcast' | 'future';
  /** Predictive quantiles of the eventual count (nowcast and future blocks). */
  q: Quantiles | null;
}

export interface RtPoint {
  day: number;
  median: number;
  lo: number;
  hi: number;
}

export interface AreaForecast {
  asOf: number;
  status: 'ok' | 'few';
  /** Observed local cases in the 28 days up to the as-of day. */
  recent28: number;
  /** Observed imported cases in the same 28 days. */
  recentImported28: number;
  rt: (RtPoint & { shape: number; rate: number }) | null;
  /** Rt over the displayed history (days with enough data only). */
  rtSeries: RtPoint[];
  weeks: WeekForecast[];
  /** Eventual local cases in the next 14 days. */
  next14: Quantiles | null;
  /** Probability of at least one local case in the next 14 days. */
  pAny14: number | null;
}

export interface DailySeries {
  /** Epoch day of index 0. */
  start: number;
  /** Daily local / imported counts as known at the as-of day (index n − 1 = as-of day). */
  local: ArrayLike<number>;
  imported: ArrayLike<number>;
}

const HISTORY_WEEKS = 12;
const COMPLETE = 0.999;

/** Completeness by reporting lag: c[j] = P(published within j days of onset). */
export function completeness(p: ForecastParams): Float64Array {
  return cumulative(discreteGamma(p.delay.mean, p.delay.sd, p.delay.max, 0));
}

export function generationInterval(p: ForecastParams): Float64Array {
  return discreteGamma(p.gi.mean, p.gi.sd, p.gi.max, 1);
}

/** Λ_t from a (possibly partly simulated) series of total infectors. */
function infectivity(src: ArrayLike<number>, w: Float64Array, t: number): number {
  let s = 0;
  const m = Math.min(w.length - 1, t);
  for (let k = 1; k <= m; k++) s += w[k]! * src[t - k]!;
  return s;
}

export function forecastArea(series: DailySeries, p: ForecastParams, seed = p.seed): AreaForecast {
  const n = series.local.length;
  const T = n - 1;
  const asOf = series.start + T;
  const c = completeness(p);
  const w = generationInterval(p);
  const comp = (t: number) => {
    const lag = T - t;
    return lag >= c.length ? 1 : c[lag]!;
  };
  // Expected eventual counts for the infector series (simple inverse-completeness nowcast; floor 0.2 keeps
  // a single case on the last day from becoming five).
  const obsL = Float64Array.from(series.local), obsI = Float64Array.from(series.imported);
  const src = new Float64Array(n);
  for (let t = 0; t < n; t++) src[t] = obsL[t]! / Math.max(comp(t), 0.2) + p.importedWeight * (obsI[t]! / Math.max(comp(t), 0.2));
  const lam = new Float64Array(n);
  for (let t = 0; t < n; t++) lam[t] = infectivity(src, w, t);

  let recent28 = 0, recentImported28 = 0;
  for (let t = Math.max(0, T - 27); t <= T; t++) {
    recent28 += obsL[t]!;
    recentImported28 += obsI[t]!;
  }

  // ---- Rt posterior for windows ending on each displayed day
  const posterior = (end: number, win: number) => {
    let a = p.prior.shape, b = 1 / p.prior.scale, cases = 0;
    for (let t = Math.max(1, end - win + 1); t <= end; t++) {
      a += obsL[t]!;
      b += comp(t) * lam[t]!;
      cases += obsL[t]!;
    }
    return { shape: a, rate: b, cases, info: b - 1 / p.prior.scale };
  };
  const rtAt = (end: number, win = p.rtWindow): (RtPoint & { shape: number; rate: number }) | null => {
    const post = posterior(end, win);
    // Too little information: fewer than 5 cases in the window or almost no infectors (the prior dominates).
    if (post.cases < 5 || post.info < 2) return null;
    return {
      day: series.start + end,
      median: gammaQuantile(0.5, post.shape, post.rate),
      lo: gammaQuantile(0.025, post.shape, post.rate),
      hi: gammaQuantile(0.975, post.shape, post.rate),
      shape: post.shape,
      rate: post.rate,
    };
  };
  const rtSeries: RtPoint[] = [];
  for (let end = Math.max(p.rtWindow, T - HISTORY_WEEKS * 7 + 1); end <= T; end++) {
    const r = rtAt(end);
    if (r) rtSeries.push({ day: r.day, median: r.median, lo: r.lo, hi: r.hi });
  }
  // A waning outbreak can have too few cases in the last window: fall back to twice the window for the forecast.
  const rt = rtAt(T) ?? rtAt(T, 2 * p.rtWindow);

  // ---- observed history in 7-day blocks ending on the as-of day
  const weeks: WeekForecast[] = [];
  for (let b = HISTORY_WEEKS - 1; b >= 0; b--) {
    const end = T - 7 * b;
    let obs = 0, minComp = 1;
    for (let t = Math.max(0, end - 6); t <= end; t++) {
      obs += obsL[t]!;
      minComp = Math.min(minComp, comp(t));
    }
    weeks.push({ end: series.start + end, observed: obs, kind: minComp >= 0.95 ? 'past' : 'nowcast', q: null });
  }
  const H = p.horizon;
  for (let b = 1; b <= H / 7; b++) weeks.push({ end: asOf + 7 * b, observed: 0, kind: 'future', q: null });

  const status: AreaForecast['status'] = recent28 >= p.minCases && rt ? 'ok' : 'few';
  if (status !== 'ok' || !rt) return { asOf, status, recent28, recentImported28, rt, rtSeries, weeks, next14: null, pAny14: null };

  // ---- simulation
  const r = rng(seed);
  const nowcastFrom = Math.max(0, T - c.length + 1);
  const nowIdx = weeks.map((wk, i) => (wk.kind === 'nowcast' ? i : -1)).filter((i) => i >= 0);
  const futIdx = weeks.map((wk, i) => (wk.kind === 'future' ? i : -1)).filter((i) => i >= 0);
  const blockTotals = weeks.map(() => new Float64Array(p.sims));
  const next14 = new Float64Array(p.sims);
  let any14 = 0;
  // Future imported infectors: recent nowcasted daily mean.
  let impRate = 0;
  for (let t = Math.max(0, T - 27); t <= T; t++) impRate += obsI[t]! / Math.max(comp(t), 0.2);
  impRate /= Math.min(28, n);
  const path = new Float64Array(n + H); // total infectors (local + α·imported), simulated where unknown
  const localPath = new Float64Array(n + H);
  for (let s = 0; s < p.sims; s++) {
    const R0 = gamma(r, rt.shape, 1 / rt.rate);
    for (let t = 0; t < nowcastFrom; t++) {
      path[t] = src[t]!;
      localPath[t] = obsL[t]!;
    }
    // Complete the latest days: unobserved part ~ Poisson-gamma(R0 · Λ_t · (1 − c)).
    for (let t = nowcastFrom; t <= T; t++) {
      const ct = comp(t);
      let loc = obsL[t]!;
      if (ct < COMPLETE) {
        const lt = R0 * infectivity(path, w, t);
        const m = lt * (1 - ct);
        loc += m > 0 ? poisson(r, gamma(r, p.dispersion, m / p.dispersion)) : 0;
      }
      localPath[t] = loc;
      path[t] = loc + p.importedWeight * (obsI[t]! / Math.max(ct, 0.2));
    }
    let z = 0;
    for (let h = 1; h <= H; h++) {
      if (h % 7 === 1) z += p.rwSd * normal(r);
      const t = T + h;
      const R = Math.max(0, 1 + (R0 - 1) * Math.pow(p.damping, h / 7)) * Math.exp(z);
      const loc = negbin(r, R * infectivity(path, w, t), p.dispersion);
      localPath[t] = loc;
      path[t] = loc + p.importedWeight * poisson(r, impRate);
    }
    for (const i of [...nowIdx, ...futIdx]) {
      const end = weeks[i]!.end - series.start;
      let sum = 0;
      for (let t = end - 6; t <= end; t++) sum += localPath[t]!;
      blockTotals[i]![s] = sum;
    }
    let n14 = 0;
    for (let h = 1; h <= 14; h++) n14 += localPath[T + h]!;
    next14[s] = n14;
    if (n14 > 0) any14++;
  }
  for (const i of [...nowIdx, ...futIdx]) weeks[i]!.q = quantiles(blockTotals[i]!);
  return { asOf, status, recent28, recentImported28, rt, rtSeries, weeks, next14: quantiles(next14), pAny14: any14 / p.sims };
}

export function quantiles(samples: Float64Array): Quantiles {
  const s = Float64Array.from(samples).sort();
  const [q05, q25, q50, q75, q95] = QUANTILE_LEVELS.map((q) => quantileSorted(s, q)) as [number, number, number, number, number];
  return { q05, q25, q50, q75, q95 };
}
