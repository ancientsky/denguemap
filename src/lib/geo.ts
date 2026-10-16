// Small geometry helpers (pure).

export type LngLat = [number, number];
export type BBox = [number, number, number, number];

export const TAIWAN: LngLat = [120.98, 23.97];
export const TAIWAN_BOUNDS: BBox = [119.3, 21.85, 122.05, 25.35];

const rad = Math.PI / 180;
const deg = 180 / Math.PI;

/**
 * Great-circle (slerp) path from a to b with `n` segments. Longitudes are unwrapped to be continuous
 * so lines never jump across the antimeridian.
 */
export function greatCircle(a: LngLat, b: LngLat, n = 64): LngLat[] {
  const [l1, p1] = [a[0] * rad, a[1] * rad];
  const [l2, p2] = [b[0] * rad, b[1] * rad];
  const v1 = [Math.cos(p1) * Math.cos(l1), Math.cos(p1) * Math.sin(l1), Math.sin(p1)];
  const v2 = [Math.cos(p2) * Math.cos(l2), Math.cos(p2) * Math.sin(l2), Math.sin(p2)];
  const dot = Math.min(1, Math.max(-1, v1[0]! * v2[0]! + v1[1]! * v2[1]! + v1[2]! * v2[2]!));
  const omega = Math.acos(dot);
  if (omega < 1e-9) return [a, b];
  const so = Math.sin(omega);
  const out: LngLat[] = [];
  let prevLng = a[0];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const k1 = Math.sin((1 - t) * omega) / so;
    const k2 = Math.sin(t * omega) / so;
    const x = k1 * v1[0]! + k2 * v2[0]!, y = k1 * v1[1]! + k2 * v2[1]!, z = k1 * v1[2]! + k2 * v2[2]!;
    let lng = Math.atan2(y, x) * deg;
    const lat = Math.atan2(z, Math.hypot(x, y)) * deg;
    while (lng - prevLng > 180) lng -= 360;
    while (lng - prevLng < -180) lng += 360;
    prevLng = lng;
    out.push([Math.round(lng * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
  }
  return out;
}

/** Bounding box of any GeoJSON geometry. */
export function bboxOf(g: GeoJSON.Geometry | null | undefined): BBox | null {
  if (!g) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') {
      const x = c[0] as number, y = c[1] as number;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      return;
    }
    for (const cc of c) visit(cc);
  };
  if (g.type === 'GeometryCollection') {
    for (const gg of g.geometries) {
      const b = bboxOf(gg);
      if (b) visit([[b[0], b[1]], [b[2], b[3]]]);
    }
  } else visit(g.coordinates);
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

/** Area-weighted centroid of the largest polygon ring (fallback: bbox centre). */
export function centroidOf(g: GeoJSON.Polygon | GeoJSON.MultiPolygon): LngLat {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let best: LngLat | null = null, bestA = 0;
  for (const p of polys) {
    const ring = p[0];
    if (!ring || ring.length < 3) continue;
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i] as [number, number];
      const [xj, yj] = ring[j] as [number, number];
      const f = xj * yi - xi * yj;
      a += f;
      cx += (xi + xj) * f;
      cy += (yi + yj) * f;
    }
    if (Math.abs(a) > bestA) {
      bestA = Math.abs(a);
      best = [cx / (3 * a), cy / (3 * a)];
    }
  }
  if (best && Number.isFinite(best[0])) return best;
  const b = bboxOf(g)!;
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

/** Graticule lines every `step` degrees (for the offline globe). */
export function graticule(step = 15): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  for (let lng = -180; lng < 180; lng += step) {
    const coords: number[][] = [];
    for (let lat = -80; lat <= 80; lat += 2.5) coords.push([lng, lat]);
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
  }
  for (let lat = -75; lat <= 75; lat += step) {
    const coords: number[][] = [];
    for (let lng = -180; lng <= 180; lng += 2.5) coords.push([lng, lat]);
    features.push({ type: 'Feature', properties: { eq: lat === 0 ? 1 : 0 }, geometry: { type: 'LineString', coordinates: coords } });
  }
  return { type: 'FeatureCollection', features };
}
