// Theme preference ('system' | 'light' | 'dark') → html[data-theme] = effective 'light' | 'dark'.
// public/theme-init.js applies the same logic synchronously before first paint.
import { canPersistPrefs, getEmbedState, initialThemePref } from './lib/embed';
import { Emitter, getPref, setPref } from './lib/prefs';

export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';
const KEY = 'denguemap.theme';
const ORDER: ThemePref[] = ['system', 'light', 'dark'];
const mq = matchMedia('(prefers-color-scheme: dark)');

export const themeChanged = new Emitter<Theme>();
// Embed mode (or an explicit ?theme=) takes precedence over the saved preference and is never persisted.
let pref: ThemePref = readPref();
let effective: Theme = resolve(pref);

function readPref(): ThemePref {
  const st = getEmbedState();
  return initialThemePref(st, st.embed ? null : getPref(KEY));
}
function resolve(p: ThemePref): Theme {
  return p === 'system' ? (mq.matches ? 'dark' : 'light') : p;
}

const THEME_COLORS: Record<Theme, string> = { light: '#f5f7fa', dark: '#0b111b' };

function apply(): void {
  const root = document.documentElement;
  root.dataset.theme = effective;
  root.dataset.themePref = pref;
  root.style.colorScheme = effective;
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    if (pref === 'system') m.content = m.media.includes('dark') ? THEME_COLORS.dark : THEME_COLORS.light;
    else m.content = THEME_COLORS[effective];
  }
}

export function initTheme(): void {
  apply();
  mq.addEventListener('change', () => {
    if (pref !== 'system') return;
    const next = resolve(pref);
    if (next !== effective) {
      effective = next;
      apply();
      themeChanged.emit(effective);
    }
  });
}

export const getThemePref = (): ThemePref => pref;
export const getTheme = (): Theme => effective;
export const nextThemePref = (p: ThemePref): ThemePref => ORDER[(ORDER.indexOf(p) + 1) % ORDER.length]!;

export function cycleTheme(): void {
  pref = nextThemePref(pref);
  if (canPersistPrefs(getEmbedState())) setPref(KEY, pref);
  const next = resolve(pref);
  const changed = next !== effective;
  effective = next;
  apply();
  if (changed) themeChanged.emit(effective);
}

/** Read a CSS custom property from :root (used to theme map layers and charts). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
