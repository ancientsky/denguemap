// #/vector — 蚊媒地圖: village mosquito-risk polygons (point fallback), week + county filters,
// danger-village table, client-side CSV, exact risk definitions and survey coverage.
import type { Map as MLMap, GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import { feature } from 'topojson-client';
import type { GeometryCollection } from 'topojson-specification';
import { errorCard } from '../app';
import { fmtDate, fmtNum, fmtPct, getLang, placeName, t, type MessageKey } from '../i18n';
import { loadAdmin, type Admin, type Place } from '../lib/admin';
import { csvBlob, downloadBlob } from '../lib/csv';
import { DataError, loadData } from '../lib/data';
import { clear, h } from '../lib/dom';
import { TAIWAN_BOUNDS, type BBox } from '../lib/geo';
import { icon } from '../lib/icons';
import { normalizeVectorParams, serializeVectorParams, type VectorParams } from '../lib/params';
import type { Vector, VectorVillage, VectorWeek } from '../lib/types';
import { validateTopology, validateVector } from '../lib/validate';
import { removeAll, type MapHost, type Overlay, type OverlayCtx } from '../map/host';
import type { View, ViewContext } from './types';
import { loadingBlock, panel, section, select, unavailableState } from './ui';
import { isUnavailable } from '../lib/warnings';

const L = { fill: 'dm-v-fill', line: 'dm-v-line', ptsAll: 'dm-v-pts', ptsNp: 'dm-v-pts-np' };
const S = { poly: 'dm-v-poly', pts: 'dm-v-pts' };
const RISK_KEYS: MessageKey[] = ['vector.risk0', 'vector.risk1', 'vector.risk2', 'vector.risk3'];
const DEF_KEYS: MessageKey[] = ['vector.def0', 'vector.def1', 'vector.def2', 'vector.def3'];

type PolyFC = GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, { code: string }>;

class VectorOverlay implements Overlay {
  polys: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  pts: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  private unbind: (() => void)[] = [];
  private map: MLMap | null = null;
  constructor(private host: MapHost, private onPick: (e: MapLayerMouseEvent, hover: boolean) => void) {}
  install({ map, palette: p, beforeId }: OverlayCtx): void {
    this.map = map;
    const color: ExpressionSpecification = ['match', ['get', 'r'], 3, p.risk[3], 2, p.risk[2], 1, p.risk[1], p.risk[0]];
    map.addSource(S.poly, { type: 'geojson', data: this.polys });
    map.addSource(S.pts, { type: 'geojson', data: this.pts });
    map.addLayer({ id: L.fill, type: 'fill', source: S.poly, minzoom: 9, layout: { 'fill-sort-key': ['get', 'r'] }, paint: { 'fill-color': color, 'fill-opacity': 0.72 } }, beforeId);
    map.addLayer({ id: L.line, type: 'line', source: S.poly, minzoom: 9, paint: { 'line-color': p.halo, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.4, 14, 1.4], 'line-opacity': 0.8 } }, beforeId);
    const circle = (id: string, filter: boolean, minzoom: number, maxzoom: number) =>
      map.addLayer({
        id, type: 'circle', source: S.pts, minzoom, maxzoom,
        ...(filter ? { filter: ['==', ['get', 'np'], 1] as ExpressionSpecification } : {}),
        layout: { 'circle-sort-key': ['get', 'r'] },
        paint: {
          'circle-color': color, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, ['+', 2.2, ['*', 0.7, ['get', 'r']]], 12, ['+', 5, ['get', 'r']]],
          'circle-stroke-color': p.halo, 'circle-stroke-width': 1, 'circle-opacity': 0.95,
        },
      }, beforeId);
    circle(L.ptsAll, false, 0, 9.5);
    circle(L.ptsNp, true, 9.5, 24);
    if (!this.unbind.length) {
      this.unbind.push(
        this.host.interactive(L.fill, (e, hv) => this.onPick(e, hv)),
        this.host.interactive(L.ptsAll, (e, hv) => this.onPick(e, hv)),
        this.host.interactive(L.ptsNp, (e, hv) => this.onPick(e, hv)),
      );
    }
  }
  uninstall(map: MLMap): void {
    for (const u of this.unbind) u();
    this.unbind = [];
    removeAll(map, [L.ptsNp, L.ptsAll, L.line, L.fill], [S.pts, S.poly]);
    this.map = null;
  }
  setData(polys: GeoJSON.FeatureCollection, pts: GeoJSON.FeatureCollection): void {
    this.polys = polys;
    this.pts = pts;
    (this.map?.getSource(S.poly) as GeoJSONSource | undefined)?.setData(polys);
    (this.map?.getSource(S.pts) as GeoJSONSource | undefined)?.setData(pts);
  }
}

const pct = (v: number | null) => (v == null ? '—' : fmtPct(v / 100));
const lvl = (v: number | null) => (v == null ? '—' : t('vector.levelN', { n: v }));

export default async function vectorView(ctx: ViewContext): Promise<View> {
  const { app, root } = ctx;
  const pnl = panel(t('vector.title'), t('vector.intro'), 'panel-vector');
  root.append(pnl.el);
  pnl.body.append(loadingBlock());
  let destroyed = false;

  const [host, admin, vRes, pRes] = await Promise.all([
    app.getMapHost(),
    loadAdmin().catch(() => null as Admin | null),
    loadData('vector.json', validateVector).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })),
    loadData('geo/vector-villages.topo.json', (v) => validateTopology(v, 'geo/vector-villages.topo.json', ['villages'])).catch(() => null),
  ]);
  if (destroyed) return { destroy() {} };
  clear(pnl.body);
  if (host) host.padding = pnl.padding;
  if (isUnavailable(app.getManifestNow(), 'vector')) {
    pnl.body.append(unavailableState());
    return { destroy() {} };
  }
  if (!vRes.ok) {
    pnl.body.append(errorCard('', () => location.reload(), vRes.e instanceof DataError ? vRes.e.file : 'vector.json'));
    return { destroy() {} };
  }
  const data: Vector = vRes.v;

  // village code → polygon
  const polyByCode = new Map<string, PolyFC['features'][number]>();
  if (pRes) {
    const fc = feature(pRes, pRes.objects.villages as GeometryCollection<{ code: string }>) as unknown as PolyFC;
    for (const f of fc.features) if (f.geometry && typeof f.properties?.code === 'string') polyByCode.set(f.properties.code, f);
  }
  // county code for each village (villCode prefix, else via county name)
  const countyOf = (v: VectorVillage): Place | undefined =>
    (v[5] ? admin?.countyByCode.get(v[5].slice(0, 5)) : undefined) ?? admin?.countyByZh.get(v[0]);
  const countyCodes = new Set<string>();
  for (const v of data.villages) {
    const c = countyOf(v);
    if (c) countyCodes.add(c.code);
  }
  let st: VectorParams = normalizeVectorParams(ctx.params, data.weeks.length, countyCodes);
  const counties = (admin?.counties ?? []).filter((c) => countyCodes.has(c.code));

  const villageLabel = (v: VectorVillage): string => {
    if (getLang() !== 'en' || !admin) return `${v[0]}${v[1]}${v[2]}`;
    const c = countyOf(v);
    const town = c ? [...admin.towns.values()].find((x) => x.county === c.code && x.zh === v[1]) : undefined;
    return `${v[2]}, ${town?.en ?? v[1]}, ${c?.en ?? v[0]}`;
  };
  const weekLabel = (i: number) => {
    const w = data.weeks[i]!;
    return t('vector.weekOption', { from: fmtDate(w[0], 'short'), to: fmtDate(w[1], 'short') }) + (i === 0 ? t('vector.weekLatest') : '');
  };
  const filtered = () => data.villages.map((v, k) => [v, k] as const).filter(([v]) => !st.county || countyOf(v)?.code === st.county);
  const wk = (v: VectorVillage): VectorWeek => v[7][st.week] ?? [0, null, null, null];

  // ---------------- popups
  const onPick = (e: MapLayerMouseEvent, hover: boolean) => {
    const f = e.features?.[0];
    const v = f ? data.villages[Number(f.properties?.k)] : undefined;
    if (!v || !host) return;
    const [r, bi, ovi, gra] = wk(v);
    host.showPopup(e.lngLat, h('div', { class: 'pop' },
      h('p', { class: 'pop-title' }, villageLabel(v)),
      h('p', null, h('span', { class: 'pill risk', style: { '--sw': `var(--risk-${r})` } }, t(RISK_KEYS[r]!))),
      h('dl', { class: 'pop-dl' },
        h('dt', null, t('vector.week')), h('dd', null, weekLabel(st.week)),
        h('dt', null, t('vector.breteau')), h('dd', null, lvl(bi)),
        h('dt', null, t('vector.ovitrap')), h('dd', null, pct(ovi)),
        h('dt', null, t('vector.gravitrap')), h('dd', null, pct(gra))),
      v[5] && polyByCode.has(v[5]) ? null : h('p', { class: 'pop-sub' }, t('vector.noPolygon').trim())), hover);
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
    section(null, h('div', { class: 'field-row field-row-even' }, weekSel, countySel)),
    section(t('common.legend'), defs),
    section(null, dangerBox, h('div', null, csvBtn)),
    section(t('vector.coverage'), coverage),
  );

  function update(): void {
    const rows = filtered();
    const counts = [0, 0, 0, 0];
    const polys: GeoJSON.Feature[] = [];
    const pts: GeoJSON.Feature[] = [];
    for (const [v, k] of rows) {
      const r = wk(v)[0];
      counts[r]!++;
      const poly = v[5] ? polyByCode.get(v[5]) : undefined;
      if (poly) polys.push({ type: 'Feature', id: k, properties: { k, r }, geometry: poly.geometry });
      pts.push({ type: 'Feature', id: k, properties: { k, r, np: poly ? 0 : 1 }, geometry: { type: 'Point', coordinates: [v[3], v[4]] } });
    }
    overlay?.setData({ type: 'FeatureCollection', features: polys }, { type: 'FeatureCollection', features: pts });

    clear(defs);
    for (const r of [3, 2, 1, 0]) {
      defs.append(h('li', { class: 'def-item' }, h('span', { class: 'lg-square', style: { '--sw': `var(--risk-${r})` }, 'aria-hidden': 'true' }),
        h('span', null, h('span', { class: 'def-name' }, t(RISK_KEYS[r]!)), h('span', { class: 'def-count' }, fmtNum(counts[r]!))),
        h('span', { class: 'def-text' }, t(DEF_KEYS[r]!))));
    }

    const danger = rows.filter(([v]) => wk(v)[0] === 3).map(([v]) => v);
    clear(dangerBox);
    dangerBox.append(h('h2', { class: 'psec-title' }, t('vector.dangerList', { n: fmtNum(danger.length) })));
    if (!danger.length) dangerBox.append(h('p', { class: 'hint' }, t('vector.dangerEmpty')));
    else {
      dangerBox.append(h('div', { class: 'table-scroll table-box', tabindex: '0', role: 'region', 'aria-label': t('vector.dangerList', { n: danger.length }) },
        h('table', { class: 'data-table' },
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('vector.village')), h('th', { scope: 'col' }, t('vector.indicators')))),
          h('tbody', null, ...danger.map((v) => {
            const [, bi, ovi, gra] = wk(v);
            const parts = [bi != null ? `${t('vector.biShort')} ${bi}` : '', ovi != null ? `${t('vector.oviShort')} ${pct(ovi)}` : '', gra != null ? `${t('vector.graShort')} ${pct(gra)}` : ''].filter(Boolean);
            return h('tr', null, h('th', { scope: 'row', class: 'wrap' }, villageLabel(v)), h('td', { class: 'wrap' }, parts.join(' · ') || '—'));
          })))));
    }
    const countyName = st.county ? placeName(admin?.countyByCode.get(st.county)) : t('common.allCounties');
    const msg = `${countyName} ${weekLabel(st.week)}: ${t('vector.counts', { r3: counts[3]!, r2: counts[2]!, r1: counts[1]! })}`;
    app.mapSummary(msg);
    app.announce(msg);
    app.setParams(serializeVectorParams(st));
  }

  function zoom(): void {
    if (!host) return;
    const b = st.county ? admin?.countyByCode.get(st.county)?.bbox : null;
    if (b) return host.fit(b, 11);
    // all surveyed villages
    let bb: BBox | null = null;
    for (const v of data.villages) bb = bb ? [Math.min(bb[0], v[3]), Math.min(bb[1], v[4]), Math.max(bb[2], v[3]), Math.max(bb[3], v[4])] : [v[3], v[4], v[3], v[4]];
    host.fit(bb ?? TAIWAN_BOUNDS, 10);
  }

  function downloadCsv(): void {
    const w = data.weeks[st.week]!;
    const head = getLang() === 'en'
      ? ['County', 'Township', 'Village', 'Village code', 'Risk', 'Breteau level', 'Ovitrap positivity (%)', 'Gravitrap positivity (%)', 'Week start', 'Week end']
      : ['縣市', '鄉鎮市區', '村里', '村里代碼', '風險等級', '布氏級數', '誘卵桶陽性率(%)', '誘殺桶陽性率(%)', '週起日', '週迄日'];
    const rows = filtered()
      .map(([v]) => [v, wk(v)] as const)
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

  return {
    destroy() {
      destroyed = true;
      app.mapSummary('');
    },
  };
}
