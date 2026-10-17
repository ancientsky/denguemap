// Map view period: presets, resolution against the data range and "today" (Taiwan), pure (unit-tested).
//
// The data range runs from Jan 1 of the first data year to the "data end": today (Asia/Taipei), but never
// past Dec 31 of the newest data year (the pipeline has not produced next year's file yet) and never before
// the latest onset (a browser clock that lags the data). Every preset is relative to the data end, so the
// map keeps working through a year rollover without code changes.
import { addDays, dayDiff, isISODate } from './dates';

export type PeriodPreset = 'ytd' | 'py' | '90d' | '12m' | 'year' | 'custom';
/** Display order of the period selector. */
export const PERIOD_PRESETS: readonly PeriodPreset[] = ['ytd', 'py', '90d', '12m', 'year', 'custom'];
/** Longest custom period (3 years incl. a leap day): keeps the merged case set and playback responsive. */
export const MAX_PERIOD_DAYS = 1096;

export interface PeriodCtx {
  /** manifest.years (any order) */
  years: readonly number[];
  /** manifest.latestOnset */
  latestOnset: string;
  /** today in Taiwan, YYYY-MM-DD */
  today: string;
}

export interface Period {
  preset: PeriodPreset;
  /** the selected year for 'year'; otherwise the year of `end` */
  year: number;
  start: string;
  end: string;
  /** a custom period was shortened to MAX_PERIOD_DAYS */
  capped: boolean;
}

/** First and last selectable dates. */
export function dataRange(ctx: PeriodCtx): { min: string; max: string } {
  const todayYear = isISODate(ctx.today) ? +ctx.today.slice(0, 4) : 2026;
  const years = ctx.years.length ? ctx.years : [todayYear];
  const min = `${Math.min(...years)}-01-01`;
  const yearEnd = `${Math.max(...years)}-12-31`;
  let max = isISODate(ctx.today) && ctx.today < yearEnd ? ctx.today : yearEnd;
  if (isISODate(ctx.latestOnset) && ctx.latestOnset > max) max = ctx.latestOnset;
  if (max < min) max = yearEnd;
  return { min, max };
}

/**
 * Default preset: the current year, except in January, when it starts on Jan 1 of the previous year
 * (as the old CDC map did) so cases with onset in late December, which still need follow-up, stay visible.
 */
export function defaultPreset(ctx: PeriodCtx): PeriodPreset {
  return dataRange(ctx).max.slice(5, 7) === '01' ? 'py' : 'ytd';
}

/** Same calendar day one year earlier (Feb 29 → Feb 28). */
export function sameDayPrevYear(iso: string): string {
  const d = `${+iso.slice(0, 4) - 1}${iso.slice(4)}`;
  return isISODate(d) ? d : `${+iso.slice(0, 4) - 1}-02-28`;
}

export interface PeriodOpts {
  year?: number | null;
  start?: string | null;
  end?: string | null;
}

export function resolvePeriod(preset: PeriodPreset, opts: PeriodOpts, ctx: PeriodCtx): Period {
  const { min, max } = dataRange(ctx);
  const clampD = (d: string) => (d < min ? min : d > max ? max : d);
  const endYear = +max.slice(0, 4);
  let start: string;
  let end = max;
  let year = endYear;
  let capped = false;
  switch (preset) {
    case 'ytd':
      start = `${endYear}-01-01`;
      break;
    case 'py':
      start = `${endYear - 1}-01-01`;
      break;
    case '90d':
      start = addDays(max, -89);
      break;
    case '12m':
      start = addDays(sameDayPrevYear(max), 1);
      break;
    case 'year': {
      const years = ctx.years;
      const fallback = years.includes(endYear) || !years.length ? endYear : Math.max(...years);
      year = opts.year != null && years.includes(opts.year) ? opts.year : fallback;
      start = `${year}-01-01`;
      end = `${year}-12-31` < max ? `${year}-12-31` : max;
      break;
    }
    case 'custom': {
      let e = opts.end && isISODate(opts.end) ? clampD(opts.end) : max;
      let s = opts.start && isISODate(opts.start) ? clampD(opts.start) : clampD(`${e.slice(0, 4)}-01-01`);
      if (s > e) [s, e] = [e, s];
      if (dayDiff(s, e) + 1 > MAX_PERIOD_DAYS) {
        s = addDays(e, -(MAX_PERIOD_DAYS - 1));
        capped = true;
      }
      start = s;
      end = e;
      year = +e.slice(0, 4);
      break;
    }
  }
  start = clampD(start);
  if (end < start) end = start;
  return { preset, year, start, end, capped };
}

/** Data years (from `years`) that a date span touches, ascending. */
export function yearsTouched(start: string, end: string, years: readonly number[]): number[] {
  const a = +start.slice(0, 4), b = +end.slice(0, 4);
  return [...years].filter((y) => y >= a && y <= b).sort((x, y) => x - y);
}

/** Inclusive number of days of a span. */
export const spanDays = (start: string, end: string): number => dayDiff(start, end) + 1;
