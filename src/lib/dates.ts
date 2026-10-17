// Calendar-date helpers. All dates are Taiwan calendar dates as 'YYYY-MM-DD' strings and are
// handled as UTC midnights internally so no time-zone shifting can occur.

const DAY = 86_400_000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isISODate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
  return toISO(ms) === s;
}

/** Parse 'YYYY-MM-DD' to UTC ms; NaN if invalid. */
export function parseISO(s: string): number {
  return isISODate(s) ? Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) : NaN;
}

export function toISO(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInYear = (y: number): number => (isLeap(y) ? 366 : 365);

/** 1-based day of year of an ISO date. */
export function dayOfYear(iso: string): number {
  const ms = parseISO(iso);
  const y = +iso.slice(0, 4);
  return Math.round((ms - Date.UTC(y, 0, 1)) / DAY) + 1;
}

/** ISO date of 1-based day-of-year `doy` in `year`. */
export function dateFromDoy(year: number, doy: number): string {
  return toISO(Date.UTC(year, 0, 1) + (doy - 1) * DAY);
}

export function addDays(iso: string, n: number): string {
  return toISO(parseISO(iso) + n * DAY);
}

/** Today's date in Taiwan (Asia/Taipei) as YYYY-MM-DD. */
export function todayTaipei(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Reference date for recency colouring. When the range ends at the newest data,
 * measure from today (as the old CDC map did: "目前日期與發病日"), so a case
 * that fell ill 6 days ago is still flagged even if reporting lags; otherwise
 * use the end of the selected range (history browsing and playback).
 */
export function recencyRef(rangeEnd: string, latestOnset: string, today: string = todayTaipei()): string {
  return rangeEnd >= latestOnset && today > rangeEnd ? today : rangeEnd;
}

/** Days since 1970-01-01 of an ISO date (NaN if invalid). */
export function epochDay(iso: string): number {
  return Math.round(parseISO(iso) / DAY);
}

/** ISO date of an epoch day. */
export function isoFromEpochDay(n: number): string {
  return toISO(n * DAY);
}

/** Epoch day of 1-based day-of-year `doy` in `year`. */
export function epochDayOfDoy(year: number, doy: number): number {
  return Math.round(Date.UTC(year, 0, 1) / DAY) + doy - 1;
}

/** Whole days from a to b (b - a). */
export function dayDiff(a: string, b: string): number {
  return Math.round((parseISO(b) - parseISO(a)) / DAY);
}

/** ISO-8601 week-numbering year and week for a UTC-midnight timestamp. */
export function isoWeek(ms: number): { year: number; week: number } {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const thursday = ms + (3 - dow) * DAY;
  const ty = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(ty, 0, 1)) / DAY / 7) + 1;
  return { year: ty, week };
}

/** Monday (ISO week start) of the week containing ms. */
export function weekStart(ms: number): number {
  const dow = (new Date(ms).getUTCDay() + 6) % 7;
  return ms - dow * DAY;
}

export const DAY_MS = DAY;
