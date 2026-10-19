// Rolling-origin backtest of the forecast model on past outbreaks (run: npm run backtest).
// Each week from June to November, the data are cut at that day and thinned with the assumed reporting
// delay (what would have been published by then); the forecast is compared with the final counts.
// Step 1 tunes four parameters on 2002/2014/2015 (grid search, relative WIS); step 2 scores the chosen
// parameters on every series, including the 2023 outbreaks it never saw. Writes:
//   src/lib/forecast/tuned.json     chosen parameters (read by the page)
//   src/lib/forecast/backtest.json  summary shown on the page
//   docs/forecast-backtest.md       full report
import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { mergeCaseYears } from '../../src/lib/aggregate';
import { epochDayOfDoy, isoFromEpochDay } from '../../src/lib/dates';
import { covers, flatBaseline, wis } from '../../src/lib/forecast/evaluate';
import { completeness, forecastArea } from '../../src/lib/forecast/model';
import { BASE_PARAMS } from '../../src/lib/forecast/params';
import { countyCounts, seriesOf, snapshotAt, truthBlocks } from '../../src/lib/forecast/snapshot';
import { tempFactors, tempPath } from '../../src/lib/forecast/weather';

const root = new URL('../../', import.meta.url);
const loadYear = (y) => JSON.parse(readFileSync(new URL(`public/data/cases/${y}.json`, root), 'utf8'));
// Weekly temperature since 2001 (NASA POWER bias-corrected to CWA station normals; docs/data-contract.md v4).
const WEATHER = JSON.parse(readFileSync(new URL('public/data/weather.json', root), 'utf8'));

const SERIES = [
  { year: 2002, county: '64000', name: '2002 高雄', role: 'tune' },
  { year: 2014, county: '64000', name: '2014 高雄', role: 'tune' },
  { year: 2015, county: '67000', name: '2015 臺南', role: 'tune' },
  { year: 2015, county: '64000', name: '2015 高雄', role: 'tune' },
  { year: 2023, county: '67000', name: '2023 臺南', role: 'holdout' },
  { year: 2023, county: '64000', name: '2023 高雄', role: 'holdout' },
  { year: 2023, county: '10009', name: '2023 雲林', role: 'holdout' },
  { year: 2016, county: '64000', name: '2016 高雄', role: 'small' },
  { year: 2018, county: '66000', name: '2018 臺中', role: 'small' },
  { year: 2024, county: '64000', name: '2024 高雄', role: 'small' },
  { year: 2019, county: null, name: '2019 全國', role: 'small' },
];
const HORIZONS = [0, 1, 2, 3, 4]; // 0 = the as-of week (nowcast), 1–4 = weeks ahead
const GRID = {
  dispersion: [0.2, 0.5],
  damping: [1, 0.8, 0.6, 0.5, 0.4],
  rwSd: [0, 0.1, 0.2],
  importedWeight: [0.5],
  // Weakly informative prior centred on 1 (beat Cori's mean-5 default in the earlier tuning, docs history).
  prior: [{ shape: 2, scale: 0.5 }],
  // Temperature effect (weather.ts): 0 = none.
  tempGamma: [0, 1, 2, 3, 4],
};
// Forecast accuracy by outbreak size (local cases in the 28 days before the as-of day).
const BUCKETS = [[10, 29], [30, 99], [100, 299], [300, Infinity]];

const sets = new Map();
const setFor = (year) => {
  if (!sets.has(year)) sets.set(year, mergeCaseYears([loadYear(year - 1), loadYear(year)]));
  return sets.get(year);
};

/** All forecasts of one series with parameters p: per origin, per horizon {q, truth, baseline}. */
function runSeries(s, p) {
  const set = setFor(s.year);
  const comp = completeness(p);
  const out = { scored: [], declined: [] };
  for (let doy = 152; doy <= 334; doy += 7) {
    const asOf = epochDayOfDoy(s.year, doy);
    const start = asOf - 140;
    const snap = snapshotAt(set, asOf, start, comp, 7);
    const station = WEATHER.county[s.county ?? countyCounts(set, snap)[0]?.[0] ?? ''];
    const factors = tempFactors(tempPath(WEATHER, station, asOf, p.horizon), p.tempGamma, p.horizon);
    const f = forecastArea(seriesOf(set, snap, s.county, start), p, p.seed ^ doy, factors);
    const ends = HORIZONS.map((h) => asOf + 7 * h);
    const truth = truthBlocks(set, s.county, ends);
    if (f.status !== 'ok') {
      out.declined.push({ asOf, recent28: f.recent28, next28: truth.slice(1).reduce((a, b) => a + b, 0) });
      continue;
    }
    // Baseline level: the last block the model itself treats as complete (as-of − 14 … − 8), with 8 weeks of changes.
    const hist = truthBlocks(set, s.county, Array.from({ length: 9 }, (_, i) => asOf - 7 * (10 - i)));
    const rows = HORIZONS.map((h, i) => {
      const wk = f.weeks.find((w) => w.end === ends[i]);
      return { h, q: wk.q, y: truth[i], base: flatBaseline(hist, h + 2, doy * 31 + h) };
    });
    out.scored.push({ asOf, recent28: f.recent28, rt: f.rt?.median ?? null, rows });
  }
  return out;
}

function summarise(results) {
  return HORIZONS.map((h) => {
    let n = 0, w = 0, wb = 0, c50 = 0, c90 = 0, ae = 0, aeb = 0;
    for (const r of results.scored) {
      const row = r.rows.find((x) => x.h === h);
      n++;
      w += wis(row.q, row.y);
      wb += wis(row.base, row.y);
      c50 += covers(row.q, row.y, 50) ? 1 : 0;
      c90 += covers(row.q, row.y, 90) ? 1 : 0;
      ae += Math.abs(row.q.q50 - row.y);
      aeb += Math.abs(row.base.q50 - row.y);
    }
    return { h, n, relWis: wb ? w / wb : null, cov50: n ? c50 / n : null, cov90: n ? c90 / n : null, mae: n ? ae / n : null, maeBase: n ? aeb / n : null };
  });
}

/**
 * Tuning score: mean over tuning series of (Σ model WIS / Σ baseline WIS) over horizons 1–4, and the lowest
 * pooled 90 % interval coverage over those horizons (WIS alone rewards intervals that are too narrow).
 */
function score(p) {
  const rel = [];
  const scored = [];
  for (const s of SERIES.filter((x) => x.role === 'tune')) {
    const r = runSeries(s, p);
    scored.push(...r.scored);
    let w = 0, wb = 0;
    for (const o of r.scored) for (const row of o.rows) if (row.h >= 1) {
      w += wis(row.q, row.y);
      wb += wis(row.base, row.y);
    }
    if (wb) rel.push(w / wb);
  }
  const cov90 = Math.min(...summarise({ scored }).filter((x) => x.h >= 1).map((x) => x.cov90));
  return { score: rel.reduce((a, b) => a + b, 0) / rel.length, cov90 };
}
const MIN_COVERAGE_90 = 0.85;

const priorName = (p) => `gamma(形狀 ${p.shape}, 尺度 ${p.scale})，平均 ${p.shape * p.scale}`;
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const num = (v, d = 2) => (v == null ? '—' : v.toFixed(d));

it('backtest', () => {
  // ---- 1. tune
  const trials = [];
  for (const dispersion of GRID.dispersion) for (const damping of GRID.damping) for (const rwSd of GRID.rwSd) for (const importedWeight of GRID.importedWeight) for (const prior of GRID.prior) for (const tempGamma of GRID.tempGamma) {
    const p = { ...BASE_PARAMS, sims: 300, dispersion, damping, rwSd, importedWeight, prior, tempGamma };
    trials.push({ dispersion, damping, rwSd, importedWeight, prior, tempGamma, ...score(p) });
  }
  // Best WIS among the parameter sets whose 90 % intervals are honest enough; else the best-covered one.
  trials.sort((a, b) => a.score - b.score);
  const best = trials.find((x) => x.cov90 >= MIN_COVERAGE_90) ?? [...trials].sort((a, b) => b.cov90 - a.cov90)[0];
  const tuned = { dispersion: best.dispersion, damping: best.damping, rwSd: best.rwSd, importedWeight: best.importedWeight, prior: best.prior, tempGamma: best.tempGamma };
  const P = { ...BASE_PARAMS, ...tuned };
  // Does temperature help? The best parameter set without it (same coverage rule), scored on every role.
  const noTemp = trials.filter((x) => x.tempGamma === 0);
  const bestNoTemp = noTemp.find((x) => x.cov90 >= MIN_COVERAGE_90) ?? [...noTemp].sort((a, b) => b.cov90 - a.cov90)[0];
  const P0 = { ...BASE_PARAMS, dispersion: bestNoTemp.dispersion, damping: bestNoTemp.damping, rwSd: bestNoTemp.rwSd, importedWeight: bestNoTemp.importedWeight, prior: bestNoTemp.prior, tempGamma: 0 };
  const poolWith = (params, role) => summarise({ scored: SERIES.filter((s) => s.role === role).flatMap((s) => runSeries(s, params).scored) });
  const tempCompare = ['tune', 'holdout', 'small'].map((role) => ({ role, without: poolWith(P0, role), with: poolWith(P, role) }));

  // ---- 2. evaluate every series with the chosen parameters
  const series = SERIES.map((s) => {
    const r = runSeries(s, P);
    return { ...s, origins: r.scored.length, declined: r.declined.length, missed: r.declined.filter((d) => d.next28 >= 10).length, perH: summarise(r) };
  });
  const pool = (role) => {
    const rs = SERIES.filter((s) => s.role === role).map((s) => runSeries(s, P));
    return summarise({ scored: rs.flatMap((r) => r.scored) });
  };
  const overall = { tune: pool('tune'), holdout: pool('holdout'), small: pool('small') };
  const allScored = SERIES.flatMap((s) => runSeries(s, P).scored);
  const bySize = BUCKETS.map(([lo, hi]) => ({ lo, hi: Number.isFinite(hi) ? hi : null, perH: summarise({ scored: allScored.filter((o) => o.recent28 >= lo && o.recent28 <= hi) }) }));

  writeFileSync(new URL('src/lib/forecast/tuned.json', root), `${JSON.stringify(tuned, null, 2)}\n`);
  const summary = {
    generatedAt: new Date().toISOString().slice(0, 10),
    params: tuned,
    overall,
    tempCompare: tempCompare.map((c) => ({ role: c.role, without: c.without.map((x) => x.relWis), with: c.with.map((x) => x.relWis) })),
    bySize,
    series: series.map((s) => ({ name: s.name, role: s.role, origins: s.origins, declined: s.declined, missed: s.missed, perH: s.perH })),
  };
  writeFileSync(new URL('src/lib/forecast/backtest.json', root), `${JSON.stringify(summary, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v))}\n`);

  // ---- 3. report
  const hName = (h) => (h === 0 ? '本週（補正）' : `第 ${h} 週`);
  const table = (perH) => [
    '| 預測期 | 預測次數 | 相對 WIS（<1 優於基準） | 50% 區間涵蓋率 | 90% 區間涵蓋率 | 中位數 MAE | 基準 MAE |',
    '|---|---|---|---|---|---|---|',
    ...perH.map((x) => `| ${hName(x.h)} | ${x.n} | ${num(x.relWis)} | ${pct(x.cov50)} | ${pct(x.cov90)} | ${num(x.mae, 1)} | ${num(x.maeBase, 1)} |`),
  ].join('\n');
  const md = `# 登革熱預測模型回測報告（實驗性）

> 由 \`npm run backtest\`（tests/backtest/backtest.run.mjs）自動產生於 ${summary.generatedAt}；請勿手動編輯。

## 方法摘要

- **資料**：本站 \`public/data/cases/{年}.json\` 的本土／境外移入病例（發病日、最小統計區座標）。
- **回測方式**：每年 6 月 1 日至 11 月 30 日，每 7 天當作一次「預測當日」；只使用發病日在當日以前的病例，
  並以假設的通報延遲（gamma 分布，平均 ${BASE_PARAMS.delay.mean} 天、標準差 ${BASE_PARAMS.delay.sd} 天）隨機抽除尚未公布的病例，模擬當時實際看得到的資料。
  與最終（完整）資料的每 7 天病例數比較。
- **模型**：renewal model（世代間隔 gamma 平均 ${BASE_PARAMS.gi.mean} 天、標準差 ${BASE_PARAMS.gi.sd} 天），境外移入病例只當感染源（權重 α），
  Rt 以近 ${BASE_PARAMS.rtWindow} 天的 Poisson 概似（考慮通報完整度）求 gamma 事後分布；預測時 R 逐週向 1 收斂（φ）並加上對數隨機漫步（σ），每日病例為負二項分布（k）。
- **基準**：COVID-19 Forecast Hub 式的「持平基準」──以最近一個完整週的病例數為中位數，加上過去 8 週週間變化（對稱化）重抽樣的不確定性。
- **評分**：加權區間分數 WIS（Bracher et al., 2021；50%、90% 區間與中位數），相對 WIS = 模型 WIS 總和 ÷ 基準 WIS 總和；以及區間涵蓋率。
- **調參**：只用 2002、2014、2015 年調整 k、φ、σ 與 R 的事前分布（網格搜尋 ${trials.length} 組）；2023 年完全未參與調參，作為驗證。

## 選定參數

| 參數 | 值 | 說明 |
|---|---|---|
| 負二項離散度 k | ${tuned.dispersion} | 越小代表病例越容易成群爆發 |
| 收斂係數 φ（每週） | ${tuned.damping} | 1 = R 維持不變；越小越快回到 1 |
| 對數 R 隨機漫步 σ（每週） | ${tuned.rwSd} | 傳播強度未來變化的不確定性 |
| 境外移入感染力權重 α | ${tuned.importedWeight} | 固定值（未調參） |
| R 事前分布 | ${priorName(tuned.prior)} | 病例少時事前分布影響較大 |
| 氣溫效果強度 γ | ${tuned.tempGamma} | 0 = 不使用氣溫；R × (相對 R0(未來氣溫) ÷ 相對 R0(近 14 天氣溫))^γ |

選參規則：第 1–4 週 90% 預測區間的合併涵蓋率都要達 ${pct(MIN_COVERAGE_90)}（WIS 本身會偏好過窄的區間），符合者中取平均相對 WIS 最低的一組。

WIS 前 5 名（分數 = 平均相對 WIS，不論涵蓋率）：

| k | φ | σ | γ | 分數 | 90% 區間最低涵蓋率 |
|---|---|---|---|---|---|
${trials.slice(0, 5).map((x) => `| ${x.dispersion} | ${x.damping} | ${x.rwSd} | ${x.tempGamma} | ${num(x.score, 3)} | ${pct(x.cov90)} |`).join('\n')}

符合涵蓋率條件的最佳組合（即選定參數）：k ${best.dispersion}、φ ${best.damping}、σ ${best.rwSd}，分數 ${num(best.score, 3)}，90% 區間最低涵蓋率 ${pct(best.cov90)}。

## 氣溫有沒有幫助？

同樣的選參規則下，不使用氣溫（γ = 0）的最佳組合：k ${bestNoTemp.dispersion}、φ ${bestNoTemp.damping}、σ ${bestNoTemp.rwSd}（分數 ${num(bestNoTemp.score, 3)}）；
選定組合 γ = ${tuned.tempGamma}（分數 ${num(best.score, 3)}）。各預測期的相對 WIS（越低越好）：

| 資料 | 不用氣溫：第 1／2／3／4 週 | 使用氣溫：第 1／2／3／4 週 |
|---|---|---|
${tempCompare.map((c) => `| ${c.role === 'tune' ? '調參（2002、2014、2015）' : c.role === 'holdout' ? '驗證（2023）' : '小規模'} | ${c.without.filter((x) => x.h >= 1).map((x) => num(x.relWis)).join('／')} | ${c.with.filter((x) => x.h >= 1).map((x) => num(x.relWis)).join('／')} |`).join('\n')}

氣溫資料：2001 年起 NASA POWER 每日氣溫，依 CWA 測站 1991–2020 月平均校正；未來 4 週用月平均加上目前偏差（每 14 天減半）。
溫度與傳播力的關係採 Mordecai et al. 2017（埃及斑蚊，17.8–34.6 °C，峰值 29.1 °C）。

## 總結

### 調參資料（2002、2014、2015）

${table(overall.tune)}

### 驗證資料（2023，未參與調參）

${table(overall.holdout)}

### 小規模流行（2016、2018、2019、2024）

${table(overall.small)}

### 依疫情規模（全部序列，預測當日前 28 天本土病例數）

${bySize.map((b) => `#### ${b.lo}${b.hi ? `–${b.hi}` : ' 以上'} 例\n\n${table(b.perH)}`).join('\n\n')}

## 各序列

${series.map((s) => `### ${s.name}（${s.role === 'tune' ? '調參' : s.role === 'holdout' ? '驗證' : '小規模'}）

預測 ${s.origins} 次；因近 28 天病例少於 ${BASE_PARAMS.minCases} 例而不預測 ${s.declined} 次，其中 ${s.missed} 次之後 4 週實際出現 ≥ 10 例。

${table(s.perH)}`).join('\n\n')}

## 限制

- **通報延遲是假設值**：來源資料沒有通報日，回測時用同一個假設分布抽除病例，所以「本週（補正）」的成績只代表模型在這個假設下的表現，
  不能證明假設本身正確。取得通報日（或本站資料庫每 3 小時快照累積的「首次出現日」）後應重新估計並重跑回測。
- 歷史資料已含後來補報與研判修正，與當時實際看到的資料仍有差異。
- 模型假設防治強度與傳播條件維持近期水準，未納入氣象、病媒指數與人口移動；大規模防治介入或天候急遽變化時會偏離。
- 預測單位為縣市；地圖上的方向與範圍是描述性統計（重心軌跡與共變異數橢圓），不是機率預測。
`;
  writeFileSync(new URL('docs/forecast-backtest.md', root), md);
  console.log(JSON.stringify({ tuned, top: trials.slice(0, 5), overall }, null, 1));
}, 1_800_000);
