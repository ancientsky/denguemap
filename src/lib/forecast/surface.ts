// Where the next 14 days' cases are likely to occur: the area total from the renewal model (model.ts) spread
// over a grid by a self-exciting (Hawkes-type) kernel. Each recent case contributes its remaining infectivity
// over the next 14 days (generation interval, completed for reporting delay), spread by a two-scale Gaussian
// (short range: mosquitoes and neighbourhood; long range: people moving); a share β goes to earlier foci of the
// season (reactivation). Gaussians are separable, so the density is two 1-D blurs of a rasterised case grid.
//
// Output: the share of expected cases per cell, the highest-density regions holding 50 % and 90 % of them,
// and per-cell P(≥ 1 case in 14 days) integrated over the simulated area totals.
import type { CaseSet } from '../aggregate';
import { projection, type Proj } from './foci';
import type { ForecastParams } from './model';
import { completeness, generationInterval } from './model';
import type { Snapshot } from './snapshot';

export interface SurfaceParams {
  cellM: number;
  /** Short- and long-range kernel scales (m) and the long-range share. */
  sigma1M: number;
  sigma2M: number;
  rho: number;
  /** Share of the expected cases placed around the season's earlier cases (days −140 … −29). */
  beta: number;
}

export const DEFAULT_SURFACE: SurfaceParams = { cellM: 250, sigma1M: 300, sigma2M: 2000, rho: 0.3, beta: 0.1 };

const MAX_CELLS = 250_000;
const DAYS = 14;

interface Grid {
  proj: Proj;
  x0: number;
  y0: number;
  cellM: number;
  nx: number;
  ny: number;
  /** Share of the expected cases per cell (all grids together sum to ~1). */
  d: Float64Array;
}

export interface RiskCell {
  /** Closed ring [lng, lat]. */
  ring: [number, number][];
  share: number;
  /** 1: within the 50 % region, 2: within the 90 % region. */
  cls: 1 | 2;
  /** P(at least one case in the cell within 14 days); null without simulated totals. */
  pAny: number | null;
  /** Expected cases (median total × share). */
  expected: number | null;
}

export interface RiskSurface {
  cellM: number;
  cells: RiskCell[];
  area50Km2: number;
  area90Km2: number;
  /** Share and class of the cell holding a point (cls 3 = outside the 90 % region, null = off every grid). */
  locate(lng: number, lat: number): { share: number; cls: 1 | 2 | 3 } | null;
  /** Share of the expected cases per cell, for every cell with any (backtest). */
  allCells(): { lng: number; lat: number; share: number }[];
}

interface Pt {
  lng: number;
  lat: number;
  w: number;
}

/** 1-D Gaussian blur along rows (dir 0) or columns (dir 1), truncated at 3σ, mass-preserving inside the grid. */
function blur(src: Float64Array, nx: number, ny: number, sigmaCells: number, dir: 0 | 1): Float64Array {
  const r = Math.max(1, Math.ceil(3 * sigmaCells));
  const k = new Float64Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) ks += k[i + r] = Math.exp(-(i * i) / (2 * sigmaCells * sigmaCells));
  for (let i = 0; i < k.length; i++) k[i]! /= ks;
  const out = new Float64Array(src.length);
  if (dir === 0) {
    for (let y = 0; y < ny; y++) {
      const row = y * nx;
      for (let x = 0; x < nx; x++) {
        const v = src[row + x]!;
        if (!v) continue;
        const a = Math.max(0, x - r), b = Math.min(nx - 1, x + r);
        for (let j = a; j <= b; j++) out[row + j]! += v * k[j - x + r]!;
      }
    }
  } else {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const v = src[y * nx + x]!;
        if (!v) continue;
        const a = Math.max(0, y - r), b = Math.min(ny - 1, y + r);
        for (let j = a; j <= b; j++) out[j * nx + x]! += v * k[j - y + r]!;
      }
    }
  }
  return out;
}

const gauss2d = (g: Float64Array, nx: number, ny: number, sigmaCells: number) => blur(blur(g, nx, ny, sigmaCells, 0), nx, ny, sigmaCells, 1);

/**
 * Infectors (local + α · imported, completed for reporting delay, weighted by their remaining generation-interval
 * mass over the next 14 days) and the season's earlier local cases, from a snapshot.
 */
export function surfacePoints(set: CaseSet, snap: Snapshot, county: string | null, p: ForecastParams): { infectors: Pt[]; older: Pt[] } {
  const gi = generationInterval(p), comp = completeness(p);
  const T = snap.asOf;
  const infectors: Pt[] = [], older: Pt[] = [];
  for (let i = 0; i < snap.length; i++) {
    const pt = set.pts[snap.pt[i]!];
    if (!pt) continue;
    if (county && pt[2]?.slice(0, 5) !== county) continue;
    const d = snap.day[i]!, n = snap.n[i]!, imp = snap.imp[i]!;
    let rem = 0;
    for (let h = 1; h <= DAYS; h++) {
      const lag = T + h - d;
      if (lag < gi.length) rem += gi[lag]!;
    }
    if (rem > 0) {
      const lag = T - d;
      const c = lag >= comp.length ? 1 : comp[lag]!;
      infectors.push({ lng: pt[0], lat: pt[1], w: (n / Math.max(c, 0.2)) * (imp ? p.importedWeight : 1) * rem });
    } else if (!imp && d > T - 140 && d <= T - 28) older.push({ lng: pt[0], lat: pt[1], w: n });
  }
  return { infectors, older };
}

/**
 * Risk surface for the next 14 days. `samples14` are simulated area totals (model.ts samples14); without them
 * only shares and regions are computed (enough for the backtest's spatial scores).
 */
export function riskSurface(infectors: readonly Pt[], older: readonly Pt[], sp: SurfaceParams = DEFAULT_SURFACE, samples14: Float64Array | null = null): RiskSurface | null {
  const wA = infectors.reduce((s, q) => s + q.w, 0), wB = older.reduce((s, q) => s + q.w, 0);
  if (wA <= 0 && wB <= 0) return null;
  const beta = wA <= 0 ? 1 : wB <= 0 ? 0 : sp.beta;
  const all = [...infectors.map((q) => ({ ...q, a: true })), ...older.map((q) => ({ ...q, a: false }))];
  let lng0 = 0, lat0 = 0;
  for (const q of all) {
    lng0 += q.lng;
    lat0 += q.lat;
  }
  const proj0 = projection(lng0 / all.length, lat0 / all.length);
  const xs = Float64Array.from(all, (q) => proj0.x(q.lng)), ys = Float64Array.from(all, (q) => proj0.y(q.lat));
  // Separate grids for groups of points more than ~3σ₂ apart (whole-Taiwan views stay small).
  const margin = 3 * sp.sigma2M;
  const groups = coarseGroups(xs, ys, margin);
  const grids: Grid[] = [];
  for (const idx of groups) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const i of idx) {
      minX = Math.min(minX, xs[i]!);
      maxX = Math.max(maxX, xs[i]!);
      minY = Math.min(minY, ys[i]!);
      maxY = Math.max(maxY, ys[i]!);
    }
    let cellM = sp.cellM;
    const span = () => ((maxX - minX + 2 * margin) / cellM + 1) * ((maxY - minY + 2 * margin) / cellM + 1);
    while (span() > MAX_CELLS) cellM *= 1.5;
    const x0 = minX - margin, y0 = minY - margin;
    const nx = Math.ceil((maxX - minX + 2 * margin) / cellM) + 1, ny = Math.ceil((maxY - minY + 2 * margin) / cellM) + 1;
    const A = new Float64Array(nx * ny), B = new Float64Array(nx * ny);
    for (const i of idx) {
      const cx = Math.floor((xs[i]! - x0) / cellM), cy = Math.floor((ys[i]! - y0) / cellM);
      (all[i]!.a ? A : B)[cy * nx + cx]! += all[i]!.w;
    }
    // d = (1 − β)(1 − ρ)·G₁(A)/ΣA + G₂((1 − β)ρ·A/ΣA + β·B/ΣB): one blur per scale.
    const near = new Float64Array(nx * ny), wide = new Float64Array(nx * ny);
    for (let c = 0; c < A.length; c++) {
      if (A[c]) near[c] = ((1 - beta) * (1 - sp.rho) * A[c]!) / wA;
      if (A[c] || B[c]) wide[c] = (A[c] ? ((1 - beta) * sp.rho * A[c]!) / wA : 0) + (B[c] ? (beta * B[c]!) / wB : 0);
    }
    const g1 = gauss2d(near, nx, ny, sp.sigma1M / cellM), g2 = gauss2d(wide, nx, ny, sp.sigma2M / cellM);
    const d = new Float64Array(nx * ny);
    for (let c = 0; c < d.length; c++) d[c] = g1[c]! + g2[c]!;
    grids.push({ proj: proj0, x0, y0, cellM, nx, ny, d });
  }

  // Highest-density regions over all grids.
  const order: { g: number; c: number; v: number }[] = [];
  grids.forEach((gr, g) => gr.d.forEach((v, c) => v > 1e-9 && order.push({ g, c, v })));
  order.sort((p, q) => q.v - p.v);
  const cls = grids.map((gr) => new Uint8Array(gr.d.length).fill(3));
  let cum = 0, area50 = 0, area90 = 0;
  const cells: RiskCell[] = [];
  const draws = samples14 ? Array.from(samples14).filter((_, i) => i % 5 === 0) : null;
  const median = samples14 ? Float64Array.from(samples14).sort()[Math.floor(samples14.length / 2)]! : null;
  for (const o of order) {
    if (cum >= 0.9) break;
    const c: 1 | 2 = cum < 0.5 ? 1 : 2;
    cum += o.v;
    const gr = grids[o.g]!;
    cls[o.g]![o.c] = c;
    const km2 = (gr.cellM * gr.cellM) / 1e6;
    if (c === 1) area50 += km2;
    area90 += km2;
    const cx = o.c % gr.nx, cy = Math.floor(o.c / gr.nx);
    const X = gr.x0 + cx * gr.cellM, Y = gr.y0 + cy * gr.cellM;
    const corner = (dx: number, dy: number): [number, number] => [round6(gr.proj.lng(X + dx)), round6(gr.proj.lat(Y + dy))];
    let pAny: number | null = null;
    if (draws) {
      let s = 0;
      for (const n of draws) s += 1 - Math.exp(-n * o.v);
      pAny = s / draws.length;
    }
    cells.push({ ring: [corner(0, 0), corner(gr.cellM, 0), corner(gr.cellM, gr.cellM), corner(0, gr.cellM), corner(0, 0)], share: o.v, cls: c, pAny, expected: median == null ? null : median * o.v });
  }
  return {
    cellM: Math.max(...grids.map((g) => g.cellM)),
    cells,
    area50Km2: area50,
    area90Km2: area90,
    locate(lng, lat) {
      for (let g = 0; g < grids.length; g++) {
        const gr = grids[g]!;
        const cx = Math.floor((gr.proj.x(lng) - gr.x0) / gr.cellM), cy = Math.floor((gr.proj.y(lat) - gr.y0) / gr.cellM);
        if (cx < 0 || cy < 0 || cx >= gr.nx || cy >= gr.ny) continue;
        const c = cy * gr.nx + cx;
        return { share: gr.d[c]!, cls: cls[g]![c] as 1 | 2 | 3 };
      }
      return null;
    },
    allCells() {
      const out: { lng: number; lat: number; share: number }[] = [];
      for (const gr of grids) {
        gr.d.forEach((v, c) => {
          if (v <= 1e-9) return;
          const cx = c % gr.nx, cy = Math.floor(c / gr.nx);
          out.push({ lng: gr.proj.lng(gr.x0 + (cx + 0.5) * gr.cellM), lat: gr.proj.lat(gr.y0 + (cy + 0.5) * gr.cellM), share: v });
        });
      }
      return out;
    },
  };
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Groups of points whose coarse cells (size `size`) touch: O(n), unlike pairwise linking, which turns quadratic
 * when thousands of cases share a few cells. Only used to size the grids, so the coarser rule is fine.
 */
function coarseGroups(xs: Float64Array, ys: Float64Array, size: number): number[][] {
  const cellOf = new Map<string, number>();
  const keys: [number, number][] = [];
  const pointCell = new Int32Array(xs.length);
  for (let i = 0; i < xs.length; i++) {
    const cx = Math.floor(xs[i]! / size), cy = Math.floor(ys[i]! / size);
    const k = `${cx},${cy}`;
    let id = cellOf.get(k);
    if (id === undefined) {
      id = keys.length;
      cellOf.set(k, id);
      keys.push([cx, cy]);
    }
    pointCell[i] = id;
  }
  const parent = Int32Array.from({ length: keys.length }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  keys.forEach(([cx, cy], id) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const j = cellOf.get(`${cx + dx},${cy + dy}`);
        if (j === undefined) continue;
        const a = find(id), b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
  });
  const groups = new Map<number, number[]>();
  for (let i = 0; i < xs.length; i++) {
    const r = find(pointCell[i]!);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  return [...groups.values()];
}
