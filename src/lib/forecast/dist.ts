// Gamma distribution helpers: the generation interval and the onset-to-publication delay are discretised
// gamma distributions; the Rt posterior is a gamma distribution (conjugate to the Poisson renewal likelihood).

/** ln Γ(x), Lanczos approximation (x > 0). */
export function lnGamma(x: number): number {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularised lower incomplete gamma P(a, x): series below a + 1, continued fraction above. */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (!Number.isFinite(x)) return 1;
  const lnPre = a * Math.log(x) - x - lnGamma(a);
  if (x < a + 1) {
    let sum = 1 / a, term = sum, ap = a;
    for (let n = 0; n < 500; n++) {
      ap += 1;
      term *= x / ap;
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return Math.min(1, sum * Math.exp(lnPre));
  }
  // Lentz's continued fraction for Q(a, x).
  let b = x + 1 - a, c = 1e300, d = 1 / b, hh = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    hh *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.max(0, 1 - Math.exp(lnPre) * hh);
}

/** CDF of a gamma distribution given its mean and standard deviation. */
export function gammaCdfMeanSd(x: number, mean: number, sd: number): number {
  const shape = (mean / sd) ** 2, scale = (sd * sd) / mean;
  return gammaP(shape, x / scale);
}

/**
 * Discretised gamma pmf on days 0..max: p[d] = F(d + 0.5) − F(d − 0.5) (day 0 gets F(0.5)),
 * renormalised so the truncated pmf sums to 1. With `minDay` = 1 (generation interval), day 0 is 0.
 */
export function discreteGamma(mean: number, sd: number, max: number, minDay = 0): Float64Array {
  const p = new Float64Array(max + 1);
  let sum = 0;
  for (let d = minDay; d <= max; d++) {
    const lo = d === minDay ? 0 : d - 0.5;
    p[d] = gammaCdfMeanSd(d + 0.5, mean, sd) - gammaCdfMeanSd(lo, mean, sd);
    sum += p[d]!;
  }
  for (let d = 0; d <= max; d++) p[d] = sum > 0 ? p[d]! / sum : 0;
  return p;
}

/** Running sum of a pmf: cdf[d] = P(X ≤ d). */
export function cumulative(p: ArrayLike<number>): Float64Array {
  const out = new Float64Array(p.length);
  let s = 0;
  for (let i = 0; i < p.length; i++) out[i] = s += p[i]!;
  return out;
}

/** Quantile of Gamma(shape, rate) by bisection on the CDF. */
export function gammaQuantile(q: number, shape: number, rate: number): number {
  if (!(shape > 0) || !(rate > 0)) return NaN;
  let lo = 0, hi = Math.max(1, (shape / rate) * 10);
  while (gammaP(shape, hi * rate) < q) hi *= 2;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (gammaP(shape, mid * rate) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
