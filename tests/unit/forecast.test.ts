import { describe, expect, it } from 'vitest';
import { mergeCaseYears } from '../../src/lib/aggregate';
import { epochDayOfDoy } from '../../src/lib/dates';
import { cumulative, discreteGamma, gammaP, gammaQuantile } from '../../src/lib/forecast/dist';
import { compass8, covEllipse, findFoci, linkClusters, type CaseRow } from '../../src/lib/forecast/foci';
import { completeness, forecastArea, generationInterval, type ForecastParams } from '../../src/lib/forecast/model';
import { BASE_PARAMS } from '../../src/lib/forecast/params';
import { negbin, rng } from '../../src/lib/forecast/random';
import { seriesOf, snapshotAt, truthBlocks } from '../../src/lib/forecast/snapshot';
import { DEFAULT_SURFACE, riskSurface } from '../../src/lib/forecast/surface';
import type { CasesYear } from '../../src/lib/types';

const P: ForecastParams = { ...BASE_PARAMS, sims: 400 };
const NO_DELAY: ForecastParams = { ...P, delay: { mean: 1, sd: 1, max: 0 } };

/** Expected-value renewal epidemic with constant R, seeded by `seed` cases on day 0. */
function renewal(R: number, days: number, p: ForecastParams, seed = 20): Float64Array {
  const w = generationInterval(p);
  const x = new Float64Array(days);
  for (let t = 0; t < 5; t++) x[t] = seed;
  for (let t = 5; t < days; t++) {
    let lam = 0;
    for (let k = 1; k < w.length && k <= t; k++) lam += w[k]! * x[t - k]!;
    x[t] = R * lam;
  }
  return x;
}

describe('forecast: distributions', () => {
  it('regularised incomplete gamma matches closed forms', () => {
    expect(gammaP(1, 2)).toBeCloseTo(1 - Math.exp(-2), 10);
    expect(gammaP(2, 1)).toBeCloseTo(1 - 2 / Math.E, 10);
    expect(gammaP(30, 45)).toBeGreaterThan(0.99);
    expect(gammaQuantile(0.5, 1, 1)).toBeCloseTo(Math.LN2, 6);
  });
  it('discretised gamma is a pmf with about the requested mean', () => {
    const p = discreteGamma(16, 5, 40, 1);
    expect(p[0]).toBe(0);
    expect(cumulative(p)[40]).toBeCloseTo(1, 10);
    const mean = [...p].reduce((s, v, d) => s + v * d, 0);
    expect(mean).toBeGreaterThan(15.3);
    expect(mean).toBeLessThan(16.7);
  });
  it('negative binomial has the requested mean and overdispersion', () => {
    const r = rng(7);
    const xs = Array.from({ length: 20000 }, () => negbin(r, 10, 2));
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
    expect(m).toBeGreaterThan(9.6);
    expect(m).toBeLessThan(10.4);
    expect(v).toBeGreaterThan(50); // Poisson would be ~10; NB(k=2): 10 + 100/2 = 60
    expect(v).toBeLessThan(70);
  });
  it('the random stream is deterministic per seed', () => {
    const a = rng(42), b = rng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('forecast: Rt and projection', () => {
  it('recovers a constant R from a complete series', () => {
    const x = renewal(1.5, 120, NO_DELAY);
    const f = forecastArea({ start: 0, local: x.map(Math.round), imported: new Float64Array(120) }, NO_DELAY);
    expect(f.status).toBe('ok');
    expect(f.rt!.median).toBeGreaterThan(1.4);
    expect(f.rt!.median).toBeLessThan(1.6);
    expect(f.rt!.lo).toBeLessThan(f.rt!.median);
    expect(f.rt!.hi).toBeGreaterThan(f.rt!.median);
  });
  it('accounts for reporting delay: thinned recent days do not read as a decline', () => {
    const x = renewal(1.3, 120, P);
    const c = completeness(P);
    const T = 119;
    const obs = x.map((v, t) => Math.round(v * (T - t >= c.length ? 1 : c[T - t]!)));
    const naive = forecastArea({ start: 0, local: obs, imported: new Float64Array(120) }, NO_DELAY);
    const aware = forecastArea({ start: 0, local: obs, imported: new Float64Array(120) }, P);
    expect(naive.rt!.median).toBeLessThan(1.1); // ignoring the delay: a spurious decline
    expect(aware.rt!.median).toBeGreaterThan(1.15);
    expect(aware.rt!.median).toBeLessThan(1.45);
    // The nowcast block's median is above what has been observed so far.
    const now = aware.weeks.find((w) => w.kind === 'nowcast' && w.end === T)!;
    expect(now.q!.q50).toBeGreaterThan(now.observed);
  });
  it('projects a stable level when R ≈ 1, with ordered quantiles', () => {
    const x = renewal(1, 140, NO_DELAY, 10);
    const f = forecastArea({ start: 0, local: x.map(Math.round), imported: new Float64Array(140) }, NO_DELAY);
    const fut = f.weeks.filter((w) => w.kind === 'future');
    const last = f.weeks.filter((w) => w.kind !== 'future').at(-1)!.observed;
    expect(fut).toHaveLength(4);
    for (const w of fut) {
      expect(w.q!.q05).toBeLessThanOrEqual(w.q!.q25);
      expect(w.q!.q25).toBeLessThanOrEqual(w.q!.q50);
      expect(w.q!.q50).toBeLessThanOrEqual(w.q!.q75);
      expect(w.q!.q75).toBeLessThanOrEqual(w.q!.q95);
      expect(w.q!.q50).toBeGreaterThan(0.6 * last);
      expect(w.q!.q50).toBeLessThan(1.6 * last);
    }
    expect(f.pAny14).toBe(1);
  });
  it('declines to forecast with too few cases', () => {
    const local = new Float64Array(100);
    local[90] = 1;
    local[95] = 2;
    const f = forecastArea({ start: 0, local, imported: new Float64Array(100) }, P);
    expect(f.status).toBe('few');
    expect(f.next14).toBeNull();
    expect(f.weeks.filter((w) => w.kind === 'future').every((w) => w.q === null)).toBe(true);
  });
  it('is deterministic', () => {
    const x = renewal(1.2, 100, P).map(Math.round);
    const a = forecastArea({ start: 0, local: x, imported: new Float64Array(100) }, P);
    const b = forecastArea({ start: 0, local: x, imported: new Float64Array(100) }, P);
    expect(a).toEqual(b);
  });
});

describe('forecast: foci', () => {
  const rows = (lng: number, lat: number, days: number[], dLngPerDay = 0): CaseRow[] =>
    days.map((d) => ({ lng: lng + dLngPerDay * d, lat, day: d, n: 1, town: '67000330' }));

  it('links nearby cases and keeps distant groups apart', () => {
    const xs = Float64Array.from([0, 500, 1000, 10000, 10400]), ys = new Float64Array(5);
    const g = linkClusters(xs, ys, 800);
    expect(g[0]).toBe(g[2]);
    expect(g[3]).toBe(g[4]);
    expect(g[0]).not.toBe(g[3]);
  });
  it('finds two foci and reports an eastward drift only for the moving one', () => {
    const days = Array.from({ length: 28 }, (_, i) => 100 - 27 + i);
    // ~1 km east over 4 weeks (≈ 36 m/day); a second, stationary focus 30 km away.
    const moving = rows(120.2, 23.0, days, 0.00035).map((r) => ({ ...r, lng: r.lng - 0.00035 * 73 }));
    const still = rows(120.5, 23.2, days).map((r, i) => ({ ...r, lat: r.lat + (i % 3) * 0.001 }));
    const foci = findFoci([...moving, ...still], 100);
    expect(foci).toHaveLength(2);
    const mv = foci.find((f) => f.direction)!;
    expect(mv).toBeTruthy();
    expect(compass8(mv.direction!.bearing)).toBe(2); // east
    expect(mv.track).toHaveLength(4);
    expect(mv.track[3]!.lng).toBeGreaterThan(mv.track[0]!.lng);
    const st = foci.find((f) => f !== mv)!;
    expect(st.direction).toBeNull();
    expect(st.last14!.areaKm2).toBeGreaterThan(0);
  });
  it('covariance ellipse: floor for a single point, closed ring', () => {
    const proj = { x: (l: number) => l, y: (l: number) => l, lng: (x: number) => x, lat: (y: number) => y };
    const e = covEllipse([0], [0], [1], proj, 100, 0.9)!;
    expect(e.areaKm2).toBeCloseTo((Math.PI * 100 * 100) / 1e6, 6);
    expect(e.ring[0]).toEqual(e.ring[e.ring.length - 1]);
  });
  it('compass8 wraps', () => {
    expect(compass8(0)).toBe(0);
    expect(compass8(359)).toBe(0);
    expect(compass8(90)).toBe(2);
    expect(compass8(225)).toBe(5);
  });
});

describe('forecast: snapshots', () => {
  const year: CasesYear = {
    year: 2015,
    pts: [[120.2, 23.0, '67000330'], [120.3, 22.6, '64000010']],
    c: [[200, 0, 0, 30], [205, 1, 0, 20], [210, 0, 1, 5], [215, 0, 0, 40]],
  } as CasesYear;
  const set = mergeCaseYears([year]);
  const asOf = epochDayOfDoy(2015, 215);

  it('thins recent rows with the delay and keeps old rows', () => {
    const c = completeness(P);
    const full = snapshotAt(set, asOf, asOf - 30, null);
    const thin = snapshotAt(set, asOf, asOf - 30, c, 3);
    const sum = (s: typeof full) => Array.from(s.n.subarray(0, s.length)).reduce((a, b) => a + b, 0);
    expect(sum(full)).toBe(95);
    expect(sum(thin)).toBeLessThan(95);
    expect(sum(thin)).toBeGreaterThanOrEqual(30); // day 200 (15 days back) is ~complete
    expect(snapshotAt(set, asOf, asOf - 30, c, 3)).toEqual(thin);
  });
  it('series and truth per county', () => {
    const snap = snapshotAt(set, asOf, asOf - 30, null);
    const s = seriesOf(set, snap, '67000', asOf - 20);
    expect(Array.from(s.local).reduce((a, b) => a + b, 0)).toBe(70);
    expect(Array.from(s.imported).reduce((a, b) => a + b, 0)).toBe(5);
    expect(truthBlocks(set, '64000', [asOf - 7, asOf])).toEqual([20, 0]);
  });
});

describe('forecast: risk surface', () => {
  const S = { ...DEFAULT_SURFACE, sigma1M: 300, sigma2M: 1500, rho: 0.3, beta: 0.2 };
  it('spreads one infector into nested 50 % / 90 % regions that hold the point', () => {
    const surf = riskSurface([{ lng: 120.2, lat: 23.0, w: 1 }], [], S)!;
    const total = surf.allCells().reduce((s, c) => s + c.share, 0);
    expect(total).toBeGreaterThan(0.97);
    expect(total).toBeLessThan(1.001);
    expect(surf.locate(120.2, 23.0)!.cls).toBe(1);
    expect(surf.area50Km2).toBeGreaterThan(0);
    expect(surf.area90Km2).toBeGreaterThan(surf.area50Km2);
    expect(surf.locate(121.5, 25.0)).toBeNull(); // far away: off every grid
    const far = surf.locate(120.2 + 0.03, 23.0)!; // ~3 km east
    expect(far.cls).toBe(3);
  });
  it('weights infectors: the 50 % region sits on the heavier one', () => {
    const surf = riskSurface([{ lng: 120.2, lat: 23.0, w: 10 }, { lng: 120.3, lat: 23.0, w: 1 }], [], S)!;
    expect(surf.locate(120.2, 23.0)!.cls).toBe(1);
    expect(surf.locate(120.3, 23.0)!.share).toBeLessThan(surf.locate(120.2, 23.0)!.share);
  });
  it('puts β of the mass around earlier cases, and all of it when there are no infectors', () => {
    const only = riskSurface([], [{ lng: 120.5, lat: 23.2, w: 3 }], S)!;
    expect(only.locate(120.5, 23.2)!.cls).toBe(1);
    expect(riskSurface([], [], S)).toBeNull();
  });
  it('per-cell probability grows with the simulated totals', () => {
    const low = riskSurface([{ lng: 120.2, lat: 23.0, w: 1 }], [], S, Float64Array.from({ length: 100 }, () => 2))!;
    const high = riskSurface([{ lng: 120.2, lat: 23.0, w: 1 }], [], S, Float64Array.from({ length: 100 }, () => 50))!;
    expect(high.cells[0]!.pAny!).toBeGreaterThan(low.cells[0]!.pAny!);
    expect(high.cells[0]!.pAny!).toBeLessThanOrEqual(1);
    expect(high.cells[0]!.expected).toBeCloseTo(50 * high.cells[0]!.share, 6);
  });
});
