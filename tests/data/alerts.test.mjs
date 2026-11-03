import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAlerts } from '../../scripts/alerts/build.mjs';
import { isSourceUrl, loadVillages, publishAlert, validateAlert } from '../../scripts/alerts/lib.mjs';

const REAL = JSON.parse(await readFile(new URL('../../content/alerts/2026-11-02-kaohsiung-xiaogang.json', import.meta.url), 'utf8'));
const villages = await loadVillages();
const clone = () => JSON.parse(JSON.stringify(REAL));

describe('alerts: validation', () => {
  it('accepts the committed notices', () => {
    expect(validateAlert(REAL, villages, '2026-11-02-kaohsiung-xiaogang')).toEqual([]);
  });
  it('rejects unknown or foreign villages, bad dates, markup and unknown fields', () => {
    const a = clone();
    a.villages = ['64000110007', '99999999999', '67000330001'];
    a.validUntil = '2027-03-01';
    a.title = '<script>x</script>';
    a.extra = 1;
    a.screeningStations[0].hours = ['16:30-14:00'];
    a.exposureSites[0].to = '2026-10-01';
    const errs = validateAlert(a, villages, a.id).join('\n');
    expect(errs).toMatch(/找不到村里代碼：99999999999/);
    expect(errs).toMatch(/不在該縣市/);
    expect(errs).toMatch(/60 天內/);
    expect(errs).toMatch(/標題/);
    expect(errs).toMatch(/不認得的欄位：extra/);
    expect(errs).toMatch(/HH:MM-HH:MM/);
    expect(errs).toMatch(/結束不早於開始/);
  });
  it('checks coordinates against the warning area (swapped lat/lng is caught)', () => {
    const a = clone();
    a.screeningStations[0].lng = 22.56;
    a.screeningStations[0].lat = 120.34;
    expect(validateAlert(a, villages, a.id).join()).toMatch(/經緯度是否填反/);
    a.screeningStations[0].lng = 120.34;
    a.screeningStations[0].lat = 22.56;
    expect(validateAlert(a, villages, a.id)).toEqual([]);
  });
  it('source URLs: government, official social pages and listed news sites only', () => {
    expect(isSourceUrl('https://khd.kcg.gov.tw/tw/news/1')).toBe(true);
    expect(isSourceUrl('https://www.facebook.com/kcghealth/posts/1')).toBe(true);
    expect(isSourceUrl('https://www.mnews.tw/story/x')).toBe(true);
    expect(isSourceUrl('http://khd.kcg.gov.tw/')).toBe(false);
    expect(isSourceUrl('https://gov.tw.evil.example/')).toBe(false);
    expect(isSourceUrl('https://evil.example/?u=https://x.gov.tw')).toBe(false);
    expect(isSourceUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('alerts: publish and build', () => {
  it('resolves village names and polygons from the codes', () => {
    const p = publishAlert(REAL, villages);
    expect(p.townZh).toBe('小港區');
    expect(p.townEn).toBe('Xiaogang District');
    expect(p.villages.map((v) => v.zh)).toContain('港南里');
    expect(p.area.features).toHaveLength(8);
    expect(['Polygon', 'MultiPolygon']).toContain(p.area.features[0].geometry.type);
  });
  it('builds valid notices, drops long-expired ones and fails on any invalid file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alerts-'));
    await mkdir(join(root, 'content/alerts'), { recursive: true });
    await writeFile(join(root, 'content/alerts/2026-11-02-kaohsiung-xiaogang.json'), JSON.stringify(REAL));
    let out = await buildAlerts({ root, today: '2026-11-20' });
    expect(out.alerts).toHaveLength(1);
    expect(JSON.parse(await readFile(join(root, 'public/data/alerts.json'), 'utf8')).alerts[0].id).toBe(REAL.id);
    out = await buildAlerts({ root, today: '2026-12-01', check: true });
    expect(out.alerts).toHaveLength(0); // validUntil 11-16 + 7 days < 12-01
    await writeFile(join(root, 'content/alerts/2026-11-05-bad.json'), JSON.stringify({ ...REAL, id: 'wrong' }));
    await expect(buildAlerts({ root, today: '2026-11-20', check: true })).rejects.toThrow(/防疫公告驗證失敗/);
  });
});
