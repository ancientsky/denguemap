// Builders for the data-contract v2 files (docs/data-contract.md "v2 增補"):
//   geo/world.topo.json  — from npm world-atlas (50m) + i18n-iso-countries, simplified
//   travel.json          — from SafeTravel TW alerts.json + epidemics.json (or a small synthetic set)
// Used by make-fixtures.mjs for local development only; the real pipeline produces these files.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const topojson = require('topojson-client');
const { presimplify, simplify, quantile } = require('topojson-simplify');

export const VB = {
  登革熱: 'dengue', 屈公病: 'chikungunya', 茲卡病毒感染症: 'zika', 黃熱病: 'yellowFever', 瘧疾: 'malaria', 日本腦炎: 'japaneseEncephalitis', 西尼羅熱: 'westNile',
};
const DISEASES = {
  dengue: { zh: '登革熱', en: 'Dengue' }, chikungunya: { zh: '屈公病', en: 'Chikungunya' }, zika: { zh: '茲卡病毒感染症', en: 'Zika virus infection' },
  yellowFever: { zh: '黃熱病', en: 'Yellow fever' }, malaria: { zh: '瘧疾', en: 'Malaria' }, japaneseEncephalitis: { zh: '日本腦炎', en: 'Japanese encephalitis' },
  westNile: { zh: '西尼羅熱', en: 'West Nile fever' },
};

export function buildWorld() {
  const iso = require('i18n-iso-countries');
  const w = structuredClone(require('world-atlas/countries-50m.json'));
  delete w.objects.land;
  const geoms = [];
  for (const g of w.objects.countries.geometries) {
    if (!g.id || g.id === '010') continue; // unnamed territories; Antarctica
    const a2 = iso.numericToAlpha2(g.id);
    if (!a2) continue;
    geoms.push({ ...g, id: undefined, properties: { iso2: a2.toLowerCase() } });
  }
  w.objects.countries.geometries = geoms;
  // Drop the transform-relative quantisation, simplify on the sphere-ish planar weights, then re-quantise.
  const pre = presimplify(w);
  const simp = simplify(pre, quantile(pre, 0.5));
  // keep tiny island nations (sg, mv…): simplify() never removes arc endpoints, so rings survive
  return topojson.quantize(simp, 1e4);
}

const clean = (s, max = 600) => String(s ?? '').normalize('NFKC').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const SAFE_URL = /^https:\/\/www\.cdc\.gov\.tw\//;

export function buildTravel(dir, today) {
  const alertsP = join(dir, 'alerts.json');
  const epiP = join(dir, 'epidemics.json');
  if (!existsSync(alertsP) || !existsSync(epiP)) return syntheticTravel(today);
  const alerts = JSON.parse(readFileSync(alertsP, 'utf8'));
  const epi = JSON.parse(readFileSync(epiP, 'utf8'));
  const levels = {};
  for (const [k, l] of Object.entries(alerts.levels ?? {})) {
    levels[k] = { zh: clean(l.zh).replace(/\s*\([^)]*\)$/, ''), en: clean(l.en), adviceZh: clean(l.instruction_zh), adviceEn: clean(l.instruction_en) };
  }
  const countries = {};
  for (const [cc, c] of Object.entries(alerts.countries ?? {})) {
    if (!/^[A-Z]{2}$/.test(cc) || !c.alerts?.length) continue;
    const vb = c.alerts.filter((a) => VB[a.disease]).map((a) => ({ d: VB[a.disease], level: a.level, since: a.effective ?? '', areaZh: clean(a.area_zh, 200), areaEn: clean(a.area_en, 200) }));
    countries[cc.toLowerCase()] = { zh: clean(c.name_zh, 60), en: clean(c.name_en, 60), level: c.max_level, vb };
  }
  const cutoff = `${Number(today.slice(0, 4)) - 2}${today.slice(4)}`;
  const news = [];
  for (const it of epi.items ?? []) {
    const names = String(it.disease_zh ?? '').split(/[,，、]/).map((s) => s.trim());
    const d = [...new Set(names.map((n) => VB[n]).filter(Boolean))];
    if (!d.length || !(it.date >= cutoff)) continue;
    news.push({
      id: String(it.id), date: it.date, d, countries: (it.countries ?? []).filter((c) => /^[A-Z]{2}$/.test(c)).map((c) => c.toLowerCase()),
      headlineZh: clean(it.headline_zh), headlineEn: clean(it.headline_en), summaryZh: clean(it.summary_zh), summaryEn: clean(it.summary_en),
      url: SAFE_URL.test(it.url ?? '') ? it.url : null,
    });
  }
  news.sort((a, b) => b.date.localeCompare(a.date));
  return { updated: alerts.generated_at, levels, diseases: DISEASES, countries, news: news.slice(0, 300) };
}

function syntheticTravel(today) {
  const levels = {
    1: { zh: '第一級：注意', en: 'Level 1: Watch', adviceZh: '提醒遵守當地的一般預防措施', adviceEn: 'Practice usual precautions' },
    2: { zh: '第二級：警示', en: 'Level 2: Alert', adviceZh: '對當地採取加強防護', adviceEn: 'Practice enhanced precautions' },
    3: { zh: '第三級：警告', en: 'Level 3: Warning', adviceZh: '避免至當地所有非必要旅遊', adviceEn: 'Avoid all non-essential travel' },
  };
  const c = (zh, en, level, vb) => ({ zh, en, level, vb });
  const countries = {
    vn: c('越南', 'Vietnam', 2, [{ d: 'dengue', level: 2, since: '2026-02-03', areaZh: '', areaEn: '' }]),
    id: c('印尼', 'Indonesia', 1, [{ d: 'dengue', level: 1, since: '2025-06-01', areaZh: '', areaEn: '' }]),
    br: c('巴西', 'Brazil', 2, [{ d: 'chikungunya', level: 2, since: '2025-04-01', areaZh: '', areaEn: '' }, { d: 'yellowFever', level: 1, since: '2025-02-01', areaZh: '', areaEn: '' }]),
    jp: c('日本', 'Japan', 1, []),
  };
  const news = [{ id: 'syn1', date: today, d: ['dengue'], countries: ['vn'], headlineZh: '越南-登革熱', headlineEn: 'Vietnam – Dengue', summaryZh: '越南登革熱病例上升。', summaryEn: 'Dengue cases are rising in Vietnam.', url: null }];
  return { updated: `${today}T08:00:00+08:00`, levels, diseases: DISEASES, countries, news };
}
