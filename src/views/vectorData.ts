// Shared mosquito-vector data: loading (vector.json + village polygons), GeoJSON building,
// the 5-week popup table and danger-trigger helpers. Used by the vector view and (lazily) by the
// map view's "mosquito risk villages" overlay.
import type { Map as MLMap } from 'maplibre-gl';
import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import { feature } from 'topojson-client';
import type { Palette } from '../map/palette';
import { addRiskSquares } from '../map/images';
import type { GeometryCollection } from 'topojson-specification';
import { fmtDate, getLang, t, type MessageKey } from '../i18n';
import type { Admin, Place } from '../lib/admin';
import { loadData } from '../lib/data';
import { h } from '../lib/dom';
import type { Vector, VectorVillage, VectorWeek } from '../lib/types';
import { validateTopology, validateVector } from '../lib/validate';

export const RISK_KEYS: MessageKey[] = ['vector.risk0', 'vector.risk1', 'vector.risk2', 'vector.risk3'];
type PolyFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, { code: string }>;

export interface VectorBundle {
  data: Vector;
  polyByCode: Map<string, PolyFeature>;
}

let bundleP: Promise<VectorBundle> | null = null;
/** vector.json is required; polygons are optional (points are the fallback). */
export function loadVectorBundle(): Promise<VectorBundle> {
  if (!bundleP) {
    bundleP = Promise.all([
      loadData('vector.json', validateVector),
      loadData('geo/vector-villages.topo.json', (v) => validateTopology(v, 'geo/vector-villages.topo.json', ['villages'])).catch(() => null),
    ]).then(([data, topo]) => {
      const polyByCode = new Map<string, PolyFeature>();
      if (topo) {
        const fc = feature(topo, topo.objects.villages as GeometryCollection<{ code: string }>) as unknown as GeoJSON.FeatureCollection<PolyFeature['geometry'], { code: string }>;
        for (const f of fc.features) if (f.geometry && typeof f.properties?.code === 'string') polyByCode.set(f.properties.code, f as PolyFeature);
      }
      return { data, polyByCode };
    });
    bundleP.catch(() => (bundleP = null));
  }
  return bundleP;
}

export const weekOf = (v: VectorVillage, w: number): VectorWeek => v[7][w] ?? [0, null, null, null];

/** Polygon + point GeoJSON for one week (k = index into data.villages, r = risk, np = no polygon). */
export function vectorFC(b: VectorBundle, week: number, keep: (v: VectorVillage) => boolean = () => true): { polys: GeoJSON.FeatureCollection; pts: GeoJSON.FeatureCollection; counts: number[] } {
  const counts = [0, 0, 0, 0];
  const polys: GeoJSON.Feature[] = [];
  const pts: GeoJSON.Feature[] = [];
  b.data.villages.forEach((v, k) => {
    if (!keep(v)) return;
    const r = weekOf(v, week)[0];
    counts[r]!++;
    const poly = v[5] ? b.polyByCode.get(v[5]) : undefined;
    if (poly) polys.push({ type: 'Feature', id: k, properties: { k, r }, geometry: poly.geometry });
    pts.push({ type: 'Feature', id: k, properties: { k, r, np: poly ? 0 : 1 }, geometry: { type: 'Point', coordinates: [v[3], v[4]] } });
  });
  return { polys: { type: 'FeatureCollection', features: polys }, pts: { type: 'FeatureCollection', features: pts }, counts };
}

// ------------------------------------------------------------------ formatting
const pctFmt = (digits: number) => new Intl.NumberFormat(getLang() === 'en' ? 'en' : 'zh-Hant-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits });
/** Ovitrap positivity: integer percent. */
export const fmtOvi = (v: number | null): string => (v == null ? '—' : `${pctFmt(0).format(v)}%`);
/** Gravitrap positivity: one decimal like the CDC site (5 → 5.0%). */
export const fmtGra = (v: number | null): string => (v == null ? '—' : `${pctFmt(1).format(v)}%`);
export const fmtBi = (v: number | null): string => (v == null ? '—' : t('vector.levelN', { n: v }));

/** Which indicators meet the danger thresholds (ovitrap ≥ 60 %, Breteau ≥ 3, gravitrap ≥ 30 %). */
export function dangerTriggers(w: VectorWeek): ('bi' | 'ovi' | 'gra')[] {
  const out: ('bi' | 'ovi' | 'gra')[] = [];
  if (w[1] != null && w[1] >= 3) out.push('bi');
  if (w[2] != null && w[2] >= 60) out.push('ovi');
  if (w[3] != null && w[3] >= 30) out.push('gra');
  return out;
}

export function triggerText(w: VectorWeek): string {
  const trig = dangerTriggers(w);
  const parts = (trig.length ? trig : (['bi', 'ovi', 'gra'] as const).filter((k) => w[k === 'bi' ? 1 : k === 'ovi' ? 2 : 3] != null)).map((k) =>
    k === 'bi' ? `${t('vector.biShort')} ${w[1]}` : k === 'ovi' ? `${t('vector.oviShort')} ${fmtOvi(w[2])}` : `${t('vector.graShort')} ${fmtGra(w[3])}`);
  return parts.join(' · ') || '—';
}

export function countyOf(admin: Admin | null, v: VectorVillage): Place | undefined {
  return (v[5] ? admin?.countyByCode.get(v[5].slice(0, 5)) : undefined) ?? admin?.countyByZh.get(v[0]);
}

export function villageLabel(admin: Admin | null, v: VectorVillage): string {
  if (getLang() !== 'en' || !admin) return `${v[0]}${v[1]}${v[2]}`;
  const c = countyOf(admin, v);
  const town = c ? [...admin.towns.values()].find((x) => x.county === c.code && x.zh === v[1]) : undefined;
  return `${v[2]}, ${town?.en ?? v[1]}, ${c?.en ?? v[0]}`;
}

/** Popup: all 5 weeks as rows (前1週 = latest), tinted by that week's risk, selected week highlighted. */
export function villagePopup(b: VectorBundle, admin: Admin | null, v: VectorVillage, selected: number, hasPoly: boolean): HTMLElement {
  const r = weekOf(v, selected)[0];
  const rows = b.data.weeks.map((w, i) => {
    const wk = weekOf(v, i);
    return h('tr', { class: `wk-row risk-row-${wk[0]}${i === selected ? ' is-sel' : ''}`, 'aria-current': i === selected ? 'true' : undefined },
      h('th', { scope: 'row' }, h('span', { class: 'wk-n' }, t('vector.weekN', { n: i + 1 })), h('span', { class: 'wk-d' }, `${fmtDate(w[0], 'short')}–${fmtDate(w[1], 'short')}`)),
      h('td', { class: 'num' }, wk[1] == null ? '—' : String(wk[1])),
      h('td', { class: 'num' }, fmtOvi(wk[2])),
      h('td', { class: 'num' }, fmtGra(wk[3])),
      h('td', null, h('span', { class: 'sr-only' }, t(RISK_KEYS[wk[0]]!))));
  });
  return h('div', { class: 'pop pop-vector' },
    h('p', { class: 'pop-title' }, villageLabel(admin, v)),
    h('p', null, h('span', { class: 'pill risk', style: { '--sw': `var(--risk-${r})` } }, t(RISK_KEYS[r]!)), ' ', h('span', { class: 'pop-sub' }, t('vector.popupSel'))),
    h('table', { class: 'wk-table' },
      h('caption', { class: 'sr-only' }, t('vector.popupCaption')),
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('vector.week')), h('th', { scope: 'col', class: 'num' }, t('vector.breteauShort')),
        h('th', { scope: 'col', class: 'num' }, t('vector.ovitrapShort')), h('th', { scope: 'col', class: 'num' }, t('vector.gravitrapShort')), h('th', { scope: 'col', class: 'sr-only' }, t('vector.level')))),
      h('tbody', null, ...rows)),
    hasPoly ? null : h('p', { class: 'pop-sub' }, t('vector.noPolygon').trim()));
}

/** Risk fill/point layers shared with the map view's "mosquito risk villages" overlay. */
export function addVectorLayers(map: MLMap, p: Palette, ids: { fill: string; line: string; ptsAll: string; ptsNp: string; poly: string; pts: string }, opts: { fillOpacity: number; minzoom: number }): void {
  const color: ExpressionSpecification = ['match', ['get', 'r'], 3, p.risk[3], 2, p.risk[2], 1, p.risk[1], p.risk[0]];
  map.addLayer({ id: ids.fill, type: 'fill', source: ids.poly, minzoom: opts.minzoom, layout: { 'fill-sort-key': ['get', 'r'] }, paint: { 'fill-color': color, 'fill-opacity': opts.fillOpacity } });
  map.addLayer({ id: ids.line, type: 'line', source: ids.poly, minzoom: opts.minzoom, paint: { 'line-color': color, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 14, 1.8], 'line-opacity': 0.95 } });
  // Villages as small rounded squares (canvas icons) so they never read as case circles.
  addRiskSquares(map, 'dm-risk-sq-', p.risk, p.halo);
  const square = (id: string, filter: boolean, minzoom: number, maxzoom: number) =>
    map.addLayer({
      id, type: 'symbol', source: ids.pts, minzoom, maxzoom,
      ...(filter ? { filter: ['==', ['get', 'np'], 1] as ExpressionSpecification } : {}),
      layout: {
        'symbol-sort-key': ['get', 'r'], 'icon-image': ['concat', 'dm-risk-sq-', ['to-string', ['get', 'r']]],
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 6, ['+', 0.75, ['*', 0.12, ['get', 'r']]], 12, ['+', 1.1, ['*', 0.15, ['get', 'r']]]],
      },
    });
  square(ids.ptsAll, false, 0, opts.minzoom + 0.5);
  square(ids.ptsNp, true, opts.minzoom + 0.5, 24);
}

