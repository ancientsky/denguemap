// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  cleanText, daysFromIso, isoFromDays, mapLimit, normTai, parseMdy, parseYmd, round5, safeCdcUrl, sameDayLastYear, twDate, twDateTime,
} from '../../scripts/data/util.mjs';

describe('dates', () => {
  it('uses Taiwan time (UTC+8) for today', () => {
    expect(twDate(new Date('2026-10-15T16:30:00Z'))).toBe('2026-10-16');
    expect(twDate(new Date('2026-10-15T15:59:00Z'))).toBe('2026-10-15');
    expect(twDateTime(new Date('2026-10-15T16:30:00Z'))).toBe('2026-10-16 00:30');
  });
  it('parses yyyy/mm/dd and rejects impossible dates', () => {
    expect(parseYmd('2026/09/26')).toEqual({ y: 2026, m: 9, d: 26 });
    expect(parseYmd('2026-9-6')).toEqual({ y: 2026, m: 9, d: 6 });
    expect(parseYmd('2026/02/30')).toBeNull();
    expect(parseYmd('26/09/26')).toBeNull();
    expect(parseYmd(20260926)).toBeNull();
  });
  it('converts m/d/yyyy week dates', () => {
    expect(parseMdy('10/4/2026')).toBe('2026-10-04');
    expect(parseMdy('9/20/2026')).toBe('2026-09-20');
    expect(parseMdy('13/1/2026')).toBeNull();
    expect(parseMdy('2026-10-04')).toBeNull();
  });
  it('day arithmetic round-trips and handles leap days', () => {
    expect(isoFromDays(daysFromIso('1998-01-01'))).toBe('1998-01-01');
    expect(daysFromIso('2000-03-01') - daysFromIso('2000-02-28')).toBe(2);
    expect(sameDayLastYear('2028-02-29')).toBe('2027-02-28');
    expect(sameDayLastYear('2026-10-16')).toBe('2025-10-16');
  });
});

describe('text helpers', () => {
  it('normalises 台 to 臺 only', () => {
    expect(normTai('台北市台東縣')).toBe('臺北市臺東縣');
    expect(normTai('臺南市')).toBe('臺南市');
  });
  it('rounds to 5 decimals', () => {
    expect(round5(24.076008586)).toBe(24.07601);
    expect(round5(120.546402727)).toBe(120.5464);
  });
  it('cleanText: NFKC, strips html, collapses whitespace, caps length', () => {
    expect(cleanText('登⾰熱')).toBe('登革熱');
    expect(cleanText('<p>a  <b>b</b>\n\tc</p>')).toBe('a b c');
    expect(cleanText('x<script>alert(1)</script>y')).toBe('x y');
    expect(cleanText('&lt;script&gt;alert(1)&lt;/script&gt; ok')).toBe('alert(1) ok');
    expect(cleanText('a\u0000b​c')).toBe('a b c');
    expect(Array.from(cleanText('字'.repeat(1000), 600)).length).toBe(600);
    expect(cleanText(null)).toBe('');
  });
  it('safeCdcUrl only allows https://www.cdc.gov.tw/', () => {
    const ok = 'https://www.cdc.gov.tw/TravelEpidemic/Detail/abc?epidemicId=1';
    expect(safeCdcUrl(ok)).toBe(ok);
    expect(safeCdcUrl('http://www.cdc.gov.tw/x')).toBeNull();
    expect(safeCdcUrl('https://www.cdc.gov.tw.evil.com/x')).toBeNull();
    expect(safeCdcUrl('https://evil.com/https://www.cdc.gov.tw/')).toBeNull();
    expect(safeCdcUrl('javascript:alert(1)')).toBeNull();
    expect(safeCdcUrl('https://www.cdc.gov.tw/x y')).toBeNull();
    expect(safeCdcUrl('https://www.cdc.gov.tw/\\@evil.com')).toBeNull();
    expect(safeCdcUrl(undefined)).toBeNull();
  });
});

describe('mapLimit', () => {
  it('limits concurrency and keeps order', async () => {
    let active = 0, peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(3);
  });
  it('rejects on first failure', async () => {
    await expect(mapLimit([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error('boom'); return x; })).rejects.toThrow('boom');
  });
});
