// #/trends — 病例趨勢. ECharts is imported only here (tree-shaken), so it lives in this lazy chunk.
import { init, use, type ECharts } from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { DataZoomInsideComponent, DataZoomSliderComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { errorCard } from '../app';
import { fmtDate, fmtNum, placeName, t } from '../i18n';
import { loadAdmin, type Admin } from '../lib/admin';
import { annualTotals, isoWeekMatrix, trendSeries, weeklyBins } from '../lib/aggregate';
import { DataError, loadData } from '../lib/data';
import { addDays, dateFromDoy } from '../lib/dates';
import { clear, debounce, h, nextId, prefersReducedMotion } from '../lib/dom';
import { normalizeTrendParams, serializeTrendParams, type CaseType, type Granularity, type TrendParams } from '../lib/params';
import type { Trend } from '../lib/types';
import { validateTrend } from '../lib/validate';
import { cssVar, themeChanged } from '../theme';
import type { View, ViewContext } from './types';
import { dataTable, loadingBlock, notice, segmented, select, warningText } from './ui';
import { shortfallYears } from '../lib/warnings';

// No AriaComponent: its generated descriptions are Simplified Chinese/English only; each chart has an
// aria-label and a full data table instead.
use([BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, DataZoomInsideComponent, DataZoomSliderComponent, CanvasRenderer]);

const YEAR_COLORS = ['--accent', '--local', '--imported', '#6d6ef5', '#0ea5e9', '#b05fe8', '#7c8aa0', '#65a30d'];
const MAX_YEARS = 8;

interface Theme {
  text: string; muted: string; border: string; surface: string; local: string; imported: string; accent: string; font: string; split: string;
}
function readTheme(): Theme {
  return {
    text: cssVar('--text'), muted: cssVar('--muted'), border: cssVar('--border-strong'), split: cssVar('--border'), surface: cssVar('--surface'),
    local: cssVar('--local'), imported: cssVar('--imported'), accent: cssVar('--accent'), font: getComputedStyle(document.body).fontFamily,
  };
}
const yearColor = (i: number) => {
  const c = YEAR_COLORS[i % YEAR_COLORS.length]!;
  return c.startsWith('--') ? cssVar(c) : c;
};

export default async function trendsView(ctx: ViewContext): Promise<View> {
  const { app, root } = ctx;
  const head = h('header', { class: 'page-head' }, h('h1', { class: 'page-title' }, t('trends.title')), h('p', { class: 'page-intro' }, t('trends.intro')));
  const body = h('div', { class: 'trends' }, loadingBlock(t('trends.chartLoading')));
  root.append(head, body);
  let destroyed = false;

  const [trendRes, admin] = await Promise.all([
    loadData('trend.json', validateTrend).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })),
    loadAdmin().catch(() => null as Admin | null),
  ]);
  if (destroyed) return { destroy() {} };
  clear(body);
  if (!trendRes.ok) {
    body.append(errorCard('', () => location.reload(), trendRes.e instanceof DataError ? trendRes.e.file : 'trend.json'));
    return { destroy() {} };
  }
  const trend: Trend = trendRes.v;
  const firstYear = +trend.start.slice(0, 4), lastYear = +trend.end.slice(0, 4);
  const countyCodes = new Set(Object.keys(trend.county));
  let st: TrendParams = normalizeTrendParams(ctx.params, firstYear, lastYear, countyCodes);
  head.append(h('p', { class: 'card-note' }, t('trends.loadedRange', { from: fmtDate(trend.start), to: fmtDate(trend.end) })));
  const warnings = (app.getManifestNow()?.warnings ?? []).filter((w) => w.code === 'cases-shortfall').sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || String(a.type).localeCompare(String(b.type)));
  const badYears = shortfallYears(warnings);
  const warnEl = notice(warnings.map(warningText));

  // ---------------- toolbar
  const counties = (admin?.counties ?? []).filter((c) => countyCodes.has(c.code));
  const toolbar = h('div', { class: 'toolbar' },
    select(t('common.county'), [{ value: '', label: t('common.allCounties') }, ...counties.map((c) => ({ value: c.code, label: placeName(c) }))], st.county ?? '', (v) => {
      st = { ...st, county: v || null };
      renderAll();
    }),
    segmented<Granularity>(t('trends.gran'), [{ value: 'day', label: t('trends.day') }, { value: 'week', label: t('trends.weekly') }], st.gran, (v) => {
      st = { ...st, gran: v };
      renderEpi(true);
      persist();
    }),
    segmented<CaseType>(t('trends.typeFor'), [
      { value: 'local', label: t('common.local'), swatch: 'var(--local)' },
      { value: 'imported', label: t('common.importedShort'), swatch: 'var(--imported)' },
      { value: 'all', label: t('common.all') },
    ], st.type, (v) => {
      st = { ...st, type: v };
      renderCompare();
      persist();
    }));

  // ---------------- cards
  const mkCard = (title: string, note: string | null, chartCls = 'chart') => {
    const chartEl = h('div', { class: chartCls, role: 'img', 'aria-label': title });
    const tableSlot = h('div');
    const titleId = nextId('ct');
    const card = h('section', { class: 'card', 'aria-labelledby': titleId },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-h', id: titleId }, title), note ? h('p', { class: 'card-note' }, note) : null),
      chartEl, tableSlot);
    return { card, chartEl, tableSlot };
  };
  const epi = mkCard(t('trends.epicurve'), null, 'chart chart-tall');
  const cmp = mkCard(t('trends.compare'), null);
  const ann = mkCard(t('trends.annual'), null);
  const chips = h('fieldset', { class: 'year-chips' }, h('legend', { class: 'field-label' }, `${t('trends.compareYears')}（${t('trends.maxYears')}）`));
  cmp.card.insertBefore(chips, cmp.chartEl);
  if (badYears.size) ann.card.insertBefore(h('p', { class: 'card-note' }, t('warn.annualNote')), ann.tableSlot);
  body.append(toolbar, ...(warnEl ? [warnEl] : []), h('div', { class: 'cards' }, epi.card, h('div', { class: 'cards cards-2' }, cmp.card, ann.card)));
  if (warnEl) warnEl.classList.add('page-notice');

  // ---------------- charts
  let th = readTheme();
  const charts: ECharts[] = [];
  const mk = (el: HTMLElement): ECharts => {
    const c = init(el, undefined, { renderer: 'canvas', locale: 'EN' });
    charts.push(c);
    return c;
  };
  let epiChart = mk(epi.chartEl), cmpChart = mk(cmp.chartEl), annChart = mk(ann.chartEl);
  const ro = new ResizeObserver(debounce(() => charts.forEach((c) => c.resize()), 120));
  [epi.chartEl, cmp.chartEl, ann.chartEl].forEach((el) => ro.observe(el));
  const anim = !prefersReducedMotion();

  const base = () => ({
    animation: anim,
    animationDuration: 400,
    textStyle: { fontFamily: th.font, color: th.text },
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    legend: { top: 0, left: 0, textStyle: { color: th.text, fontSize: 13 }, itemWidth: 14, itemHeight: 10, icon: 'roundRect' },
    tooltip: {
      trigger: 'axis' as const, confine: true, backgroundColor: th.surface, borderColor: th.border, borderWidth: 1,
      textStyle: { color: th.text, fontSize: 13, fontFamily: th.font }, valueFormatter: (v: unknown) => (typeof v === 'number' ? fmtNum(v) : String(v ?? '—')),
      axisPointer: { type: 'shadow' as const, shadowStyle: { color: 'rgba(127,127,127,0.12)' } },
    },
  });
  const axisCommon = () => ({
    axisLine: { lineStyle: { color: th.border } }, axisTick: { lineStyle: { color: th.border } },
    axisLabel: { color: th.muted, fontSize: 12, hideOverlap: true }, splitLine: { lineStyle: { color: th.split } },
  });
  const valueAxis = () => ({ type: 'value' as const, ...axisCommon(), minInterval: 1, axisLabel: { color: th.muted, fontSize: 12, formatter: (v: number) => fmtNum(v) } });

  // Epicurve
  let epiCats: string[] = [], epiIso: string[] = [], epiLocal: number[] = [], epiImp: number[] = [];
  let epiZoom: [number, number] | null = null;
  function renderEpi(resetZoom = false): void {
    const s = trendSeries(trend, st.county);
    if (st.gran === 'week') {
      const w = weeklyBins(trend.start, s);
      epiIso = w.dates;
      epiLocal = w.local;
      epiImp = w.imported;
    } else {
      epiIso = Array.from({ length: s.local.length }, (_, i) => addDays(trend.start, i));
      epiLocal = Array.from(s.local);
      epiImp = Array.from(s.imported);
    }
    epiCats = epiIso.map((d) => fmtDate(d));
    // default window: weekly → last 3 years; daily → last 365 days
    const n = epiIso.length;
    const startIso = st.gran === 'week' ? dateFromDoy(lastYear - 2, 1) : addDays(trend.end, -364);
    const startIdx = Math.max(0, epiIso.findIndex((d) => d >= startIso));
    if (resetZoom || !epiZoom) epiZoom = [(startIdx / n) * 100, 100];
    epiChart.setOption({
      ...base(),
      xAxis: { type: 'category', data: epiCats, ...axisCommon(), splitLine: { show: false }, axisLabel: { color: th.muted, fontSize: 12, hideOverlap: true } },
      yAxis: valueAxis(),
      grid: { left: 8, right: 16, top: 36, bottom: 64, containLabel: true },
      dataZoom: [
        { type: 'inside', start: epiZoom[0], end: epiZoom[1], minValueSpan: 8 },
        { type: 'slider', start: epiZoom[0], end: epiZoom[1], height: 26, bottom: 12, borderColor: th.split, fillerColor: 'rgba(45,150,140,0.15)',
          handleStyle: { color: th.surface, borderColor: th.accent }, moveHandleStyle: { color: th.accent }, textStyle: { color: th.muted },
          dataBackground: { lineStyle: { color: th.border }, areaStyle: { color: th.split } }, selectedDataBackground: { lineStyle: { color: th.accent }, areaStyle: { color: th.accent, opacity: 0.2 } } },
      ],
      series: [
        { name: t('common.local'), type: 'bar', stack: 'c', data: epiLocal, itemStyle: { color: th.local }, barCategoryGap: '12%', large: false },
        { name: t('common.imported'), type: 'bar', stack: 'c', data: epiImp, itemStyle: { color: th.imported }, barCategoryGap: '12%' },
      ],
    }, { notMerge: true });
    renderEpiTable();
  }
  epiChart.on('datazoom', debounce(() => {
    const opt = epiChart.getOption() as { dataZoom?: { start: number; end: number }[] };
    const dz = opt.dataZoom?.[0];
    if (dz) epiZoom = [dz.start, dz.end];
    renderEpiTable();
  }, 250));
  let epiTableOpen = false;
  function renderEpiTable(): void {
    // Weekly rows for the visible range (accessible alternative to the chart).
    const n = epiIso.length;
    const [z0, z1] = epiZoom ?? [0, 100];
    const a = Math.floor((z0 / 100) * (n - 1)), b = Math.ceil((z1 / 100) * (n - 1));
    const s = trendSeries(trend, st.county);
    const w = weeklyBins(trend.start, s);
    const from = epiIso[a] ?? trend.start, to = epiIso[b] ?? trend.end;
    const rows: (string | number)[][] = [];
    for (let i = 0; i < w.dates.length; i++) {
      const d = w.dates[i]!;
      if (d < from.slice(0, 10) && addDays(d, 6) < from) continue;
      if (d > to) break;
      rows.push([t('trends.weekOf', { date: fmtDate(d) }), fmtNum(w.local[i]!), fmtNum(w.imported[i]!), fmtNum(w.local[i]! + w.imported[i]!)]);
    }
    clear(epi.tableSlot);
    const tbl = dataTable(t('trends.tableEpi'), [t('trends.date'), t('common.local'), t('common.imported'), t('common.total')], rows.slice(-400).reverse());
    if (epiTableOpen) tbl.setAttribute('open', '');
    tbl.addEventListener('toggle', () => (epiTableOpen = (tbl as HTMLDetailsElement).open));
    epi.tableSlot.append(tbl);
  }

  // Year comparison
  function renderChips(): void {
    for (const el of chips.querySelectorAll('.chip')) el.remove();
    const sel = new Set(st.years);
    for (let y = lastYear; y >= firstYear; y--) {
      const idx = st.years.indexOf(y);
      const input = h('input', { type: 'checkbox', value: String(y), checked: sel.has(y), disabled: !sel.has(y) && sel.size >= MAX_YEARS, on: { change: () => {
        const next = input.checked ? [...st.years, y] : st.years.filter((v) => v !== y);
        if (!next.length) {
          input.checked = true;
          return;
        }
        st = { ...st, years: [...new Set(next)].sort((p, q) => q - p).slice(0, MAX_YEARS) };
        renderChips();
        renderCompare();
        persist();
        (chips.querySelector(`input[value="${y}"]`) as HTMLInputElement | null)?.focus();
      } } });
      chips.append(h('label', { class: 'chip', style: idx >= 0 ? { '--chip': yearColor(idx) } : undefined }, input, h('span', null, String(y))));
    }
  }
  function renderCompare(): void {
    const s = trendSeries(trend, st.county);
    const m = isoWeekMatrix(trend.start, s, st.type, st.years);
    const weeks = Array.from({ length: 53 }, (_, i) => t('trends.isoWeek', { n: i + 1 }));
    cmpChart.setOption({
      ...base(),
      tooltip: { ...base().tooltip, axisPointer: { type: 'line' as const, lineStyle: { color: th.border } } },
      color: st.years.map((_, i) => yearColor(i)),
      xAxis: { type: 'category', data: weeks, boundaryGap: false, ...axisCommon(), splitLine: { show: false } },
      yAxis: valueAxis(),
      series: st.years.map((y, i) => ({
        name: badYears.has(y) ? `${y}*` : String(y), type: 'line', data: m.get(y), showSymbol: false, connectNulls: false, smooth: 0.2,
        lineStyle: { width: i === 0 ? 3 : 2 }, emphasis: { focus: 'series' }, z: 10 - i,
      })),
    }, { notMerge: true });
    clear(cmp.tableSlot);
    cmp.tableSlot.append(dataTable(t('trends.tableCompare'), [t('common.week'), ...st.years.map(String)],
      weeks.map((w, i) => [w, ...st.years.map((y) => {
        const v = m.get(y)?.[i];
        return v == null ? '—' : fmtNum(v);
      })])));
  }

  // Annual totals
  function renderAnnual(): void {
    const a = annualTotals(trend.start, trendSeries(trend, st.county));
    // Years with incomplete source data: dashed outline + faded bar + '*' label.
    const mark = (vals: number[], color: string) => vals.map((v, i) => (badYears.has(a.years[i]!)
      ? { value: v, itemStyle: { color, opacity: 0.45, borderColor: th.text, borderType: 'dashed' as const, borderWidth: 1 } } : v));
    annChart.setOption({
      ...base(),
      xAxis: { type: 'category', data: a.years.map((y) => (badYears.has(y) ? `${y}*` : String(y))), ...axisCommon(), splitLine: { show: false } },
      yAxis: valueAxis(),
      series: [
        { name: t('common.local'), type: 'bar', stack: 'y', data: mark(a.local, th.local), itemStyle: { color: th.local } },
        { name: t('common.imported'), type: 'bar', stack: 'y', data: mark(a.imported, th.imported), itemStyle: { color: th.imported } },
        // Nationally, the pipeline knows roughly how many records are missing: show that gap as a
        // dashed "ghost" segment so incomplete years are not mistaken for quiet years.
        ...(st.county || !badYears.size ? [] : [{
          name: t('warn.missingSeries'), type: 'bar' as const, stack: 'y', barMinHeight: 0,
          data: a.years.map((y) => warnings.filter((w) => w.year === y).reduce((s, w) => s + Math.max(0, w.expected - w.got), 0) || null),
          itemStyle: { color: 'rgba(127,127,127,0.10)', borderColor: th.muted, borderType: 'dashed' as const, borderWidth: 1.2 },
        }]),
      ],
    }, { notMerge: true });
    clear(ann.tableSlot);
    ann.tableSlot.append(dataTable(t('trends.tableAnnual'), [t('common.year'), t('common.local'), t('common.imported'), t('common.total')],
      a.years.map((y, i) => [badYears.has(y) ? `${y}*` : String(y), fmtNum(a.local[i]!), fmtNum(a.imported[i]!), fmtNum(a.local[i]! + a.imported[i]!)]).reverse()));
  }

  function persist(): void {
    app.setParams(serializeTrendParams(st, firstYear, lastYear));
  }
  function renderAll(): void {
    renderEpi(false);
    renderCompare();
    renderAnnual();
    persist();
    const county = st.county ? placeName(admin?.countyByCode.get(st.county)) : t('common.allCounties');
    app.announce(`${t('trends.title')}: ${county}`);
  }

  // Theme switch → re-init charts with new colours.
  const offTheme = themeChanged.on(() => {
    th = readTheme();
    charts.forEach((c) => c.dispose());
    charts.length = 0;
    epiChart = mk(epi.chartEl);
    cmpChart = mk(cmp.chartEl);
    annChart = mk(ann.chartEl);
    epiChart.on('datazoom', debounce(() => {
      const dz = (epiChart.getOption() as { dataZoom?: { start: number; end: number }[] }).dataZoom?.[0];
      if (dz) epiZoom = [dz.start, dz.end];
      renderEpiTable();
    }, 250));
    renderChips();
    renderAll();
  });

  renderChips();
  renderAll();

  return {
    destroy() {
      destroyed = true;
      offTheme();
      ro.disconnect();
      charts.forEach((c) => c.dispose());
    },
  };
}
