// Backtest of the 14-day spatial risk surface (src/lib/forecast/surface.ts); run with `npm run backtest`
// (or `npx vitest run --config vitest.backtest.config.ts spatial` for this part only).
// Same rolling origins as the temporal backtest (weekly, June–November, delay-thinned data, ≥ 10 local cases
// in the last 28 days). Scores where the next 14 days' local cases actually occurred:
//   - log score: mean log of the forecast density (share per km²) at each case (higher is better);
//   - capture: share of the cases inside the 50 % / 90 % regions, and those regions' areas;
//   - baseline at equal area: everything within distance r of a case of the last 14 days, with r chosen so
//     the area matches the model's 90 % region ("draw circles around recent cases").
// Tunes σ₁, σ₂, ρ, β on 2002/2014/2015 (log score), validates on 2023. Writes:
//   src/lib/forecast/surface-tuned.json, src/lib/forecast/backtest-spatial.json, docs/forecast-backtest-spatial.md
import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { mergeCaseYears } from '../../src/lib/aggregate';
import { epochDayOfDoy } from '../../src/lib/dates';
import { completeness } from '../../src/lib/forecast/model';
import { PARAMS } from '../../src/lib/forecast/params';
import { snapshotAt } from '../../src/lib/forecast/snapshot';
import { DEFAULT_SURFACE, riskSurface, surfacePoints } from '../../src/lib/forecast/surface';

const root = new URL('../../', import.meta.url);
const loadYear = (y) => JSON.parse(readFileSync(new URL(`public/data/cases/${y}.json`, root), 'utf8'));
const SERIES = [
  { year: 2002, county: '64000', name: '2002 高雄', role: 'tune' },
  { year: 2014, county: '64000', name: '2014 高雄', role: 'tune' },
  { year: 2015, county: '67000', name: '2015 臺南', role: 'tune' },
  { year: 2015, county: '64000', name: '2015 高雄', role: 'tune' },
  { year: 2023, county: '67000', name: '2023 臺南', role: 'holdout' },
  { year: 2023, county: '64000', name: '2023 高雄', role: 'holdout' },
  { year: 2023, county: '10009', name: '2023 雲林', role: 'holdout' },
  { year: 2018, county: '66000', name: '2018 臺中', role: 'small' },
  { year: 2019, county: null, name: '2019 全國', role: 'small' },
];
const GRID = { sigma1M: [150, 300], sigma2M: [750, 1000, 1500, 3000], rho: [0.2, 0.4, 0.6], beta: [0, 0.05, 0.2] };
const FLOOR = 1e-4; // density (share per km²) for cases off every grid
const M_LAT = 110_574;

const sets = new Map();
const setFor = (year) => {
  if (!sets.has(year)) sets.set(year, mergeCaseYears([loadYear(year - 1), loadYear(year)]));
  return sets.get(year);
};

/** Per origin: the surface inputs, the recent cases (baseline) and the next 14 days' actual local cases. */
function origins(s) {
  const set = setFor(s.year);
  const comp = completeness(PARAMS);
  const out = [];
  for (let doy = 152; doy <= 334; doy += 7) {
    const asOf = epochDayOfDoy(s.year, doy);
    const snap = snapshotAt(set, asOf, asOf - 140, comp, 7);
    const inCounty = (pt) => !s.county || set.pts[pt]?.[2]?.slice(0, 5) === s.county;
    let recent28 = 0;
    const recent = [];
    for (let i = 0; i < snap.length; i++) {
      if (snap.imp[i] || !inCounty(snap.pt[i])) continue;
      if (snap.day[i] > asOf - 28) recent28 += snap.n[i];
      if (snap.day[i] > asOf - 14) recent.push(set.pts[snap.pt[i]]);
    }
    if (recent28 < PARAMS.minCases) continue;
    const truth = [];
    for (let i = 0; i < set.length; i++) {
      const d = set.day[i];
      if (d <= asOf || d > asOf + 14 || set.imp[i] || !inCounty(set.pt[i])) continue;
      const p = set.pts[set.pt[i]];
      truth.push({ lng: p[0], lat: p[1], n: set.n[i] });
    }
    if (!truth.length) continue;
    out.push({ asOf, pts: surfacePoints(set, snap, s.county, PARAMS), recent, truth });
  }
  return out;
}

/** Nearest-neighbour distance (m) to a fixed point set, via a 500 m hash searched ring by ring. */
function nearestFinder(pts) {
  const B = 500, lat0 = pts.length ? pts[0][1] : 23, kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const xy = pts.map((p) => [p[0] * kx, p[1] * M_LAT]);
  const hash = new Map();
  xy.forEach(([x, y], i) => {
    const k = `${Math.floor(x / B)},${Math.floor(y / B)}`;
    (hash.get(k) ?? hash.set(k, []).get(k)).push(i);
  });
  return (lng, lat) => {
    const x = lng * kx, y = lat * M_LAT, cx = Math.floor(x / B), cy = Math.floor(y / B);
    let best = Infinity;
    for (let ring = 0; ring < 400; ring++) {
      if (best < (ring - 1) * B) break;
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          for (const i of hash.get(`${cx + dx},${cy + dy}`) ?? []) best = Math.min(best, Math.hypot(xy[i][0] - x, xy[i][1] - y));
        }
      }
    }
    return best;
  };
}

/**
 * Radius r such that the union of disks of radius r around `pts` covers `km2` (rasterised on 250 m cells,
 * binary search). This is the "circles around recent cases" baseline at the model's 90 % area.
 */
function equalAreaRadius(pts, km2) {
  const C = 250, lat0 = pts[0][1], kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const cells = [...new Set(pts.map((p) => `${Math.floor((p[0] * kx) / C)},${Math.floor((p[1] * M_LAT) / C)}`))].map((k) => k.split(',').map(Number));
  const area = (r) => {
    const rc = Math.ceil(r / C), seen = new Set();
    for (const [cx, cy] of cells) {
      for (let dx = -rc; dx <= rc; dx++) {
        for (let dy = -rc; dy <= rc; dy++) if ((dx * dx + dy * dy) * C * C <= r * r) seen.add((cx + dx) * 1_000_003 + (cy + dy));
      }
    }
    return (seen.size * C * C) / 1e6;
  };
  let lo = 0, hi = 50_000;
  if (area(hi) < km2) return hi;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (area(mid) < km2) lo = mid;
    else hi = mid;
  }
  return hi;
}

function scoreOrigin(o, sp, withBaseline) {
  const surf = riskSurface(o.pts.infectors, o.pts.older, sp);
  if (!surf) return null;
  const km2 = (surf.cellM * surf.cellM) / 1e6;
  let n = 0, ls = 0, in50 = 0, in90 = 0;
  for (const c of o.truth) {
    const at = surf.locate(c.lng, c.lat);
    const dens = at ? Math.max(at.share / km2, FLOOR) : FLOOR;
    n += c.n;
    ls += c.n * Math.log(dens);
    if (at && at.cls <= 1) in50 += c.n;
    if (at && at.cls <= 2) in90 += c.n;
  }
  const r = { n, logScore: ls / n, cap50: in50 / n, cap90: in90 / n, area50: surf.area50Km2, area90: surf.area90Km2 };
  if (withBaseline && o.recent.length) {
    const nearest = nearestFinder(o.recent);
    const radius = equalAreaRadius(o.recent, surf.area90Km2);
    let bin = 0;
    for (const c of o.truth) if (nearest(c.lng, c.lat) <= radius) bin += c.n;
    r.baseCap90 = bin / n;
    r.baseRadius = radius;
  }
  return r;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function pool(results) {
  const v = (k) => mean(results.map((r) => r[k]).filter((x) => x != null));
  return { origins: results.length, logScore: v('logScore'), cap50: v('cap50'), cap90: v('cap90'), area50: v('area50'), area90: v('area90'), baseCap90: v('baseCap90'), baseRadius: v('baseRadius') };
}

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const num = (v, d = 1) => (v == null ? '—' : v.toFixed(d));

it('spatial backtest', () => {
  const data = SERIES.map((s) => ({ ...s, origins: origins(s) }));
  const tune = data.filter((s) => s.role === 'tune');
  const trials = [];
  for (const sigma1M of GRID.sigma1M) for (const sigma2M of GRID.sigma2M) for (const rho of GRID.rho) for (const beta of GRID.beta) {
    const sp = { ...DEFAULT_SURFACE, sigma1M, sigma2M, rho, beta };
    const per = tune.map((s) => mean(s.origins.map((o) => scoreOrigin(o, sp, false)?.logScore).filter((x) => x != null)));
    trials.push({ sigma1M, sigma2M, rho, beta, score: mean(per) });
  }
  trials.sort((a, b) => b.score - a.score);
  const best = trials[0];
  const tuned = { sigma1M: best.sigma1M, sigma2M: best.sigma2M, rho: best.rho, beta: best.beta };
  const sp = { ...DEFAULT_SURFACE, ...tuned };
  const series = data.map((s) => ({ name: s.name, role: s.role, ...pool(s.origins.map((o) => scoreOrigin(o, sp, true)).filter(Boolean)) }));
  const byRole = (role) => pool(data.filter((s) => s.role === role).flatMap((s) => s.origins.map((o) => scoreOrigin(o, sp, true)).filter(Boolean)));
  const overall = { tune: byRole('tune'), holdout: byRole('holdout'), small: byRole('small') };

  writeFileSync(new URL('src/lib/forecast/surface-tuned.json', root), `${JSON.stringify(tuned, null, 2)}\n`);
  writeFileSync(new URL('src/lib/forecast/backtest-spatial.json', root), `${JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), params: tuned, overall },
    (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v))}\n`);
  const row = (name, r) => `| ${name} | ${r.origins} | ${pct(r.cap50)} | ${num(r.area50)} | ${pct(r.cap90)} | ${num(r.area90)} | ${pct(r.baseCap90)}（半徑 ${num(r.baseRadius == null ? null : r.baseRadius / 1000, 2)} 公里） | ${num(r.logScore, 2)} |`;
  const head = '| 資料 | 預測次數 | 50% 區實際涵蓋 | 50% 區面積（km²） | 90% 區實際涵蓋 | 90% 區面積（km²） | 同面積基準涵蓋 | 對數分數 |\n|---|---|---|---|---|---|---|---|';
  const md = `# 14 天風險範圍回測報告（實驗性）

> 由 \`npm run backtest\`（tests/backtest/spatial.run.mjs）自動產生於 ${new Date().toISOString().slice(0, 10)}；請勿手動編輯。

## 方法摘要

- **模型**（\`src/lib/forecast/surface.ts\`）：未來 14 天的縣市預估病例總數由時間模型（renewal model）提供，
  再依「自激點過程」的核心分配到 ${DEFAULT_SURFACE.cellM} 公尺網格：每個近期病例依其未來 14 天剩餘的感染力（世代間隔）加權，
  以兩種尺度的高斯核擴散（短距離 σ₁：病媒蚊與鄰里；長距離 σ₂：人的移動，占 ρ）；另有 β 比例放在本季較早期（−140～−29 天）的病例周圍（舊病例群復燃）。
- **50%／90% 範圍**：依預估密度由高到低累加網格，涵蓋 50%／90% 預估病例的最小區域。
- **回測**：與時間模型相同的預測日（6–11 月每週，近 28 天本土病例 ≥ ${PARAMS.minCases} 例，依假設通報延遲抽除未公布病例），
  檢查之後 14 天的實際本土病例是否落在 50%／90% 範圍內。
- **基準**：在最近 14 天病例周圍畫圓，半徑取到與模型 90% 範圍**同面積**為止，比較涵蓋率（同面積下涵蓋越多越好）。
- **對數分數**：實際病例所在網格的預估密度（每平方公里占比）取對數平均，越高越好；網格外以 ${FLOOR} 計。
- **調參**：只用 2002、2014、2015 年（${trials.length} 組，取對數分數最高）；2023 年驗證。

## 選定參數

| σ₁ 短距離 | σ₂ 長距離 | ρ 長距離比例 | β 舊病例群比例 |
|---|---|---|---|
| ${tuned.sigma1M} 公尺 | ${tuned.sigma2M} 公尺 | ${tuned.rho} | ${tuned.beta} |

前 5 名：

| σ₁ | σ₂ | ρ | β | 對數分數 |
|---|---|---|---|---|
${trials.slice(0, 5).map((x) => `| ${x.sigma1M} | ${x.sigma2M} | ${x.rho} | ${x.beta} | ${num(x.score, 3)} |`).join('\n')}

## 結果

${head}
${row('調參（2002、2014、2015）', overall.tune)}
${row('驗證（2023）', overall.holdout)}
${row('小規模（2018、2019）', overall.small)}

### 各序列

${head}
${series.map((s) => row(s.name, s)).join('\n')}

## 解讀與限制

- 50%／90% 範圍的實際涵蓋率接近 50%／90% 代表「範圍大小」校準得宜；低於標稱值代表範圍畫太小。
- 與同面積基準比較，可看出模型的加權（時間遠近、短長距離、舊病例群）是否比單純畫圓更能找到下一批病例。
- 病例座標為最小統計區中心點，網格 ${DEFAULT_SURFACE.cellM} 公尺以下的精度沒有意義。
- 未納入病媒指數、人口密度、地形與交通；跨縣市的移動只在全國檢視下才會被計入。
`;
  writeFileSync(new URL('docs/forecast-backtest-spatial.md', root), md);
  console.log(JSON.stringify({ tuned, top: trials.slice(0, 5), overall }, null, 1));
}, 3_600_000);
