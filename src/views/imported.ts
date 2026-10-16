// #/imported — 境外移入: globe with great-circle arcs from countries of infection to Taiwan,
// year filter, ranked country list, Taiwan CDC outbreak notices per country.
import type { Map as MLMap, GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import { errorCard } from '../app';
import { countryName, fmtDate, fmtNum, getLang, t } from '../i18n';
import { DataError, loadData } from '../lib/data';
import { clear, extLink, h, prefersReducedMotion } from '../lib/dom';
import { greatCircle, TAIWAN, type LngLat } from '../lib/geo';
import { icon } from '../lib/icons';
import { normalizeImportedParams, serializeImportedParams, type ImportedParams } from '../lib/params';
import type { Imported, Notices } from '../lib/types';
import { validateImported, validateNotices } from '../lib/validate';
import { removeAll, type MapHost, type Overlay, type OverlayCtx } from '../map/host';
import type { View, ViewContext } from './types';
import { isMobile, loadingBlock, notice, panel, section, select, unavailableState, warningText } from './ui';
import { importedShortfall, isUnavailable } from '../lib/warnings';

const L = { arcs: 'dm-arcs', arcsGlow: 'dm-arcs-glow', ctry: 'dm-ctry', tw: 'dm-tw' };
const S = { arcs: 'dm-arcs', ctry: 'dm-ctry', tw: 'dm-tw' };

class ImportedOverlay implements Overlay {
  readonly projection = 'globe' as const;
  arcs: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  pts: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  private map: MLMap | null = null;
  private unbind: (() => void)[] = [];
  constructor(private host: MapHost, private onPick: (e: MapLayerMouseEvent, hover: boolean) => void) {}
  install({ map, palette: p }: OverlayCtx): void {
    this.map = map;
    map.addSource(S.arcs, { type: 'geojson', data: this.arcs, lineMetrics: true });
    map.addSource(S.ctry, { type: 'geojson', data: this.pts });
    map.addSource(S.tw, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: TAIWAN } } });
    map.addLayer({ id: L.arcsGlow, type: 'line', source: S.arcs, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p.imported, 'line-opacity': 0.18, 'line-width': ['+', 4, ['*', 2, ['get', 'w']]], 'line-blur': 3 } });
    map.addLayer({ id: L.arcs, type: 'line', source: S.arcs, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': ['get', 'w'],
        'line-opacity': ['case', ['==', ['get', 'sel'], 1], 1, 0.8],
        'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, p.imported, 1, p.accent],
      } });
    map.addLayer({ id: L.ctry, type: 'circle', source: S.ctry, paint: {
      'circle-radius': ['+', 3, ['get', 'w']], 'circle-color': p.imported, 'circle-opacity': 0.92,
      'circle-stroke-color': ['case', ['==', ['get', 'sel'], 1], p.text, p.halo], 'circle-stroke-width': ['case', ['==', ['get', 'sel'], 1], 3, 1.5] } });
    map.addLayer({ id: L.tw, type: 'circle', source: S.tw, paint: { 'circle-radius': 7, 'circle-color': p.accent, 'circle-stroke-color': p.halo, 'circle-stroke-width': 2.5 } });
    if (!this.unbind.length) {
      this.unbind.push(this.host.interactive(L.ctry, (e, hv) => this.onPick(e, hv)), this.host.interactive(L.arcs, (e, hv) => this.onPick(e, hv)));
    }
  }
  uninstall(map: MLMap): void {
    for (const u of this.unbind) u();
    this.unbind = [];
    removeAll(map, [L.tw, L.ctry, L.arcs, L.arcsGlow], [S.tw, S.ctry, S.arcs]);
    this.map = null;
  }
  setData(arcs: GeoJSON.FeatureCollection, pts: GeoJSON.FeatureCollection): void {
    this.arcs = arcs;
    this.pts = pts;
    (this.map?.getSource(S.arcs) as GeoJSONSource | undefined)?.setData(arcs);
    (this.map?.getSource(S.ctry) as GeoJSONSource | undefined)?.setData(pts);
  }
}

export default async function importedView(ctx: ViewContext): Promise<View> {
  const { app, root } = ctx;
  const pnl = panel(t('imported.title'), t('imported.intro'), 'panel-imported');
  root.append(pnl.el);
  pnl.body.append(loadingBlock());
  let destroyed = false;

  const [host, impRes, notices] = await Promise.all([
    app.getMapHost(),
    loadData('imported.json', validateImported).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })),
    loadData('notices.json', validateNotices).catch(() => null as Notices | null),
  ]);
  if (destroyed) return { destroy() {} };
  clear(pnl.body);
  if (host) host.padding = pnl.padding;
  if (isUnavailable(app.getManifestNow(), 'imported')) {
    pnl.body.append(unavailableState());
    return { destroy() {} };
  }
  if (!impRes.ok) {
    pnl.body.append(errorCard('', () => location.reload(), impRes.e instanceof DataError ? impRes.e.file : 'imported.json'));
    return { destroy() {} };
  }
  const data: Imported = impRes.v;
  const y0 = +data.from.slice(0, 4), y1 = +data.to.slice(0, 4);
  const years: number[] = [];
  for (let y = y1; y >= y0; y--) years.push(y);
  let st: ImportedParams = normalizeImportedParams(ctx.params, years, new Set(Object.keys(data.countries)));
  const name = (cc: string) => countryName(cc, data.countries[cc]?.zh);
  const countOf = (cc: string): number => {
    const c = data.countries[cc]!;
    return st.year === null ? Object.values(c.byYear).reduce((a, b) => a + b, 0) : (c.byYear[String(st.year)] ?? 0);
  };

  const list = h('ol', { class: 'rank-list rank-countries' });
  const totalLine = h('p', { class: 'result-line' });
  const warnBox = h('div');
  const noticeBox = h('div', { class: 'notice-box', 'aria-live': 'polite' });
  const yearSel = select(t('common.year'), [{ value: 'all', label: t('imported.allYears') }, ...years.map((y) => ({ value: String(y), label: String(y) }))],
    st.year === null ? 'all' : String(st.year), (v) => {
      st = { ...st, year: v === 'all' ? null : Number(v) };
      update();
    });
  pnl.body.append(
    section(null, yearSel, totalLine, warnBox, h('p', { class: 'hint' }, t('imported.range', { from: fmtDate(data.from), to: fmtDate(data.to) }))),
    section(t('imported.rank'), list),
    section(null, noticeBox),
  );

  const onPick = (e: MapLayerMouseEvent, hover: boolean) => {
    const cc = String(e.features?.[0]?.properties?.cc ?? '');
    if (!data.countries[cc] || !host) return;
    if (hover) {
      host.showPopup(e.lngLat, h('div', { class: 'pop' }, h('p', { class: 'pop-title' }, name(cc)), h('p', null, h('span', { class: 'pill imported' }, t('common.cases', { n: fmtNum(countOf(cc)) })))), true);
    } else {
      host.hidePopup();
      choose(cc, true);
    }
  };
  const overlay = host ? new ImportedOverlay(host, onPick) : null;

  function choose(cc: string | null, fly: boolean): void {
    st = { ...st, country: st.country === cc ? null : cc };
    update();
    if (fly && st.country && host) {
      const c = data.countries[st.country]!;
      const mid = greatCircle([c.lng, c.lat], TAIWAN, 2)[1]!;
      host.map.easeTo({ center: mid, zoom: isMobile() ? 1.4 : 2, duration: prefersReducedMotion() ? 0 : 900, padding: host.padding() });
    }
    // keep focus on the list button for keyboard users
  }

  function renderNotices(): void {
    clear(noticeBox);
    if (!st.country) {
      noticeBox.append(h('p', { class: 'hint' }, t('imported.selectHint')));
      return;
    }
    const items = notices?.[st.country] ?? [];
    noticeBox.append(h('h2', { class: 'psec-title' }, t('imported.notices', { country: name(st.country) })));
    if (getLang() === 'en' && items.length) noticeBox.append(h('p', { class: 'hint' }, h('span', { class: 'orig-zh' }, t('imported.originalZh'))));
    if (!items.length) {
      noticeBox.append(h('p', { class: 'hint' }, t('imported.noNotices')));
      return;
    }
    noticeBox.append(h('ul', { class: 'notices' }, ...items.map((n) => h('li', { class: 'notice' },
      n.date ? h('span', { class: 'notice-date' }, fmtDate(n.date)) : null,
      h('p', { class: 'notice-h', lang: 'zh-Hant-TW' }, n.headline),
      n.text ? h('p', { class: 'notice-text', lang: 'zh-Hant-TW' }, n.text) : null,
      h('div', { class: 'notice-meta' }, n.url ? extLink(n.url, t('imported.readMore')) : null, n.url ? null : h('span', { class: 'hint' }, t('imported.source')))))));
    const links = noticeBox.querySelectorAll('a.ext');
    for (const a of links) a.append(icon('external'));
  }

  function update(): void {
    const rows = Object.keys(data.countries).map((cc) => [cc, countOf(cc)] as const).filter((r) => r[1] > 0).sort((a, b) => b[1] - a[1]);
    const max = rows[0]?.[1] ?? 1;
    const total = rows.reduce((s, r) => s + r[1], 0);
    clear(warnBox);
    const w0 = importedShortfall(app.getManifestNow()?.warnings ?? [], st.year);
    const wn = w0 ? notice([warningText(w0)]) : null;
    if (wn) warnBox.append(wn);
    totalLine.textContent = rows.length ? t('imported.total', { n: fmtNum(total), c: fmtNum(rows.length) }) : t('imported.empty');
    clear(list);
    for (const [cc, n] of rows) {
      list.append(h('li', null, h('button', { type: 'button', class: 'rank-btn', 'aria-pressed': String(st.country === cc), on: { click: () => choose(cc, true) } },
        h('span', { class: 'rank-name' }, name(cc)),
        h('span', { class: 'rank-bar single', style: { '--w': `${Math.max(3, (n / max) * 100)}%`, background: 'var(--imported)' }, 'aria-hidden': 'true' }),
        h('span', { class: 'rank-val' }, fmtNum(n)))));
    }
    const w = (n: number) => 1.2 + 7 * Math.sqrt(n / max);
    const arcs: GeoJSON.Feature[] = rows.map(([cc, n]) => {
      const c = data.countries[cc]!;
      return { type: 'Feature', properties: { cc, n, w: w(n), sel: st.country === cc ? 1 : 0 }, geometry: { type: 'LineString', coordinates: greatCircle([c.lng, c.lat] as LngLat, TAIWAN, 64) } };
    });
    const pts: GeoJSON.Feature[] = rows.map(([cc, n]) => {
      const c = data.countries[cc]!;
      return { type: 'Feature', properties: { cc, n, w: w(n) * 0.9, sel: st.country === cc ? 1 : 0 }, geometry: { type: 'Point', coordinates: [c.lng, c.lat] } };
    });
    overlay?.setData({ type: 'FeatureCollection', features: arcs }, { type: 'FeatureCollection', features: pts });
    renderNotices();
    const summary = `${totalLine.textContent} ${rows.slice(0, 5).map(([cc, n]) => `${name(cc)} ${n}`).join(', ')}`;
    app.mapSummary(summary);
    app.announce(totalLine.textContent ?? '');
    app.setParams(serializeImportedParams(st, years));
  }

  if (overlay && host) {
    host.setOverlay(overlay);
    const mobile = isMobile();
    host.map.jumpTo({ center: mobile ? [112, 4] : [108, 12], zoom: mobile ? 0.9 : 1.75, padding: host.padding() });
  }
  update();

  return {
    destroy() {
      destroyed = true;
      app.mapSummary('');
    },
  };
}
