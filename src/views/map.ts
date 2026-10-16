// #/map — 動態地圖: case points / heatmap / township choropleth, date range + 14-day playback.
import type { Map as MLMap, GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import { errorCard } from '../app';
import { fmtDate, fmtNum, getLang, placeName, t } from '../i18n';
import { loadAdmin, type Admin } from '../lib/admin';
import { aggregateCases, dailyCounts, niceBreaks, topEntries, type CaseAggregate } from '../lib/aggregate';
import { loadData, DataError } from '../lib/data';
import { dateFromDoy, dayDiff } from '../lib/dates';
import { clear, h, rafThrottle } from '../lib/dom';
import { TAIWAN_BOUNDS } from '../lib/geo';
import { icon } from '../lib/icons';
import { maxDoyFor, normalizeMapParams, serializeMapParams, type CaseType, type MapCtx, type MapMode, type MapParams } from '../lib/params';
import type { CasesYear, NS1, Summary } from '../lib/types';
import { validateCases, validateNS1, validateSummary } from '../lib/validate';
import { removeAll, type MapHost, type Overlay, type OverlayCtx } from '../map/host';
import { readPalette } from '../map/palette';
import { dualRange } from './range';
import type { View, ViewContext } from './types';
import { kpis, legendItem, loadingBlock, notice, panel, section, segmented, select, toggle, warningText, type KpiSpec } from './ui';
import { casesShortfalls } from '../lib/warnings';

const L = {
  townsFill: 'dm-towns-fill', townsLine: 'dm-towns-line', heat: 'dm-heat', pts: 'dm-pts', focus: 'dm-county-focus', ns1: 'dm-ns1',
};
const S = { towns: 'dm-towns', cases: 'dm-cases', counties: 'dm-counties', ns1: 'dm-ns1' };
const WINDOW = 14;
const SPEEDS = { '1': 320, '2': 160, '4': 70 } as const;
type Speed = keyof typeof SPEEDS;

class CasesOverlay implements Overlay {
  readonly projection = 'mercator' as const;
  fc: GeoJSON.FeatureCollection<GeoJSON.Point> = { type: 'FeatureCollection', features: [] };
  townCounts = new Map<string, number>();
  breaks: number[] = [1];
  mode: MapMode = 'points';
  county: string | null = null;
  ns1: NS1 | null = null;
  showNs1 = false;
  private unbind: (() => void)[] = [];
  private ctx: OverlayCtx | null = null;

  constructor(private host: MapHost, private admin: Admin | null, private onPick: (e: MapLayerMouseEvent, hover: boolean, layer: string) => void) {}

  install(ctx: OverlayCtx): void {
    this.ctx = ctx;
    const { map, palette: p, beforeId } = ctx;
    if (this.admin) {
      map.addSource(S.towns, { type: 'geojson', data: this.admin.townsFC });
      map.addSource(S.counties, { type: 'geojson', data: this.admin.countiesFC });
      map.addLayer({ id: L.townsFill, type: 'fill', source: S.towns, paint: { 'fill-color': this.fillExpr(), 'fill-opacity': 0.82 } }, beforeId);
      map.addLayer({ id: L.townsLine, type: 'line', source: S.towns, paint: { 'line-color': p.borderStrong, 'line-opacity': 0.5, 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.3, 12, 1] } }, beforeId);
      map.addLayer({ id: L.focus, type: 'line', source: S.counties, filter: ['==', ['get', 'code'], this.county ?? ''], paint: { 'line-color': p.accent, 'line-width': 2.2 } }, beforeId);
    }
    map.addSource(S.cases, { type: 'geojson', data: this.fc });
    map.addLayer({
      id: L.heat, type: 'heatmap', source: S.cases, maxzoom: 15,
      paint: {
        'heatmap-weight': ['interpolate', ['linear'], ['get', 'n'], 0, 0, 1, 0.35, 10, 1],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 6, 0.8, 13, 2.2],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 6, 8, 10, 18, 14, 34],
        'heatmap-opacity': 0.85,
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.15, p.heat[1], 0.4, p.heat[2], 0.7, p.heat[3], 1, p.heat[4]],
      },
    }, beforeId);
    map.addLayer({
      id: L.pts, type: 'circle', source: S.cases,
      layout: { 'circle-sort-key': ['-', 0, ['get', 'n']] },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, ['+', 2.2, ['*', 1.5, ['sqrt', ['get', 'n']]]], 12, ['+', 5, ['*', 3.2, ['sqrt', ['get', 'n']]]]],
        'circle-color': ['case', ['>=', ['get', 'l'], ['get', 'i']], p.local, p.imported],
        'circle-opacity': 0.82,
        'circle-stroke-color': p.halo,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 1.4],
        'circle-stroke-opacity': 0.9,
      },
    }, beforeId);
    map.addSource(S.ns1, { type: 'geojson', data: this.ns1FC() });
    map.addLayer({
      id: L.ns1, type: 'circle', source: S.ns1,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3, 13, 7],
        'circle-color': p.halo, 'circle-stroke-color': p.accent,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 1.5, 13, 3],
      },
    }, beforeId);
    this.applyMode();
    this.applyTownState();
    if (!this.unbind.length) {
      this.unbind.push(
        this.host.interactive(L.pts, (e, hv) => this.onPick(e, hv, L.pts)),
        this.host.interactive(L.townsFill, (e, hv) => this.onPick(e, hv, L.townsFill)),
        this.host.interactive(L.ns1, (e, hv) => this.onPick(e, hv, L.ns1)),
      );
    }
  }

  uninstall(map: MLMap): void {
    for (const u of this.unbind) u();
    this.unbind = [];
    removeAll(map, [L.ns1, L.pts, L.heat, L.focus, L.townsLine, L.townsFill], [S.ns1, S.cases, S.counties, S.towns]);
    this.ctx = null;
  }

  private fillExpr(): ExpressionSpecification {
    const ch = (this.ctx?.palette ?? readPalette()).choropleth;
    const expr: unknown[] = ['step', ['coalesce', ['feature-state', 'n'], 0], 'rgba(0,0,0,0)'];
    this.breaks.forEach((b, i) => expr.push(b, ch[Math.min(ch.length - 1, i + 1)]));
    return expr as ExpressionSpecification;
  }

  private ns1FC(): GeoJSON.FeatureCollection<GeoJSON.Point> {
    if (!this.ns1 || !this.showNs1) return { type: 'FeatureCollection', features: [] };
    return {
      type: 'FeatureCollection',
      features: this.ns1.h.map((r, i) => ({ type: 'Feature', id: i, properties: { i }, geometry: { type: 'Point', coordinates: [r[3], r[4]] } })),
    };
  }

  private get map(): MLMap | null {
    return this.ctx?.map ?? null;
  }

  setCases(fc: GeoJSON.FeatureCollection<GeoJSON.Point>, towns: Map<string, number>, breaks: number[]): void {
    this.fc = fc;
    const breaksChanged = breaks.join() !== this.breaks.join();
    this.townCounts = towns;
    this.breaks = breaks;
    const m = this.map;
    if (!m) return;
    (m.getSource(S.cases) as GeoJSONSource | undefined)?.setData(fc);
    if (breaksChanged && m.getLayer(L.townsFill)) m.setPaintProperty(L.townsFill, 'fill-color', this.fillExpr());
    if (this.mode === 'towns') this.applyTownState();
  }

  private applyTownState(): void {
    const m = this.map;
    if (!m || !m.getSource(S.towns)) return;
    m.removeFeatureState({ source: S.towns });
    if (this.mode !== 'towns') return;
    for (const [code, n] of this.townCounts) m.setFeatureState({ source: S.towns, id: Number(code) }, { n });
  }

  setMode(mode: MapMode): void {
    this.mode = mode;
    this.applyMode();
    this.applyTownState();
  }

  private applyMode(): void {
    const m = this.map;
    if (!m) return;
    const vis = (id: string, on: boolean) => m.getLayer(id) && m.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    vis(L.pts, this.mode === 'points');
    vis(L.heat, this.mode === 'heat');
    vis(L.townsFill, this.mode === 'towns');
    vis(L.townsLine, this.mode === 'towns');
    vis(L.ns1, this.showNs1);
  }

  setCounty(code: string | null): void {
    this.county = code;
    if (this.map?.getLayer(L.focus)) this.map.setFilter(L.focus, ['==', ['get', 'code'], code ?? '']);
  }

  setNs1(data: NS1 | null, show: boolean): void {
    this.ns1 = data;
    this.showNs1 = show;
    (this.map?.getSource(S.ns1) as GeoJSONSource | undefined)?.setData(this.ns1FC());
    this.applyMode();
  }
}

export default async function mapView(ctx: ViewContext): Promise<View> {
  const { app, root } = ctx;
  const pnl = panel(t('map.title'), undefined, 'panel-map');
  root.append(pnl.el);
  pnl.body.append(loadingBlock());
  let destroyed = false;
  const cleanups: (() => void)[] = [];

  const manifest = await app.whenManifest();
  const [admin, host] = await Promise.all([loadAdmin().catch(() => null), app.getMapHost()]);
  if (destroyed) return { destroy() {} };
  clear(pnl.body);
  if (!manifest) {
    pnl.body.append(errorCard('manifest.json', () => location.reload(), 'manifest.json'));
    return { destroy() {} };
  }
  if (host) host.padding = pnl.padding;

  const mctx: MapCtx = { years: manifest.years, latestOnset: manifest.latestOnset, counties: new Set(admin?.counties.map((c) => c.code) ?? []) };
  let st: MapParams = normalizeMapParams(ctx.params, mctx);
  let data: CasesYear | null = null;
  let agg: CaseAggregate | null = null;

  // ------------------------------------------------------------- popups
  const fmtRange = () => t('common.dateRange', { from: fmtDate(dateFromDoy(st.year, st.from)), to: fmtDate(dateFromDoy(st.year, st.to)) });
  const townLabel = (code: string | null | undefined): string => {
    const town = code ? admin?.towns.get(code) : undefined;
    if (!town) return t('common.unknownTown');
    const county = admin?.countyByCode.get(town.county);
    return getLang() === 'en' ? `${placeName(town)}, ${placeName(county)}` : `${placeName(county)}${placeName(town)}`;
  };
  const onPick = (e: MapLayerMouseEvent, hover: boolean, layer: string) => {
    const f = e.features?.[0];
    if (!f || !host) return;
    const pr = f.properties as Record<string, unknown>;
    let content: HTMLElement;
    if (layer === L.pts) {
      const l = Number(pr.l) || 0, i = Number(pr.i) || 0;
      content = h('div', { class: 'pop' },
        h('p', { class: 'pop-title' }, townLabel(data?.pts[Number(f.id)]?.[2] ?? null)),
        h('p', { class: 'pop-sub' }, t('map.popupPoint')),
        h('dl', { class: 'pop-dl' },
          h('dt', null, t('map.popupCases')),
          h('dd', null, st.type !== 'imported' ? h('span', { class: 'pill local' }, `${t('common.local')} ${fmtNum(l)}`) : null,
            st.type !== 'local' ? h('span', { class: 'pill imported' }, `${t('common.importedShort')} ${fmtNum(i)}`) : null),
          h('dt', null, t('map.range')), h('dd', null, fmtRange())));
      const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      host.showPopup(coords, content, hover);
    } else if (layer === L.townsFill) {
      const code = String(pr.code ?? '');
      const n = agg?.byTown.get(code);
      content = h('div', { class: 'pop' }, h('p', { class: 'pop-title' }, townLabel(code)),
        h('dl', { class: 'pop-dl' }, h('dt', null, t('map.popupCases')), h('dd', null, t('common.cases', { n: fmtNum(n ? n[0] + n[1] : 0) })),
          h('dt', null, t('map.range')), h('dd', null, fmtRange())));
      host.showPopup(e.lngLat, content, hover);
    } else if (layer === L.ns1 && ns1Data) {
      const r = ns1Data.h[Number(pr.i)];
      if (!r) return;
      content = h('div', { class: 'pop' }, h('p', { class: 'pop-kicker' }, icon('hospital'), t('map.hospital')), h('p', { class: 'pop-title' }, r[0]),
        h('dl', { class: 'pop-dl' }, h('dt', null, t('map.hospitalAddr')), h('dd', null, r[1] || '—'), h('dt', null, t('map.hospitalTel')),
          h('dd', null, r[2] && /^[\d\-#() ]{6,20}$/.test(r[2]) ? h('a', { href: `tel:${r[2].replace(/[^\d#]/g, '')}` }, r[2]) : r[2] || '—')));
      host.showPopup([r[3], r[4]], content, hover);
    }
  };

  const overlay = host ? new CasesOverlay(host, admin, onPick) : null;
  let ns1Data: NS1 | null = null;

  // ------------------------------------------------------------- panel UI
  const kpiBox = h('div', { class: 'kpi-slot' }, h('div', { class: 'kpis kpis-skeleton', 'aria-hidden': 'true' }, h('div', { class: 'kpi' }), h('div', { class: 'kpi' }), h('div', { class: 'kpi' }), h('div', { class: 'kpi' })));
  const resultLine = h('p', { class: 'result-line' });
  const statusLine = h('p', { class: 'inline-status', role: 'status' });
  const warnBox = h('div', { class: 'warn-slot' });
  function renderWarnings(): void {
    clear(warnBox);
    const n = notice(casesShortfalls(manifest!.warnings, st.year, st.type).map(warningText));
    if (n) warnBox.append(n);
  }
  const legend = h('ul', { class: 'legend', 'aria-label': t('common.legend') });
  const topList = h('ol', { class: 'rank-list' });

  const yearSel = select(t('common.year'), [...manifest.years].reverse().map((y) => ({ value: String(y), label: String(y) })), String(st.year), (v) => {
    stopPlay(false);
    const y = Number(v);
    const maxDoy = maxDoyFor(y, manifest.latestOnset);
    st = { ...st, year: y, from: 1, to: maxDoy };
    renderWarnings();
    range.setMax(maxDoy);
    range.set(1, maxDoy);
    void loadYear();
  });
  const countyOpts = [{ value: '', label: t('common.allCounties') }, ...(admin?.counties ?? []).map((c) => ({ value: c.code, label: placeName(c) }))];
  const countySel = select(t('map.countyZoom'), countyOpts, st.county ?? '', (v) => {
    st = { ...st, county: v || null };
    overlay?.setCounty(st.county);
    zoomToCounty();
    commit();
  });
  const typeSeg = segmented<CaseType>(t('map.type'), [
    { value: 'local', label: t('common.local'), swatch: 'var(--local)' },
    { value: 'imported', label: t('common.importedShort'), swatch: 'var(--imported)' },
    { value: 'all', label: t('common.all') },
  ], st.type, (v) => {
    st = { ...st, type: v };
    refreshHistogram();
    commit();
  });
  const modeSeg = segmented<MapMode>(t('map.mode'), [
    { value: 'points', label: t('map.mode.points') },
    { value: 'heat', label: t('map.mode.heat') },
    { value: 'towns', label: t('map.mode.towns') },
  ], st.mode, (v) => {
    st = { ...st, mode: v };
    overlay?.setMode(v);
    renderLegend();
    commit();
  });
  const ns1Note = h('p', { class: 'hint' });
  const ns1Toggle = toggle(t('map.ns1'), st.ns1, (on) => {
    st = { ...st, ns1: on };
    void applyNs1();
    commit();
  }, 'hospital');

  const fmtShort = (doy: number) => fmtDate(dateFromDoy(st.year, doy), 'short');
  const range = dualRange({
    max: maxDoyFor(st.year, manifest.latestOnset), from: st.from, to: st.to,
    labelFrom: t('map.rangeFrom'), labelTo: t('map.rangeTo'), format: fmtShort,
    onChange: (f, to, final) => {
      if (playing) stopPlay(false);
      st = { ...st, from: f, to };
      if (final) commit();
      else renderSoon();
    },
  });

  // Play controls
  let playing = false;
  let playTimer: ReturnType<typeof setTimeout> | undefined;
  let preRange: [number, number] | null = null;
  let playEnd = 0;
  let speed: Speed = '1';
  const playBtn = h('button', { type: 'button', class: 'btn btn-primary play-btn', on: { click: () => (playing ? pausePlay() : startPlay()) } });
  const stopBtn = h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': t('map.stop'), title: t('map.stop'), disabled: true, on: { click: () => stopPlay(true) } }, icon('stop'));
  const speedSel = select(t('map.speed'), (Object.keys(SPEEDS) as Speed[]).map((s) => ({ value: s, label: `${s}×` })), speed, (v) => (speed = v), 'field-compact');
  function renderPlayBtn(): void {
    clear(playBtn);
    playBtn.append(icon(playing ? 'pause' : 'play'), h('span', null, playing ? t('map.pause') : t('map.playShort')));
    playBtn.setAttribute('aria-label', playing ? t('map.pause') : t('map.play'));
    playBtn.title = playing ? t('map.pause') : t('map.playHint');
    playBtn.setAttribute('aria-pressed', String(playing));
    stopBtn.toggleAttribute('disabled', !preRange);
  }
  function startPlay(): void {
    const maxDoy = maxDoyFor(st.year, manifest!.latestOnset);
    if (!preRange) {
      preRange = [st.from, st.to];
      let a = st.from, b = st.to;
      if (b - a + 1 <= WINDOW) [a, b] = [1, maxDoy];
      playEnd = b;
      st = { ...st, from: a, to: Math.min(b, a + WINDOW - 1) };
    } else if (st.to >= playEnd) {
      // finished: restart from the beginning of the original range
      const a = preRange[1] - preRange[0] + 1 <= WINDOW ? 1 : preRange[0];
      st = { ...st, from: a, to: Math.min(playEnd, a + WINDOW - 1) };
    }
    playing = true;
    renderPlayBtn();
    tick();
  }
  function tick(): void {
    range.set(st.from, st.to);
    renderSoon();
    if (st.to >= playEnd) {
      playing = false;
      renderPlayBtn();
      commit();
      return;
    }
    playTimer = setTimeout(() => {
      if (!playing) return;
      st = { ...st, from: st.from + 1, to: st.to + 1 };
      tick();
    }, SPEEDS[speed]);
  }
  function pausePlay(): void {
    playing = false;
    clearTimeout(playTimer);
    renderPlayBtn();
    commit();
  }
  function stopPlay(restore: boolean): void {
    clearTimeout(playTimer);
    const wasActive = playing || preRange;
    playing = false;
    if (restore && preRange) {
      st = { ...st, from: preRange[0], to: preRange[1] };
      range.set(st.from, st.to);
    }
    preRange = null;
    renderPlayBtn();
    if (wasActive && restore) commit();
  }
  renderPlayBtn();

  pnl.body.append(
    kpiBox,
    section(null, h('div', { class: 'field-row' }, yearSel, countySel), typeSeg),
    section(t('map.range'), range.el, h('div', { class: 'play-row' }, playBtn, stopBtn, speedSel), statusLine, warnBox),
    section(null, modeSeg, ns1Toggle, ns1Note),
    section(t('common.legend'), legend, resultLine),
    section(t('map.topTowns'), topList),
    h('p', { class: 'privacy-note' }, icon('pin'), t('map.privacy')),
  );

  // ------------------------------------------------------------- KPIs
  loadData('summary.json', validateSummary).then((s) => !destroyed && renderKpis(s), (e: unknown) => {
    if (destroyed) return;
    clear(kpiBox);
    kpiBox.append(errorCard('', undefined, e instanceof DataError ? e.file : 'summary.json'));
  });
  function renderKpis(s: Summary): void {
    const delta = (cur: number, prev: number): KpiSpec['trend'] => (cur > prev ? 'up' : cur < prev ? 'down' : 'flat');
    const ago = dayDiff(s.latestOnset, s.asOf);
    const prevBad = (type: 'local' | 'imported') => casesShortfalls(manifest!.warnings, s.year - 1, type).length > 0;
    const cmp = (type: 'local' | 'imported'): Pick<KpiSpec, 'sub' | 'trend' | 'note'> => prevBad(type)
      ? { sub: t('kpi.vsPrevNA'), note: t('warn.prevIncomplete') }
      : { sub: t('kpi.vsPrev', { n: fmtNum(s.prevYtd[type]) }), trend: delta(s.ytd[type], s.prevYtd[type]) };
    clear(kpiBox);
    kpiBox.append(kpis([
      { label: t('kpi.ytdLocal', { year: s.year }), value: fmtNum(s.ytd.local), tone: 'local', ...cmp('local') },
      { label: t('kpi.ytdImported', { year: s.year }), value: fmtNum(s.ytd.imported), tone: 'imported', ...cmp('imported') },
      { label: t('kpi.last14'), value: fmtNum(s.last14.local + s.last14.imported), sub: t('kpi.last14Detail', { l: fmtNum(s.last14.local), i: fmtNum(s.last14.imported) }) },
      { label: t('kpi.latestOnset'), value: fmtDate(s.latestOnset, 'short'), sub: ago <= 0 ? t('kpi.today') : t('kpi.daysAgo', { n: ago }) },
    ]));
  }

  // ------------------------------------------------------------- data + render
  function renderLegend(): void {
    clear(legend);
    const p = readPalette();
    if (st.mode === 'points') {
      if (st.type !== 'imported') legend.append(legendItem(p.local, t('map.legendLocal')));
      if (st.type !== 'local') legend.append(legendItem(p.imported, t('map.legendImported')));
      legend.append(h('li', { class: 'legend-item legend-note' }, h('span', { class: 'lg-sizes', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), t('map.legendSize')));
    } else if (st.mode === 'heat') {
      legend.append(h('li', { class: 'legend-item legend-ramp' }, h('span', { class: 'ramp ramp-heat', 'aria-hidden': 'true' }), h('span', null, t('map.legendHeat'))));
    } else {
      const br = overlay?.breaks ?? [1];
      legend.append(h('li', { class: 'legend-item legend-title' }, t('map.legendTowns')));
      br.forEach((b, i) => {
        const next = br[i + 1];
        const label = next ? (next - 1 > b ? `${fmtNum(b)}–${fmtNum(next - 1)}` : fmtNum(b)) : `≥ ${fmtNum(b)}`;
        legend.append(legendItem(p.choropleth[Math.min(5, i + 1)], label, 'square'));
      });
    }
    if (st.ns1) legend.append(h('li', { class: 'legend-item' }, h('span', { class: 'lg-ring', 'aria-hidden': 'true' }), t('map.hospital')));
  }

  function summaryText(): string {
    if (!agg) return '';
    const n = st.type === 'local' ? agg.total.local : st.type === 'imported' ? agg.total.imported : agg.total.local + agg.total.imported;
    const typeLabel = st.type === 'local' ? t('common.local') : st.type === 'imported' ? t('common.imported') : t('common.all');
    const vars = { range: fmtRange(), type: getLang() === 'en' && st.type === 'all' ? '' : typeLabel.toLowerCase(), n: fmtNum(n), towns: fmtNum(agg.byTown.size) };
    const county = st.county ? admin?.countyByCode.get(st.county) : undefined;
    return (county ? t('map.summaryCounty', { ...vars, county: placeName(county) }) : t('map.summary', vars)).replace(/\s{2,}/g, ' ');
  }

  function render(): void {
    if (!data || destroyed) return;
    agg = aggregateCases(data, { from: st.from, to: st.to, type: st.type, county: st.county });
    const pts = data.pts;
    const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
    for (const [idx, [l, i]] of agg.byPt) {
      const p = pts[idx]!;
      features.push({ type: 'Feature', id: idx, properties: { l, i, n: l + i }, geometry: { type: 'Point', coordinates: [p[0], p[1]] } });
    }
    const towns = new Map<string, number>();
    let max = 0;
    for (const [code, [l, i]] of agg.byTown) {
      towns.set(code, l + i);
      max = Math.max(max, l + i);
    }
    const breaks = niceBreaks(max);
    overlay?.setCases({ type: 'FeatureCollection', features }, towns, breaks);
    if (st.mode === 'towns') renderLegend();
    const text = summaryText();
    resultLine.textContent = features.length ? text : `${text} ${t('map.noCases')}`;
    app.mapSummary(text);
    renderTop();
  }
  const renderSoon = rafThrottle(render);

  function renderTop(): void {
    clear(topList);
    if (!agg) return;
    const top = topEntries(agg.byTown, 8);
    if (!top.length) {
      topList.append(h('li', { class: 'empty' }, t('map.noCases')));
      return;
    }
    const max = top[0]![1] + top[0]![2];
    for (const [code, l, i] of top) {
      const town = admin?.towns.get(code);
      const btn = h('button', { type: 'button', class: 'rank-btn', on: { click: () => town?.bbox && host?.fit(town.bbox, 13) } },
        h('span', { class: 'rank-name' }, townLabel(code)),
        h('span', { class: 'rank-bar', style: { '--w': `${Math.max(4, ((l + i) / max) * 100)}%` }, 'aria-hidden': 'true' },
          h('i', { class: 'bar-local', style: { '--w': `${l + i ? (l / (l + i)) * 100 : 0}%` } })),
        h('span', { class: 'rank-val' }, fmtNum(l + i)));
      topList.append(h('li', null, btn));
    }
  }

  function commit(): void {
    renderSoon();
    app.setParams(serializeMapParams(st, mctx));
    setTimeout(() => !destroyed && app.announce(summaryText()), 50);
  }

  function refreshHistogram(): void {
    renderWarnings();
    range.el.dataset.type = st.type;
    range.setHistogram(data ? dailyCounts(data, maxDoyFor(st.year, manifest!.latestOnset), st.type) : null);
  }

  async function loadYear(): Promise<void> {
    const year = st.year;
    statusLine.textContent = t('map.loadingYear', { year });
    statusLine.classList.add('busy');
    try {
      const d = await loadData(`cases/${year}.json`, (v) => validateCases(v, year));
      if (destroyed || year !== st.year) return;
      data = d;
      statusLine.textContent = '';
      statusLine.classList.remove('busy');
      refreshHistogram();
      commit();
    } catch (e) {
      if (destroyed || year !== st.year) return;
      statusLine.classList.remove('busy');
      clear(statusLine);
      statusLine.append(errorCard('', () => void loadYear(), e instanceof DataError ? e.file : `cases/${year}.json`));
    }
  }

  async function applyNs1(): Promise<void> {
    ns1Note.textContent = '';
    if (st.ns1 && !ns1Data) {
      try {
        ns1Data = await loadData('ns1.json', validateNS1);
      } catch (e) {
        if (destroyed) return;
        ns1Note.append(errorCard('', () => void applyNs1(), e instanceof DataError ? e.file : 'ns1.json'));
        return;
      }
    }
    if (destroyed) return;
    if (st.ns1 && ns1Data?.sourceDate) ns1Note.textContent = t('map.ns1Note', { date: fmtDate(ns1Data.sourceDate) });
    overlay?.setNs1(ns1Data, st.ns1);
    renderLegend();
  }

  function zoomToCounty(): void {
    if (!host) return;
    const c = st.county ? admin?.countyByCode.get(st.county) : null;
    host.fit(c?.bbox ?? TAIWAN_BOUNDS, c ? 11 : 8);
  }

  // ------------------------------------------------------------- go
  renderLegend();
  if (overlay && host) {
    overlay.mode = st.mode;
    overlay.county = st.county;
    host.setOverlay(overlay);
    zoomToCounty();
  }
  if (st.ns1) void applyNs1();
  await loadYear();

  return {
    destroy() {
      destroyed = true;
      clearTimeout(playTimer);
      for (const c of cleanups) c();
      app.mapSummary('');
    },
  };
}
