// What was known on a given day: the case rows with onset up to the as-of day, optionally thinned with the
// assumed reporting delay (history replay and backtests use final data, which already holds every late report).
import type { CaseSet } from '../aggregate';
import { lowerBoundSet } from '../aggregate';
import type { CaseRow } from './foci';
import type { DailySeries } from './model';
import { binomial, rng } from './random';

export interface Snapshot {
  asOf: number;
  /** First epoch day held. */
  from: number;
  day: Int32Array;
  pt: Int32Array;
  imp: Uint8Array;
  n: Int32Array;
  length: number;
}

/**
 * Rows of `set` with onset in [from, asOf]. With `completeness`, each row keeps Binomial(n, c[asOf − day])
 * cases (seeded): the cases that would already have been published on the as-of day.
 */
export function snapshotAt(set: CaseSet, asOf: number, from: number, completeness: Float64Array | null, seed = 1): Snapshot {
  const r = rng(seed ^ asOf);
  const i0 = lowerBoundSet(set, from);
  const cap = Math.max(0, lowerBoundSet(set, asOf + 1) - i0);
  const out: Snapshot = { asOf, from, day: new Int32Array(cap), pt: new Int32Array(cap), imp: new Uint8Array(cap), n: new Int32Array(cap), length: 0 };
  for (let i = i0; i < i0 + cap; i++) {
    const d = set.day[i]!;
    let n = set.n[i]!;
    if (completeness) {
      const lag = asOf - d;
      const c = lag >= completeness.length ? 1 : completeness[lag]!;
      if (c < 1) n = binomial(r, n, c);
    }
    if (!n) continue;
    const k = out.length++;
    out.day[k] = d;
    out.pt[k] = set.pt[i]!;
    out.imp[k] = set.imp[i]!;
    out.n[k] = n;
  }
  return out;
}

const countyOf = (set: CaseSet, pt: number): string | null => set.pts[pt]?.[2]?.slice(0, 5) ?? null;

/** Daily local / imported series of one area (null = Taiwan) from `start` to the snapshot's as-of day. */
export function seriesOf(set: CaseSet, snap: Snapshot, county: string | null, start: number): DailySeries {
  const len = snap.asOf - start + 1;
  const local = new Float64Array(len), imported = new Float64Array(len);
  for (let i = 0; i < snap.length; i++) {
    const k = snap.day[i]! - start;
    if (k < 0 || k >= len) continue;
    if (county && countyOf(set, snap.pt[i]!) !== county) continue;
    (snap.imp[i] ? imported : local)[k]! += snap.n[i]!;
  }
  return { start, local, imported };
}

/** Local case rows (for the foci) of one area in the snapshot. */
export function localRows(set: CaseSet, snap: Snapshot, county: string | null, from: number): CaseRow[] {
  const rows: CaseRow[] = [];
  for (let i = 0; i < snap.length; i++) {
    if (snap.imp[i] || snap.day[i]! < from) continue;
    const p = set.pts[snap.pt[i]!];
    if (!p) continue;
    const town = p[2] ?? null;
    if (county && town?.slice(0, 5) !== county) continue;
    rows.push({ lng: p[0], lat: p[1], day: snap.day[i]!, n: snap.n[i]!, town });
  }
  return rows;
}

/** Local cases per county in the 28 days up to the as-of day (for the area list), most first. */
export function countyCounts(set: CaseSet, snap: Snapshot): [string, number][] {
  const m = new Map<string, number>();
  for (let i = 0; i < snap.length; i++) {
    if (snap.imp[i] || snap.day[i]! <= snap.asOf - 28) continue;
    const c = countyOf(set, snap.pt[i]!);
    if (c) m.set(c, (m.get(c) ?? 0) + snap.n[i]!);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Final (complete) weekly local totals of an area for 7-day blocks ending at the given days. */
export function truthBlocks(set: CaseSet, county: string | null, ends: readonly number[]): number[] {
  return ends.map((end) => {
    let s = 0;
    for (let i = lowerBoundSet(set, end - 6); i < set.length && set.day[i]! <= end; i++) {
      if (set.imp[i]) continue;
      if (county && countyOf(set, set.pt[i]!) !== county) continue;
      s += set.n[i]!;
    }
    return s;
  });
}
