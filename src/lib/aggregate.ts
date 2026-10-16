// Pure aggregation helpers (unit-tested).
import { DAY_MS, isoWeek, parseISO, toISO, weekStart } from './dates';
import type { CaseType } from './params';
import type { CasesYear, LI, Trend } from './types';

/** First index in sorted rows with row[0] >= doy. */
export function lowerBound(rows: readonly (readonly number[])[], doy: number): number {
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid]![0]! < doy) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface CaseFilter {
  from: number;
  to: number;
  type: CaseType;
  county: string | null;
}

export interface CaseAggregate {
  /** ptIndex → [local, imported] */
  byPt: Map<number, [number, number]>;
  /** townCode → [local, imported] */
  byTown: Map<string, [number, number]>;
  total: LI;
}

export function aggregateCases(file: CasesYear, f: CaseFilter): CaseAggregate {
  const byPt = new Map<number, [number, number]>();
  const byTown = new Map<string, [number, number]>();
  const total = { local: 0, imported: 0 };
  const { c, pts } = file;
  for (let i = lowerBound(c, f.from); i < c.length; i++) {
    const [d, p, imp, n] = c[i]!;
    if (d > f.to) break;
    if (f.type === 'local' && imp) continue;
    if (f.type === 'imported' && !imp) continue;
    const town = pts[p]?.[2] ?? null;
    if (f.county && (!town || town.slice(0, 5) !== f.county)) continue;
    let a = byPt.get(p);
    if (!a) byPt.set(p, (a = [0, 0]));
    a[imp] += n;
    if (town) {
      let t = byTown.get(town);
      if (!t) byTown.set(town, (t = [0, 0]));
      t[imp] += n;
    }
    if (imp) total.imported += n;
    else total.local += n;
  }
  return { byPt, byTown, total };
}

/** Daily totals for the year (index 0 = day 1) for a case type — used by the range slider sparkline. */
export function dailyCounts(file: CasesYear, days: number, type: CaseType): Uint32Array {
  const out = new Uint32Array(days);
  for (const [d, , imp, n] of file.c) {
    if (d > days) continue;
    if (type === 'local' && imp) continue;
    if (type === 'imported' && !imp) continue;
    out[d - 1]! += n;
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
