import { describe, expect, it } from 'vitest';
import { alertFromIssue, coords, normDate, sections } from '../../scripts/alerts/from-issue.mjs';
import { loadVillages } from '../../scripts/alerts/lib.mjs';

const villages = await loadVillages();
// The body GitHub renders for an issue form ("### label" + value; empty optional fields are "_No response_").
const body = (over = {}) => {
  const f = {
    縣市: '高雄市', 鄉鎮市區: '小港區', 公告標題: '高雄市小港區本土登革熱群聚', '英文標題（選填）': '_No response_',
    發布日期: '2026-11-02', 有效期限: '2026-11-16', 發布單位: '高雄市政府衛生局', 來源網址: 'https://www.mnews.tw/story/mm-20261103edi047',
    警戒範圍村里: '港南、小港里、港墘里、港后里\n港明里、港興里、港口里、港正里',
    '曾至地點（選填）': '99五金賣場｜高雄市小港區小港路186號｜10/17｜11/2｜曾至港南里活動或在賣場採購的民眾，請至採血站檢驗。｜',
    '採檢站（選填）': '小港衛生所｜高雄市小港區小港二街10號｜11/3, 11/4｜08:30-11:30, 14:00-16:30｜22.5671, 120.3389\n99五金賣場|高雄市小港區小港路186號|11/3、11/4|8:30～11:30，14:00～16:30|',
    '說明（選填）': '請醫療院所提高警覺，落實 TOCC 問診，加強通報。', '英文說明（選填）': '_No response_',
    確認: '- [X] 已核對衛生局原始公告，內容一致',
    ...over,
  };
  return Object.entries(f).map(([k, v]) => `### ${k}\n\n${v}`).join('\n\n');
};

describe('alert from issue form', () => {
  it('parses sections and helpers', () => {
    expect(sections('### A\n\nx\n\n### B\n\n_No response_')).toEqual({ A: 'x', B: '' });
    expect(normDate('11/3', 2026)).toBe('2026-11-03');
    expect(normDate('2026/1/5', 2026)).toBe('2026-01-05');
    expect(coords('22.5671, 120.3389')).toEqual({ lng: 120.3389, lat: 22.5671, bad: false });
    expect(coords('120.3389 22.5671')).toEqual({ lng: 120.3389, lat: 22.5671, bad: false });
    expect(coords('somewhere').bad).toBe(true);
  });
  it('builds the same notice as the hand-written file', () => {
    const r = alertFromIssue(body(), 12, { villages, exists: () => false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.id).toBe('2026-11-02-kaohsiung-xiaogang');
    expect(r.alert.county).toBe('64000');
    expect(r.alert.town).toBe('64000110');
    expect(r.alert.villages).toHaveLength(8);
    expect(r.alert.villages).toContain('64000110007'); // 港南 without 里
    expect(r.alert.exposureSites[0]).toMatchObject({ from: '2026-10-17', to: '2026-11-02' });
    expect(r.alert.screeningStations[0]).toMatchObject({ dates: ['2026-11-03', '2026-11-04'], hours: ['08:30-11:30', '14:00-16:30'], lng: 120.3389, lat: 22.5671 });
    expect(r.alert.screeningStations[1].hours).toEqual(['08:30-11:30', '14:00-16:30']);
    expect(r.prBody).toMatch(/Closes #12/);
  });
  it('reports problems instead of guessing', () => {
    const r = alertFromIssue(body({ 警戒範圍村里: '港南里、不存在里', 確認: '- [ ] 已核對衛生局原始公告，內容一致' }), 13, { villages });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(/找不到村里「不存在里」/);
    expect(r.errors.join('\n')).toMatch(/請勾選/);
    const bad = alertFromIssue(body({ 來源網址: 'https://evil.example/x' }), 14, { villages });
    expect(bad.ok).toBe(false);
  });
  it('a second notice for the same town and day gets the issue number; mentions are neutralised', () => {
    const r = alertFromIssue(body({ 公告標題: '小港區群聚 @someone' }), 15, { villages, exists: () => true });
    expect(r.ok && r.id).toBe('2026-11-02-kaohsiung-xiaogang-15');
    expect(r.ok && r.prBody).not.toMatch(/@/);
  });
});
