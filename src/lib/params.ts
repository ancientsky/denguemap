// Validation / clamping of URL query state per view. Pure functions (unit-tested).
import { dateFromDoy, daysInYear, isISODate } from './dates';
import { dataRange, defaultPreset, PERIOD_PRESETS, resolvePeriod, type Period, type PeriodCtx, type PeriodPreset } from './period';
import type { Params } from './router';

export type CaseType = 'local' | 'imported' | 'all';
export const CASE_TYPES: readonly CaseType[] = ['local', 'imported', 'all'];
export type MapMode = 'points' | 'heat' | 'towns';
export const MAP_MODES: readonly MapMode[] = ['points', 'heat', 'towns'];
export type ColorBy = 'recency' | 'type';
export const COLOR_BY: readonly ColorBy[] = ['recency', 'type'];

export function clampInt(v: string | undefined, min: number, max: number, def: number): number {
  if (v == null || !/^-?\d{1,9}$/.test(v.trim())) return def;
  const n = parseInt(v, 10);
  return Math.min(max, Math.max(min, n));
}

export function oneOf<T extends string>(v: string | undefined, list: readonly T[], def: T): T {
  return v != null && (list as readonly string[]).includes(v) ? (v as T) : def;
}

const COUNTY_RE = /^\d{5}$/;
export function countyParam(v: string | undefined, valid: ReadonlySet<string>): string | null {
  return v && COUNTY_RE.test(v) && valid.has(v) ? v : null;
}

// ---------------------------------------------------------------- map view
export interface MapParams {
  /** the period: slider extent, files loaded */
  period: Period;
  /** selected sub-range within the period (ISO dates, inclusive) */
  from: string;
  to: string;
  type: CaseType;
  county: string | null;
  mode: MapMode;
  ns1: boolean;
  /** case colouring: days since onset (default) or local/imported */
  color: ColorBy;
  /** mosquito-risk village overlay */
  mv: boolean;
}
export interface MapCtx extends PeriodCtx {
  counties: ReadonlySet<string>;
}

const YEAR_RE = /^\d{4}$/;
const DOY_RE = /^\d{1,3}$/;

/**
 * URL → state. Current params: p=ytd|py|90d|12m|year|custom, year (p=year), start/end (p=custom),
 * from/to (ISO sub-range). Old links (`year=YYYY&from=DOY&to=DOY`, day-of-year numbers) are translated:
 * a 4-digit `year` or numeric from/to without `p` means p=year (the newest year when `year` is absent),
 * and numeric from/to are days of that year.
 */
export function normalizeMapParams(raw: Params, ctx: MapCtx): MapParams {
  const years = ctx.years.length ? ctx.years : [+dataRange(ctx).max.slice(0, 4)];
  const latestYear = Math.max(...years);
  const yearRaw = raw.year != null && YEAR_RE.test(raw.year) ? Math.min(latestYear, Math.max(Math.min(...years), +raw.year)) : null;
  const year = yearRaw != null && years.includes(yearRaw) ? yearRaw : latestYear;
  const pRaw = raw.p && (PERIOD_PRESETS as readonly string[]).includes(raw.p) ? (raw.p as PeriodPreset) : null;
  const legacy = !pRaw && (yearRaw != null || DOY_RE.test(raw.from ?? '') || DOY_RE.test(raw.to ?? ''));
  const preset: PeriodPreset = pRaw ?? (isISODate(raw.start) || isISODate(raw.end) ? 'custom' : legacy ? 'year' : defaultPreset(ctx));
  const period = resolvePeriod(preset, { year, start: raw.start, end: raw.end }, ctx);
  const doyYear = preset === 'year' ? period.year : +period.start.slice(0, 4);
  const sub = (v: string | undefined, def: string): string => {
    let d = def;
    if (isISODate(v)) d = v;
    else if (v != null && DOY_RE.test(v)) d = dateFromDoy(doyYear, Math.min(daysInYear(doyYear), Math.max(1, +v)));
    return d < period.start ? period.start : d > period.end ? period.end : d;
  };
  let from = sub(raw.from, period.start);
  let to = sub(raw.to, period.end);
  if (from > to) [from, to] = [to, from];
  return {
    period,
    from,
    to,
    type: oneOf(raw.type, CASE_TYPES, 'local'),
    county: countyParam(raw.county, ctx.counties),
    mode: oneOf(raw.mode, MAP_MODES, 'points'),
    ns1: raw.ns1 === '1',
    color: oneOf(raw.color, COLOR_BY, 'recency'),
    mv: raw.mv === '1',
  };
}

/** Serialise, omitting defaults so shared URLs stay short. */
export function serializeMapParams(p: MapParams, ctx: MapCtx): Params {
  const out: Params = {};
  const pr = p.period;
  if (pr.preset !== defaultPreset(ctx)) out.p = pr.preset;
  if (pr.preset === 'year') out.year = String(pr.year);
  if (pr.preset === 'custom') {
    out.start = pr.start;
    out.end = pr.end;
  }
  if (p.type !== 'local') out.type = p.type;
  if (p.county) out.county = p.county;
  if (p.from !== pr.start) out.from = p.from;
  if (p.to !== pr.end) out.to = p.to;
  if (p.mode !== 'points') out.mode = p.mode;
  if (p.ns1) out.ns1 = '1';
  if (p.color !== 'recency') out.color = p.color;
  if (p.mv) out.mv = '1';
  return out;
}

// ---------------------------------------------------------------- vector view
export interface VectorParams {
  week: number; // 0 = latest
  county: string | null;
}
export function normalizeVectorParams(raw: Params, weeks: number, counties: ReadonlySet<string>): VectorParams {
  return { week: clampInt(raw.week, 0, Math.max(0, weeks - 1), 0), county: countyParam(raw.county, counties) };
}
export function serializeVectorParams(p: VectorParams): Params {
  const out: Params = {};
  if (p.week) out.week = String(p.week);
  if (p.county) out.county = p.county;
  return out;
}

// ---------------------------------------------------------------- trends view
export type Granularity = 'day' | 'week';
export interface TrendParams {
  county: string | null;
  gran: Granularity;
  type: CaseType;
  years: number[];
}
export function defaultCompareYears(first: number, last: number): number[] {
  const want = [last, last - 1, 2023, 2015];
  return [...new Set(want.filter((y) => y >= first && y <= last))].sort((a, b) => b - a);
}
export function normalizeTrendParams(raw: Params, firstYear: number, lastYear: number, counties: ReadonlySet<string>): TrendParams {
  let years: number[] = [];
  if (raw.years) {
    years = raw.years
      .split(',')
      .slice(0, 12)
      .map((s) => clampInt(s, -1, 9999, -1))
      .filter((y) => y >= firstYear && y <= lastYear);
    years = [...new Set(years)].sort((a, b) => b - a).slice(0, 8);
  }
  if (!years.length) years = defaultCompareYears(firstYear, lastYear);
  return {
    county: countyParam(raw.county, counties),
    gran: oneOf(raw.gran, ['day', 'week'] as const, 'week'),
    type: oneOf(raw.type, CASE_TYPES, 'local'),
    years,
  };
}
export function serializeTrendParams(p: TrendParams, firstYear: number, lastYear: number): Params {
  const out: Params = {};
  if (p.county) out.county = p.county;
  if (p.gran !== 'week') out.gran = p.gran;
  if (p.type !== 'local') out.type = p.type;
  const def = defaultCompareYears(firstYear, lastYear).join(',');
  const ys = [...p.years].sort((a, b) => b - a).join(',');
  if (ys !== def) out.years = ys;
  return out;
}

// ---------------------------------------------------------------- imported view
export type ImportedTab = 'rank' | 'adv' | 'news';
export type AdvLayer = 'vb' | 'all' | 'off';
export interface ImportedParams {
  year: number | null; // null = all years
  country: string | null;
  tab: ImportedTab;
  adv: AdvLayer;
}
export function normalizeImportedParams(raw: Params, years: readonly number[], countries: ReadonlySet<string>): ImportedParams {
  const y = raw.year === 'all' ? null : clampInt(raw.year, -1, 9999, -1);
  const latest = years.length ? Math.max(...years) : null;
  const year = y === null ? null : years.includes(y) ? y : latest;
  const cc = raw.country && /^[a-z]{2}$/.test(raw.country) && countries.has(raw.country) ? raw.country : null;
  return { year, country: cc, tab: oneOf(raw.tab, ['rank', 'adv', 'news'] as const, 'rank'), adv: oneOf(raw.adv, ['vb', 'all', 'off'] as const, 'vb') };
}
export function serializeImportedParams(p: ImportedParams, years: readonly number[]): Params {
  const out: Params = {};
  const latest = years.length ? Math.max(...years) : null;
  if (p.year === null) out.year = 'all';
  else if (p.year !== latest) out.year = String(p.year);
  if (p.country) out.country = p.country;
  if (p.tab !== 'rank') out.tab = p.tab;
  if (p.adv !== 'vb') out.adv = p.adv;
  return out;
}
