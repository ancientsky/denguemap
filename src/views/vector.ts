// #/vector — 蚊媒地圖: village mosquito-risk polygons (point fallback), week + county filters,
// 5-week popup, danger-village table with triggering indicators, client-side CSV, risk definitions,
// survey coverage, and an optional "recent cases" overlay (last 30 days, recency colours).
import type { Map as MLMap, GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import { errorCard } from '../app';
import { fmtDate, fmtNum, fmtPct, getLang, placeName, t, type MessageKey } from '../i18n';
import { loadAdmin, type Admin } from '../lib/admin';
import { aggregateCases } from '../lib/aggregate';
import { csvBlob, downloadBlob } from '../lib/csv';
import { DataError, loadData } from '../lib/data';
import { addDays, dayOfYear, recencyRef } from '../lib/dates';
import { clear, h } from '../lib/dom';
import { TAIWAN_BOUNDS, type BBox } from '../lib/geo';
import { icon } from '../lib/icons';
import { normalizeVectorParams, serializeVectorParams, type VectorParams } from '../lib/params';
import type { VectorVillage } from '../lib/types';
import { validateCases } from '../lib/validate';
import { isUnavailable } from '../lib/warnings';
import { removeAll, type MapHost, type Overlay, type OverlayCtx } from '../map/host';
import { caseFeatures, casePaint, casePopup, caseSortKey, recencyLegend } from './caseLayer';
import type { View, ViewContext } from './types';
import { loadingBlock, panel, section, select, toggle, unavailableState } from './ui';
import { addVectorLayers, countyOf, loadVectorBundle, RISK_KEYS, triggerText, vectorFC, villageLabel, villagePopup, weekOf, type VectorBundle } from './vectorData';

const L = { fill: 'dm-v-fill', line: 'dm-v-line', ptsAll: 'dm-v-pts', ptsNp: 'dm-v-pts-np', cases: 'dm-v-cases' };
const S = { poly: 'dm-v-poly', pts: 'dm-v-pts', cases: 'dm-v-cases' };
const DEF_KEYS: MessageKey[] = ['vector.def0', 'vector.def1', 'vector.def2', 'vector.def3'];
const RECENT_DAYS = 30;

class VectorOverlay implements Overlay {
  polys: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  pts: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  cases: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  private unbind: (() => void)[] = [];
  private map: MLMap | null = null;
  constructor(private host: MapHost, private onPick: (e: MapLayerMouseEvent, hover: boolean, layer: string) => void) {}
  install({ map, palette: p }: OverlayCtx): void {
    this.map = map;
    map.addSource(S.poly, { type: 'geojson', data: this.polys });
    map.addSource(S.pts, { type: 'geojson', data: this.pts });
    map.addSource(S.cases, { type: 'geojson', data: this.cases });
    addVectorLayers(map, p, { ...L, poly: S.poly, pts: S.pts }, { fillOpacity: 0.6, minzoom: 9 });
    map.addLayer({ id: L.cases, type: 'circle', source: S.cases, layout: { 'circle-sort-key': caseSortKey('recency') }, paint: casePaint(p, 'recency') });
    if (!this.unbind.length) {
      for (const id of [L.fill, L.ptsAll, L.ptsNp, L.cases]) this.unbind.push(this.host.interactive(id, (e, hv) => this.onPick(e, hv, id)));
    }
  }
  uninstall(map: MLMap): void {
    for (const u of this.unbind) u();
    this.unbind = [];
    removeAll(map, [L.cases, L.ptsNp, L.ptsAll, L.line, L.fill], [S.cases, S.pts, S.poly]);
    this.map = null;
  }
  setData(polys: GeoJSON.FeatureCollection, pts: GeoJSON.FeatureCollection): void {
    this.polys = polys;
    this.pts = pts;
    (this.map?.getSource(S.poly) as GeoJSONSource | undefined)?.setData(polys);
    (this.map?.getSource(S.pts) as GeoJSONSource | undefined)?.setData(pts);
  }
  setCases(fc: GeoJSON.FeatureCollection): void {
    this.cases = fc;
    (this.map?.getSource(S.cases) as GeoJSONSource | undefined)?.setData(fc);
  }
}

export default async function vectorView(ctx: ViewContext): Promise<View> {
  const { app, root } = ctx;
  const pnl = panel(t('vector.title'), t('vector.intro'), 'panel-vector');
  root.append(pnl.el);
  pnl.body.append(loadingBlock());
  let destroyed = false;

  const [host, admin, bRes] = await Promise.all([
    app.getMapHost(),
    loadAdmin().catch(() => null as Admin | null),
    loadVectorBundle().then((b) => ({ ok: true as const, b }), (e: unknown) => ({ ok: false as const, e })),
  ]);
  if (destroyed) return { destroy() {} };
  clear(pnl.body);
  if (host) host.padding = pnl.padding;
  if (isUnavailable(app.getManifestNow(), 'vector')) {
    pnl.body.append(unavailableState());
    return { destroy() {} };
  }
  if (!bRes.ok) {
    pnl.body.append(errorCard('', () => location.reload(), bRes.e instanceof DataError ? bRes.e.file : 'vector.json'));
    return { destroy() {} };
  }
  const bundle: VectorBundle = bRes.b;
  const data = bundle.data;
  const countyCodes = new Set<string>();
  for (const v of data.villages) {
    const c = countyOf(admin, v);
    if (c) countyCodes.add(c.code);
  }
  let st: VectorParams = normalizeVectorParams(ctx.params, data.weeks.length, countyCodes);
  let showCases = ctx.params.cases === '1';
  const counties = (admin?.counties ?? []).filter((c) => countyCodes.has(c.code));
  const weekLabel = (i: number) => {
    const w = data.weeks[i]!;
    return t('vector.weekOption', { from: fmtDate(w[0], 'short'), to: fmtDate(w[1], 'short') }) + (i === 0 ? t('vector.weekLatest') : '');
  };
  const keep = (v: VectorVillage) => !st.county || countyOf(admin, v)?.code === st.county;
  const townLabel = (code: string | null | undefined): string => {
    const town = code ? admin?.towns.get(code) : undefined;
    if (!town) return t('common.unknownTown');
    const county = admin?.countyByCode.get(town.county);
    return getLang() === 'en' ? `${placeName(town)}, ${placeName(county)}` : `${placeName(county)}${placeName(town)}`;
  };

  // ---------------- popups
  let caseTowns = new Map<number, string | null>();
  const onPick = (e: MapLayerMouseEvent, hover: boolean, layer: string) => {
    const f = e.features?.[0];
    if (!f || !host) return;
    if (layer === L.cases) {
      const pr = f.properties as Record<string, unknown>;
      host.showPopup(e.lngLat, casePopup({ title: townLabel(caseTowns.get(Number(f.id))), showLocal: true, showImported: true, rangeText: null, props: pr }), hover);
      return;
    }
    const v = data.villages[Number(f.properties?.k)];
    if (!v) return;
    host.showPopup(e.lngLat, villagePopup(bundle, admin, v, st.week, !!(v[5] && bundle.polyByCode.has(v[5]))), hover);
  };
  const overlay = host ? new VectorOverlay(host, onPick) : null;

  // ---------------- panel
  const weekSel = select(t('vector.week'), data.weeks.map((_, i) => ({ value: String(i), label: weekLabel(i) })), String(st.week), (v) => {
    st = { ...st, week: Number(v) };
    update();
  });
  const countySel = select(t('common.county'), [{ value: '', label: t('common.all') }, ...counties.map((c) => ({ value: c.code, label: placeName(c) }))], st.county ?? '', (v) => {
    st = { ...st, county: v || null };
    update();
    zoom();
  });
  const caseNote = h('div', { class: 'case-note' });
  const caseToggle = toggle(t('vector.showCases'), showCases, (on) => {
    showCases = on;
    void applyCases();
    persist();
  });
  const defs = h('ul', { class: 'def-list' });
  const dangerBox = h('div');
  const csvBtn = h('button', { type: 'button', class: 'btn', on: { click: () => downloadCsv() } }, icon('download'), t('common.download'));
  const coverage = h('ul', { class: 'cov-list' });
  for (const c of counties) {
    const s = data.surveyed[c.code];
    if (!s) continue;
    coverage.append(h('li', { class: 'cov-row' }, h('span', null, placeName(c)),
      h('span', { class: 'cov-bar', role: 'img', 'aria-label': fmtPct(s.villages / s.total) }, h('i', { style: { '--w': `${Math.min(100, (s.villages / s.total) * 100)}%` } })),
      h('span', { class: 'cov-val' }, t('vector.coverageRow', { n: fmtNum(s.villages), total: fmtNum(s.total) }))));
  }
  pnl.body.append(
    h('p', { class: 'hint' }, t('vector.updated', { date: fmtDate(data.updated) })),
    section(null, h('div', { class: 'field-row field-row-even' }, weekSel, countySel), caseToggle, caseNote),
    section(t('common.legend'), defs),
    section(null, dangerBox, h('div', null, csvBtn)),
    section(t('vector.coverage'), coverage),
  );

  function persist(): void {
    app.setParams({ ...serializeVectorParams(st), ...(showCases ? { cases: '1' } : {}) });
  }

  function update(): void {
    const { polys, pts, counts } = vectorFC(bundle, st.week, keep);
    overlay?.setData(polys, pts);
    clear(defs);
    for (const r of [3, 2, 1, 0]) {
      defs.append(h('li', { class: 'def-item' }, h('span', { class: 'lg-square', style: { '--sw': `var(--risk-${r})` }, 'aria-hidden': 'true' }),
        h('span', null, h('span', { class: 'def-name' }, t(RISK_KEYS[r]!)), h('span', { class: 'def-count' }, fmtNum(counts[r]!))),
        h('span', { class: 'def-text' }, t(DEF_KEYS[r]!))));
    }
    const danger = data.villages.filter((v) => keep(v) && weekOf(v, st.week)[0] === 3);
    clear(dangerBox);
    dangerBox.append(h('h2', { class: 'psec-title' }, t('vector.dangerList', { n: fmtNum(danger.length) })));
    if (!danger.length) dangerBox.append(h('p', { class: 'hint' }, t('vector.dangerEmpty')));
    else {
      dangerBox.append(h('div', { class: 'table-scroll table-box', tabindex: '0', role: 'region', 'aria-label': t('vector.dangerList', { n: danger.length }) },
        h('table', { class: 'data-table' },
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('vector.village')), h('th', { scope: 'col' }, t('vector.triggered')))),
          h('tbody', null, ...danger.map((v) => h('tr', null, h('th', { scope: 'row', class: 'wrap' }, villageLabel(admin, v)), h('td', { class: 'wrap' }, triggerText(weekOf(v, st.week)))))))));
    }
    const countyName = st.county ? placeName(admin?.countyByCode.get(st.county)) : t('common.allCounties');
    const msg = `${countyName} ${weekLabel(st.week)}: ${t('vector.counts', { r3: counts[3]!, r2: counts[2]!, r1: counts[1]! })}`;
    app.mapSummary(msg);
    app.announce(msg);
    persist();
  }

  async function applyCases(): Promise<void> {
    clear(caseNote);
    if (!showCases) {
      overlay?.setCases({ type: 'FeatureCollection', features: [] });
      return;
    }
    const m = app.getManifestNow();
    if (!m) return;
    const ref = m.latestOnset;
    const start = addDays(ref, -RECENT_DAYS);
    const colourRef = recencyRef(ref, ref);
    const years = [...new Set([+start.slice(0, 4), +ref.slice(0, 4)])].filter((y) => m.years.includes(y));
    caseNote.append(h('p', { class: 'inline-status busy', role: 'status' }, t('app.loading')));
    try {
      const files = await Promise.all(years.map((y) => loadData(`cases/${y}.json`, (v) => validateCases(v, y))));
      if (destroyed || !showCases) return;
      const feats: GeoJSON.Feature[] = [];
      caseTowns = new Map();
      let total = 0;
      for (const f of files) {
        const from = f.year === +start.slice(0, 4) ? dayOfYear(start) : 1;
        const to = f.year === +ref.slice(0, 4) ? dayOfYear(ref) : 366;
        const agg = aggregateCases(f, { from, to, type: 'all', county: null });
        const base = f.year * 100_000;
        for (const ft of caseFeatures(f, agg, colourRef, base)) {
          feats.push(ft);
          caseTowns.set(Number(ft.id), f.pts[Number(ft.id) - base]?.[2] ?? null);
        }
        total += agg.total.local + agg.total.imported;
      }
      overlay?.setCases({ type: 'FeatureCollection', features: feats });
      clear(caseNote);
      caseNote.append(
        h('p', { class: 'hint' }, t('vector.casesNote', { n: fmtNum(total), from: fmtDate(start, 'short'), to: fmtDate(ref, 'short') })),
        h('ul', { class: 'legend' }, ...recencyLegend(true).slice(0, 3), ...recencyLegend(true).slice(4)));
    } catch (e) {
      if (destroyed) return;
      clear(caseNote);
      caseNote.append(errorCard('', () => void applyCases(), e instanceof DataError ? e.file : 'cases'));
    }
  }

  function zoom(): void {
    if (!host) return;
    const b = st.county ? admin?.countyByCode.get(st.county)?.bbox : null;
    if (b) return host.fit(b, 11);
    let bb: BBox | null = null;
    for (const v of data.villages) bb = bb ? [Math.min(bb[0], v[3]), Math.min(bb[1], v[4]), Math.max(bb[2], v[3]), Math.max(bb[3], v[4])] : [v[3], v[4], v[3], v[4]];
    host.fit(bb ?? TAIWAN_BOUNDS, 10);
  }

  function downloadCsv(): void {
    const w = data.weeks[st.week]!;
    const head = getLang() === 'en'
      ? ['County', 'Township', 'Village', 'Village code', 'Risk', 'Breteau level', 'Ovitrap positivity (%)', 'Gravitrap positivity (%)', 'Week start', 'Week end']
      : ['縣市', '鄉鎮市區', '村里', '村里代碼', '風險等級', '布氏級數', '誘卵桶陽性率(%)', '誘殺桶陽性率(%)', '週起日', '週迄日'];
    const rows = data.villages.filter(keep)
      .map((v) => [v, weekOf(v, st.week)] as const)
      .sort((a, b) => b[1][0] - a[1][0])
      .map(([v, [r, bi, ovi, gra]]) => [v[0], v[1], v[2], v[5] ?? '', t(RISK_KEYS[r]!), bi ?? '', ovi ?? '', gra ?? '', w[0], w[1]]);
    const county = st.county ? `-${admin?.countyByCode.get(st.county)?.[getLang() === 'en' ? 'en' : 'zh'] ?? st.county}` : '';
    downloadBlob(csvBlob([head, ...rows]), `${t('vector.csvName')}${county}-${w[0]}.csv`.replace(/[\\/:*?"<>|\s]+/g, '_'));
  }

  if (overlay && host) {
    host.setOverlay(overlay);
    zoom();
  }
  update();
  if (showCases) void applyCases();

  return {
    destroy() {
      destroyed = true;
      app.mapSummary('');
    },
  };
}
