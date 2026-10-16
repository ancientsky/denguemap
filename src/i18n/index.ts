// i18n runtime: language detection, t(), Intl formatters, document metadata.
import { getPref, setPref, Emitter } from '../lib/prefs';
import { parseISO } from '../lib/dates';
import { zhHant, type Dictionary, type MessageKey } from './zh-Hant';

export type Lang = 'zh' | 'en';
// zh-Hant ships in the entry chunk; English is a separate lazily-loaded chunk.
const DICTS: Partial<Record<Lang, Dictionary>> = { zh: zhHant };
async function ensureDict(l: Lang): Promise<void> {
  if (!DICTS[l] && l === 'en') DICTS.en = (await import('./en')).en;
}
const PREF = 'denguemap.lang';

export function detectLang(search: string, hashQuery: string, stored: string | null, navLangs: readonly string[]): Lang {
  const q = new URLSearchParams(search).get('lang') ?? new URLSearchParams(hashQuery).get('lang');
  const norm = (s: string | null): Lang | null => (s === 'en' ? 'en' : s === 'zh' || s === 'zh-Hant' || s === 'zh-TW' ? 'zh' : null);
  const fromQuery = norm(q);
  if (fromQuery) return fromQuery;
  const fromStore = norm(stored);
  if (fromStore) return fromStore;
  for (const l of navLangs) {
    const s = l.toLowerCase();
    if (s.startsWith('zh')) return 'zh';
    if (s.startsWith('en')) return 'en';
  }
  return 'zh';
}

let lang: Lang = 'zh';
export const langChanged = new Emitter<Lang>();
export const getLang = (): Lang => lang;
export const locale = (): string => (lang === 'zh' ? 'zh-Hant-TW' : 'en');

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const s = DICTS[lang]?.[key] ?? zhHant[key] ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export async function initLang(): Promise<Lang> {
  const hash = location.hash;
  const q = hash.indexOf('?');
  const want = detectLang(location.search, q >= 0 ? hash.slice(q + 1) : '', getPref(PREF), navigator.languages ?? [navigator.language]);
  try {
    await ensureDict(want);
    lang = want;
  } catch {
    lang = 'zh';
  }
  applyDocumentLang();
  return lang;
}

export async function setLang(l: Lang): Promise<void> {
  if (l === lang) return;
  try {
    await ensureDict(l);
  } catch {
    return;
  }
  lang = l;
  setPref(PREF, l);
  fmtCache.clear();
  applyDocumentLang();
  langChanged.emit(l);
}

function applyDocumentLang(): void {
  document.documentElement.lang = locale();
  document.title = t('app.title');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('app.description'));
}

// ------------------------------------------------------------------ formatters
const fmtCache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.DisplayNames>();
function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat | Intl.DisplayNames>(key: string, make: () => T): T {
  let f = fmtCache.get(key) as T | undefined;
  if (!f) fmtCache.set(key, (f = make()));
  return f;
}

export function fmtNum(n: number): string {
  return cached('num', () => new Intl.NumberFormat(locale())).format(n);
}
export function fmtPct(n: number): string {
  return cached('pct', () => new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: 0 })).format(n);
}

type DateStyle = 'short' | 'medium' | 'long' | 'month' | 'year';
const DATE_OPTS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: { month: 'numeric', day: 'numeric' },
  medium: { year: 'numeric', month: 'short', day: 'numeric' },
  long: { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' },
  month: { year: 'numeric', month: 'short' },
  year: { year: 'numeric' },
};
/** Format a calendar date 'YYYY-MM-DD' (no time-zone shifting). */
export function fmtDate(iso: string, style: DateStyle = 'medium'): string {
  const ms = parseISO(iso);
  if (Number.isNaN(ms)) return iso || '—';
  return cached(`d-${style}`, () => new Intl.DateTimeFormat(locale(), { ...DATE_OPTS[style], timeZone: 'UTC' })).format(ms);
}
/** Format an ISO timestamp in Taiwan time. */
export function fmtDateTime(isoTs: string | null, withYear = false): string {
  if (!isoTs) return '—';
  const ms = Date.parse(isoTs);
  if (Number.isNaN(ms)) return '—';
  return cached(`dt-${withYear}`, () => new Intl.DateTimeFormat(locale(), {
    ...(withYear ? { year: 'numeric' } : {}), month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Taipei',
  })).format(ms);
}

/** Country name from ISO 3166-1 alpha-2 via Intl.DisplayNames; falls back to the data's Chinese name. */
export function countryName(cc: string, zhFallback?: string): string {
  try {
    const dn = cached('dn', () => new Intl.DisplayNames([locale()], { type: 'region', fallback: 'none' }));
    const n = dn.of(cc.toUpperCase());
    if (n) return n;
  } catch {
    /* ignore */
  }
  return zhFallback ?? cc.toUpperCase();
}

/** Localised place name from an admin record. */
export function placeName(p: { zh: string; en: string } | undefined | null): string {
  if (!p) return t('common.unknownTown');
  return lang === 'en' ? p.en || p.zh : p.zh;
}

export type { MessageKey };
