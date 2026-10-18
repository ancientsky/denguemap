// Spatial side of the forecast: where the recent local cases are, which way each focus is moving and how
// far it extends. Descriptive statistics only (no model): single-linkage foci, the weekly centroid track,
// a weighted regression of position on onset day (direction and speed), and covariance ellipses for the
// last 14 days against the 14 days before (expanding or shrinking).

export interface CaseRow {
  lng: number;
  lat: number;
  /** Onset, epoch day. */
  day: number;
  n: number;
  town: string | null;
}

export interface FociParams {
  /** Cases closer than this (m) belong to the same focus. */
  linkM: number;
  /** Smallest focus shown. */
  minCases: number;
  /** Floor added to each ellipse axis (m): statistical-area centroids are approximate, a lone case is not a point. */
  floorM: number;
  /** Probability mass of the covariance ellipse (bivariate-normal reading). */
  mass: number;
  /** Minimum cases and projected 14-day displacement (m) before a direction is reported. */
  dirMinCases: number;
  dirMinShiftM: number;
}

export const DEFAULT_FOCI: FociParams = { linkM: 800, minCases: 3, floorM: 100, mass: 0.9, dirMinCases: 8, dirMinShiftM: 200 };

export interface Ellipse {
  center: [number, number];
  /** Closed ring, [lng, lat]. */
  ring: [number, number][];
  areaKm2: number;
  cases: number;
}

export interface Focus {
  cases: number;
  /** Cases in the last 14 days of the 28-day window. */
  cases14: number;
  /** Town code with the most cases (for naming), and how many towns the focus touches. */
  town: string | null;
  towns: number;
  bbox: [number, number, number, number];
  /** Weekly (7-day blocks ending on the as-of day, oldest first) weighted centroids; blocks without cases are skipped. */
  track: { end: number; lng: number; lat: number; n: number }[];
  last14: Ellipse | null;
  prev14: Ellipse | null;
  /** Movement of the case centroid: metres per day east/north, with a significance flag. */
  velocity: { east: number; north: number; z: number } | null;
  /** Bearing (degrees clockwise from north) and projected 14-day displacement when the movement is clear. */
  direction: { bearing: number; shift14M: number; to: [number, number] } | null;
}

const M_PER_DEG_LAT = 110_574;
const mPerDegLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

interface Proj {
  x: (lng: number) => number;
  y: (lat: number) => number;
  lng: (x: number) => number;
  lat: (y: number) => number;
}
function projection(lng0: number, lat0: number): Proj {
  const kx = mPerDegLng(lat0);
  return { x: (l) => (l - lng0) * kx, y: (l) => (l - lat0) * M_PER_DEG_LAT, lng: (x) => lng0 + x / kx, lat: (y) => lat0 + y / M_PER_DEG_LAT };
}

/** Group cases into foci by single linkage (grid hash + union–find, O(n) for bounded density). */
export function linkClusters(xs: Float64Array, ys: Float64Array, linkM: number): Int32Array {
  const n = xs.length;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const grid = new Map<string, number[]>();
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(xs[i]! / linkM), cy = Math.floor(ys[i]! / linkM);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(key(cx + dx, cy + dy)) ?? []) {
          if ((xs[i]! - xs[j]!) ** 2 + (ys[i]! - ys[j]!) ** 2 <= linkM * linkM) {
            const a = find(i), b = find(j);
            if (a !== b) parent[a] = b;
          }
        }
      }
    }
    const k = key(cx, cy);
    const cell = grid.get(k);
    if (cell) cell.push(i);
    else grid.set(k, [i]);
  }
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = find(i);
  return out;
}

/** Weighted covariance ellipse holding `mass` of a bivariate normal, as a lng/lat ring. */
export function covEllipse(xs: number[], ys: number[], ws: number[], proj: Proj, floorM: number, mass: number): Ellipse | null {
  let W = 0, mx = 0, my = 0;
  for (let i = 0; i < xs.length; i++) {
    W += ws[i]!;
    mx += ws[i]! * xs[i]!;
    my += ws[i]! * ys[i]!;
  }
  if (W <= 0) return null;
  mx /= W;
  my /= W;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx, dy = ys[i]! - my;
    sxx += ws[i]! * dx * dx;
    syy += ws[i]! * dy * dy;
    sxy += ws[i]! * dx * dy;
  }
  sxx /= W;
  syy /= W;
  sxy /= W;
  // Eigen-decomposition of the 2×2 covariance.
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc);
  const theta = Math.abs(sxy) < 1e-9 ? (sxx >= syy ? 0 : Math.PI / 2) : Math.atan2(l1 - sxx, sxy);
  const k = Math.sqrt(-2 * Math.log(1 - mass));
  const a = Math.sqrt(k * k * l1 + floorM * floorM), b = Math.sqrt(k * k * l2 + floorM * floorM);
  const ring: [number, number][] = [];
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const u = (2 * Math.PI * (i % N)) / N;
    const ex = a * Math.cos(u), ey = b * Math.sin(u);
    const x = mx + ex * Math.cos(theta) - ey * Math.sin(theta);
    const y = my + ex * Math.sin(theta) + ey * Math.cos(theta);
    ring.push([round5(proj.lng(x)), round5(proj.lat(y))]);
  }
  return { center: [round5(proj.lng(mx)), round5(proj.lat(my))], ring, areaKm2: (Math.PI * a * b) / 1e6, cases: W };
}

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

/**
 * Foci of the local cases with onset in [asOf − 27, asOf]. Sorted by cases in the last 14 days, then all cases.
 */
export function findFoci(rows: readonly CaseRow[], asOf: number, p: FociParams = DEFAULT_FOCI): Focus[] {
  const recent = rows.filter((r) => r.day <= asOf && r.day > asOf - 28 && r.n > 0);
  if (!recent.length) return [];
  let lng0 = 0, lat0 = 0;
  for (const r of recent) {
    lng0 += r.lng;
    lat0 += r.lat;
  }
  const proj0 = projection(lng0 / recent.length, lat0 / recent.length);
  const xs = Float64Array.from(recent, (r) => proj0.x(r.lng)), ys = Float64Array.from(recent, (r) => proj0.y(r.lat));
  const root = linkClusters(xs, ys, p.linkM);
  const groups = new Map<number, number[]>();
  root.forEach((g, i) => {
    const a = groups.get(g);
    if (a) a.push(i);
    else groups.set(g, [i]);
  });
  const foci: Focus[] = [];
  for (const idx of groups.values()) {
    const members = idx.map((i) => recent[i]!);
    const cases = members.reduce((s, r) => s + r.n, 0);
    if (cases < p.minCases) continue;
    foci.push(describeFocus(members, asOf, p));
  }
  return foci.sort((a, b) => b.cases14 - a.cases14 || b.cases - a.cases);
}

function describeFocus(members: CaseRow[], asOf: number, p: FociParams): Focus {
  let W = 0, lng0 = 0, lat0 = 0;
  const towns = new Map<string, number>();
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const r of members) {
    W += r.n;
    lng0 += r.n * r.lng;
    lat0 += r.n * r.lat;
    if (r.town) towns.set(r.town, (towns.get(r.town) ?? 0) + r.n);
    minLng = Math.min(minLng, r.lng);
    minLat = Math.min(minLat, r.lat);
    maxLng = Math.max(maxLng, r.lng);
    maxLat = Math.max(maxLat, r.lat);
  }
  const proj = projection(lng0 / W, lat0 / W);
  const town = [...towns.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

  // Weekly centroid track (blocks ending asOf − 21, −14, −7, 0).
  const track: Focus['track'] = [];
  for (let b = 3; b >= 0; b--) {
    const end = asOf - 7 * b;
    let n = 0, x = 0, y = 0;
    for (const r of members) {
      if (r.day > end - 7 && r.day <= end) {
        n += r.n;
        x += r.n * proj.x(r.lng);
        y += r.n * proj.y(r.lat);
      }
    }
    if (n) track.push({ end, lng: round5(proj.lng(x / n)), lat: round5(proj.lat(y / n)), n });
  }

  const split = (from: number, to: number) => {
    const sel = members.filter((r) => r.day > from && r.day <= to);
    return covEllipse(sel.map((r) => proj.x(r.lng)), sel.map((r) => proj.y(r.lat)), sel.map((r) => r.n), proj, p.floorM, p.mass);
  };
  const last14 = split(asOf - 14, asOf);
  const prev14 = split(asOf - 28, asOf - 14);
  const cases14 = members.reduce((s, r) => s + (r.day > asOf - 14 ? r.n : 0), 0);

  // Weighted least squares of position on onset day (each case is one observation).
  let velocity: Focus['velocity'] = null, direction: Focus['direction'] = null;
  let tbar = 0;
  for (const r of members) tbar += r.n * r.day;
  tbar /= W;
  let stt = 0, sxt = 0, syt = 0, xbar = 0, ybar = 0;
  for (const r of members) {
    xbar += r.n * proj.x(r.lng);
    ybar += r.n * proj.y(r.lat);
  }
  xbar /= W;
  ybar /= W;
  for (const r of members) {
    const dt = r.day - tbar;
    stt += r.n * dt * dt;
    sxt += r.n * dt * (proj.x(r.lng) - xbar);
    syt += r.n * dt * (proj.y(r.lat) - ybar);
  }
  if (W >= 3 && stt > 0) {
    const bx = sxt / stt, by = syt / stt;
    let rx = 0, ry = 0;
    for (const r of members) {
      const dt = r.day - tbar;
      rx += r.n * (proj.x(r.lng) - xbar - bx * dt) ** 2;
      ry += r.n * (proj.y(r.lat) - ybar - by * dt) ** 2;
    }
    const dof = Math.max(1, W - 2);
    // Position noise floor: a centroid is not exact, so tiny residuals never make a drift "significant".
    const sx = Math.sqrt(Math.max(rx / dof, p.floorM ** 2) / stt), sy = Math.sqrt(Math.max(ry / dof, p.floorM ** 2) / stt);
    const z = Math.sqrt((bx / sx) ** 2 + (by / sy) ** 2);
    velocity = { east: bx, north: by, z };
    const shift14M = Math.hypot(bx, by) * 14;
    // χ²(2) 95%: √5.99 ≈ 2.45.
    if (W >= p.dirMinCases && z >= 2.45 && shift14M >= p.dirMinShiftM) {
      const from = last14?.center ?? [proj.lng(xbar), proj.lat(ybar)];
      const fx = proj.x(from[0]), fy = proj.y(from[1]);
      direction = {
        bearing: ((Math.atan2(bx, by) * 180) / Math.PI + 360) % 360,
        shift14M,
        to: [round5(proj.lng(fx + bx * 14)), round5(proj.lat(fy + by * 14))],
      };
    }
  }
  return { cases: W, cases14, town, towns: towns.size, bbox: [minLng, minLat, maxLng, maxLat], track, last14, prev14, velocity, direction };
}

/** 8-point compass index (0 = N, 1 = NE, …, 7 = NW) of a bearing in degrees. */
export function compass8(bearing: number): number {
  return Math.round((((bearing % 360) + 360) % 360) / 45) % 8;
}
