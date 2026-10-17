// #/imported — 境外移入: animated globe (day-by-day comets along great-circle arcs to Taiwan),
// travel-advisory choropleth (SafeTravel TW data), ranked countries, country detail panel and a
// mosquito-borne disease news feed.
import type { Map as MLMap, GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import { feature } from 'topojson-client';
import type { GeometryCollection } from 'topojson-specification';
import { errorCard } from '../app';
import { countryName, fmtDate, fmtNum, getLang, t } from '../i18n';
import { DataError, loadData } from '../lib/data';
import { clear, extLink, h, prefersReducedMotion } from '../lib/dom';
import { isEmbed } from '../lib/embed';
import { centroidOf, greatCircle, TAIWAN, type LngLat } from '../lib/geo';
import { icon } from '../lib/icons';
import { normalizeImportedParams, serializeImportedParams, type AdvLayer, type ImportedParams, type ImportedTab } from '../lib/params';
import { advisoryLevel, dayToISO, filterNews, importedEvents, levelHistogram, levelsByCountry } from '../lib/travel';
import { VB_KEYS, type Imported, type Notices, type Travel, type TravelNews, type VbKey } from '../lib/types';
import { validateImported, validateNotices, validateTopology, validateTravel } from '../lib/validate';
import { importedShortfall, isUnavailable } from '../lib/warnings';
import { removeAll, type MapHost, type Overlay, type OverlayCtx } from '../map/host';
import type { Palette } from '../map/palette';
import { ImportAnimator, SRC } from './importedAnim';
import type { View, ViewContext } from './types';
import { isMobile, loadingBlock, notice, panel, section, segmented, select, tabs, unavailableState, warningText } from './ui';

const SAFETRAVEL = 'https://ancientsky.github.io/safetravel/';
const L = {
  hit: 'dm-w-hit', land: 'dm-w-land', border: 'dm-w-border', adv: 'dm-w-adv', sel: 'dm-w-sel', arcs: 'dm-arcs',
  trailGlow: 'dm-i-trail-glow', trail: 'dm-i-trail', mkGlow: 'dm-i-mk-glow', mk: 'dm-i-mk', rip: 'dm-i-rip', headGlow: 'dm-i-head-glow', head: 'dm-i-head', tw: 'dm-tw',
};
const S = { world: 'dm-world', arcs: 'dm-arcs', tw: 'dm-tw' };
const NEWS_PAGE = 20;
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** '#rrggbb' → 'rgba(r,g,b,a)'; other colour strings are returned unchanged. */
function alpha(c: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return c;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

class ImportedOverlay implements Overlay {
  readonly projection = 'globe' as const;
  world: GeoJSON.FeatureCollection | null = null;
  arcs: GeoJSON.FeatureCollection = EMPTY;
  adv: AdvLayer = 'vb';
  selected: string | null = null;
  dimArcs = false;
  private map: MLMap | null = null;
  private pal: Palette | null = null;
  private unbind: (() => void)[] = [];
  constructor(private host: MapHost, private anim: ImportAnimator, private onPick: (e: MapLayerMouseEvent, hover: boolean, layer: string) => void) {}

  install({ map, palette: p, fallback }: OverlayCtx): void {
    this.map = map;
    this.pal = p;
    map.addSource(S.world, { type: 'geojson', data: this.world ?? EMPTY });
    map.addSource(S.arcs, { type: 'geojson', data: this.arcs, lineMetrics: true });
    for (const id of Object.values(SRC)) map.addSource(id, { type: 'geojson', data: EMPTY, lineMetrics: id === SRC.trails });
    map.addSource(S.tw, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: TAIWAN } } });
    map.addLayer({ id: L.hit, type: 'fill', source: S.world, paint: { 'fill-color': '#000', 'fill-opacity': 0 } });
    if (fallback) {
      // offline basemap has no world: draw land + borders so the globe still reads as Earth
      map.addLayer({ id: L.land, type: 'fill', source: S.world, paint: { 'fill-color': p.worldLand } });
      map.addLayer({ id: L.border, type: 'line', source: S.world, paint: { 'line-color': p.worldLine, 'line-width': 0.5 } });
    }
    map.addLayer({ id: L.adv, type: 'fill', source: S.world, layout: { visibility: this.adv === 'off' ? 'none' : 'visible' }, paint: { 'fill-color': this.advColor(), 'fill-opacity': this.advOpacity(), 'fill-opacity-transition': { duration: 600 } } });
    map.addLayer({ id: L.sel, type: 'line', source: S.world, filter: ['==', ['get', 'iso2'], this.selected ?? ''], paint: { 'line-color': p.text, 'line-width': 2 } });
    map.addLayer({ id: L.arcs, type: 'line', source: S.arcs, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': ['get', 'w'], 'line-opacity': this.dimArcs ? 0.28 : 0.85,
        'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, alpha(p.imported, 0.35), 0.6, p.imported, 1, p.accent],
      } });
    map.addLayer({ id: L.trailGlow, type: 'line', source: SRC.trails, layout: { 'line-cap': 'round' },
      paint: { 'line-width': 13, 'line-blur': 8, 'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, alpha(p.glow, 0), 1, alpha(p.glow, 0.55)] } });
    map.addLayer({ id: L.trail, type: 'line', source: SRC.trails, layout: { 'line-cap': 'round' },
      paint: { 'line-width': 3.2, 'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, alpha(p.glow, 0), 0.7, alpha(p.glow, 0.85), 1, p.glowCore] } });
    map.addLayer({ id: L.mkGlow, type: 'circle', source: SRC.markers, paint: { 'circle-radius': ['*', ['get', 'w'], 2], 'circle-color': p.glow, 'circle-opacity': 0.22, 'circle-blur': 1 } });
    map.addLayer({ id: L.mk, type: 'circle', source: SRC.markers, paint: {
      'circle-radius': ['get', 'w'], 'circle-color': p.imported, 'circle-opacity': 0.95,
      'circle-stroke-color': ['case', ['==', ['get', 'cc'], this.selected ?? ''], p.text, p.halo], 'circle-stroke-width': ['case', ['==', ['get', 'cc'], this.selected ?? ''], 3, 1.5] } });
    map.addLayer({ id: L.rip, type: 'circle', source: SRC.ripples, paint: {
      'circle-radius': ['+', 6, ['*', 30, ['get', 'p']]], 'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': p.glow, 'circle-stroke-width': ['+', 0.6, ['*', 2.6, ['-', 1, ['get', 'p']]]], 'circle-stroke-opacity': ['-', 1, ['get', 'p']] } });
    map.addLayer({ id: L.headGlow, type: 'circle', source: SRC.heads, paint: { 'circle-radius': 16, 'circle-color': p.glow, 'circle-opacity': 0.55, 'circle-blur': 1 } });
    map.addLayer({ id: L.head, type: 'circle', source: SRC.heads, paint: { 'circle-radius': 4.4, 'circle-color': p.glowCore, 'circle-stroke-color': p.glow, 'circle-stroke-width': 1.2 } });
    map.addLayer({ id: L.tw, type: 'circle', source: S.tw, paint: { 'circle-radius': 7, 'circle-color': p.accent, 'circle-stroke-color': p.halo, 'circle-stroke-width': 2.5 } });
    if (!this.unbind.length) {
      for (const id of [L.mk, L.arcs, L.hit]) this.unbind.push(this.host.interactive(id, (e, hv) => this.onPick(e, hv, id)));
    }
    this.anim.attach(map);
  }

  uninstall(map: MLMap): void {
    for (const u of this.unbind) u();
    this.unbind = [];
    this.anim.attach(null);
    removeAll(map, [L.tw, L.head, L.headGlow, L.rip, L.mk, L.mkGlow, L.trail, L.trailGlow, L.arcs, L.sel, L.adv, L.border, L.land, L.hit], [S.tw, ...Object.values(SRC), S.arcs, S.world]);
    this.map = null;
  }

  private advOpacity(): number {
    // fade the choropleth while comets fly so the animation reads clearly
    return this.dimArcs ? 0.16 : 0.38;
  }
  private advColor(): ExpressionSpecification {
    const p = this.pal!;
    const key = this.adv === 'all' ? 'a' : 'v';
    return ['match', ['get', key], 1, p.adv[0], 2, p.adv[1], 3, p.adv[2], 'rgba(0,0,0,0)'];
  }

  setWorld(fc: GeoJSON.FeatureCollection): void {
    this.world = fc;
    (this.map?.getSource(S.world) as GeoJSONSource | undefined)?.setData(fc);
  }
  setArcs(fc: GeoJSON.FeatureCollection): void {
    this.arcs = fc;
    (this.map?.getSource(S.arcs) as GeoJSONSource | undefined)?.setData(fc);
  }
  setAdv(mode: AdvLayer): void {
    this.adv = mode;
    const m = this.map;
    if (!m?.getLayer(L.adv)) return;
    m.setLayoutProperty(L.adv, 'visibility', mode === 'off' ? 'none' : 'visible');
    if (mode !== 'off') m.setPaintProperty(L.adv, 'fill-color', this.advColor());
  }
  setSelected(cc: string | null): void {
    this.selected = cc;
    const m = this.map;
    if (!m?.getLayer(L.sel) || !this.pal) return;
    m.setFilter(L.sel, ['==', ['get', 'iso2'], cc ?? '']);
    m.setPaintProperty(L.mk, 'circle-stroke-color', ['case', ['==', ['get', 'cc'], cc ?? ''], this.pal.text, this.pal.halo]);
    m.setPaintProperty(L.mk, 'circle-stroke-width', ['case', ['==', ['get', 'cc'], cc ?? ''], 3, 1.5]);
  }
  setDim(dim: boolean): void {
    this.dimArcs = dim;
    if (this.map?.getLayer(L.arcs)) this.map.setPaintProperty(L.arcs, 'line-opacity', dim ? 0.28 : 0.85);
    if (this.map?.getLayer(L.adv)) this.map.setPaintProperty(L.adv, 'fill-opacity', this.advOpacity());
  }
}

export default async function importedView(ctx: ViewContext): Promise<View> {
  const { app, root } = ctx;
  const pnl = panel(t('imported.title'), t('imported.intro'), 'panel-imported');
  root.append(pnl.el);
  pnl.body.append(loadingBlock());
  let destroyed = false;
  const cleanup: (() => void)[] = [];
  const reduced = prefersReducedMotion();
  const manifest = app.getManifestNow();
  const travelOff = isUnavailable(manifest, 'travel');

  const [host, impRes, notices, travelRes] = await Promise.all([
    app.getMapHost(),
    loadData('imported.json', validateImported).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })),
    loadData('notices.json', validateNotices).catch(() => null as Notices | null),
    travelOff ? Promise.resolve(null) : loadData('travel.json', validateTravel).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })),
  ]);
  if (destroyed) return { destroy() {} };
  clear(pnl.body);
  if (host) host.padding = pnl.padding;
  if (isUnavailable(manifest, 'imported')) {
    pnl.body.append(unavailableState());
    return { destroy() {} };
  }
  if (!impRes.ok) {
    pnl.body.append(errorCard('', () => location.reload(), impRes.e instanceof DataError ? impRes.e.file : 'imported.json'));
    return { destroy() {} };
  }
  const data: Imported = impRes.v;
  const travel: Travel | null = travelRes && travelRes.ok ? travelRes.v : null;
  const travelErr = travelRes && !travelRes.ok ? travelRes.e : null;
  const y0 = +data.from.slice(0, 4), y1 = +data.to.slice(0, 4);
  const years: number[] = [];
  for (let y = y1; y >= y0; y--) years.push(y);
  const known = new Set([...Object.keys(data.countries), ...Object.keys(travel?.countries ?? {})]);
  let st: ImportedParams = normalizeImportedParams(ctx.params, years, known);
  const name = (cc: string) => countryName(cc, data.countries[cc]?.zh ?? travel?.countries[cc]?.zh);
  const countOf = (cc: string): number => {
    const c = data.countries[cc];
    if (!c) return 0;
    return st.year === null ? Object.values(c.byYear).reduce((a, b) => a + b, 0) : (c.byYear[String(st.year)] ?? 0);
  };
  const { events, approximate } = importedEvents(data);
  const coords = new Map<string, LngLat>(Object.entries(data.countries).map(([cc, c]) => [cc, [c.lng, c.lat]]));
  const lastDay = Math.round((Date.parse(data.to) - Date.parse(data.from)) / 86_400_000);
  const rangeOf = (y: number | null): [number, number] => {
    if (y === null) return [0, lastDay];
    const a = Math.max(0, Math.round((Date.UTC(y, 0, 1) - Date.parse(data.from)) / 86_400_000));
    const b = Math.min(lastDay, Math.round((Date.UTC(y, 11, 31) - Date.parse(data.from)) / 86_400_000));
    return [a, b];
  };

  // ---------------- map overlay + animation
  const badgeDate = h('span', { class: 'date-badge-date' });
  const badgeSub = h('span', { class: 'date-badge-label' });
  const badge = h('div', { class: 'date-badge date-badge-imported' }, badgeSub, badgeDate);
  root.append(badge);
  const counter = h('p', { class: 'anim-counter', 'aria-live': 'off' });
  const scrub = h('input', { type: 'range', class: 'scrubber', min: '0', max: '1', step: '1', value: '0', 'aria-label': t('imported.scrub') });
  const playBtn = h('button', { type: 'button', class: 'btn btn-primary play-btn' });
  let animPlaying = false;
  const anim = new ImportAnimator(events, coords, {
    onDay(day, cum, total) {
      const iso = dayToISO(data.from, day);
      badgeDate.textContent = `${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
      const txt = t('imported.cumulative', { n: fmtNum(total), c: fmtNum([...cum.values()].filter((n) => n > 0).length) });
      badgeSub.textContent = txt;
      counter.textContent = `${fmtDate(iso)} · ${txt}`;
      scrub.value = String(day);
      scrub.setAttribute('aria-valuetext', fmtDate(iso));
    },
    onState(playing) {
      animPlaying = playing;
      clear(playBtn);
      playBtn.append(icon(playing ? 'pause' : 'play'), h('span', null, playing ? t('map.pause') : t('imported.play')));
      playBtn.setAttribute('aria-pressed', String(playing));
      overlay?.setDim(playing);
      if (!playing) app.announce(counter.textContent ?? '');
    },
  }, reduced);
  // Embedded on someone else's page: no auto-rotation and no autoplay (CPU/battery); Play is up to the user.
  const calm = reduced || isEmbed();
  anim.rotate = !calm;

  const onPick = (e: MapLayerMouseEvent, hover: boolean, layer: string) => {
    const f = e.features?.[0];
    const cc = String(f?.properties?.cc ?? f?.properties?.iso2 ?? '');
    if (!cc || !host) return;
    if (hover) {
      const c = travel?.countries[cc];
      const lv = st.adv === 'off' ? 0 : advisoryLevel(c, st.adv === 'all' ? 'all' : 'vb');
      host.showPopup(e.lngLat, h('div', { class: 'pop' },
        h('p', { class: 'pop-title' }, name(cc)),
        layer !== L.hit || countOf(cc) ? h('p', null, h('span', { class: 'pill imported' }, t('common.cases', { n: fmtNum(countOf(cc)) }))) : null,
        lv && travel ? h('p', null, levelBadge(lv, travel)) : null), true);
    } else {
      host.hidePopup();
      choose(cc, true);
    }
  };
  const overlay = host ? new ImportedOverlay(host, anim, onPick) : null;
  if (overlay) overlay.adv = st.adv;

  // ---------------- panel: header controls
  const totalLine = h('p', { class: 'result-line' });
  const warnBox = h('div');
  const yearSel = select(t('common.year'), [{ value: 'all', label: t('imported.allYears') }, ...years.map((y) => ({ value: String(y), label: String(y) }))],
    st.year === null ? 'all' : String(st.year), (v) => {
      st = { ...st, year: v === 'all' ? null : Number(v) };
      update();
      startTimeline(!calm);
    });
  const speedSeg = segmented<'1' | '2' | '4'>(t('map.speed'), [{ value: '1', label: '1×' }, { value: '2', label: '2×' }, { value: '4', label: '4×' }], '1', (v) => (anim.speed = Number(v)));
  playBtn.addEventListener('click', () => (animPlaying ? anim.pause() : anim.play()));
  scrub.addEventListener('input', () => {
    anim.pause();
    anim.seek(Number(scrub.value));
  });
  anim.speed = 1;
  const playRow = h('div', { class: 'play-row' }, playBtn);
  const countryBox = h('div', { class: 'country-box', 'aria-live': 'polite' });
  const rankList = h('ol', { class: 'rank-list rank-countries' });

  // tabs
  const tb = tabs<ImportedTab>(t('imported.tabsLabel'), [
    { id: 'rank', label: t('imported.tabRank') },
    { id: 'adv', label: t('imported.tabAdv') },
    { id: 'news', label: t('imported.tabNews') },
  ], st.tab, (id) => {
    st = { ...st, tab: id };
    persist();
  });
  tb.panels.rank.append(rankList);

  pnl.body.append(
    section(null, yearSel, totalLine, warnBox,
      h('div', { class: 'anim-box' }, playRow, h('div', { class: 'scrub-row' }, scrub), speedSeg, counter,
        approximate ? h('p', { class: 'hint' }, t('imported.approxEvents')) : null,
        h('p', { class: 'hint' }, t('imported.range', { from: fmtDate(data.from), to: fmtDate(data.to) })))),
    countryBox,
    h('div', { class: 'tabs-wrap' }, tb.bar, tb.panels.rank, tb.panels.adv, tb.panels.news),
  );

  // ---------------- advisory tab
  function renderAdvTab(): void {
    const box = tb.panels.adv;
    clear(box);
    if (travelOff) return void box.append(unavailableState());
    if (!travel) return void box.append(errorCard('', () => location.reload(), travelErr instanceof DataError ? travelErr.file : 'travel.json'));
    const seg = segmented<AdvLayer>(t('imported.advLayer'), [
      { value: 'vb', label: t('imported.advVb') },
      { value: 'all', label: t('imported.advAll') },
      { value: 'off', label: t('imported.advOff') },
    ], st.adv, (v) => {
      st = { ...st, adv: v };
      overlay?.setAdv(v);
      renderAdvTab();
      persist();
    });
    const hist = levelHistogram(levelsByCountry(travel, st.adv === 'all' ? 'all' : 'vb'));
    const lang = getLang();
    const legend = h('ul', { class: 'def-list adv-legend' }, ...([3, 2, 1] as const).map((k) => {
      const l = travel.levels[String(k) as '1'];
      return h('li', { class: 'def-item' }, h('span', { class: 'lg-square', style: { '--sw': `var(--adv-${k})` }, 'aria-hidden': 'true' }),
        h('span', null, h('span', { class: 'def-name' }, lang === 'en' ? l.en : l.zh), h('span', { class: 'def-count' }, t('imported.nCountries', { n: fmtNum(hist[k]) }))),
        h('span', { class: 'def-text' }, lang === 'en' ? l.adviceEn : l.adviceZh));
    }));
    box.append(seg, h('p', { class: 'hint' }, st.adv === 'all' ? t('imported.advAllNote') : t('imported.advVbNote')), legend,
      h('p', { class: 'hint' }, t('imported.travelSource', { time: travel.updated ? fmtDate(travel.updated.slice(0, 10)) : '—' }), ' ', safeTravelLink()));
  }

  // ---------------- news tab
  const diseaseFilter = new Set<VbKey>();
  let newsShown = NEWS_PAGE;
  function renderNewsTab(): void {
    const box = tb.panels.news;
    clear(box);
    if (travelOff) return void box.append(unavailableState());
    if (!travel) return void box.append(errorCard('', () => location.reload(), travelErr instanceof DataError ? travelErr.file : 'travel.json'));
    const chips = h('div', { class: 'chip-row', role: 'group', 'aria-label': t('imported.filterDisease') }, ...VB_KEYS.map((d) =>
      h('button', { type: 'button', class: 'fchip', 'aria-pressed': String(diseaseFilter.has(d)), on: { click: () => {
        if (diseaseFilter.has(d)) diseaseFilter.delete(d);
        else diseaseFilter.add(d);
        newsShown = NEWS_PAGE;
        renderNewsTab();
        (box.querySelector(`.fchip[data-d="${d}"]`) as HTMLElement | null)?.focus();
      } }, dataset: { d } }, diseaseName(d, travel))));
    const items = filterNews(travel.news, { diseases: diseaseFilter });
    const list = h('ol', { class: 'news-list' }, ...items.slice(0, newsShown).map((n) => newsItem(n, travel, choose)));
    box.append(chips, h('p', { class: 'hint' }, t('imported.newsCount', { n: fmtNum(items.length) })), list);
    if (items.length > newsShown) {
      box.append(h('button', { type: 'button', class: 'btn more-btn', on: { click: () => {
        newsShown += NEWS_PAGE;
        renderNewsTab();
        (box.querySelectorAll('.news-item')[newsShown - NEWS_PAGE] as HTMLElement | undefined)?.querySelector<HTMLElement>('a,button')?.focus();
      } } }, t('imported.more', { n: fmtNum(Math.min(NEWS_PAGE, items.length - newsShown)) })));
    }
  }

  // ---------------- country detail
  function renderCountry(): void {
    clear(countryBox);
    const cc = st.country;
    if (!cc) return;
    const c = data.countries[cc];
    const tc = travel?.countries[cc];
    const lang = getLang();
    const head = h('div', { class: 'country-head' }, h('h2', { class: 'country-name' }, name(cc)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('common.close'), on: { click: () => choose(null, false) } }, icon('close')));
    const adv = h('div', { class: 'adv-badges' });
    if (travel) {
      if (tc?.vb.length) {
        for (const a of [...tc.vb].sort((x, y) => y.level - x.level)) {
          const area = lang === 'en' ? a.areaEn : a.areaZh;
          adv.append(h('div', { class: `adv-badge lv-${a.level}` }, h('span', { class: 'adv-d' }, diseaseName(a.d, travel)), levelBadge(a.level, travel),
            h('span', { class: 'adv-meta' }, [a.since ? t('imported.since', { date: fmtDate(a.since) }) : '', area].filter(Boolean).join(' · '))));
        }
      } else adv.append(h('p', { class: 'hint' }, t('imported.noVbAdvisory')));
      if (tc && tc.level) adv.append(h('p', { class: 'hint' }, t('imported.allLevel'), ' ', levelBadge(tc.level, travel)));
    }
    const yearsBox = h('ul', { class: 'year-bars' });
    const byYear = c ? Object.entries(c.byYear).sort((a, b) => b[0].localeCompare(a[0])) : [];
    const ymax = Math.max(1, ...byYear.map((r) => r[1]));
    for (const [y, n] of byYear) yearsBox.append(h('li', null, h('span', null, y), h('span', { class: 'yb', 'aria-hidden': 'true' }, h('i', { style: { '--w': `${(n / ymax) * 100}%` } })), h('span', { class: 'num' }, fmtNum(n))));
    const news = travel ? filterNews(travel.news, { country: cc }).slice(0, 5) : [];
    const items = notices?.[cc] ?? [];
    countryBox.append(h('section', { class: 'country-card', 'aria-label': name(cc) }, head,
      travel ? h('div', null, h('h3', { class: 'psec-title' }, t('imported.advisoriesFor')), adv) : null,
      h('div', null, h('h3', { class: 'psec-title' }, t('imported.casesByYear')), byYear.length ? yearsBox : h('p', { class: 'hint' }, t('imported.noCases'))),
      travel ? h('div', null, h('h3', { class: 'psec-title' }, t('imported.latestNews')),
        news.length ? h('ol', { class: 'news-list' }, ...news.map((n) => newsItem(n, travel, choose, cc))) : h('p', { class: 'hint' }, t('imported.noNews'))) : null,
      h('div', null, h('h3', { class: 'psec-title' }, t('imported.notices', { country: name(cc) })),
        lang === 'en' && items.length ? h('p', { class: 'hint' }, h('span', { class: 'orig-zh' }, t('imported.originalZh'))) : null,
        items.length ? h('ul', { class: 'notices' }, ...items.map((n) => h('li', { class: 'notice' },
          n.date ? h('span', { class: 'notice-date' }, fmtDate(n.date)) : null,
          h('p', { class: 'notice-h', lang: 'zh-Hant-TW' }, n.headline),
          n.text ? h('p', { class: 'notice-text', lang: 'zh-Hant-TW' }, n.text) : null,
          n.url ? h('div', { class: 'notice-meta' }, withIcon(extLink(n.url, t('imported.readMore')))) : null))) : h('p', { class: 'hint' }, t('imported.noNotices'))),
      h('p', null, safeTravelLink())));
  }

  function choose(cc: string | null, fly: boolean): void {
    st = { ...st, country: cc && st.country === cc && !fly ? null : cc };
    overlay?.setSelected(st.country);
    renderCountry();
    renderRank();
    persist();
    if (fly && st.country && host) {
      const c = coords.get(st.country) ?? worldCentroids.get(st.country);
      if (c) {
        anim.interacted();
        const mid = greatCircle(c, TAIWAN, 2)[1]!;
        host.map.easeTo({ center: mid, zoom: isMobile() ? 1.3 : 1.9, duration: reduced ? 0 : 900, padding: host.padding() });
      }
      if (isMobile()) pnl.el.dataset.state = 'expanded';
    }
  }

  function renderRank(): void {
    const rows = Object.keys(data.countries).map((cc) => [cc, countOf(cc)] as const).filter((r) => r[1] > 0).sort((a, b) => b[1] - a[1]);
    const max = rows[0]?.[1] ?? 1;
    clear(rankList);
    for (const [cc, n] of rows) {
      rankList.append(h('li', null, h('button', { type: 'button', class: 'rank-btn', 'aria-pressed': String(st.country === cc), on: { click: () => choose(cc, true) } },
        h('span', { class: 'rank-name' }, name(cc)),
        h('span', { class: 'rank-bar single', style: { '--w': `${Math.max(3, (n / max) * 100)}%`, background: 'var(--imported)' }, 'aria-hidden': 'true' }),
        h('span', { class: 'rank-val' }, fmtNum(n)))));
    }
  }

  function update(): void {
    const rows = Object.keys(data.countries).map((cc) => [cc, countOf(cc)] as const).filter((r) => r[1] > 0).sort((a, b) => b[1] - a[1]);
    const max = rows[0]?.[1] ?? 1;
    const total = rows.reduce((s, r) => s + r[1], 0);
    totalLine.textContent = rows.length ? t('imported.total', { n: fmtNum(total), c: fmtNum(rows.length) }) : t('imported.empty');
    clear(warnBox);
    const w0 = importedShortfall(manifest?.warnings ?? [], st.year);
    const wn = w0 ? notice([warningText(w0)]) : null;
    if (wn) warnBox.append(wn);
    renderRank();
    const arcs: GeoJSON.Feature[] = [];
    for (const [cc, n] of rows) {
      const line = anim.arcs.get(cc);
      if (line && line.length > 1) arcs.push({ type: 'Feature', properties: { cc, n, w: 1 + 5 * Math.sqrt(n / max) }, geometry: { type: 'LineString', coordinates: line } });
    }
    overlay?.setArcs({ type: 'FeatureCollection', features: arcs });
    app.mapSummary(`${totalLine.textContent} ${rows.slice(0, 5).map(([cc, n]) => `${name(cc)} ${n}`).join(', ')}`);
    app.announce(totalLine.textContent ?? '');
    persist();
  }

  function startTimeline(play: boolean): void {
    const [a, b] = rangeOf(st.year);
    scrub.min = String(a);
    scrub.max = String(b);
    anim.setRange(a, b, play ? a : b);
    if (play) anim.play();
    else anim.pause();
  }

  function persist(): void {
    app.setParams(serializeImportedParams(st, years));
  }

  // ---------------- world topology (lazy, after first paint)
  const worldCentroids = new Map<string, LngLat>();
  async function loadWorld(): Promise<void> {
    try {
      const topo = await loadData('geo/world.topo.json', (v) => validateTopology(v, 'geo/world.topo.json', ['countries']));
      if (destroyed) return;
      const fc = feature(topo, topo.objects.countries as GeometryCollection<{ iso2: string }>) as unknown as GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, { iso2: string }>;
      const lv = travel ? levelsByCountry(travel, 'vb') : new Map<string, number>();
      const la = travel ? levelsByCountry(travel, 'all') : new Map<string, number>();
      const feats: GeoJSON.Feature[] = [];
      for (const f of fc.features) {
        const iso2 = f.properties?.iso2;
        if (!f.geometry || typeof iso2 !== 'string' || !/^[a-z]{2}$/.test(iso2)) continue;
        worldCentroids.set(iso2, centroidOf(f.geometry));
        feats.push({ type: 'Feature', properties: { iso2, v: lv.get(iso2) ?? 0, a: la.get(iso2) ?? 0 }, geometry: f.geometry });
      }
      overlay?.setWorld({ type: 'FeatureCollection', features: feats });
    } catch (e) {
      console.warn('world topology unavailable', e);
    }
  }

  // ---------------- go
  renderAdvTab();
  renderNewsTab();
  update();
  renderCountry();
  playBtn.append(icon('play'), h('span', null, t('imported.play')));
  if (overlay && host) {
    host.setOverlay(overlay);
    const mobile = isMobile();
    host.map.jumpTo({ center: mobile ? [112, 6] : [110, 12], zoom: mobile ? 0.95 : 1.8, padding: host.padding() });
    const stopRotate = () => anim.interacted();
    const canvas = host.map.getCanvasContainer();
    for (const ev of ['pointerdown', 'wheel', 'touchstart', 'keydown']) canvas.addEventListener(ev, stopRotate, { passive: true });
    cleanup.push(() => { for (const ev of ['pointerdown', 'wheel', 'touchstart', 'keydown']) canvas.removeEventListener(ev, stopRotate); });
  }
  startTimeline(!calm && !st.country);
  void loadWorld();

  return {
    destroy() {
      destroyed = true;
      anim.destroy();
      for (const c of cleanup) c();
      app.mapSummary('');
    },
  };
}

// ------------------------------------------------------------------ small components
function diseaseName(d: VbKey, travel: Travel): string {
  return getLang() === 'en' ? travel.diseases[d].en : travel.diseases[d].zh;
}

function levelBadge(level: number, travel: Travel): HTMLElement {
  const l = travel.levels[String(level) as '1'];
  return h('span', { class: `lv-badge lv-${level}` }, l ? (getLang() === 'en' ? l.en : l.zh) : String(level));
}

function withIcon(a: HTMLElement): HTMLElement {
  if (a.tagName === 'A') a.append(icon('external'));
  return a;
}

function safeTravelLink(): HTMLElement {
  return withIcon(extLink(SAFETRAVEL, t('imported.safetravel')));
}

function newsItem(n: TravelNews, travel: Travel, choose: (cc: string, fly: boolean) => void, current?: string): HTMLElement {
  const en = getLang() === 'en';
  const headline = (en ? n.headlineEn : n.headlineZh) || n.headlineZh || n.headlineEn;
  const summary = (en ? n.summaryEn : n.summaryZh) || n.summaryZh || n.summaryEn;
  const isZhFallback = en && !n.headlineEn;
  return h('li', { class: 'news-item' },
    h('div', { class: 'news-meta' }, h('time', { datetime: n.date }, fmtDate(n.date)), ...n.d.map((d) => h('span', { class: `dchip d-${d}` }, diseaseName(d, travel)))),
    h('p', { class: 'news-h', lang: isZhFallback ? 'zh-Hant-TW' : undefined }, headline),
    summary ? h('p', { class: 'news-s', lang: isZhFallback ? 'zh-Hant-TW' : undefined }, summary) : null,
    h('div', { class: 'news-foot' },
      n.countries.length ? h('span', { class: 'news-cc' }, ...n.countries.slice(0, 8).map((cc) =>
        h('button', { type: 'button', class: 'cc-btn', 'aria-pressed': current === cc ? 'true' : undefined, on: { click: () => choose(cc, true) } }, countryName(cc, travel.countries[cc]?.zh)))) : null,
      n.url ? withIcon(extLink(n.url, t('imported.source'))) : null));
}
