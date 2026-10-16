#!/usr/bin/env node
// Generates REALISTIC but SYNTHETIC data conforming to docs/data-contract.md into public/data/.
// The real pipeline (scripts/data/) overwrites these files; the app must not depend on fixture specifics.
// Usage: npm run fixtures   (deterministic: seeded PRNG, "today" fixed to TODAY below unless FIXTURE_TODAY is set)
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const topojson = require('topojson-client');
const { topology } = require('topojson-server');
const { presimplify, simplify, quantile } = require('topojson-simplify');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'public', 'data');
const TODAY = process.env.FIXTURE_TODAY || '2026-10-16';
const LATEST_ONSET = addDays(TODAY, -2);

// ---------- deterministic PRNG ----------
let seed = 20261016;
function rand() {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
function gauss() { let u = 0, v = 0; while (u === 0) u = rand(); while (v === 0) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function weighted(entries) { // [[value, weight], ...]
  const total = entries.reduce((s, e) => s + e[1], 0); let r = rand() * total;
  for (const [v, w] of entries) { if ((r -= w) <= 0) return v; }
  return entries[entries.length - 1][0];
}
const r5 = (x) => Math.round(x * 1e5) / 1e5;

// ---------- dates (UTC math on YYYY-MM-DD) ----------
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function fmt(ms) { return new Date(ms).toISOString().slice(0, 10); }
function addDays(s, n) { return fmt(parseDate(s) + n * 86400000); }
function doyOf(s) { const y = Number(s.slice(0, 4)); return Math.round((parseDate(s) - Date.UTC(y, 0, 1)) / 86400000) + 1; }
function dateOfDoy(y, doy) { return fmt(Date.UTC(y, 0, 1) + (doy - 1) * 86400000); }
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y) => (isLeap(y) ? 366 : 365);
const TODAY_YEAR = Number(TODAY.slice(0, 4));

// ---------- output helpers ----------
const written = new Map();
function out(rel, obj) {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  const s = JSON.stringify(obj);
  writeFileSync(p, s);
  written.set(rel, createHash('sha256').update(s).digest('hex').slice(0, 8));
  console.log(`  ${rel.padEnd(32)} ${(s.length / 1024).toFixed(1).padStart(8)} KB`);
}

const zhNorm = (s) => String(s).replace(/台/g, '臺');

// ---------- geometry helpers ----------
function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function polyContains(geom, x, y) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  for (const p of polys) {
    if (ringContains(p[0], x, y) && !p.slice(1).some((h) => ringContains(h, x, y))) return true;
  }
  return false;
}
function bboxOf(geom) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const p of polys) for (const [x, y] of p[0]) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}
function largestPolygonBBox(geom) {
  if (geom.type === 'Polygon') return bboxOf(geom);
  let best = null, bestA = -1;
  for (const p of geom.coordinates) {
    const b = bboxOf({ type: 'Polygon', coordinates: p }); const a = (b[2] - b[0]) * (b[3] - b[1]);
    if (a > bestA) { bestA = a; best = b; }
  }
  return best;
}
function randomPointIn(feature) {
  const b = largestPolygonBBox(feature.geometry);
  for (let i = 0; i < 500; i++) {
    const x = b[0] + rand() * (b[2] - b[0]), y = b[1] + rand() * (b[3] - b[1]);
    if (polyContains(feature.geometry, x, y)) return [r5(x), r5(y)];
  }
  return [r5((b[0] + b[2]) / 2), r5((b[1] + b[3]) / 2)];
}

// ======================================================================
console.log(`Generating fixtures into ${OUT} (today=${TODAY})`);
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ---------- geo/admin.topo.json ----------
const atlasTowns = require('taiwan-atlas/towns-10t.json');
const admin = structuredClone(atlasTowns);
delete admin.objects.nation;
for (const g of admin.objects.counties.geometries) {
  const p = g.properties;
  g.properties = { code: p.COUNTYCODE, zh: zhNorm(p.COUNTYNAME), en: p.COUNTYENG };
}
for (const g of admin.objects.towns.geometries) {
  const p = g.properties;
  g.properties = { code: p.TOWNCODE, county: p.COUNTYCODE, zh: zhNorm(p.TOWNNAME), en: p.TOWNENG };
}
const adminPre = presimplify(admin);
// simplify() returns absolute [x, y, weight] arcs; quantize() re-encodes as delta-encoded integer [x, y]
const adminSimple = topojson.quantize(simplify(adminPre, quantile(adminPre, 0.3)), 1e5);
out('geo/admin.topo.json', adminSimple);

const towns = topojson.feature(atlasTowns, atlasTowns.objects.towns).features.map((f) => ({
  ...f, code: f.properties.TOWNCODE, county: f.properties.COUNTYCODE, zh: zhNorm(f.properties.TOWNNAME),
}));
const townByCode = new Map(towns.map((t) => [t.code, t]));
const townsOf = (county) => towns.filter((t) => t.county === county);
const findTown = (county, zh) => towns.find((t) => t.county === county && t.zh === zh);

const C = { TPE: '63000', NTP: '65000', TYN: '68000', TXG: '66000', TNN: '67000', KHH: '64000', PIF: '10013', CYI: '10020', CYQ: '10010', HSZ: '10018', HSQ: '10004', ILA: '10002', MIA: '10005', CHA: '10007', NAN: '10008', YUN: '10009', KEE: '10017', HUA: '10015', TTT: '10014', PEN: '10016', KIN: '09020', LIE: '09007' };

// Population-ish weights for where imported cases live
const importedCountyWeights = [[C.NTP, 18], [C.TPE, 12], [C.TYN, 12], [C.TXG, 13], [C.KHH, 12], [C.TNN, 8], [C.CHA, 5], [C.PIF, 4], [C.HSQ, 3], [C.HSZ, 2], [C.YUN, 3], [C.MIA, 2], [C.ILA, 2], [C.NAN, 2], [C.KEE, 1], [C.CYI, 1], [C.CYQ, 2], [C.HUA, 1], [C.TTT, 1]];

// ---------- case generation ----------
// Outbreak spec: county, list of [townZh, weight], n cases, peak doy, sd (days)
function buildYear(year, { outbreaks, imported, maxDoy }) {
  const pts = []; const ptIndex = new Map();
  const addPt = (xy, town) => {
    const key = `${xy[0]},${xy[1]}`;
    if (!ptIndex.has(key)) { ptIndex.set(key, pts.length); pts.push([xy[0], xy[1], town]); }
    return ptIndex.get(key);
  };
  const agg = new Map(); // `${doy}|${pt}|${imp}` -> count
  const caseList = []; // for trend/summary derivations: [doy, townCode|null, imp]
  const add = (doy, pt, imp, town) => {
    const k = `${doy}|${pt}|${imp}`; agg.set(k, (agg.get(k) || 0) + 1); caseList.push([doy, town, imp]);
  };
  const lastDoy = Math.min(maxDoy, daysIn(year));
  for (const ob of outbreaks) {
    const townEntries = ob.towns.map(([zh, w]) => {
      const t = findTown(ob.county, zh); if (!t) throw new Error(`town not found ${ob.county} ${zh}`);
      // candidate centroid pool per town (minimum statistical areas): sized by weight
      const pool = Array.from({ length: Math.max(6, Math.round(w * ob.poolScale)) }, () => addPt(randomPointIn(t), t.code));
      return [{ t, pool }, w];
    });
    for (let i = 0; i < ob.n; i++) {
      let doy = Math.round(ob.peak + gauss() * ob.sd);
      if (doy < 1 || doy > lastDoy) { i--; if (rand() < 0.02) i++; continue; }
      const { t, pool } = weighted(townEntries);
      // zipf-ish clustering within the pool
      const idx = Math.min(pool.length - 1, Math.floor(Math.pow(rand(), 2.2) * pool.length));
      add(doy, pool[idx], 0, t.code);
    }
  }
  // sporadic local cases elsewhere
  for (let i = 0; i < (imported.sporadicLocal || 0); i++) {
    const county = weighted([[C.KHH, 4], [C.TNN, 3], [C.PIF, 2], [C.TXG, 1], [C.CYQ, 1]]);
    const t = pick(townsOf(county));
    const doy = Math.round(240 + gauss() * 40);
    if (doy < 1 || doy > lastDoy) continue;
    add(doy, addPt(randomPointIn(t), t.code), 0, t.code);
  }
  for (let i = 0; i < imported.n; i++) {
    let doy = rand() < 0.65 ? Math.round(200 + gauss() * 55) : randInt(1, daysIn(year));
    if (doy < 1 || doy > lastDoy) { i--; continue; }
    const county = weighted(importedCountyWeights);
    const t = pick(townsOf(county));
    add(doy, addPt(randomPointIn(t), t.code), 1, t.code);
  }
  // a couple of points with unknown town (e.g. offshore islets not matched) to exercise null townCode
  if (year === TODAY_YEAR) {
    const pIdx = addPt([r5(119.56), r5(23.56)], null);
    add(Math.min(lastDoy, 200), pIdx, 1, null);
  }
  const c = [...agg.entries()].map(([k, n]) => { const [d, p, i] = k.split('|').map(Number); return [d, p, i, n]; })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return { file: { year, pts, c }, caseList };
}

const yearSpecs = {
  2015: { outbreaks: [
      { county: C.TNN, towns: [['北區', 5], ['中西區', 4], ['東區', 5], ['南區', 3], ['永康區', 4], ['安南區', 2], ['安平區', 2]], n: 22700, peak: 255, sd: 28, poolScale: 120 },
      { county: C.KHH, towns: [['前鎮區', 5], ['三民區', 4], ['苓雅區', 4], ['鳳山區', 4], ['小港區', 3], ['新興區', 2], ['鼓山區', 2], ['左營區', 2]], n: 19700, peak: 275, sd: 26, poolScale: 120 },
      { county: C.PIF, towns: [['屏東市', 3], ['東港鎮', 1]], n: 350, peak: 280, sd: 25, poolScale: 20 },
    ], imported: { n: 366, sporadicLocal: 600 }, maxDoy: 366 },
  2023: { outbreaks: [
      { county: C.TNN, towns: [['永康區', 5], ['北區', 4], ['東區', 4], ['中西區', 2], ['南區', 3], ['仁德區', 2], ['歸仁區', 2], ['新市區', 1]], n: 19800, peak: 258, sd: 30, poolScale: 100 },
      { county: C.KHH, towns: [['三民區', 3], ['鳳山區', 3], ['前鎮區', 2], ['左營區', 2], ['苓雅區', 2]], n: 4100, peak: 280, sd: 25, poolScale: 60 },
      { county: C.PIF, towns: [['屏東市', 2]], n: 120, peak: 270, sd: 25, poolScale: 12 },
    ], imported: { n: 412, sporadicLocal: 300 }, maxDoy: 366 },
  2024: { outbreaks: [
      { county: C.KHH, towns: [['前鎮區', 2], ['鳳山區', 2], ['三民區', 1]], n: 120, peak: 250, sd: 30, poolScale: 8 },
      { county: C.TNN, towns: [['東區', 1], ['北區', 1]], n: 40, peak: 230, sd: 20, poolScale: 6 },
    ], imported: { n: 268, sporadicLocal: 25 }, maxDoy: 366 },
  2025: { outbreaks: [
      { county: C.KHH, towns: [['鼓山區', 2], ['三民區', 2], ['苓雅區', 1]], n: 140, peak: 262, sd: 22, poolScale: 8 },
      { county: C.TNN, towns: [['安南區', 1]], n: 25, peak: 280, sd: 15, poolScale: 4 },
    ], imported: { n: 231, sporadicLocal: 20 }, maxDoy: 366 },
  [TODAY_YEAR]: { outbreaks: [
      { county: C.TNN, towns: [['東區', 3], ['北區', 2], ['永康區', 2], ['中西區', 1]], n: 120, peak: doyOf(LATEST_ONSET) - 32, sd: 18, poolScale: 10 },
      { county: C.KHH, towns: [['前鎮區', 3], ['苓雅區', 2], ['鳳山區', 2], ['小港區', 1]], n: 150, peak: doyOf(LATEST_ONSET) - 22, sd: 16, poolScale: 10 },
      { county: C.PIF, towns: [['屏東市', 2], ['東港鎮', 1]], n: 48, peak: doyOf(LATEST_ONSET) - 14, sd: 10, poolScale: 6 },
    ], imported: { n: 185, sporadicLocal: 12 }, maxDoy: doyOf(LATEST_ONSET) },
};

const generated = {};
for (const [y, spec] of Object.entries(yearSpecs)) {
  const year = Number(y);
  generated[year] = buildYear(year, spec);
  // ensure the latest onset day actually has a case in the current year
  if (year === TODAY_YEAR) {
    const f = generated[year].file; const d = doyOf(LATEST_ONSET);
    if (!f.c.some((r) => r[0] === d)) {
      const t = findTown(C.KHH, '前鎮區'); const idx = f.pts.length; f.pts.push([...randomPointIn(t), t.code]);
      f.c.push([d, idx, 0, 1]); generated[year].caseList.push([d, t.code, 0]);
    }
  }
  out(`cases/${year}.json`, generated[year].file);
}
const caseYears = Object.keys(generated).map(Number).sort((a, b) => a - b);

// ---------- trend.json ----------
// Approximate national annual totals [local, imported] for years without a generated cases file.
const annual = { 1998: [222, 122], 1999: [26, 42], 2000: [113, 26], 2001: [228, 52], 2002: [5336, 52], 2003: [86, 59], 2004: [336, 91], 2005: [202, 104], 2006: [965, 109], 2007: [1999, 214], 2008: [714, 226], 2009: [837, 204], 2010: [1670, 304], 2011: [1545, 157], 2012: [1300, 178], 2013: [524, 263], 2014: [15492, 240], 2016: [381, 363], 2017: [10, 333], 2018: [101, 432], 2019: [104, 536], 2020: [0, 66], 2021: [12, 0], 2022: [25, 63] };
const START = '1998-01-01';
const nDays = Math.round((parseDate(TODAY) - parseDate(START)) / 86400000) + 1;
const nat = { local: new Array(nDays).fill(0), imported: new Array(nDays).fill(0) };
const countyDaily = new Map(); // code -> {local: Map(day->n), imported: Map}
const cAdd = (code, kind, day, n) => {
  if (!countyDaily.has(code)) countyDaily.set(code, { local: new Map(), imported: new Map() });
  const m = countyDaily.get(code)[kind]; m.set(day, (m.get(day) || 0) + n);
};
const dayIndex = (year, doy) => Math.round((Date.UTC(year, 0, 1) - parseDate(START)) / 86400000) + doy - 1;
for (let year = 1998; year <= TODAY_YEAR; year++) {
  if (generated[year]) {
    for (const [doy, town, imp] of generated[year].caseList) {
      const di = dayIndex(year, doy); if (di < 0 || di >= nDays) continue;
      const kind = imp ? 'imported' : 'local';
      nat[kind][di]++;
      if (town) cAdd(town.slice(0, 5), kind, di, 1);
    }
    continue;
  }
  const [nl, ni] = annual[year] || [0, 0];
  const localCounties = year === 2002 || year === 2009 ? [[C.KHH, 8], [C.PIF, 1], [C.TNN, 1]] : [[C.KHH, 5], [C.TNN, 4], [C.PIF, 1]];
  for (let i = 0; i < nl; i++) {
    const doy = Math.round(270 + gauss() * 32); if (doy < 1 || doy > daysIn(year)) continue;
    const di = dayIndex(year, doy); nat.local[di]++; cAdd(weighted(localCounties), 'local', di, 1);
  }
  for (let i = 0; i < ni; i++) {
    const doy = rand() < 0.6 ? Math.round(205 + gauss() * 55) : randInt(1, daysIn(year)); if (doy < 1 || doy > daysIn(year)) continue;
    const di = dayIndex(year, doy); nat.imported[di]++; cAdd(weighted(importedCountyWeights), 'imported', di, 1);
  }
}
const county = {};
for (const [code, kinds] of [...countyDaily.entries()].sort()) {
  county[code] = {
    local: [...kinds.local.entries()].sort((a, b) => a[0] - b[0]),
    imported: [...kinds.imported.entries()].sort((a, b) => a[0] - b[0]),
  };
}
out('trend.json', { start: START, end: TODAY, national: nat, county });

// ---------- summary.json ----------
{
  const cur = generated[TODAY_YEAR].caseList; const prev = generated[TODAY_YEAR - 1]?.caseList || [];
  const todayDoy = doyOf(TODAY);
  const sum = (list, pred) => list.reduce((s, r) => { if (pred(r)) s[r[2] ? 'imported' : 'local']++; return s; }, { local: 0, imported: 0 });
  const prevCut = doyOf(`${TODAY_YEAR - 1}${TODAY.slice(4)}`);
  const byCounty = {};
  for (const [, town, imp] of cur) { if (!town) continue; const k = town.slice(0, 5); byCounty[k] ??= { local: 0, imported: 0 }; byCounty[k][imp ? 'imported' : 'local']++; }
  const t14 = new Map();
  for (const [doy, town, imp] of cur) { if (!town || doy <= todayDoy - 14) continue; const v = t14.get(town) || [0, 0]; v[imp]++; t14.set(town, v); }
  const topTowns14 = [...t14.entries()].map(([k, [l, i]]) => [k, l, i]).sort((a, b) => b[1] - a[1] || b[2] - a[2]).slice(0, 20);
  out('summary.json', {
    asOf: TODAY, latestOnset: LATEST_ONSET, year: TODAY_YEAR,
    ytd: sum(cur, () => true),
    last7: sum(cur, (r) => r[0] > todayDoy - 7), last14: sum(cur, (r) => r[0] > todayDoy - 14), last30: sum(cur, (r) => r[0] > todayDoy - 30),
    prevYtd: sum(prev, (r) => r[0] <= prevCut), byCounty, topTowns14,
  });
}

// ---------- imported.json + notices.json ----------
const countries = {
  vn: ['越南', 14.06, 108.28, 24], id: ['印尼', -0.79, 113.92, 22], ph: ['菲律賓', 12.88, 121.77, 12], th: ['泰國', 15.87, 100.99, 9],
  my: ['馬來西亞', 4.21, 101.98, 8], kh: ['柬埔寨', 12.57, 104.99, 4], mm: ['緬甸', 21.91, 95.96, 3], sg: ['新加坡', 1.35, 103.82, 3],
  in: ['印度', 20.59, 78.96, 3], bd: ['孟加拉', 23.68, 90.36, 2], mv: ['馬爾地夫', 3.2, 73.22, 2], lk: ['斯里蘭卡', 7.87, 80.77, 1.5],
  br: ['巴西', -14.24, -51.93, 1], la: ['寮國', 19.86, 102.5, 1], pk: ['巴基斯坦', 30.38, 69.35, 0.6],
};
const imp = {};
let impFrom = '2023-01-01';
for (const year of caseYears.filter((y) => y >= 2023)) {
  for (const [doy, , isImp] of generated[year].caseList) {
    if (!isImp) continue;
    const cc = weighted(Object.entries(countries).map(([k, v]) => [k, v[3]]));
    const d = dateOfDoy(year, doy);
    imp[cc] ??= { zh: countries[cc][0], lat: countries[cc][1], lng: countries[cc][2], byYear: {}, byMonth: {} };
    imp[cc].byYear[year] = (imp[cc].byYear[year] || 0) + 1;
    imp[cc].byMonth[d.slice(0, 7)] = (imp[cc].byMonth[d.slice(0, 7)] || 0) + 1;
  }
}
for (const v of Object.values(imp)) {
  v.byYear = Object.fromEntries(Object.entries(v.byYear).sort());
  v.byMonth = Object.fromEntries(Object.entries(v.byMonth).sort());
}
out('imported.json', { from: impFrom, to: LATEST_ONSET, countries: Object.fromEntries(Object.entries(imp).sort((a, b) => a[0].localeCompare(b[0]))) });

const noticeTexts = [
  (zh) => `${zh}衛生單位統計，今年累計登革熱病例數較去年同期上升，近期仍處流行季，以東南部及沿海城市病例較多。疾管署提醒民眾前往當地應做好防蚊措施，穿著淺色長袖衣褲並使用含 DEET、Picaridin 或 IR3535 等有效成分之防蚊藥劑。`,
  (zh) => `${zh}近期登革熱疫情升溫，多個行政區病例數創近年新高，當地已啟動病媒蚊孳生源清除行動。返國後如出現發燒、頭痛、後眼窩痛、肌肉關節痛或出疹等症狀，請儘速就醫並主動告知旅遊史。`,
  (zh) => `${zh}今年登革熱疫情處於季節性流行高峰，病例主要分布於都會區。國際旅遊疫情建議等級維持第一級：注意（Watch），提醒民眾遵守當地的一般預防措施。`,
  (zh) => `${zh}衛生部門公布最新監測資料，登革熱累計病例逾數萬例，其中重症及死亡病例集中於兒童與高齡族群；當地正值雨季，預期疫情將持續。`,
];
const notices = {};
let nid = 21800;
for (const [cc, v] of Object.entries(imp)) {
  const recent = Object.entries(v.byMonth).some(([m, n]) => n > 0 && m >= addDays(TODAY, -365).slice(0, 7));
  if (!recent) continue;
  const k = randInt(1, 4); const list = [];
  let d = addDays(TODAY, -randInt(3, 20));
  for (let i = 0; i < k; i++) {
    list.push({ date: d, headline: `${v.zh}-登革熱`, text: noticeTexts[(i + cc.charCodeAt(0)) % noticeTexts.length](v.zh), url: rand() < 0.92 ? `https://www.cdc.gov.tw/Bulletin/Detail/${(nid++).toString(36)}?typeid=9` : null });
    d = addDays(d, -randInt(15, 70));
  }
  notices[cc] = list;
}
out('notices.json', notices);

// ---------- vector.json + geo/vector-villages.topo.json ----------
const atlasVill = require('taiwan-atlas/villages-10t.json');
const villFeatures = topojson.feature(atlasVill, atlasVill.objects.villages).features;
const villTotals = {};
for (const f of villFeatures) villTotals[f.properties.COUNTYCODE] = (villTotals[f.properties.COUNTYCODE] || 0) + 1;
const weekEnd = (() => { // most recent Saturday at least 2 days before TODAY
  let d = addDays(TODAY, -2); while (new Date(parseDate(d)).getUTCDay() !== 6) d = addDays(d, -1); return d;
})();
const weeks = Array.from({ length: 5 }, (_, i) => [addDays(weekEnd, -6 - 7 * i), addDays(weekEnd, -7 * i)]);
const vectorCountyPlan = [[C.KHH, 140], [C.TNN, 110], [C.PIF, 50], [C.CYQ, 10], [C.TXG, 8]];
function indicatorsFor(color) {
  // [color, breteauLevel|null, ovitrap%|null, gravitrap%|null] — consistent with the risk definitions
  if (color === 0) return [0, null, null, null];
  const which = pick(['bi', 'ovi', 'gra']);
  let bi = rand() < 0.5 ? randInt(0, 1) : null, ovi = rand() < 0.5 ? randInt(0, 39) : null, gra = rand() < 0.3 ? randInt(0, 9) : null;
  if (color === 3) { if (which === 'bi') bi = randInt(3, 6); else if (which === 'ovi') ovi = randInt(60, 100); else gra = randInt(30, 70); }
  if (color === 2) { if (which === 'bi') bi = 2; else if (which === 'ovi') ovi = randInt(40, 59); else gra = randInt(10, 29); }
  if (color === 1 && bi === null && ovi === null && gra === null) bi = 1;
  return [color, bi, ovi, gra];
}
const villages = [];
const polyCodes = new Set();
for (const [code, n] of vectorCountyPlan) {
  const pool = villFeatures.filter((f) => f.properties.COUNTYCODE === code);
  const chosen = new Set();
  while (chosen.size < Math.min(n, pool.length)) chosen.add(pool[Math.floor(rand() * pool.length)]);
  let k = 0;
  for (const f of chosen) {
    const p = f.properties;
    const wk = weeks.map((_, wi) => {
      if (rand() < 0.35) return indicatorsFor(0);
      const base = code === C.KHH || code === C.TNN ? [[1, 62], [2, 26], [3, 12]] : [[1, 75], [2, 20], [3, 5]];
      return indicatorsFor(weighted(wi === 0 ? base : base.map(([c, w]) => [c, w])));
    });
    if (wk.every((w) => w[0] === 0)) wk[0] = indicatorsFor(1);
    const overall = Math.max(...wk.map((w) => w[0]));
    const [lng, lat] = randomPointIn(f);
    const noCode = k++ % 23 === 5; // a few villages without polygon match → point fallback
    const villCode = noCode ? null : p.VILLCODE;
    if (villCode) polyCodes.add(villCode);
    villages.push([zhNorm(p.COUNTYNAME), zhNorm(p.TOWNNAME), zhNorm(p.VILLNAME), lng, lat, villCode, overall, wk]);
  }
}
villages.sort((a, b) => b[6] - a[6] || a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));
const surveyed = {};
for (const [code] of vectorCountyPlan) {
  const countyZh = zhNorm(villFeatures.find((f) => f.properties.COUNTYCODE === code).properties.COUNTYNAME);
  surveyed[code] = { villages: villages.filter((v) => v[0] === countyZh).length, total: villTotals[code] };
}
out('vector.json', { updated: addDays(weekEnd, 2), weeks, villages, surveyed });

{
  const fc = { type: 'FeatureCollection', features: villFeatures.filter((f) => polyCodes.has(f.properties.VILLCODE)).map((f) => ({ type: 'Feature', properties: { code: f.properties.VILLCODE }, geometry: f.geometry })) };
  let topo = topology({ villages: fc }, 1e5);
  topo = presimplify(topo); topo = topojson.quantize(simplify(topo, quantile(topo, 0.2)), 1e5);
  out('geo/vector-villages.topo.json', topo);
}

// ---------- clusters.json ----------
function blob(center, radius, nv = 9) {
  const ring = [];
  for (let i = 0; i < nv; i++) { const a = (i / nv) * Math.PI * 2; const r = radius * (0.7 + rand() * 0.5); ring.push([r5(center[0] + Math.cos(a) * r), r5(center[1] + Math.sin(a) * r * 0.92)]); }
  ring.push(ring[0]); return { type: 'Polygon', coordinates: [ring] };
}
{
  const t1 = findTown(C.TNN, '東區'), t2 = findTown(C.KHH, '前鎮區');
  out('clusters.json', { type: 'FeatureCollection', fetchedAt: `${TODAY}T03:00:00Z`, features: [
    { type: 'Feature', geometry: blob(randomPointIn(t1), 0.0045), properties: { county: '臺南市', town: '東區', code1: 'A6701-0318-04', count: 4, lastOnset: addDays(LATEST_ONSET, -3) } },
    { type: 'Feature', geometry: blob(randomPointIn(t2), 0.0035), properties: { county: '高雄市', town: '前鎮區', code1: 'A6409-0127-11', count: 2, lastOnset: addDays(LATEST_ONSET, -1) } },
  ] });
}

// ---------- ns1.json ----------
let ns1Count = 0;
{
  const prefixes = ['仁愛', '安康', '博愛', '康健', '惠民', '福安', '新生', '長安', '永和', '和平', '光明', '樂群', '民生', '中山', '育英', '同心', '信義', '大同', '成功', '建國'];
  const kinds = ['內科診所', '家庭醫學科診所', '小兒科診所', '醫院', '聯合診所', '耳鼻喉科診所'];
  const roads = ['中山路', '中正路', '民族路', '民生路', '自由路', '建國路', '成功路', '光復路', '中華路', '和平路'];
  const area = { [C.KHH]: '07', [C.TNN]: '06', [C.PIF]: '08', [C.TPE]: '02', [C.NTP]: '02', [C.TXG]: '04', [C.TYN]: '03', [C.CYI]: '05', [C.CYQ]: '05' };
  const h = [];
  const plan = [[C.KHH, 16], [C.TNN, 14], [C.PIF, 6], [C.TPE, 4], [C.NTP, 3], [C.TXG, 3], [C.TYN, 2], [C.CYI, 2]];
  for (const [code, n] of plan) {
    for (let i = 0; i < n; i++) {
      const t = pick(townsOf(code)); const [lng, lat] = randomPointIn(t);
      const countyZh = admin.objects.counties.geometries.find((g) => g.properties.code === code).properties.zh;
      const name = `${pick(prefixes)}${pick(kinds)}`;
      const addr = `${countyZh}${t.zh}${pick(roads)}${randInt(1, 3) > 1 ? `${'一二三'[randInt(0, 2)]}段` : ''}${randInt(1, 480)}號`;
      const tel = `${area[code]}-${randInt(2, 8)}${String(randInt(0, 999999)).padStart(6, '0')}`;
      const id = h.length === 7 ? 'N/A' : `${code.slice(0, 2)}${String(randInt(0, 99999999)).padStart(8, '0')}`;
      h.push([name, addr, tel, lng, lat, id, code]);
    }
  }
  ns1Count = h.length;
  out('ns1.json', { sourceDate: '2016-06-03', h });
}

// ---------- manifest.json ----------
const gen = `${TODAY}T04:00:00Z`;
// Data-quality warnings (contract addition): exercise the UI's honesty paths.
const countOf = (year, imp) => generated[year].caseList.filter((r) => r[2] === imp).length;
const impYear = (y) => Object.values(imp).reduce((s, v) => s + (v.byYear[y] || 0), 0);
const impTotal = Object.values(imp).reduce((s, v) => s + Object.values(v.byYear).reduce((a, b) => a + b, 0), 0);
const warnings = [
  { code: 'cases-shortfall', year: 2024, type: 'local', got: countOf(2024, 0), expected: 232 },
  { code: 'cases-shortfall', year: TODAY_YEAR - 1, type: 'imported', got: countOf(TODAY_YEAR - 1, 1), expected: 326 },
  { code: 'imported-shortfall', got: impTotal, expected: impTotal + 120 },
  { code: 'imported-shortfall', year: TODAY_YEAR - 1, got: impYear(TODAY_YEAR - 1), expected: 326 },
];
const totalCases = Object.values(generated).reduce((s, g) => s + g.caseList.length, 0);
out('manifest.json', {
  schema: 1, fixture: true, generatedAt: gen, latestOnset: LATEST_ONSET, years: caseYears,
  sources: {
    cases: { ok: true, stale: false, fetchedAt: gen, records: totalCases },
    imported: { ok: true, stale: false, fetchedAt: gen, records: Object.values(imp).reduce((s, v) => s + Object.values(v.byYear).reduce((a, b) => a + b, 0), 0) },
    notices: { ok: true, stale: false, fetchedAt: gen, records: Object.values(notices).reduce((s, l) => s + l.length, 0) },
    clusters: { ok: true, stale: false, fetchedAt: gen, records: 2 },
    vector: { ok: true, stale: false, fetchedAt: `${addDays(weekEnd, 2)}T02:00:00Z`, records: villages.length, periodStart: weeks[4][0], periodEnd: weeks[0][1] },
    ns1: { ok: true, stale: false, fetchedAt: gen, records: ns1Count, sourceDate: '2016-06-03' },
  },
  warnings,
  files: Object.fromEntries([...written.entries()].sort()),
});
console.log('done.');
