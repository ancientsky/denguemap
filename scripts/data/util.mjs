// @ts-check
/**
 * Small pure helpers shared by the data pipeline (dates, text sanitising,
 * hashing, concurrency).  No I/O here.
 */
import { createHash } from 'node:crypto';

/** Taiwan time is a fixed UTC+8 (no DST). */
const TW_OFFSET_MS = 8 * 3600 * 1000;

/**
 * Taiwan calendar date (YYYY-MM-DD) for an instant.
 * @param {Date} d
 */
export function twDate(d) {
  return new Date(d.getTime() + TW_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Taiwan wall-clock "YYYY-MM-DD HH:mm" for an instant.
 * @param {Date} d
 */
export function twDateTime(d) {
  return new Date(d.getTime() + TW_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/** ISO UTC string without milliseconds. @param {Date} d */
export function isoUtc(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** @param {number} y @param {number} m @param {number} d */
export function isValidYmd(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const pad2 = (/** @type {number} */ n) => String(n).padStart(2, '0');

/** @param {number} y @param {number} m @param {number} d */
export function ymd(y, m, d) {
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

/**
 * Parse `yyyy/mm/dd` or `yyyy-mm-dd` (optionally followed by a time) into parts.
 * @param {unknown} s
 * @returns {{y:number,m:number,d:number}|null}
 */
export function parseYmd(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[T ].*)?$/.exec(s.trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  return isValidYmd(y, mo, d) ? { y, m: mo, d } : null;
}

/**
 * Parse `m/d/yyyy` (the vector map's week dates) into `YYYY-MM-DD`.
 * @param {unknown} s
 * @returns {string|null}
 */
export function parseMdy(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const mo = +m[1], d = +m[2], y = +m[3];
  return isValidYmd(y, mo, d) ? ymd(y, mo, d) : null;
}

/** Days since 1970-01-01 for a Y-M-D (UTC arithmetic, no DST). */
export function daysFromYmd(/** @type {number} */ y, /** @type {number} */ m, /** @type {number} */ d) {
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

/** Days since epoch for a `YYYY-MM-DD` string. @param {string} s */
export function daysFromIso(s) {
  const p = parseYmd(s);
  if (!p) throw new Error(`bad date ${s}`);
  return daysFromYmd(p.y, p.m, p.d);
}

/** `YYYY-MM-DD` for days since epoch. @param {number} n */
export function isoFromDays(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

/** 1-based day of year. */
export function dayOfYear(/** @type {number} */ y, /** @type {number} */ m, /** @type {number} */ d) {
  return daysFromYmd(y, m, d) - daysFromYmd(y, 1, 1) + 1;
}

/**
 * Same month/day one year earlier (Feb 29 -> Feb 28).
 * @param {string} iso
 */
export function sameDayLastYear(iso) {
  const p = parseYmd(iso);
  if (!p) throw new Error(`bad date ${iso}`);
  const y = p.y - 1;
  const d = p.m === 2 && p.d === 29 ? 28 : p.d;
  return ymd(y, p.m, d);
}

/** MOI writes 臺, taiwan-atlas / the source sometimes write 台. @param {string} s */
export function normTai(s) {
  return s.replace(/台/g, '臺');
}

/**
 * Round to 5 decimals (about 1 m).
 * @param {number} x
 */
export function round5(x) {
  return Math.round(x * 1e5) / 1e5;
}

/** @param {number} x @param {number} dp */
export function roundTo(x, dp) {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** Remove HTML tags; block-level ones leave a space, inline ones vanish. */
function stripTags(/** @type {string} */ t) {
  return t.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*|!)[^>]*>/g, (_m, name) => (/^(br|p|div|li|ul|ol|tr|td|th|table|h[1-6]|hr|section|article)$/i.test(name) ? ' ' : ''));
}

/**
 * Sanitise untrusted free text: NFKC, strip HTML, drop control chars,
 * collapse whitespace, cap length (counted in code points).
 * @param {unknown} s
 * @param {number} [max]
 */
export function cleanText(s, max = 600) {
  if (typeof s !== 'string') return '';
  let t = s.normalize('NFKC');
  // drop whole script/style blocks, then tags, decode a few entities, strip tags again
  t = t.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = stripTags(t);
  t = t
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
  t = stripTags(t);
  // control + format chars (zero-width, BOM, bidi marks), line/paragraph separators
  t = t.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  const cps = Array.from(t);
  if (cps.length > max) t = cps.slice(0, max).join('').trimEnd();
  return t;
}

/**
 * Sanitise a short label (names/addresses): trim, drop control chars, cap.
 * Keeps characters as-is (no NFKC) so official names are not altered.
 * @param {unknown} s
 * @param {number} [max]
 */
export function cleanLabel(s, max = 120) {
  if (typeof s !== 'string') return '';
  // control chars and line/paragraph separators
  let t = s.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/<\/?[a-zA-Z!][^>]*>/g, '');
  const cps = Array.from(t);
  if (cps.length > max) t = cps.slice(0, max).join('');
  return t;
}

const CDC_PREFIX = 'https://www.cdc.gov.tw/';
/**
 * Only https://www.cdc.gov.tw/... links survive; everything else is null.
 * @param {unknown} u
 * @returns {string|null}
 */
export function safeCdcUrl(u) {
  if (typeof u !== 'string') return null;
  const s = u.trim();
  if (!s.startsWith(CDC_PREFIX) || s.length > 500) return null;
  // whitespace/control chars and URL-unsafe chars are never valid in these links
  if (/[\p{Cc}\s"<>\\^`{|}]/u.test(s)) return null;
  try {
    const url = new URL(s);
    if (url.protocol !== 'https:' || url.hostname !== 'www.cdc.gov.tw' || url.username || url.password || url.port) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** First 8 hex chars of sha256. @param {string|Buffer} data */
export function sha8(data) {
  return createHash('sha256').update(data).digest('hex').slice(0, 8);
}

/** Minified JSON. @param {unknown} v */
export function toJson(v) {
  return JSON.stringify(v);
}

/** Plain code-unit string comparison (locale independent). */
export function cmp(/** @type {string} */ a, /** @type {string} */ b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Run async tasks with limited concurrency; results keep input order.
 * Rejects on the first failure (remaining queued tasks are skipped).
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item:T, index:number)=>Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Like mapLimit but never rejects: resolves to settled results.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item:T, index:number)=>Promise<R>} fn
 * @returns {Promise<Array<{ok:true,value:R}|{ok:false,error:Error}>>}
 */
export async function mapLimitSettled(items, limit, fn) {
  return mapLimit(items, limit, async (item, i) => {
    try {
      return { ok: /** @type {const} */ (true), value: await fn(item, i) };
    } catch (e) {
      return { ok: /** @type {const} */ (false), error: e instanceof Error ? e : new Error(String(e)) };
    }
  });
}

/** Deep structural equality for JSON-like values. */
export function jsonEqual(/** @type {unknown} */ a, /** @type {unknown} */ b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
