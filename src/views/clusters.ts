// #/clusters — 聚集警示: official cluster polygons + list; explicit empty state; last-14-day local towns.
import type { Map as MLMap, MapLayerMouseEvent } from 'maplibre-gl';
import { errorCard } from '../app';
import { fmtDate, fmtDateTime, fmtNum, getLang, placeName, t } from '../i18n';
import { loadAdmin, type Admin } from '../lib/admin';
import { DataError, loadData } from '../lib/data';
import { clear, h } from '../lib/dom';
import { bboxOf, centroidOf, TAIWAN_BOUNDS, type BBox } from '../lib/geo';
import { icon } from '../lib/icons';
import type { Clusters } from '../lib/types';
import { validateClusters, validateSummary } from '../lib/validate';
import type { MapHost, Overlay, OverlayCtx } from '../map/host';
import { removeAll } from '../map/layers';
import type { View, ViewContext } from './types';
import { loadingBlock, panel, section, unavailableState } from './ui';
import { isUnavailable } from '../lib/warnings';

const L = { towns: 'dm-c-towns', townsLine: 'dm-c-towns-line', fill: 'dm-cl-fill', line: 'dm-cl-line', pt: 'dm-cl-pt' };
const S = { towns: 'dm-c-towns', poly: 'dm-cl', pt: 'dm-cl-pt' };

class ClusterOverlay implements Overlay {
  private unbind: (() => void)[] = [];
  constructor(
    private host: MapHost,
    private clusters: Clusters,
    private towns: GeoJSON.FeatureCollection,
    private onPick: (e: MapLayerMouseEvent, hover: boolean, layer: string) => void,
  ) {}
  install({ map, palette: p, beforeId }: OverlayCtx): void {
    map.addSource(S.towns, { type: 'geojson', data: this.towns });
    map.addLayer({ id: L.towns, type: 'fill', source: S.towns, paint: {
      'fill-color': ['step', ['get', 'l'], p.choropleth[1], 3, p.choropleth[2], 6, p.choropleth[3], 11, p.choropleth[4]], 'fill-opacity': 0.55 } }, beforeId);
    map.addLayer({ id: L.townsLine, type: 'line', source: S.towns, paint: { 'line-color': p.local, 'line-opacity': 0.5, 'line-width': 1 } }, beforeId);
    map.addSource(S.poly, { type: 'geojson', data: this.clusters });
    map.addLayer({ id: L.fill, type: 'fill', source: S.poly, paint: { 'fill-color': p.local, 'fill-opacity': 0.28 } }, beforeId);
    map.addLayer({ id: L.line, type: 'line', source: S.poly, paint: { 'line-color': p.local, 'line-width': 2.2 } }, beforeId);
    const pts: GeoJSON.FeatureCollection<GeoJSON.Point> = {
      type: 'FeatureCollection',
      features: this.clusters.features.map((f, i) => ({ type: 'Feature', id: i, properties: { i, n: f.properties.count }, geometry: { type: 'Point', coordinates: centroidOf(f.geometry) } })),
    };
    map.addSource(S.pt, { type: 'geojson', data: pts });
    map.addLayer({ id: L.pt, type: 'circle', source: S.pt, maxzoom: 13, paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 7, 12, 11], 'circle-color': p.local, 'circle-opacity': 0.9,
      'circle-stroke-color': p.halo, 'circle-stroke-width': 2.5 } }, beforeId);
    if (!this.unbind.length) {
      this.unbind.push(
        this.host.interactive(L.pt, (e, hv) => this.onPick(e, hv, 'cluster')),
        this.host.interactive(L.fill, (e, hv) => this.onPick(e, hv, 'cluster')),
        this.host.interactive(L.towns, (e, hv) => this.onPick(e, hv, 'town')),
      );
    }
  }
  uninstall(map: MLMap): void {
    for (const u of this.unbind) u();
    this.unbind = [];
    removeAll(map, [L.pt, L.line, L.fill, L.townsLine, L.towns], [S.pt, S.poly, S.towns]);
  }
}

export default async function clustersView(ctx: ViewContext): Promise<View> {
  const { app, root } = ctx;
  const pnl = panel(t('clusters.title'), t('clusters.intro'), 'panel-clusters');
  root.append(pnl.el);
  pnl.body.append(loadingBlock());
  let destroyed = false;

  const [host, admin] = await Promise.all([app.getMapHost(), loadAdmin().catch(() => null as Admin | null)]);
  if (host) host.padding = pnl.padding;
  const [clRes, sumRes] = await Promise.allSettled([loadData('clusters.json', validateClusters), loadData('summary.json', validateSummary)]);
  if (destroyed) return { destroy() {} };
  clear(pnl.body);

  const townLabel = (code: string): string => {
    const town = admin?.towns.get(code);
    if (!town) return code;
    const county = admin?.countyByCode.get(town.county);
    return getLang() === 'en' ? `${placeName(town)}, ${placeName(county)}` : `${placeName(county)}${placeName(town)}`;
  };
  /** Cluster props are Chinese names from CDC; map to English via the admin lookup when possible. */
  const clusterLabel = (county: string, town: string, village = ''): string => {
    if (getLang() !== 'en' || !admin) return `${county}${town}${village}`;
    const c = admin.countyByZh.get(county);
    const tw = c ? [...admin.towns.values()].find((x) => x.county === c.code && x.zh === town.replace(/台/g, '臺')) : undefined;
    // Village names have no official English form here: keep the Chinese name in brackets.
    return tw && c ? `${tw.en}, ${c.en}${village ? ` (${village})` : ''}` : `${county}${town}${village}`;
  };

  const clusters = clRes.status === 'fulfilled' ? clRes.value : null;
  const summary = sumRes.status === 'fulfilled' ? sumRes.value : null;
  const bboxes: (BBox | null)[] = clusters?.features.map((f) => bboxOf(f.geometry)) ?? [];
  const list = h('ul', { class: 'list-cards' });

  function select(i: number): void {
    for (const [j, el] of [...list.querySelectorAll('.card-btn')].entries()) el.setAttribute('aria-pressed', String(j === i));
    const b = bboxes[i];
    if (b && host) host.fit(b, 15);
  }

  // ---- clusters section
  if (isUnavailable(app.getManifestNow(), 'clusters')) {
    pnl.body.append(unavailableState());
  } else if (!clusters) {
    pnl.body.append(errorCard('', () => location.reload(), clRes.status === 'rejected' && clRes.reason instanceof DataError ? clRes.reason.file : 'clusters.json'));
  } else if (!clusters.features.length) {
    pnl.body.append(h('div', { class: 'empty-state', role: 'status' }, icon('check'),
      h('p', { class: 'empty-title' }, t('clusters.emptyTitle')), h('p', { class: 'empty-body' }, t('clusters.emptyBody'))));
  } else {
    clusters.features.forEach((f, i) => {
      const p = f.properties;
      list.append(h('li', null, h('button', { type: 'button', class: 'card-btn', 'aria-pressed': 'false', on: { click: () => select(i) } },
        h('span', { class: 'card-title' }, h('span', null, clusterLabel(p.county, p.town, p.village)), h('span', { class: 'badge' }, t('clusters.cases', { n: fmtNum(p.count) }))),
        h('span', { class: 'card-meta' }, p.lastOnset ? h('span', null, t('clusters.lastOnset', { date: fmtDate(p.lastOnset) })) : null, p.code1 ? h('span', null, p.code1) : null))));
    });
    pnl.body.append(section(t('clusters.count', { n: fmtNum(clusters.features.length) }), list));
  }
  // clusters.json fetchedAt only changes with content; the manifest tells when it was last checked.
  const checked = app.getManifestNow()?.sources.clusters?.fetchedAt ?? clusters?.fetchedAt ?? null;
  if (checked) pnl.body.append(h('p', { class: 'hint' }, t('clusters.checked', { time: fmtDateTime(checked, true) })));

  // ---- last 14 days local towns
  const top = summary?.topTowns14.filter((r) => r[1] > 0) ?? [];
  const townList = h('ol', { class: 'rank-list' });
  if (!summary) {
    townList.append(h('li', { class: 'empty' }, t('common.loadError')));
  } else if (!top.length) {
    townList.append(h('li', { class: 'empty' }, t('clusters.topTownsEmpty')));
  } else {
    const max = top[0]![1];
    for (const [code, l, i] of top) {
      const town = admin?.towns.get(code);
      townList.append(h('li', null, h('button', { type: 'button', class: 'rank-btn', 'aria-label': `${townLabel(code)}: ${t('common.local')} ${l}, ${t('common.importedShort')} ${i}`, on: { click: () => town?.bbox && host?.fit(town.bbox, 13) } },
        h('span', { class: 'rank-name' }, townLabel(code)),
        h('span', { class: 'rank-bar single', style: { '--w': `${Math.max(4, (l / max) * 100)}%`, background: 'var(--local)' }, 'aria-hidden': 'true' }),
        h('span', { class: 'rank-val' }, `${fmtNum(l)}${i ? ` (${fmtNum(i)})` : ''}`))));
    }
  }
  pnl.body.append(section(t('clusters.topTowns'), townList, h('p', { class: 'hint' }, t('clusters.topTownsNote'))));

  // ---- map
  if (host && clusters) {
    const topMap = new Map(top.map((r) => [r[0], r]));
    const townsFC: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: (admin?.townsFC.features ?? []).filter((f) => topMap.has(f.properties.code))
        .map((f) => ({ ...f, properties: { code: f.properties.code, l: topMap.get(f.properties.code)![1], i: topMap.get(f.properties.code)![2] } })),
    };
    const onPick = (e: MapLayerMouseEvent, hover: boolean, kind: string) => {
      const f = e.features?.[0];
      if (!f) return;
      if (kind === 'cluster') {
        const idx = f.layer.id === L.pt ? Number(f.properties?.i) : clusters.features.findIndex((c) => c.properties.code1 === f.properties?.code1 && c.properties.town === f.properties?.town);
        const c = clusters.features[idx];
        if (!c) return;
        const p = c.properties;
        host.showPopup(e.lngLat, h('div', { class: 'pop' }, h('p', { class: 'pop-kicker' }, icon('clusters'), t('clusters.title')), h('p', { class: 'pop-title' }, clusterLabel(p.county, p.town, p.village)),
          h('dl', { class: 'pop-dl' }, h('dt', null, t('common.caseCount')), h('dd', null, h('span', { class: 'pill local' }, fmtNum(p.count))),
            p.lastOnset ? h('dt', null, t('kpi.latestOnset')) : null, p.lastOnset ? h('dd', null, fmtDate(p.lastOnset)) : null,
            p.code1 ? h('dt', null, 'ID') : null, p.code1 ? h('dd', null, p.code1) : null)), hover);
      } else {
        const code = String(f.properties?.code ?? '');
        host.showPopup(e.lngLat, h('div', { class: 'pop' }, h('p', { class: 'pop-title' }, townLabel(code)), h('p', { class: 'pop-sub' }, t('kpi.last14')),
          h('dl', { class: 'pop-dl' }, h('dt', null, t('common.local')), h('dd', null, h('span', { class: 'pill local' }, fmtNum(Number(f.properties?.l) || 0))),
            h('dt', null, t('common.importedShort')), h('dd', null, h('span', { class: 'pill imported' }, fmtNum(Number(f.properties?.i) || 0))))), hover);
      }
    };
    host.setOverlay(new ClusterOverlay(host, clusters, townsFC, onPick));
    // Camera: clusters if any, else the last-14-day towns, else all of Taiwan.
    const all = (bbs: (BBox | null | undefined)[]): BBox | null => {
      const v = bbs.filter((b): b is BBox => !!b);
      return v.length ? [Math.min(...v.map((b) => b[0])), Math.min(...v.map((b) => b[1])), Math.max(...v.map((b) => b[2])), Math.max(...v.map((b) => b[3]))] : null;
    };
    const clusterBox = all(bboxes);
    const target = clusterBox ?? all(top.map((r) => admin?.towns.get(r[0])?.bbox)) ?? TAIWAN_BOUNDS;
    host.fit(target, clusterBox ? 12 : 8.5);
    const n = clusters.features.length;
    const msg = n ? t('clusters.count', { n }) : t('clusters.emptyTitle');
    app.mapSummary(`${msg}. ${t('clusters.topTowns')}: ${top.map((r) => `${townLabel(r[0])} ${r[1]}`).join(', ') || t('clusters.topTownsEmpty')}`);
    app.announce(msg);
  }

  return {
    destroy() {
      destroyed = true;
      app.mapSummary('');
    },
  };
}
