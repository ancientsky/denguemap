// Embed mode + URL parameters shared by the site and by iframe hosts. Pure functions (unit-tested) plus a
// tiny location-bound singleton.
//
//   ?embed=1&theme=dark&lang=en#/vector?county=64000      (search)
//   #/map?embed=1&theme=dark&lang=en                      (hash query, the router's own query)
//
// Only whitelisted values are honoured; everything else is ignored. public/theme-init.js mirrors this
// parsing for the pre-paint theme (see tests/unit/embed.test.ts, which runs both against the same cases).
import type { Params, Route } from './router';
import { buildHash } from './router';

export type EmbedTheme = 'light' | 'dark';
export type EmbedLang = 'zh' | 'en';
export interface EmbedState {
  embed: boolean;
  /** Explicit theme from the URL (null = follow the OS / the user's saved preference). */
  theme: EmbedTheme | null;
  /** Explicit UI language from the URL (null = not given). */
  lang: EmbedLang | null;
}

/** Keys the shell owns; views never see them and the router carries them across hash rewrites. */
export const CARRY_KEYS = ['embed', 'theme', 'lang'] as const;
export type CarryKey = (typeof CARRY_KEYS)[number];

export const parseEmbedFlag = (v: string | null | undefined): boolean => v === '1';
export const parseThemeParam = (v: string | null | undefined): EmbedTheme | null => (v === 'light' || v === 'dark' ? v : null);
/** `zh-Hant` / `zh-TW` are accepted as aliases of `zh` (older shared links). */
export const parseLangParam = (v: string | null | undefined): EmbedLang | null =>
  v === 'en' ? 'en' : v === 'zh' || v === 'zh-Hant' || v === 'zh-TW' ? 'zh' : null;

function usp(query: string): URLSearchParams {
  try {
    return new URLSearchParams(query);
  } catch {
    return new URLSearchParams();
  }
}

/** The query inside a location hash ('#/map?a=1' → 'a=1'). */
export function hashQuery(hash: string): string {
  const q = hash.indexOf('?');
  return q >= 0 ? hash.slice(q + 1) : '';
}

/** First valid value wins, looking in `location.search` first, then in the hash query. */
function firstValid<T>(sources: readonly URLSearchParams[], key: string, parse: (v: string | null) => T | null): T | null {
  for (const s of sources) {
    const v = parse(s.get(key));
    if (v !== null) return v;
  }
  return null;
}

export function parseEmbedState(search: string, hash: string): EmbedState {
  const sources = [usp(search), usp(hashQuery(hash))];
  return {
    embed: firstValid(sources, 'embed', (v) => (parseEmbedFlag(v) ? true : null)) === true,
    theme: firstValid(sources, 'theme', parseThemeParam),
    lang: firstValid(sources, 'lang', parseLangParam),
  };
}

/** Embed mode never reads or writes the visitor's saved theme/language (host and map may share an origin). */
export const canPersistPrefs = (s: Pick<EmbedState, 'embed'>): boolean => !s.embed;

/** The theme preference to start with: explicit URL theme > (embed ? OS : saved preference). */
export function initialThemePref(s: EmbedState, stored: string | null): 'system' | EmbedTheme {
  if (s.theme) return s.theme;
  if (s.embed) return 'system';
  return parseThemeParam(stored) ?? 'system';
}

/** Validated shell params found in a router params object. */
export function pickCarry(params: Params): Params {
  const out: Params = {};
  if (parseEmbedFlag(params.embed)) out.embed = '1';
  const theme = parseThemeParam(params.theme);
  if (theme) out.theme = theme;
  const lang = parseLangParam(params.lang);
  if (lang) out.lang = lang;
  return out;
}

export function stripCarry(params: Params): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(params)) if (!(CARRY_KEYS as readonly string[]).includes(k)) out[k] = v;
  return out;
}

/** True when `raw` (parsed hash params) differs from what the shell wants the hash to carry. */
export function carryDiffers(raw: Params, carry: Params): boolean {
  return CARRY_KEYS.some((k) => (k in raw) !== (k in carry) || (k in raw && raw[k] !== carry[k]));
}

/** Hash for the same view+state WITHOUT embed (language always kept, theme only when it was explicit). */
export function openFullHash(route: Route, viewParams: Params, lang: EmbedLang, theme: EmbedTheme | null): string {
  return buildHash(route, { ...(theme ? { theme } : {}), lang, ...stripCarry(viewParams) });
}

// ---------------------------------------------------------------- location-bound singleton
let state: EmbedState = { embed: false, theme: null, lang: null };
let inited = false;

/** Read the URL once at startup (before anything rewrites the hash) and tag <html data-embed>. */
export function initEmbed(): EmbedState {
  if (!inited) {
    inited = true;
    state = parseEmbedState(location.search, location.hash);
    if (state.embed) document.documentElement.dataset.embed = '1';
  }
  return state;
}
export const getEmbedState = (): EmbedState => (inited ? state : initEmbed());
export const isEmbed = (): boolean => getEmbedState().embed;
