// Seeded random numbers and the distributions the forecast simulation needs (deterministic: same input,
// same seed → same forecast, so unit tests, backtests and the page agree).

export type Rng = () => number;

/** mulberry32: small, fast, good enough for Monte Carlo of this size. Returns [0, 1). */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal (Box–Muller). */
export function normal(r: Rng): number {
  let u = 0;
  while (u <= 1e-12) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** Gamma(shape, scale) by Marsaglia–Tsang (shape < 1 via the boost u^(1/shape)). */
export function gamma(r: Rng, shape: number, scale: number): number {
  if (!(shape > 0) || !(scale > 0)) return 0;
  if (shape < 1) return gamma(r, shape + 1, scale) * Math.pow(Math.max(r(), 1e-12), 1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      x = normal(r);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

/** Poisson(mean): inversion for small means, normal approximation (rounded, ≥ 0) above 60. */
export function poisson(r: Rng, mean: number): number {
  if (!(mean > 0)) return 0;
  if (mean > 60) return Math.max(0, Math.round(mean + Math.sqrt(mean) * normal(r)));
  const L = Math.exp(-mean);
  let k = 0, p = r();
  while (p > L) {
    k++;
    p *= r();
  }
  return k;
}

/** Negative binomial with mean `mean` and dispersion `k` (variance mean + mean²/k), as a gamma–Poisson mixture. */
export function negbin(r: Rng, mean: number, k: number): number {
  if (!(mean > 0)) return 0;
  return poisson(r, gamma(r, k, mean / k));
}

/** Binomial(n, p): exact for small n, normal approximation for large n. */
export function binomial(r: Rng, n: number, p: number): number {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  if (n < 50) {
    let k = 0;
    for (let i = 0; i < n; i++) if (r() < p) k++;
    return k;
  }
  const m = n * p, s = Math.sqrt(m * (1 - p));
  return Math.min(n, Math.max(0, Math.round(m + s * normal(r))));
}

/** Quantile (type 7, linear interpolation) of an already sorted array. */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  const pos = (n - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
