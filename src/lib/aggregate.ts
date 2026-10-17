// Pure aggregation helpers (unit-tested).
import { DAY_MS, epochDayOfDoy, isoWeek, parseISO, toISO, weekStart } from './dates';
import type { CaseType } from './params';
import type { CasePoint, CasesYear, LI, Trend } from './types';

/** Inclusive day range (epoch days, see CaseSet) and filters. */
export interface CaseFilter {
  from: number;
  to: number;
  type: CaseType;
  county: string | null;
}

export interface CaseAggregate {
  /** ptIndex → [local, imported] */
  byPt: Map<number, [number, number]>;
  /** ptIndex → latest onset in range (epoch day) */
  lastDay: Map<number, number>;
  /** townCode → [local, imported] */
  byTown: Map<string, [number, number]>;
  total: LI;
}

// ------------------------------------------------------------------ multi-year case sets

/**
 * Case rows of one or more cases/{year}.json files merged into one day-sorted set (built once per period).
 * Days are epoch days (days since 1970-01-01), so a period can span years. Points with identical
 * coordinates in different years are merged, so a statistical area is one map feature across the period.
 */
export interface CaseSet {
  pts: CasePoint[];
  day: Int32Array;
  pt: Int32Array;
  imp: Uint8Array;
  n: Int32Array;
  length: number;
}

export function mergeCaseYears(files: readonly CasesYear[]): CaseSet {
  const sorted = [...files].sort((a, b) => a.year - b.year);
  let len = 0;
  for (const f of sorted) len += f.c.length;
  const day = new Int32Array(len), pt = new Int32Array(len), imp = new Uint8Array(len), n = new Int32Array(len);
  const pts: CasePoint[] = [];
  const byKey = new Map<string, number>();
  let k = 0;
  for (const f of sorted) {
    const remap = new Int32Array(f.pts.length);
    f.pts.forEach((p, i) => {
      const key = `${p[0]},${p[1]}`;
      let j = byKey.get(key);
      if (j === undefined) {
        j = pts.length;
        byKey.set(key, j);
        pts.push(p);
      } else if (!pts[j]![2] && p[2]) pts[j] = p;
      remap[i] = j;
    });
    const base = epochDayOfDoy(f.year, 1) - 1;
    for (const [d, p, i, c] of f.c) {
      day[k] = base + d;
      pt[k] = remap[p]!;
      imp[k] = i;
      n[k] = c;
      k++;
    }
  }
  return { pts, day, pt, imp, n, length: k };
}

/** First row index with day >= d. */
export function lowerBoundSet(set: CaseSet, d: number): number {
  let lo = 0, hi = set.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (set.day[mid]! < d) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Aggregation of a CaseSet over [from, to] (epoch days) that can be extended forward cheaply:
 * playback only adds the rows of the new day(s) instead of re-scanning the whole period.
 * The returned aggregate is mutated by later calls; `lastDay` holds epoch days.
 */
export class SetAggregator {
  private key = '';
  private to = -Infinity;
  private cursor = 0;
  private agg: CaseAggregate = emptyAgg();
  constructor(private readonly set: CaseSet) {}

  update(f: CaseFilter): CaseAggregate {
    const key = `${f.from}|${f.type}|${f.county ?? ''}`;
    if (key !== this.key || f.to < this.to) {
      this.key = key;
      this.agg = emptyAgg();
      this.cursor = lowerBoundSet(this.set, f.from);
    }
    this.to = f.to;
    const { day, pt, imp, n, pts } = this.set;
    const { byPt, lastDay, byTown, total } = this.agg;
    let i = this.cursor;
    for (; i < this.set.length; i++) {
      const d = day[i]!;
      if (d > f.to) break;
      const im = imp[i]! as 0 | 1;
      if (f.type === 'local' && im) continue;
      if (f.type === 'imported' && !im) continue;
      const p = pt[i]!;
      const town = pts[p]?.[2] ?? null;
      if (f.county && (!town || town.slice(0, 5) !== f.county)) continue;
      const c = n[i]!;
      let a = byPt.get(p);
      if (!a) byPt.set(p, (a = [0, 0]));
      a[im] += c;
      lastDay.set(p, d);
      if (town) {
        let t = byTown.get(town);
        if (!t) byTown.set(town, (t = [0, 0]));
        t[im] += c;
      }
      if (im) total.imported += c;
      else total.local += c;
    }
    this.cursor = i;
    return this.agg;
  }
}

function emptyAgg(): CaseAggregate {
  return { byPt: new Map(), lastDay: new Map(), byTown: new Map(), total: { local: 0, imported: 0 } };
}

/** One-shot aggregation of a CaseSet over [from, to] (epoch days). */
export function aggregateSet(set: CaseSet, f: CaseFilter): CaseAggregate {
  return new SetAggregator(set).update(f);
}

/** Daily totals of a CaseSet for `len` days starting at epoch day `start` (index 0 = start). */
export function dailyCountsSet(set: CaseSet, start: number, len: number, type: CaseType): Uint32Array {
  const out = new Uint32Array(Math.max(0, len));
  for (let i = lowerBoundSet(set, start); i < set.length; i++) {
    const k = set.day[i]! - start;
    if (k >= len) break;
    const im = set.imp[i]!;
    if (type === 'local' && im) continue;
    if (type === 'imported' && !im) continue;
    out[k]! += set.n[i]!;
  }
  return out;
}

export function topEntries<K>(m: Map<K, [number, number]>, n: number): [K, number, number][] {
  return [...m.entries()]
    .map(([k, [l, i]]): [K, number, number] => [k, l, i])
    .sort((a, b) => b[1] + b[2] - (a[1] + a[2]) || b[1] - a[1])
    .slice(0, n);
}

// ------------------------------------------------------------------ trend helpers

/** Expand a sparse [dayIndex, count][] into a dense array of length len. */
export function expandSparse(sparse: readonly (readonly [number, number])[], len: number): Float64Array {
  const out = new Float64Array(len);
  for (const [i, n] of sparse) if (i >= 0 && i < len) out[i] = (out[i] ?? 0) + n;
  return out;
}

export interface Series {
  local: ArrayLike<number>;
  imported: ArrayLike<number>;
}

export function trendSeries(trend: Trend, county: string | null): Series {
  const len = trend.national.local.length;
  if (!county) return trend.national;
  const c = trend.county[county];
  if (!c) return { local: new Float64Array(len), imported: new Float64Array(len) };
  return { local: expandSparse(c.local, len), imported: expandSparse(c.imported, len) };
}

const pickType = (s: Series, type: CaseType, i: number): number =>
  type === 'local' ? s.local[i]! : type === 'imported' ? s.imported[i]! : s.local[i]! + s.imported[i]!;

/** Weekly (ISO week, Monday start) bins: [weekStartISO[], local[], imported[]]. */
export function weeklyBins(start: string, s: Series): { dates: string[]; local: number[]; imported: number[] } {
  const t0 = parseISO(start);
  const dates: string[] = [], local: number[] = [], imported: number[] = [];
  let cur = -1;
  for (let i = 0; i < s.local.length; i++) {
    const ws = weekStart(t0 + i * DAY_MS);
    if (ws !== cur) {
      cur = ws;
      dates.push(toISO(ws));
      local.push(0);
      imported.push(0);
    }
    local[local.length - 1]! += s.local[i]!;
    imported[imported.length - 1]! += s.imported[i]!;
  }
  return { dates, local, imported };
}

/** Totals per calendar year. */
export function annualTotals(start: string, s: Series): { years: number[]; local: number[]; imported: number[] } {
  const t0 = parseISO(start);
  const idx = new Map<number, number>();
  const years: number[] = [], local: number[] = [], imported: number[] = [];
  for (let i = 0; i < s.local.length; i++) {
    const y = new Date(t0 + i * DAY_MS).getUTCFullYear();
    let k = idx.get(y);
    if (k === undefined) {
      k = years.length;
      idx.set(y, k);
      years.push(y);
      local.push(0);
      imported.push(0);
    }
    local[k]! += s.local[i]!;
    imported[k]! += s.imported[i]!;
  }
  return { years, local, imported };
}

/**
 * Counts per ISO week (1..53) for each requested ISO year. Days are assigned to their ISO week-year,
 * so e.g. 2025-12-29 counts toward 2026-W01. Weeks after the data end are null (not zero).
 */
export function isoWeekMatrix(start: string, s: Series, type: CaseType, years: readonly number[]): Map<number, (number | null)[]> {
  const t0 = parseISO(start);
  const want = new Set(years);
  const out = new Map<number, (number | null)[]>();
  for (const y of years) out.set(y, new Array<number | null>(53).fill(null));
  for (let i = 0; i < s.local.length; i++) {
    const { year, week } = isoWeek(t0 + i * DAY_MS);
    if (!want.has(year)) continue;
    const arr = out.get(year)!;
    arr[week - 1] = (arr[week - 1] ?? 0) + pickType(s, type, i);
  }
  // A 52-week year has no W53: keep it null.
  return out;
}

/** Sum of a contiguous range [a, b] (inclusive) of a series for a case type. */
export function sumRange(s: Series, type: CaseType, a: number, b: number): number {
  let n = 0;
  for (let i = Math.max(0, a); i <= Math.min(b, s.local.length - 1); i++) n += pickType(s, type, i);
  return n;
}

/** Choropleth class breaks from the max township count (geometric, de-duplicated). */
export function niceBreaks(max: number): number[] {
  if (max <= 1) return [1];
  const out: number[] = [1];
  for (let k = 1; k <= 4; k++) {
    let v = Math.pow(max, k / 5);
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    v = Math.ceil(v / mag) * mag;
    if (v > out[out.length - 1]! && v <= max) out.push(Math.round(v));
  }
  return out;
}

/**
 * Recency bucket of an onset relative to a reference date (old CDC map colouring):
 * 0: ≤ 7 days, 1: 8–14, 2: 15–30, 3: > 30 days. Negative ages (onset after reference) count as 0.
 */
export function recencyBucket(daysAgo: number): 0 | 1 | 2 | 3 {
  if (daysAgo <= 7) return 0;
  if (daysAgo <= 14) return 1;
  if (daysAgo <= 30) return 2;
  return 3;
}
