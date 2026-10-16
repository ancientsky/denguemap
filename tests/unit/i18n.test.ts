import { describe, expect, it } from 'vitest';
import { en } from '../../src/i18n/en';
import { zhHant } from '../../src/i18n/zh-Hant';
import { detectLang } from '../../src/i18n';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('dictionaries', () => {
  it('en has exactly the keys of zh-Hant', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhHant).sort());
  });
  it('has no empty strings', () => {
    for (const [k, v] of [...Object.entries(zhHant), ...Object.entries(en)]) expect(v.trim(), k).not.toBe('');
  });
  it('uses the same placeholders in both languages', () => {
    for (const k of Object.keys(zhHant) as (keyof typeof zhHant)[]) expect(placeholders(en[k]), k).toEqual(placeholders(zhHant[k]));
  });
  it('uses 臺 not 台 in Chinese place-name text', () => {
    expect(Object.values(zhHant).join('')).not.toMatch(/台灣|台南|台北|台中|台東/);
  });
});

describe('detectLang', () => {
  it('prefers ?lang, then storage, then navigator', () => {
    expect(detectLang('?lang=en', '', 'zh', ['zh-TW'])).toBe('en');
    expect(detectLang('', 'year=2026&lang=en', null, ['zh-TW'])).toBe('en');
    expect(detectLang('', '', 'en', ['zh-TW'])).toBe('en');
    expect(detectLang('', '', null, ['en-US', 'zh-TW'])).toBe('en');
    expect(detectLang('', '', null, ['ja-JP', 'zh-HK'])).toBe('zh');
    expect(detectLang('?lang=fr', '', 'bogus', ['fr-FR'])).toBe('zh');
  });
});
