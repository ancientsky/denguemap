// #/forecast — 疫情預測 (internal, experimental, not in the menu). Renewal-model forecast of local cases per
// area (src/lib/forecast/model.ts), descriptive direction/extent of the recent case groups (foci.ts), and a
// replay mode that cuts the data at a past date and thins it with the assumed reporting delay, with the
// final data shown as "actual". ECharts comes from the same lazy chunk as the trends view.
import { init, use, type ECharts } from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { Map as MLMap, MapLayerMouseEvent } from 'maplibre-gl';
import { errorCard } from '../app';
import { fmtDate, fmtNum, fmtPct, getLang, placeName, t } from '../i18n';
import { loadAdmin, type Admin } from '../lib/admin';
import { mergeCaseYears, recencyBucket, type CaseSet } from '../lib/aggregate';
import { DataError, loadData } from '../lib/data';
import { epochDay, isISODate, isoFromEpochDay, todayTaipei } from '../lib/dates';
import { clear, debounce, extLink, h, nextId, prefersReducedMotion } from '../lib/dom';
import { compass8, DEFAULT_FOCI, findFoci, type Focus } from '../lib/forecast/foci';
import { completeness, forecastArea, type AreaForecast } from '../lib/forecast/model';
import { PARAMS, SURFACE } from '../lib/forecast/params';
import { riskSurface, surfacePoints, type RiskSurface } from '../lib/forecast/surface';
import { relR0, tempFactors, tempPath, validateWeather, type TempPath, type WeatherFile } from '../lib/forecast/weather';
import spatialBacktest from '../lib/forecast/backtest-spatial.json';
import { countyCounts, localRows, seriesOf, snapshotAt, truthBlocks, type Snapshot } from '../lib/forecast/snapshot';
import backtest from '../lib/forecast/backtest.json';
import { TAIWAN_BOUNDS, type BBox } from '../lib/geo';
import { icon } from '../lib/icons';
import { validateCases } from '../lib/validate';
import type { MapHost, Overlay, OverlayCtx } from '../map/host';
import { removeAll } from '../map/layers';
import { cssVar, themeChanged } from '../theme';
import { ft } from './forecastText';
import { addVectorLayers, loadVectorBundle, triggerText, vectorFC, villageLabel, villagePopup, weekOf, type VectorBundle } from './vectorData';
import type { View, ViewContext } from './types';
import { dataTable, kpis, legendItem, loadingBlock, panel, section, select, toggle, type KpiSpec } from './ui';

use([BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

const REPORT_URL = 'https://github.com/ancientsky/denguemap/blob/main/docs/forecast-backtest.md';
/** History loaded before the as-of day (12 weeks shown + generation-interval run-in). */
const LOOKBACK = 140;
const PRESETS: { date: string; county: string; zh: string; en: string }[] = [
  { date: '2014-08-20', county: '64000', zh: '2014 高雄', en: '2014 Kaohsiung' },
  { date: '2015-08-20', county: '67000', zh: '2015 臺南', en: '2015 Tainan' },
  { date: '2015-09-10', county: '64000', zh: '2015 高雄', en: '2015 Kaohsiung' },
  { date: '2023-08-15', county: '67000', zh: '2023 臺南', en: '2023 Tainan' },
];
const COUNTY_RE = /^\d{5}$/;

interface Backtest {
  overall: { holdout: { h: number; relWis: number | null; cov50: number | null; cov90: number | null }[] };
  bySize: { lo: number; hi: number | null; perH: { h: number; cov90: number | null }[] }[];
}
const BT = backtest as unknown as Backtest;
const BTS = spatialBacktest as unknown as { overall: { holdout: { cap50: number | null; cap90: number | null; baseCap90: number | null } } };

const V = { fill: 'dm-fcv-fill', line: 'dm-fcv-line', ptsAll: 'dm-fcv-pts-all', ptsNp: 'dm-fcv-pts-np', poly: 'dm-fcv-poly', pts: 'dm-fcv-pts' };
const L = {
  risk: 'dm-fc-risk', cases: 'dm-fc-cases', last: 'dm-fc-last', lastLine: 'dm-fc-last-line', prev: 'dm-fc-prev',
  track: 'dm-fc-track', trackPt: 'dm-fc-track-pt', arrowHalo: 'dm-fc-arrow-halo', arrow: 'dm-fc-arrow',
};
const S = { risk: 'dm-fc-risk', cases: 'dm-fc-cases', ell: 'dm-fc-ell', track: 'dm-fc-track', trackPt: 'dm-fc-track-pt', arrow: 'dm-fc-arrow' };

interface MapData {
  risk: GeoJSON.FeatureCollection<GeoJSON.Polygon> | null;
  vector: { polys: GeoJSON.FeatureCollection; pts: GeoJSON.FeatureCollection } | null;
  cases: GeoJSON.FeatureCollection<GeoJSON.Point>;
  ellipses: GeoJSON.FeatureCollection<GeoJSON.Polygon>;
  tracks: GeoJSON.FeatureCollection<GeoJSON.LineString>;
  trackPts: GeoJSON.FeatureCollection<GeoJSON.Point>;
  arrows: GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.MultiLineString>;
}

class ForecastOverlay implements Overlay {
  private unbind: (() => void)[] = [];
  constructor(private host: MapHost, private data: MapData, private onPick: (e: MapLayerMouseEvent, hover: boolean) => void) {}
  install({ map, palette: p, beforeId }: OverlayCtx): void {
    if (this.data.risk) {
      map.addSource(S.risk, { type: 'geojson', data: this.data.risk });
      map.addLayer({ id: L.risk, type: 'fill', source: S.risk, paint: {
        'fill-color': p.local, 'fill-opacity': ['match', ['get', 'cls'], 1, 0.34, 0.13], 'fill-antialias': false } }, beforeId);
    }
    if (this.data.vector) {
      map.addSource(V.poly, { type: 'geojson', data: this.data.vector.polys });
      map.addSource(V.pts, { type: 'geojson', data: this.data.vector.pts });
      addVectorLayers(map, p, V, { fillOpacity: 0.16, minzoom: 11 });
    }
    map.addSource(S.ell, { type: 'geojson', data: this.data.ellipses });
    map.addLayer({ id: L.prev, type: 'line', source: S.ell, filter: ['==', ['get', 'kind'], 'prev'],
      paint: { 'line-color': p.accent, 'line-width': 1.6, 'line-dasharray': [2, 2], 'line-opacity': 0.8 } }, beforeId);
    map.addLayer({ id: L.last, type: 'fill', source: S.ell, filter: ['==', ['get', 'kind'], 'last'],
      paint: { 'fill-color': p.accent, 'fill-opacity': 0.14 } }, beforeId);
    map.addLayer({ id: L.lastLine, type: 'line', source: S.ell, filter: ['==', ['get', 'kind'], 'last'],
      paint: { 'line-color': p.accent, 'line-width': 2.2 } }, beforeId);
    map.addSource(S.cases, { type: 'geojson', data: this.data.cases });
    map.addLayer({ id: L.cases, type: 'circle', source: S.cases, layout: { 'circle-sort-key': ['-', 0, ['get', 'r']] }, paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, ['+', 2.2, ['*', 1.2, ['sqrt', ['get', 'n']]]], 13, ['+', 4.5, ['*', 2.6, ['sqrt', ['get', 'n']]]]],
      'circle-color': ['match', ['get', 'r'], 0, p.rec[0], 1, p.rec[1], 2, p.rec[2], p.rec[3]],
      'circle-opacity': 0.88, 'circle-stroke-color': p.recStroke, 'circle-stroke-width': 0.8 } }, beforeId);
    map.addSource(S.track, { type: 'geojson', data: this.data.tracks });
    map.addLayer({ id: L.track, type: 'line', source: S.track, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p.text, 'line-width': 2, 'line-opacity': 0.75 } }, beforeId);
    map.addSource(S.trackPt, { type: 'geojson', data: this.data.trackPts });
    map.addLayer({ id: L.trackPt, type: 'circle', source: S.trackPt, paint: {
      'circle-radius': ['+', 3, ['*', 3, ['get', 'age']]], 'circle-color': p.halo, 'circle-stroke-color': p.text, 'circle-stroke-width': 2 } }, beforeId);
    map.addSource(S.arrow, { type: 'geojson', data: this.data.arrows });
    map.addLayer({ id: L.arrowHalo, type: 'line', source: S.arrow, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p.halo, 'line-width': 6, 'line-opacity': 0.9 } }, beforeId);
    map.addLayer({ id: L.arrow, type: 'line', source: S.arrow, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p.local, 'line-width': 3 } }, beforeId);
    if (!this.unbind.length) {
      if (this.data.risk) this.unbind.push(this.host.interactive(L.risk, this.onPick));
      if (this.data.vector) for (const id of [V.fill, V.ptsAll, V.ptsNp]) this.unbind.push(this.host.interactive(id, this.onPick));
      this.unbind.push(this.host.interactive(L.last, this.onPick));
    }
  }
  uninstall(map: MLMap): void {
    for (const u of this.unbind) u();
    this.unbind = [];
    removeAll(map, [L.arrow, L.arrowHalo, L.trackPt, L.track, L.cases, L.lastLine, L.last, L.prev, V.ptsNp, V.ptsAll, V.line, V.fill, L.risk],
      [S.arrow, S.trackPt, S.track, S.cases, S.ell, V.pts, V.poly, S.risk]);
  }
}

const M_LAT = 110_574;
/** Arrow from a to b (lng/lat): shaft + two head strokes, head size relative to the length. */
function arrow(a: [number, number], b: [number, number], i: number): GeoJSON.Feature<GeoJSON.MultiLineString> {
  const kx = 111_320 * Math.cos((a[1] * Math.PI) / 180);
  const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * M_LAT;
  const len = Math.hypot(dx, dy) || 1;
  const head = Math.min(len * 0.4, 400);
  const ux = dx / len, uy = dy / len;
  const wing = (s: number): [number, number] => {
    const ang = Math.atan2(-uy, -ux) + s * (Math.PI / 7);
    return [b[0] + (Math.cos(ang) * head) / kx, b[1] + (Math.sin(ang) * head) / M_LAT];
  };
  return { type: 'Feature', id: i, properties: { i }, geometry: { type: 'MultiLineString', coordinates: [[a, b], [wing(1), b, wing(-1)]] } };
}

function mapData(set: CaseSet, snap: Snapshot, county: string | null, foci: Focus[], surf: RiskSurface | null, vec: VectorBundle | null): MapData {
  const byPt = new Map<number, { n: number; last: number }>();
  for (let i = 0; i < snap.length; i++) {
    if (snap.imp[i] || snap.day[i]! <= snap.asOf - 28) continue;
    const pt = snap.pt[i]!;
    if (county && set.pts[pt]?.[2]?.slice(0, 5) !== county) continue;
    const e = byPt.get(pt);
    if (e) {
      e.n += snap.n[i]!;
      e.last = Math.max(e.last, snap.day[i]!);
    } else byPt.set(pt, { n: snap.n[i]!, last: snap.day[i]! });
  }
  const cases: MapData['cases'] = { type: 'FeatureCollection', features: [...byPt].map(([pt, v]) => ({
    type: 'Feature', id: pt, properties: { n: v.n, r: recencyBucket(snap.asOf - v.last) }, geometry: { type: 'Point', coordinates: [set.pts[pt]![0], set.pts[pt]![1]] },
  })) };
  const ellipses: MapData['ellipses'] = { type: 'FeatureCollection', features: [] };
  const tracks: MapData['tracks'] = { type: 'FeatureCollection', features: [] };
  const trackPts: MapData['trackPts'] = { type: 'FeatureCollection', features: [] };
  const arrows: MapData['arrows'] = { type: 'FeatureCollection', features: [] };
  foci.forEach((f, i) => {
    if (f.prev14) ellipses.features.push({ type: 'Feature', properties: { kind: 'prev', i }, geometry: { type: 'Polygon', coordinates: [f.prev14.ring] } });
    if (f.last14) ellipses.features.push({ type: 'Feature', id: i, properties: { kind: 'last', i }, geometry: { type: 'Polygon', coordinates: [f.last14.ring] } });
    if (f.track.length >= 2) tracks.features.push({ type: 'Feature', properties: { i }, geometry: { type: 'LineString', coordinates: f.track.map((p) => [p.lng, p.lat]) } });
    f.track.forEach((p, k) => trackPts.features.push({ type: 'Feature', properties: { i, age: (k + 1) / f.track.length }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } }));
    if (f.direction && f.last14) arrows.features.push(arrow(f.last14.center, f.direction.to, i));
  });
  const risk: MapData['risk'] = surf ? { type: 'FeatureCollection', features: surf.cells.map((c, i) => ({
    type: 'Feature', id: i, properties: { kind: 'risk', r: i, cls: c.cls }, geometry: { type: 'Polygon', coordinates: [c.ring] },
  })) } : null;
  const vector = vec ? vectorFC(vec, 0, (v) => weekOf(v, 0)[0] >= 2 && (!county || v[5]?.slice(0, 5) === county)) : null;
  return { risk, vector, cases, ellipses, tracks, trackPts, arrows };
}

const fmt1 = (v: number) => v.toFixed(1);
/** km² with one decimal; tiny areas as "<0.1". */
const fmtKm2 = (v: number) => (v < 0.05 ? ft('lessThan', { v: '0.1' }) : v.toFixed(1));
const fmtR = (v: number) => v.toFixed(2);
const roundQ = (v: number) => fmtNum(Math.round(v));

export default async function forecastView(ctx: ViewContext): Promise<View> {
  const { app, root, setParams } = ctx;
  const pnl = panel(ft('title'), ft('intro'), 'panel-forecast');
  root.append(pnl.el);
  pnl.body.append(loadingBlock());
  let destroyed = false;
  const charts: ECharts[] = [];
  let ro: ResizeObserver | null = null;
  let offTheme: (() => void) | null = null;
  const done = (): View => ({
    destroy() {
      destroyed = true;
      offTheme?.();
      ro?.disconnect();
      charts.forEach((c) => c.dispose());
      app.mapSummary('');
    },
  });

  const [host, admin, manifest] = await Promise.all([app.getMapHost(), loadAdmin().catch(() => null as Admin | null), app.whenManifest()]);
  if (host) host.padding = pnl.padding;
  if (destroyed) return done();
  if (!manifest) {
    clear(pnl.body);
    pnl.body.append(errorCard('', () => location.reload(), 'manifest.json'));
    return done();
  }

  // ---- state from the URL: ?asof=YYYY-MM-DD (replay; absent = latest) & county=NNNNN
  const liveDay = epochDay(todayTaipei(new Date(manifest.generatedAt)));
  const firstYear = Math.min(...manifest.years);
  const minDay = epochDay(`${firstYear}-01-01`) + LOOKBACK;
  const parse = (p: Record<string, string>) => {
    const a = p.asof && isISODate(p.asof) ? epochDay(p.asof) : NaN;
    const replay = Number.isFinite(a) && a >= minDay && a < liveDay;
    return { asOf: replay ? a : liveDay, replay, county: p.county && COUNTY_RE.test(p.county) ? p.county : null, risk: p.risk !== '0', mv: p.mv !== '0' };
  };
  let st = parse(ctx.params);
  const persist = () => setParams({ ...(st.replay ? { asof: isoFromEpochDay(st.asOf) } : {}), ...(st.county ? { county: st.county } : {}), ...(st.risk ? {} : { risk: '0' }), ...(st.mv ? {} : { mv: '0' }) });

  const yearOf = (d: number) => +isoFromEpochDay(d).slice(0, 4);
  async function loadSet(asOf: number, replay: boolean): Promise<CaseSet> {
    const years: number[] = [];
    // Replay also needs the 4 weeks after the as-of day (actual counts).
    for (let y = yearOf(asOf - LOOKBACK); y <= yearOf(asOf + (replay ? 28 : 0)); y++) if (manifest!.years.includes(y)) years.push(y);
    const files = await Promise.all(years.map((y) => loadData(`cases/${y}.json`, (v) => validateCases(v, y))));
    return mergeCaseYears(files);
  }

  // ---- static panel parts
  const controls = h('div', { class: 'fc-controls' });
  const status = h('div', { class: 'fc-status' });
  const kpiSlot = h('div');
  const wxBody = h('div', { class: 'fc-risk' });
  const chartTitleId = nextId('fc');
  const chartEl = h('div', { class: 'chart fc-chart', role: 'img', 'aria-label': ft('chartTitle') });
  const chartNote = h('p', { class: 'card-note' });
  // HTML legend (the band series are stacked pairs, which ECharts' own legend cannot label sensibly).
  const fanLegend = h('ul', { class: 'legend fc-legend' },
    legendItem('var(--trend-local)', ft('sObserved'), 'square'),
    h('li', { class: 'legend-item' }, h('span', { class: 'lg-square lg-pending', 'aria-hidden': 'true' }), h('span', null, ft('sPending'))),
    h('li', { class: 'legend-item' }, h('span', { class: 'lg-dash', 'aria-hidden': 'true' }), h('span', null, ft('sMedian'))),
    h('li', { class: 'legend-item' }, h('span', { class: 'lg-square lg-band50', 'aria-hidden': 'true' }), h('span', null, ft('sBand50'))),
    h('li', { class: 'legend-item' }, h('span', { class: 'lg-square lg-band90', 'aria-hidden': 'true' }), h('span', null, ft('sBand90'))));
  const actualLegend = h('li', { class: 'legend-item' }, h('span', { class: 'lg-actual', 'aria-hidden': 'true' }), h('span', null, ft('sActual')));
  const chartTable = h('div');
  const rtEl = h('div', { class: 'chart fc-chart-rt', role: 'img', 'aria-label': ft('rtTitle', { n: 84 }) });
  const rtTable = h('div');
  const fociList = h('ul', { class: 'list-cards' });
  const riskBody = h('div', { class: 'fc-risk' });
  const vecBody = h('div', { class: 'fc-risk fc-vec' });
  const legend = h('ul', { class: 'legend' },
    h('li', { class: 'legend-title' }, ft('lgCases')),
    ...[0, 1, 2, 3].map((r) => h('li', { class: 'legend-item' }, h('span', { class: 'lg-dot', style: { '--sw': `var(--rec-${r})` }, 'aria-hidden': 'true' }), t(`rec.${r}` as 'rec.0'))),
    h('li', { class: 'legend-item' }, h('span', { class: 'lg-square lg-risk1', 'aria-hidden': 'true' }), h('span', null, ft('lgRisk50'))),
    h('li', { class: 'legend-item' }, h('span', { class: 'lg-square lg-risk2', 'aria-hidden': 'true' }), h('span', null, ft('lgRisk90'))),
    h('li', { class: 'legend-item' }, h('span', { class: 'lg-square lg-vec', 'aria-hidden': 'true' }), h('span', null, ft('lgVec'))),
    legendItem('var(--accent)', ft('lgLast14'), 'square'),
    h('li', { class: 'legend-item' }, h('span', { class: 'lg-dash', 'aria-hidden': 'true' }), h('span', null, ft('lgPrev14'))),
    h('li', { class: 'legend-item' }, h('span', { class: 'lg-track', 'aria-hidden': 'true' }), h('span', null, ft('lgTrack'))),
    h('li', { class: 'legend-item' }, h('span', { class: 'lg-arrow', 'aria-hidden': 'true' }, '→'), h('span', null, ft('lgArrow'))));
  const holdout = BT.overall.holdout;
  const method = h('details', { class: 'fc-method' }, h('summary', null, ft('method')),
    h('ul', { class: 'fc-method-list' },
      h('li', null, ft('m1', { gi: PARAMS.gi.mean, alpha: PARAMS.importedWeight })),
      h('li', null, ft('m2', { d: PARAMS.delay.mean })),
      h('li', null, ft('m3', { sims: fmtNum(PARAMS.sims), phi: PARAMS.damping, k: PARAMS.dispersion })),
      h('li', null, ft('m4'), h('ul', null, ...holdout.filter((x) => x.h >= 1).map((x) =>
        h('li', null, `${ft('backtestH', { h: x.h })}：${ft('backtestRow', { w: x.relWis == null ? '—' : x.relWis.toFixed(2), c: x.cov90 == null ? '—' : fmtPct(x.cov90) })}`)))),
      h('li', null, ft('m5')),
      h('li', null, ft('m7')),
      h('li', null, ft('m6', { m: SURFACE.cellM, s1: SURFACE.sigma1M, s2: fmtNum(SURFACE.sigma2M), rho: fmtPct(SURFACE.rho), beta: fmtPct(SURFACE.beta) }))),
    h('p', null, extLink(REPORT_URL, ft('mReport'))));
  pnl.body.replaceChildren(
    h('div', { class: 'notice-warn fc-banner', role: 'note' }, icon('alert'), h('div', null, h('p', null, h('strong', null, ft('bannerTitle'))), h('p', null, ft('bannerBody')))),
    controls, status, kpiSlot,
    section(ft('wxTitle'), wxBody),
    h('section', { class: 'psec', 'aria-labelledby': chartTitleId }, h('h2', { class: 'psec-title', id: chartTitleId }, ft('chartTitle')), fanLegend, chartEl, chartNote, chartTable),
    section(ft('rtTitle', { n: 84 }), rtEl, h('p', { class: 'card-note' }, ft('rtNote')), rtTable),
    section(ft('riskTitle'), riskBody),
    section(ft('vecTitle'), vecBody),
    section(ft('fociTitle'), h('p', { class: 'hint' }, ft('fociNote', { m: DEFAULT_FOCI.linkM, n: DEFAULT_FOCI.minCases })), fociList),
    section(ft('legendTitle'), legend),
    method);
  const c50 = holdout.find((x) => x.h === 2)?.cov50, c90 = holdout.find((x) => x.h === 2)?.cov90;
  chartNote.textContent = ft('chartNote', { c50: c50 == null ? '—' : fmtPct(c50), c90: c90 == null ? '—' : fmtPct(c90) });

  // ---- charts
  const anim = !prefersReducedMotion();
  const theme = () => ({
    text: cssVar('--text'), muted: cssVar('--muted'), border: cssVar('--border-strong'), split: cssVar('--border'), surface: cssVar('--surface'),
    local: cssVar('--trend-local'), accent: cssVar('--accent'), font: getComputedStyle(document.body).fontFamily,
  });
  let th = theme();
  const mk = (el: HTMLElement) => {
    const c = init(el, undefined, { renderer: 'canvas', locale: 'EN' });
    charts.push(c);
    return c;
  };
  let fanChart = mk(chartEl), rtChart = mk(rtEl);
  ro = new ResizeObserver(debounce(() => charts.forEach((c) => c.resize()), 120));
  ro.observe(chartEl);
  ro.observe(rtEl);

  // ---- data + render
  let set: CaseSet | null = null;
  let setKey = '';
  let last: { f: AreaForecast; truth: number[] | null; snap: Snapshot; foci: Focus[]; surf: RiskSurface | null } | null = null;
  // Vector data are current only: loaded for live views, never shown in replay.
  let vec: VectorBundle | null = null;
  let weather: WeatherFile | null = null;
  let weatherTried = false;
  let vecError = false;
  let token = 0;

  const countyName = (code: string | null) => (code ? placeName(admin?.countyByCode.get(code)) || code : ft('national'));
  const townName = (code: string | null) => {
    if (!code) return '';
    const tw = admin?.towns.get(code);
    const c = tw ? admin?.countyByCode.get(tw.county) : undefined;
    return tw ? (getLang() === 'en' ? `${placeName(tw)}, ${placeName(c)}` : `${placeName(c)}${placeName(tw)}`) : code;
  };

  function renderControls(snap: Snapshot): void {
    const counts = countyCounts(set!, snap);
    const opts = [{ value: '', label: ft('national') }, ...counts.map(([c, n]) => ({ value: c, label: ft('areaCount', { name: countyName(c), n: fmtNum(n) }) }))];
    if (st.county && !counts.some(([c]) => c === st.county)) opts.push({ value: st.county, label: ft('areaCount', { name: countyName(st.county), n: 0 }) });
    const dateId = nextId('fcd');
    const dateInput = h('input', { type: 'date', id: dateId, class: 'date-input', min: isoFromEpochDay(minDay), max: isoFromEpochDay(liveDay - 1),
      value: st.replay ? isoFromEpochDay(st.asOf) : '', on: { change: () => {
        const v = dateInput.value;
        if (!isISODate(v)) return;
        st = { ...parse({ asof: v, county: st.county ?? '' }) };
        void run();
      } } });
    const presetBtns = PRESETS.map((p) => h('button', { type: 'button', class: 'fchip', 'aria-pressed': String(st.replay && isoFromEpochDay(st.asOf) === p.date && st.county === p.county), on: { click: () => {
      st = parse({ asof: p.date, county: p.county });
      void run();
    } } }, getLang() === 'en' ? p.en : p.zh));
    const latestBtn = h('button', { type: 'button', class: 'fchip', 'aria-pressed': String(!st.replay), on: { click: () => {
      st = { ...st, asOf: liveDay, replay: false };
      void run();
    } } }, ft('asOfLatest'));
    controls.replaceChildren(
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, ft('presets')), h('div', { class: 'chip-row' }, latestBtn, ...presetBtns)),
      h('div', { class: 'field-row field-row-half' },
        h('div', { class: 'field' }, h('label', { for: dateId, class: 'field-label' }, ft('asOfPick')), dateInput),
        select(ft('area'), opts, st.county ?? '', (v) => {
          st = { ...st, county: v || null };
          void run();
        })),
      h('p', { class: 'hint' }, ft('areaHint')));
  }

  function renderKpis(f: AreaForecast): void {
    const items: KpiSpec[] = [{ label: ft('kpiRecent'), value: fmtNum(f.recent28), sub: ft('kpiImported', { n: fmtNum(f.recentImported28) }), tone: 'local' }];
    if (f.rt) {
      const trend = f.rt.lo > 1 ? 'up' : f.rt.hi < 1 ? 'down' : 'flat';
      items.push({ label: ft('kpiRt'), value: fmtR(f.rt.median), sub: ft('kpiRtCi', { lo: fmtR(f.rt.lo), hi: fmtR(f.rt.hi) }), trend,
        note: trend === 'up' ? ft('rtUp') : trend === 'down' ? ft('rtDown') : ft('rtFlat') });
    } else items.push({ label: ft('kpiRt'), value: '—', sub: ft('kpiRtNone') });
    if (f.next14 && f.pAny14 != null) {
      items.push({ label: ft('kpiNext14'), value: roundQ(f.next14.q50), sub: ft('kpiNext14Ci', { lo: roundQ(f.next14.q05), hi: roundQ(f.next14.q95) }) },
        { label: ft('kpiAny'), value: fmtPct(f.pAny14) });
    }
    kpiSlot.replaceChildren(kpis(items));
  }

  function renderStatus(f: AreaForecast): void {
    const dateText = fmtDate(isoFromEpochDay(f.asOf));
    const parts: HTMLElement[] = [h('p', { class: 'hint fc-mode' }, st.replay ? ft('replayNote', { date: dateText }) : ft('liveNote', { date: dateText }))];
    if (f.status === 'few') {
      parts.push(h('div', { class: 'empty-state', role: 'status' }, icon('check'),
        h('p', { class: 'empty-title' }, ft('fewTitle')), h('p', { class: 'empty-body' }, ft('fewBody', { n: fmtNum(f.recent28), min: PARAMS.minCases }))));
    } else {
      const bucket = BT.bySize.find((b) => f.recent28 >= b.lo && (b.hi == null || f.recent28 <= b.hi));
      const cov = bucket?.perH.find((x) => x.h === 4)?.cov90;
      if (bucket && bucket.hi != null && bucket.hi < 30 && cov != null) parts.push(h('div', { class: 'notice-warn', role: 'note' }, icon('alert'), h('div', null, h('p', null, ft('lowConf', { n: fmtNum(f.recent28), cov: fmtPct(cov) })))));
    }
    status.replaceChildren(...parts);
  }

  function renderFan(f: AreaForecast, truth: number[] | null): void {
    const cats = f.weeks.map((w) => fmtDate(isoFromEpochDay(w.end), 'short'));
    const obs = f.weeks.map((w) => (w.kind === 'future' ? null : w.observed));
    const pending = f.weeks.map((w) => (w.kind === 'nowcast' && w.q ? Math.max(0, Math.round(w.q.q50) - w.observed) : null));
    const qv = (k: 'q05' | 'q25' | 'q50' | 'q75' | 'q95') => f.weeks.map((w) => (w.q ? w.q[k] : null));
    const q05 = qv('q05'), q25 = qv('q25'), q50 = qv('q50'), q75 = qv('q75'), q95 = qv('q95');
    const diff = (a: (number | null)[], b: (number | null)[]) => a.map((v, i) => (v == null || b[i] == null ? null : Math.max(0, v - b[i]!)));
    const actualIdx = new Set(f.weeks.map((w, i) => (w.kind !== 'past' ? i : -1)).filter((i) => i >= 0));
    const actual = truth ? f.weeks.map((_, i) => (actualIdx.has(i) ? truth[[...actualIdx].indexOf(i)] ?? null : null)) : null;
    const band = (name: string, lo: (number | null)[], hi: (number | null)[], opacity: number, stack: string) => [
      { name, type: 'line' as const, stack, data: lo, lineStyle: { opacity: 0 }, symbol: 'none', silent: true, legendHoverLink: false, tooltip: { show: false } },
      { name, type: 'line' as const, stack, data: diff(hi, lo), lineStyle: { opacity: 0 }, symbol: 'none', areaStyle: { color: th.accent, opacity }, silent: true, tooltip: { show: false } },
    ];
    fanChart.setOption({
      animation: anim,
      textStyle: { fontFamily: th.font, color: th.text },
      grid: { left: 6, right: 10, top: 14, bottom: 6, containLabel: true },
      tooltip: { trigger: 'axis', confine: true, backgroundColor: th.surface, borderColor: th.border, textStyle: { color: th.text, fontSize: 12.5, fontFamily: th.font },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? fmtNum(Math.round(v)) : '—') },
      xAxis: { type: 'category', data: cats, axisLine: { lineStyle: { color: th.border } }, axisLabel: { color: th.muted, fontSize: 11, hideOverlap: true } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { color: th.muted, fontSize: 11, formatter: (v: number) => fmtNum(v) }, splitLine: { lineStyle: { color: th.split } } },
      series: [
        { name: ft('sObserved'), type: 'bar', stack: 'obs', data: obs, itemStyle: { color: th.local }, barCategoryGap: '18%' },
        { name: ft('sPending'), type: 'bar', stack: 'obs', data: pending, itemStyle: { color: th.local, opacity: 0.35, borderColor: th.local, borderType: 'dashed', borderWidth: 1 } },
        ...band(ft('sBand90'), q05, q95, 0.16, 'b90'),
        ...band(ft('sBand50'), q25, q75, 0.3, 'b50'),
        { name: ft('sMedian'), type: 'line', data: q50, symbol: 'circle', symbolSize: 5, lineStyle: { color: th.accent, width: 2.5, type: 'dashed' }, itemStyle: { color: th.accent } },
        ...(actual ? [{ name: ft('sActual'), type: 'line' as const, data: actual, symbol: 'diamond', symbolSize: 8, lineStyle: { color: th.text, width: 1.5 }, itemStyle: { color: th.text } }] : []),
      ],
    }, { notMerge: true });
    if (actual) fanLegend.append(actualLegend);
    else actualLegend.remove();
    const kind = (k: string) => (k === 'past' ? ft('kindPast') : k === 'nowcast' ? ft('kindNowcast') : ft('kindFuture'));
    const head = [ft('colWeek'), ft('colObserved'), ft('colMedian'), ft('col50'), ft('col90'), ...(actual ? [ft('colActual')] : [])];
    const rows = f.weeks.map((w, i) => [
      `${ft('week', { date: fmtDate(isoFromEpochDay(w.end)) })}（${kind(w.kind)}）`,
      w.kind === 'future' ? '—' : fmtNum(w.observed),
      w.q ? roundQ(w.q.q50) : '—',
      w.q ? `${roundQ(w.q.q25)}–${roundQ(w.q.q75)}` : '—',
      w.q ? `${roundQ(w.q.q05)}–${roundQ(w.q.q95)}` : '—',
      ...(actual ? [actual[i] == null ? '—' : fmtNum(actual[i]!)] : []),
    ]);
    chartTable.replaceChildren(dataTable(ft('tableWeeks'), head, rows));
  }

  function renderRt(f: AreaForecast): void {
    const days: string[] = [], med: (number | null)[] = [], lo: (number | null)[] = [], span: (number | null)[] = [];
    const byDay = new Map(f.rtSeries.map((r) => [r.day, r]));
    for (let d = f.asOf - 83; d <= f.asOf; d++) {
      const r = byDay.get(d);
      days.push(fmtDate(isoFromEpochDay(d), 'short'));
      med.push(r ? r.median : null);
      lo.push(r ? r.lo : null);
      span.push(r ? r.hi - r.lo : null);
    }
    rtChart.setOption({
      animation: anim,
      textStyle: { fontFamily: th.font, color: th.text },
      grid: { left: 6, right: 10, top: 16, bottom: 6, containLabel: true },
      tooltip: { trigger: 'axis', confine: true, backgroundColor: th.surface, borderColor: th.border, textStyle: { color: th.text, fontSize: 12.5, fontFamily: th.font },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? fmtR(v) : '—') },
      xAxis: { type: 'category', data: days, boundaryGap: false, axisLine: { lineStyle: { color: th.border } }, axisLabel: { color: th.muted, fontSize: 11, hideOverlap: true } },
      // Early in an outbreak the interval can be very wide: cap the axis so the estimate stays readable.
      yAxis: { type: 'value', min: 0, max: (v: { max: number }) => Math.min(Math.max(2, Math.ceil(v.max)), 5),
        axisLabel: { color: th.muted, fontSize: 11 }, splitLine: { lineStyle: { color: th.split } } },
      series: [
        { name: ft('rtBand'), type: 'line', stack: 'ci', data: lo, lineStyle: { opacity: 0 }, symbol: 'none', silent: true, tooltip: { show: false } },
        { name: ft('rtBand'), type: 'line', stack: 'ci', data: span, lineStyle: { opacity: 0 }, symbol: 'none', areaStyle: { color: th.accent, opacity: 0.22 }, silent: true, tooltip: { show: false } },
        { name: ft('rtOne'), type: 'line', data: days.map(() => 1), symbol: 'none', lineStyle: { color: th.muted, type: 'dashed', width: 1 }, silent: true, tooltip: { show: false } },
        { name: ft('rtLine'), type: 'line', data: med, symbol: 'none', connectNulls: false, lineStyle: { color: th.accent, width: 2.5 } },
      ],
    }, { notMerge: true });
    const weekly = f.rtSeries.filter((r) => (f.asOf - r.day) % 7 === 0).reverse();
    rtTable.replaceChildren(dataTable(ft('tableRt'), [ft('colWeek'), ft('colRt'), ft('colCi')],
      weekly.map((r) => [fmtDate(isoFromEpochDay(r.day)), fmtR(r.median), `${fmtR(r.lo)}–${fmtR(r.hi)}`])));
  }

  const focusName = (f: Focus) => (f.towns > 1 ? ft('focusMore', { name: townName(f.town), n: getLang() === 'en' ? f.towns - 1 : f.towns }) : townName(f.town));
  const focusLines = (f: Focus): string[] => {
    const out = [ft('focusCases', { n: fmtNum(f.cases), m: fmtNum(f.cases14) })];
    out.push(f.direction ? ft('focusDir', { dir: ft(`dir${compass8(f.direction.bearing)}` as 'dir0'), km: fmt1(f.direction.shift14M / 1000) }) : ft('focusNoDir'));
    if (f.last14) {
      let s = ft('focusArea', { a: fmtKm2(f.last14.areaKm2) });
      if (f.prev14) {
        const r = f.last14.areaKm2 / f.prev14.areaKm2;
        const x = r >= 1.25 ? ft('grow', { r: fmt1(r) }) : r <= 0.8 ? ft('shrink', { r: fmt1(r) }) : ft('same');
        s += `${ft('sep')}${ft('focusAreaChange', { b: fmtKm2(f.prev14.areaKm2), x })}`;
      }
      out.push(s);
    }
    return out;
  };

  function renderFoci(foci: Focus[]): void {
    clear(fociList);
    if (!foci.length) {
      fociList.append(h('li', { class: 'empty' }, ft('fociNone')));
      return;
    }
    foci.slice(0, 8).forEach((f, i) => {
      const [, ...rest] = focusLines(f);
      fociList.append(h('li', null, h('button', { type: 'button', class: 'card-btn', 'aria-pressed': 'false', on: { click: () => {
        for (const [j, el] of [...fociList.querySelectorAll('.card-btn')].entries()) el.setAttribute('aria-pressed', String(j === i));
        host?.fit(f.bbox, 14);
      } } },
        h('span', { class: 'card-title' }, h('span', null, focusName(f)), h('span', { class: 'badge' }, t('clusters.cases', { n: fmtNum(f.cases) }))),
        h('span', { class: 'card-meta fc-focus-meta' }, h('span', null, ft('focusCases', { n: fmtNum(f.cases), m: fmtNum(f.cases14) })), ...rest.map((s) => h('span', null, s))))));
    });
  }

  async function run(): Promise<void> {
    const my = ++token;
    persist();
    status.replaceChildren(loadingBlock());
    const key = `${st.asOf}|${st.replay}`;
    try {
      if (key !== setKey || !set) {
        set = await loadSet(st.asOf, st.replay);
        setKey = key;
      }
    } catch (e) {
      if (my !== token || destroyed) return;
      status.replaceChildren(errorCard('', () => void run(), e instanceof DataError ? e.file : 'cases'));
      return;
    }
    if (my !== token || destroyed) return;
    const comp = completeness(PARAMS);
    // Replay: what had been published by the as-of day (seeded thinning). Live data are already incomplete.
    const snap = snapshotAt(set, st.asOf, st.asOf - LOOKBACK, st.replay ? comp : null, 11);
    const series = seriesOf(set, snap, st.county, st.asOf - LOOKBACK);
    if (!weatherTried) {
      weatherTried = true;
      weather = await loadData('weather.json', validateWeather).catch(() => null);
      if (my !== token || destroyed) return;
    }
    // National view: the station of the county with the most recent local cases.
    const wxCounty = st.county ?? countyCounts(set, snap)[0]?.[0] ?? null;
    const wx = weather && wxCounty ? tempPath(weather, weather.county[wxCounty], st.asOf, PARAMS.horizon) : null;
    const f = forecastArea(series, PARAMS, PARAMS.seed ^ st.asOf ^ (st.county ? Number(st.county) : 0), tempFactors(wx, PARAMS.tempGamma, PARAMS.horizon));
    renderWeather(wx);
    const truth = st.replay ? truthBlocks(set, st.county, f.weeks.filter((w) => w.kind !== 'past').map((w) => w.end)) : null;
    const foci = findFoci(localRows(set, snap, st.county, st.asOf - 27), st.asOf);
    let surf: RiskSurface | null = null;
    if (f.status === 'ok' && f.samples14) {
      const pts = surfacePoints(set, snap, st.county, PARAMS);
      surf = riskSurface(pts.infectors, pts.older, SURFACE, f.samples14);
    }
    if (!st.replay && !vec && !vecError) {
      try {
        vec = await loadVectorBundle();
      } catch {
        vecError = true;
      }
      if (my !== token || destroyed) return;
    }
    last = { f, truth, snap, foci, surf };
    renderRisk(surf);
    renderVector(surf);
    renderControls(snap);
    renderStatus(f);
    renderKpis(f);
    renderFan(f, truth);
    renderRt(f);
    renderFoci(foci);
    renderMap();
    const area = countyName(st.county);
    app.announce(`${ft('title')}: ${area}`);
    app.mapSummary(ft('mapSummary', { area, date: fmtDate(isoFromEpochDay(st.asOf)), n: fmtNum(f.recent28), foci: foci.length }));
    document.body.dataset.forecastReady = `${isoFromEpochDay(st.asOf)}|${st.county ?? ''}|${f.status}`;
  }

  function renderMap(refit = true): void {
    if (!host || !last || !set) return;
    const { snap, foci, surf } = last;
    const data = mapData(set, snap, st.county, foci, st.risk ? surf : null, !st.replay && st.mv ? vec : null);
    const onPick = (e: MapLayerMouseEvent, hover: boolean) => {
      const props = e.features?.[0]?.properties;
      if (props?.k != null && vec) {
        const v = vec.data.villages[Number(props.k)];
        if (v) host.showPopup(e.lngLat, villagePopup(vec, admin, v, 0, !Number(props.np)), hover);
        return;
      }
      if (props?.kind === 'risk') {
        const c = surf?.cells[Number(props.r)];
        if (!c) return;
        host.showPopup(e.lngLat, h('div', { class: 'pop' }, h('p', { class: 'pop-kicker' }, ft('popupRisk')),
          h('p', { class: 'pop-title' }, ft(c.cls === 1 ? 'popupRiskCls1' : 'popupRiskCls2')),
          c.pAny != null ? h('p', { class: 'pop-sub' }, ft('popupRiskP', { m: surf!.cellM, p: fmtPct(c.pAny) })) : null,
          c.expected != null ? h('p', { class: 'pop-sub' }, ft('popupRiskE', { e: c.expected < 0.1 ? '<0.1' : c.expected.toFixed(1) })) : null), hover);
        return;
      }
      const i = Number(props?.i);
      const f = foci[i];
      if (!f) return;
      host.showPopup(e.lngLat, h('div', { class: 'pop' }, h('p', { class: 'pop-kicker' }, ft('popupFocus')), h('p', { class: 'pop-title' }, focusName(f)),
        ...focusLines(f).map((s) => h('p', { class: 'pop-sub' }, s))), hover);
    };
    host.setOverlay(new ForecastOverlay(host, data, onPick));
    if (!refit) return;
    const boxes = foci.map((f) => f.bbox);
    const countyBox = st.county ? admin?.countyByCode.get(st.county)?.bbox ?? null : null;
    const target: BBox = boxes.length
      ? [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))]
      : countyBox ?? TAIWAN_BOUNDS;
    host.fit(target, boxes.length ? 13 : 9);
  }

  function renderVector(surf: RiskSurface | null): void {
    if (st.replay) {
      vecBody.replaceChildren(h('p', { class: 'hint' }, ft('vecReplay')));
      return;
    }
    if (!vec) {
      vecBody.replaceChildren(h('p', { class: 'hint' }, ft('vecLoadError')));
      return;
    }
    const b = vec;
    const wk = b.data.weeks[0];
    const rows: { v: (typeof b.data.villages)[number]; cls: 1 | 2; share: number }[] = [];
    if (surf) {
      for (const v of b.data.villages) {
        if (weekOf(v, 0)[0] < 2 || (st.county && v[5]?.slice(0, 5) !== st.county)) continue;
        const at = surf.locate(v[3], v[4]);
        if (at && at.cls <= 2) rows.push({ v, cls: at.cls as 1 | 2, share: at.share });
      }
      rows.sort((a, c) => a.cls - c.cls || c.share - a.share);
    }
    const list = h('ul', { class: 'list-cards' }, ...rows.slice(0, 10).map(({ v, cls }) => {
      const r = weekOf(v, 0)[0];
      return h('li', null, h('button', { type: 'button', class: 'card-btn', on: { click: () => host?.jump([v[3], v[4]], 15) } },
        h('span', { class: 'card-title' }, h('span', null, villageLabel(admin, v)), h('span', { class: 'pill risk', style: { '--sw': `var(--risk-${r})` } }, t(r === 3 ? 'vector.risk3' : 'vector.risk2'))),
        h('span', { class: 'card-meta fc-focus-meta' }, h('span', null, ft(cls === 1 ? 'vecIn1' : 'vecIn2')), h('span', null, triggerText(weekOf(v, 0))))));
    }));
    vecBody.replaceChildren(
      h('p', null, ft('vecIntro')),
      h('p', { class: 'hint' }, wk ? ft('vecWeek', { from: fmtDate(wk[0], 'short'), to: fmtDate(wk[1], 'short') }) : ''),
      !surf ? h('p', { class: 'hint' }, ft('vecNoRisk')) : rows.length ? list : h('p', { class: 'hint' }, ft('vecNone')),
      h('p', { class: 'hint' }, ft('vecBias')),
      toggle(ft('vecToggle'), st.mv, (on) => {
        st = { ...st, mv: on };
        persist();
        renderMap(false);
      }));
  }

  function renderWeather(wx: TempPath | null): void {
    if (!wx || !weather) {
      wxBody.replaceChildren(h('p', { class: 'hint' }, ft('wxNone')));
      return;
    }
    const name = weather.series[wx.station]?.name ?? wx.station;
    const end = wx.temps[wx.temps.length - 1]!;
    const base = relR0(wx.temps[0]!);
    const ratio = base > 0.05 ? relR0(end) / base : null;
    const sign = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
    wxBody.replaceChildren(
      h('p', null, ft('wxNow', { t: wx.recent.toFixed(1), a: sign(wx.anomaly), st: name })),
      h('p', null, ft('wxAhead', { t: end.toFixed(1), r: ratio == null ? '—' : fmtPct(ratio) })),
      h('p', { class: 'hint' }, PARAMS.tempGamma > 0 ? ft('wxUsed', { g: PARAMS.tempGamma }) : ft('wxUnused')),
      h('p', { class: 'hint' }, ft('wxSource')));
  }

  function renderRisk(surf: RiskSurface | null): void {
    if (!surf) {
      riskBody.replaceChildren(h('p', { class: 'hint' }, ft('riskNone')));
      return;
    }
    const ho = BTS.overall.holdout;
    riskBody.replaceChildren(
      h('p', null, ft('riskSummary', { a50: fmt1(surf.area50Km2), a90: fmt1(surf.area90Km2) })),
      h('p', { class: 'hint' }, ft('riskBacktest', { c50: ho.cap50 == null ? '—' : fmtPct(ho.cap50), c90: ho.cap90 == null ? '—' : fmtPct(ho.cap90), b90: ho.baseCap90 == null ? '—' : fmtPct(ho.baseCap90) })),
      toggle(ft('riskToggle'), st.risk, (on) => {
        st = { ...st, risk: on };
        persist();
        renderMap(false);
      }));
  }

  offTheme = themeChanged.on(() => {
    th = theme();
    charts.forEach((c) => c.dispose());
    charts.length = 0;
    fanChart = mk(chartEl);
    rtChart = mk(rtEl);
    if (last) {
      renderFan(last.f, last.truth);
      renderRt(last.f);
    }
  });

  await run();
  return {
    update(params) {
      const next = parse(params);
      if (next.asOf === st.asOf && next.replay === st.replay && next.county === st.county) {
        if (next.risk !== st.risk || next.mv !== st.mv) {
          st = next;
          if (last) {
            renderRisk(last.surf);
            renderVector(last.surf);
          }
          renderMap(false);
        }
        return;
      }
      st = next;
      void run();
    },
    ...done(),
  };
}
