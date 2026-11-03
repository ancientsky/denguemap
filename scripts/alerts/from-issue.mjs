// @ts-check
/**
 * Turn a "新增防疫公告" issue (.github/ISSUE_TEMPLATE/dengue-alert.yml) into content/alerts/<id>.json.
 * Run by .github/workflows/alert-from-issue.yml with the issue body in env ISSUE_BODY (never interpolated into a
 * shell command). On success writes the notice, pr-body.md and `id=<id>` to $GITHUB_OUTPUT; on failure writes the
 * problems to alert-errors.md (posted back on the issue) and exits 1.
 */
import { appendFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDate, loadVillages, validateAlert } from './lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Labels of the issue form fields (keep in sync with the template). */
export const LABELS = {
  county: '縣市', town: '鄉鎮市區', title: '公告標題', titleEn: '英文標題（選填）', issuedAt: '發布日期', validUntil: '有效期限',
  issuer: '發布單位', sourceUrl: '來源網址', villages: '警戒範圍村里', exposure: '曾至地點（選填）', stations: '採檢站（選填）',
  note: '說明（選填）', noteEn: '英文說明（選填）', confirm: '確認',
};

/** "### Label\n\nvalue" sections of an issue-form body. */
export function sections(body) {
  /** @type {Record<string, string>} */
  const out = {};
  const parts = String(body ?? '').replace(/\r\n/g, '\n').split(/^### /m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const label = (nl < 0 ? p : p.slice(0, nl)).trim();
    const value = (nl < 0 ? '' : p.slice(nl + 1)).trim();
    out[label] = value === '_No response_' ? '' : value;
  }
  return out;
}

const tai = (/** @type {string} */ s) => s.replace(/台/g, '臺').trim();
/** M/D or YYYY-MM-DD or YYYY/M/D → YYYY-MM-DD (M/D takes the year of `year`). */
export function normDate(/** @type {string} */ s, /** @type {number} */ year) {
  const t = s.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[/.](\d{1,2})$/.exec(t);
  if (m) return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return t;
}
/** "22.567, 120.339" (Google Maps order) or "120.339, 22.567" → {lng, lat}; '' → nulls. */
export function coords(/** @type {string} */ s) {
  const n = (s ?? '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (n.length !== 2) return { lng: null, lat: null, bad: (s ?? '').trim() !== '' };
  const [a, b] = n;
  return a > 90 ? { lng: a, lat: b, bad: false } : { lng: b, lat: a, bad: false };
}
const lines = (/** @type {string} */ s) => (s ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !/^[-*]\s*$/.test(l));
const cells = (/** @type {string} */ l) => l.replace(/^[-*]\s+/, '').split(/[|｜]/).map((c) => c.trim());
const list = (/** @type {string} */ s) => (s ?? '').split(/[、,，;；\s]+/).map((x) => x.trim()).filter(Boolean);
const slug = (/** @type {string} */ en) => en.toLowerCase().replace(/\b(city|county|district|township|city)\b/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * @param {string} body issue body @param {number} issue issue number
 * @param {{villages:Map<string, any>, exists?:(id:string)=>boolean}} env
 * @returns {{ok:true, alert:any, id:string, prBody:string}|{ok:false, errors:string[]}}
 */
export function alertFromIssue(body, issue, env) {
  const f = sections(body);
  /** @type {string[]} */
  const errors = [];
  const vill = [...env.villages.values()].map((v) => v.properties);
  const countyName = tai(f[LABELS.county] ?? '');
  const inCounty = vill.filter((p) => p.COUNTYNAME === countyName);
  if (!inCounty.length) errors.push(`找不到縣市「${countyName}」`);
  const townName = tai(f[LABELS.town] ?? '');
  const inTown = inCounty.filter((p) => p.TOWNNAME === townName);
  if (inCounty.length && !inTown.length) errors.push(`${countyName}沒有「${townName}」`);
  const issuedAt = normDate(f[LABELS.issuedAt] ?? '', new Date().getUTCFullYear());
  const year = isDate(issuedAt) ? +issuedAt.slice(0, 4) : new Date().getUTCFullYear();
  const validUntil = normDate(f[LABELS.validUntil] ?? '', year);
  // Villages: names (with or without 里/村) in the town first, then anywhere in the county; or 11-digit codes.
  const codes = [];
  for (const raw of list(f[LABELS.villages] ?? '')) {
    if (/^\d{11}$/.test(raw)) { codes.push(raw); continue; }
    const name = tai(raw).replace(/[（(].*$/, '');
    const match = (/** @type {any[]} */ pool) => pool.filter((p) => p.VILLNAME === name || p.VILLNAME === `${name}里` || p.VILLNAME === `${name}村`);
    let hit = match(inTown);
    if (!hit.length) hit = match(inCounty);
    if (hit.length === 1) codes.push(String(hit[0].VILLCODE));
    else errors.push(hit.length ? `「${raw}」在${countyName}有 ${hit.length} 個同名村里，請改填村里代碼` : `${countyName}${townName}找不到村里「${raw}」`);
  }
  const exposureSites = lines(f[LABELS.exposure] ?? '').map((l, i) => {
    const [name = '', address = '', from = '', to = '', note = '', xy = ''] = cells(l);
    const c = coords(xy);
    if (c.bad) errors.push(`曾至地點第 ${i + 1} 行的座標看不懂：${xy}`);
    return { name, address, from: normDate(from, year), to: normDate(to, year), ...(note ? { note } : {}), ...(c.lng !== null ? { lng: c.lng, lat: c.lat } : {}) };
  });
  const screeningStations = lines(f[LABELS.stations] ?? '').map((l, i) => {
    const [name = '', address = '', dates = '', hours = '', xy = ''] = cells(l);
    const c = coords(xy);
    if (c.bad) errors.push(`採檢站第 ${i + 1} 行的座標看不懂：${xy}`);
    return {
      name, address,
      dates: list(dates).map((d) => normDate(d, year)),
      hours: list(hours.replace(/[~～–—]/g, '-').replace(/：/g, ':')).map((x) => x.replace(/^(\d):/, '0$1:').replace(/-(\d):/, '-0$1:')),
      ...(c.lng !== null ? { lng: c.lng, lat: c.lat } : {}),
    };
  });
  if (!/- \[[xX]\]/.test(f[LABELS.confirm] ?? '')) errors.push('請勾選「已核對衛生局原始公告」');
  if (errors.length) return { ok: false, errors };

  const t0 = inTown[0];
  // e.g. 2026-11-02-kaohsiung-xiaogang; a town whose English name is only "… City" falls back to its code
  let id = `${issuedAt}-${slug(String(t0.COUNTYENG)) || t0.COUNTYCODE}-${slug(String(t0.TOWNENG)) || t0.TOWNCODE}`;
  if (env.exists?.(id)) id = `${id}-${issue}`;
  const opt = (/** @type {string} */ k) => (f[k] ?? '').trim();
  const alert = {
    id,
    title: opt(LABELS.title),
    ...(opt(LABELS.titleEn) ? { titleEn: opt(LABELS.titleEn) } : {}),
    county: String(t0.COUNTYCODE),
    town: String(t0.TOWNCODE),
    issuedAt, validUntil,
    issuer: opt(LABELS.issuer),
    sourceUrl: opt(LABELS.sourceUrl),
    villages: codes,
    exposureSites,
    screeningStations,
    ...(opt(LABELS.note) ? { note: opt(LABELS.note).replace(/\s*\n\s*/g, ' ') } : {}),
    ...(opt(LABELS.noteEn) ? { noteEn: opt(LABELS.noteEn).replace(/\s*\n\s*/g, ' ') } : {}),
  };
  const problems = validateAlert(alert, env.villages, id);
  if (problems.length) return { ok: false, errors: problems };
  const names = codes.map((c) => env.villages.get(c).properties.VILLNAME).join('、');
  const noMention = (/** @type {string} */ s) => s.replace(/@/g, '＠');
  const prBody = noMention([
    `新增防疫公告 \`${id}\`（由 #${issue} 的表單產生）。`,
    '',
    `- **${alert.title}**（${alert.issuer}，${issuedAt} 發布，有效至 ${validUntil}）`,
    `- 警戒範圍：${countyName}${townName} ${names}`,
    ...exposureSites.map((s) => `- 曾至地點：${s.name}（${s.address}）${s.from}～${s.to}`),
    ...screeningStations.map((s) => `- 採檢站：${s.name}（${s.address}）${s.dates.join('、')} ${s.hours.join('、')}`),
    `- 來源：${alert.sourceUrl}`,
    '',
    '審核者請對照原始公告核對村里、日期、時段與地址，確認無誤後合併；合併後約 3 分鐘上線。',
    '',
    `Closes #${issue}`,
  ].join('\n'));
  return { ok: true, alert, id, prBody };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const issue = Number(process.env.ISSUE_NUMBER);
  const villages = await loadVillages();
  const r = alertFromIssue(process.env.ISSUE_BODY ?? '', issue, { villages, exists: (id) => existsSync(join(ROOT, 'content/alerts', `${id}.json`)) });
  if (!r.ok) {
    await writeFile(join(ROOT, 'alert-errors.md'), `表單內容有問題，請編輯這則 issue 修正後會自動重新檢查：\n\n${r.errors.map((e) => `- ${e}`).join('\n')}\n`);
    console.error(r.errors.join('\n'));
    process.exit(1);
  }
  await writeFile(join(ROOT, 'content/alerts', `${r.id}.json`), `${JSON.stringify(r.alert, null, 2)}\n`);
  await writeFile(join(ROOT, 'pr-body.md'), `${r.prBody}\n`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `id=${r.id}\n`);
  console.log(`content/alerts/${r.id}.json written`);
}
