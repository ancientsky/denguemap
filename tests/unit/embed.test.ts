import { describe, expect, it } from 'vitest';
import { detectLang } from '../../src/i18n';
import {
  canPersistPrefs, carryDiffers, hashQuery, initialThemePref, openFullHash, parseEmbedState, parseLangParam, parseThemeParam,
  pickCarry, stripCarry,
} from '../../src/lib/embed';
import { parseHash } from '../../src/lib/router';
import themeInit from '../../public/theme-init.js?raw';

describe('parseEmbedState', () => {
  it('reads embed/theme/lang from location.search', () => {
    expect(parseEmbedState('?embed=1&theme=dark&lang=en', '#/vector?county=64000')).toEqual({ embed: true, theme: 'dark', lang: 'en' });
  });
  it('reads them from the hash query the router uses', () => {
    expect(parseEmbedState('', '#/map?embed=1&theme=dark&lang=zh')).toEqual({ embed: true, theme: 'dark', lang: 'zh' });
    expect(parseEmbedState('', '#/map?year=2025&embed=1')).toEqual({ embed: true, theme: null, lang: null });
  });
  it('defaults to a normal page', () => {
    expect(parseEmbedState('', '')).toEqual({ embed: false, theme: null, lang: null });
    expect(parseEmbedState('', '#/map')).toEqual({ embed: false, theme: null, lang: null });
  });
  it('whitelists values strictly (exact, case-sensitive)', () => {
    for (const bad of ['0', 'true', 'yes', '', '01', ' 1', '1 ', '1&x', 'on', '1,1']) {
      expect(parseEmbedState(`?embed=${encodeURIComponent(bad)}`, '').embed, JSON.stringify(bad)).toBe(false);
    }
    for (const bad of ['Dark', 'LIGHT', 'system', 'auto', '', 'dark ', '<script>', 'javascript:alert(1)']) {
      expect(parseEmbedState(`?theme=${encodeURIComponent(bad)}`, '').theme, JSON.stringify(bad)).toBeNull();
    }
    for (const bad of ['EN', 'fr', 'zh-CN', '', 'en ', '../x']) {
      expect(parseEmbedState(`?lang=${encodeURIComponent(bad)}`, '').lang, JSON.stringify(bad)).toBeNull();
    }
  });
  it('ignores unknown parameters', () => {
    expect(parseEmbedState('?foo=bar&embed=1&x[]=1', '#/map?theme=dark&evil=%3Cb%3E')).toEqual({ embed: true, theme: 'dark', lang: null });
  });
  it('first valid value wins: search before hash, invalid values fall through', () => {
    expect(parseEmbedState('?theme=light', '#/map?theme=dark').theme).toBe('light');
    expect(parseEmbedState('?theme=bogus', '#/map?theme=dark').theme).toBe('dark');
    expect(parseEmbedState('?embed=0', '#/map?embed=1').embed).toBe(true);
    // within one source only the first occurrence counts
    expect(parseEmbedState('?embed=0&embed=1', '').embed).toBe(false);
  });
  it('survives malformed percent-encoding', () => {
    expect(() => parseEmbedState('?embed=%E0%A4%A&theme=%', '#/map?lang=%zz')).not.toThrow();
  });
  it('accepts the legacy zh aliases for lang', () => {
    expect(parseLangParam('zh-Hant')).toBe('zh');
    expect(parseLangParam('zh-TW')).toBe('zh');
    expect(parseThemeParam('light')).toBe('light');
  });
  it('hashQuery extracts the query part only', () => {
    expect(hashQuery('#/map?a=1&b=2')).toBe('a=1&b=2');
    expect(hashQuery('#/map')).toBe('');
  });
});

describe('detectLang (shared parsing)', () => {
  it('lets an invalid search lang fall through to the hash query', () => {
    expect(detectLang('?lang=fr', 'lang=en', null, ['zh-TW'])).toBe('en');
    expect(detectLang('?lang=en', 'lang=zh', 'zh', ['zh-TW'])).toBe('en');
  });
});

describe('persistence rules', () => {
  it('embed mode never persists theme/lang', () => {
    expect(canPersistPrefs({ embed: true })).toBe(false);
    expect(canPersistPrefs({ embed: false })).toBe(true);
  });
  it('embed ignores the saved theme and follows ?theme= or the OS', () => {
    const embed = (theme: 'light' | 'dark' | null) => ({ embed: true, theme, lang: null });
    expect(initialThemePref(embed(null), 'dark')).toBe('system');
    expect(initialThemePref(embed('light'), 'dark')).toBe('light');
  });
  it('outside embed an explicit ?theme= beats the saved preference (for this load only)', () => {
    const page = (theme: 'light' | 'dark' | null) => ({ embed: false, theme, lang: null });
    expect(initialThemePref(page('dark'), 'light')).toBe('dark');
    expect(initialThemePref(page(null), 'light')).toBe('light');
    expect(initialThemePref(page(null), 'bogus')).toBe('system');
    expect(initialThemePref(page(null), null)).toBe('system');
  });
});

describe('shell params carried through hash rewrites', () => {
  it('pickCarry keeps only valid values; stripCarry removes shell keys', () => {
    expect(pickCarry({ embed: '1', theme: 'dark', lang: 'en', year: '2024' })).toEqual({ embed: '1', theme: 'dark', lang: 'en' });
    expect(pickCarry({ embed: 'true', theme: 'blue', lang: 'fr' })).toEqual({});
    expect(stripCarry({ embed: '1', theme: 'dark', lang: 'en', year: '2024', county: '64000' })).toEqual({ year: '2024', county: '64000' });
  });
  it('carryDiffers detects missing, extra and invalid shell params in the hash', () => {
    const carry = { embed: '1', theme: 'dark' };
    expect(carryDiffers({ embed: '1', theme: 'dark', year: '2024' }, carry)).toBe(false);
    expect(carryDiffers({ year: '2024' }, carry)).toBe(true); // nav link dropped them
    expect(carryDiffers({ embed: '1', theme: 'bogus' }, carry)).toBe(true);
    expect(carryDiffers({ embed: '1', theme: 'dark', lang: 'en' }, carry)).toBe(true);
    expect(carryDiffers({ lang: 'en', year: '1' }, {})).toBe(true); // standalone: consumed params are dropped
    expect(carryDiffers({ year: '1' }, {})).toBe(false);
  });
  it('openFullHash targets the same view+state without embed', () => {
    const h = openFullHash('vector', { week: '2', county: '64000', embed: '1' }, 'en', 'dark');
    expect(h).toBe('#/vector?theme=dark&lang=en&week=2&county=64000');
    const back = parseHash(h);
    expect(back.route).toBe('vector');
    expect(back.params.embed).toBeUndefined();
    expect(openFullHash('map', {}, 'zh', null)).toBe('#/map?lang=zh');
  });
  it('never reflects hostile values: they are rejected before they can be rebuilt', () => {
    const { params } = parseHash('#/map?embed=1&theme=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&lang=%22%3E');
    const carry = pickCarry(params);
    expect(carry).toEqual({ embed: '1' });
    expect(openFullHash('map', stripCarry(params), 'zh', null)).toBe('#/map?lang=zh');
  });
});

// public/theme-init.js runs before CSS and cannot import the module above, so run the real file against
// the same cases to keep the two parsers in lock-step.
describe('public/theme-init.js', () => {
  const src = themeInit;
  function run(search: string, hash: string, stored: string | null, osDark: boolean) {
    const attrs: Record<string, string> = {};
    const root = { setAttribute: (k: string, v: string) => (attrs[k] = v), style: {} as Record<string, string> };
    const mm = () => ({ matches: osDark });
    // The script only touches these globals; hand it fakes.
    new Function('URLSearchParams', 'location', 'localStorage', 'window', 'matchMedia', 'document', src)(
      URLSearchParams, { search, hash }, { getItem: () => stored }, { matchMedia: mm }, mm, { documentElement: root });
    return { theme: attrs['data-theme'], pref: attrs['data-theme-pref'], embed: attrs['data-embed'], scheme: root.style.colorScheme };
  }
  it('honours ?theme= in search and in the hash query, before the saved preference', () => {
    expect(run('?theme=dark', '', 'light', false)).toMatchObject({ theme: 'dark', pref: 'dark', scheme: 'dark' });
    expect(run('', '#/map?theme=dark', 'light', false)).toMatchObject({ theme: 'dark', pref: 'dark' });
    expect(run('?theme=bogus', '#/map?theme=light', null, true)).toMatchObject({ theme: 'light' });
  });
  it('standalone: saved preference, then the OS', () => {
    expect(run('', '', 'dark', false).theme).toBe('dark');
    expect(run('', '', null, true).theme).toBe('dark');
    expect(run('', '', 'junk', false).theme).toBe('light');
    expect(run('', '', null, false).embed).toBeUndefined();
  });
  it('embed: ignores the saved preference and follows the OS; tags <html data-embed>', () => {
    expect(run('?embed=1', '', 'dark', false)).toMatchObject({ theme: 'light', pref: 'system', embed: '1' });
    expect(run('', '#/map?embed=1', 'light', true)).toMatchObject({ theme: 'dark', pref: 'system', embed: '1' });
    expect(run('?embed=true', '', 'dark', false)).toMatchObject({ theme: 'dark', embed: undefined });
  });
  it('agrees with parseEmbedState on a shared case table', () => {
    const cases: [string, string][] = [
      ['?embed=1&theme=light', '#/map'], ['', '#/vector?embed=1&theme=dark'], ['?theme=Dark', '#/map?theme=light'],
      ['?embed=0', '#/map?embed=1'], ['?foo=1', ''], ['?theme=%', '#/map?embed=%zz'],
    ];
    for (const [search, hash] of cases) {
      const st = parseEmbedState(search, hash);
      const r = run(search, hash, null, false);
      expect(r.embed === '1', `${search} ${hash}`).toBe(st.embed);
      expect(r.theme, `${search} ${hash}`).toBe(st.theme ?? 'light');
    }
  });
});
