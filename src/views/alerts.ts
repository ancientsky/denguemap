// 防疫公告 UI shared by the map and clusters views (the map view loads it only when a notice is in force; the data
// loader is in lib/alerts.ts): the map layers (warning-area
// villages, places visited by cases, blood-test stations), the floating notice chip, the notice dialog with
// directions, calendar files and the on-device "am I inside a warning area?" check. Text is set with textContent only.
import type { Map as MLMap, MapLayerMouseEvent } from 'maplibre-gl';
import { fmtDate, getLang } from '../i18n';
import {
  alertBBox, loadAlertIndex, locateInAlerts, stationIcs, stationStatus,
  type AlertIndexEntry, type DengueAlert, type ScreeningStation,
} from '../lib/alerts';
import { downloadBlob } from '../lib/csv';
import { todayTaipei } from '../lib/dates';
import { directionsUrl } from '../lib/directions';
import { clear, extLink, h, nextId } from '../lib/dom';
import { icon } from '../lib/icons';
import type { MapHost, Overlay, OverlayCtx } from '../map/host';
import { addAlertIcons } from '../map/images';
import { removeAll } from '../map/layers';
import { at } from './alertsText';

const titleOf = (a: DengueAlert) => (getLang() === 'en' && a.titleEn ? a.titleEn : a.title);
const villageName = (v: { zh: string; en: string }) => (getLang() === 'en' && v.en ? v.en : v.zh);
const areaName = (a: DengueAlert) => at('areaTown', getLang() === 'en'
  ? { county: a.countyEn || a.countyZh, town: a.townEn || a.townZh }
  : { county: a.countyZh, town: a.townZh });
const short = (iso: string) => fmtDate(iso, 'short');

// ------------------------------------------------------------------ map layers
const S = { area: 'dm-al-area', places: 'dm-al-places', me: 'dm-al-me' };
const L = { fill: 'dm-al-fill', line: 'dm-al-line', places: 'dm-al-places', me: 'dm-al-me', meHalo: 'dm-al-me-halo' };
const ICON_STATION = 'dm-al-station', ICON_SITE = 'dm-al-site';
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export class AlertLayers {
  private alerts: DengueAlert[] = [];
  private me: [number, number] | null = null;
  private visible = true;
  private map: MLMap | null = null;
  private unbind: (() => void)[] = [];
  constructor(private host: MapHost, private onOpen: (a: DengueAlert) => void) {}

  setAlerts(alerts: DengueAlert[]): void {
    this.alerts = alerts;
    this.push();
  }
  /** Show or hide every notice layer (the panel switch). */
  setVisible(on: boolean): void {
    this.visible = on;
    if (!this.map) return;
    for (const id of Object.values(L)) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    if (!on) this.host.hidePopup();
  }
  setMe(pt: [number, number] | null): void {
    this.me = pt;
    this.push();
  }

  private areaFC(): GeoJSON.FeatureCollection {
    return { type: 'FeatureCollection', features: this.alerts.flatMap((a, i) => a.area.features.map((f) => ({ ...f, properties: { i, code: f.properties.code } }))) };
  }
  private placesFC(): GeoJSON.FeatureCollection {
    const today = todayTaipei();
    const out: GeoJSON.Feature[] = [];
    this.alerts.forEach((a, i) => {
      a.exposureSites.forEach((s, j) => s.lng !== null && s.lat !== null && out.push({ type: 'Feature', properties: { kind: 'site', i, j, past: 0 }, geometry: { type: 'Point', coordinates: [s.lng, s.lat] } }));
      a.screeningStations.forEach((s, j) => s.lng !== null && s.lat !== null && out.push({
        type: 'Feature', properties: { kind: 'station', i, j, past: stationStatus(s, today) === 'past' ? 1 : 0 }, geometry: { type: 'Point', coordinates: [s.lng, s.lat] } }));
    });
    // Places sharing a spot (e.g. a market that is both visited and a test station): spread the icons sideways.
    const groups = new Map<string, GeoJSON.Feature[]>();
    for (const f of out) {
      const k = (f.geometry as GeoJSON.Point).coordinates.join(',');
      groups.set(k, [...(groups.get(k) ?? []), f]);
    }
    for (const g of groups.values()) g.forEach((f, k) => (f.properties!.off = [(k - (g.length - 1) / 2) * 20, 0]));
    return { type: 'FeatureCollection', features: out };
  }
  private meFC(): GeoJSON.FeatureCollection {
    return this.me ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: this.me } }] } : EMPTY;
  }
  private push(): void {
    const m = this.map;
    if (!m) return;
    (m.getSource(S.area) as { setData?(d: unknown): void } | undefined)?.setData?.(this.areaFC());
    (m.getSource(S.places) as { setData?(d: unknown): void } | undefined)?.setData?.(this.placesFC());
    (m.getSource(S.me) as { setData?(d: unknown): void } | undefined)?.setData?.(this.meFC());
  }

  /** `below`: the view's lowest layer — the warning areas go under the view's own layers (cases, mosquito villages). */
  install({ map, palette: p }: OverlayCtx, below?: string): void {
    this.map = map;
    addAlertIcons(map, { station: ICON_STATION, site: ICON_SITE }, { station: p.local, site: p.adv[1], halo: p.halo, text: p.text });
    map.addSource(S.area, { type: 'geojson', data: this.areaFC() });
    map.addLayer({ id: L.fill, type: 'fill', source: S.area, paint: { 'fill-color': p.adv[1], 'fill-opacity': 0.16 } }, below);
    map.addLayer({ id: L.line, type: 'line', source: S.area, paint: { 'line-color': p.adv[2], 'line-width': 2, 'line-dasharray': [3, 2] } }, below);
    map.addSource(S.places, { type: 'geojson', data: this.placesFC() });
    map.addLayer({ id: L.places, type: 'symbol', source: S.places, layout: {
      'icon-image': ['match', ['get', 'kind'], 'station', ICON_STATION, ICON_SITE], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 15, 1.1], 'icon-offset': ['get', 'off'] }, paint: { 'icon-opacity': ['case', ['==', ['get', 'past'], 1], 0.45, 1] } });
    map.addSource(S.me, { type: 'geojson', data: this.meFC() });
    map.addLayer({ id: L.meHalo, type: 'circle', source: S.me, paint: { 'circle-radius': 14, 'circle-color': p.accent, 'circle-opacity': 0.2 } });
    map.addLayer({ id: L.me, type: 'circle', source: S.me, paint: { 'circle-radius': 6, 'circle-color': p.accent, 'circle-stroke-color': p.halo, 'circle-stroke-width': 2.5 } });
    if (!this.visible) this.setVisible(false);
    if (!this.unbind.length) {
      this.unbind.push(this.host.interactive(L.fill, (e, hv) => this.pick(e, hv)), this.host.interactive(L.places, (e, hv) => this.pick(e, hv)));
    }
  }

  uninstall(map: MLMap): void {
    for (const u of this.unbind) u();
    this.unbind = [];
    removeAll(map, [L.me, L.meHalo, L.places, L.line, L.fill], [S.me, S.places, S.area]);
    this.map = null;
  }

  private pick(e: MapLayerMouseEvent, hover: boolean): void {
    const pr = e.features?.[0]?.properties;
    const a = this.alerts[Number(pr?.i)];
    if (!pr || !a) return;
    // A warning area is a backdrop: where the view's own features (cases, mosquito villages, clinics…) are under
    // the pointer, their popup wins. Markers (stations, places) are deliberate targets and always answer.
    if (pr.kind === undefined && this.map?.queryRenderedFeatures(e.point).some((f) => f.layer.id.startsWith('dm-') && !f.layer.id.startsWith('dm-al-'))) return;
    let body: HTMLElement;
    if (pr.kind === 'station') {
      const s = a.screeningStations[Number(pr.j)];
      if (!s) return;
      body = h('div', { class: 'pop' }, h('p', { class: 'pop-kicker' }, at('stations')), stationBlock(a, s, false));
    } else if (pr.kind === 'site') {
      const s = a.exposureSites[Number(pr.j)];
      if (!s) return;
      body = h('div', { class: 'pop' }, h('p', { class: 'pop-kicker' }, at('sites')), h('p', { class: 'pop-title' }, s.name),
        h('p', { class: 'pop-sub' }, at('sitePeriod', { from: short(s.from), to: short(s.to) })), s.note ? h('p', { class: 'pop-sub' }, s.note) : null);
    } else {
      const v = a.villages.find((x) => x.code === pr.code);
      body = h('div', { class: 'pop' }, h('p', { class: 'pop-kicker' }, icon('alert'), titleOf(a)),
        h('p', { class: 'pop-title' }, at('popupArea', { village: v ? villageName(v) : '' })),
        h('p', { class: 'pop-sub' }, at('issued', { issuer: a.issuer, date: short(a.issuedAt) })),
        hover ? null : h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => this.onOpen(a) } }, at('popupOpen')));
    }
    this.host.showPopup(e.lngLat, body, hover);
  }
}

/** The view's overlay with the notice layers drawn on top of it. */
export function withAlerts(base: Overlay, layers: AlertLayers): Overlay {
  return {
    ...(base.projection ? { projection: base.projection } : {}),
    install(ctx) {
      const before = new Set(ctx.map.getStyle().layers.map((l) => l.id));
      base.install(ctx);
      layers.install(ctx, ctx.map.getStyle().layers.find((l) => !before.has(l.id))?.id);
    },
    uninstall(map) {
      layers.uninstall(map);
      base.uninstall(map);
    },
  };
}

// ------------------------------------------------------------------ notice content
function navLink(p: { address: string; lng: number | null; lat: number | null }): HTMLElement | null {
  const url = directionsUrl(p.address, p.lng ?? NaN, p.lat ?? NaN);
  return url ? extLink(url, at('navigate'), 'pop-action') : null;
}

function stationBlock(a: DengueAlert, s: ScreeningStation, withCalendar: boolean): HTMLElement {
  const st = stationStatus(s, todayTaipei());
  const badge = h('span', { class: `al-badge al-${st}` }, at(st === 'today' ? 'stToday' : st === 'upcoming' ? 'stUpcoming' : 'stPast'));
  const cal = withCalendar && st !== 'past' ? h('button', { type: 'button', class: 'btn btn-sm', on: { click: () => {
    const ics = stationIcs(a, s, at('calSummary', { name: s.name }), `${titleOf(a)}\n${at('symptoms')}`);
    downloadBlob(new Blob([ics], { type: 'text/calendar;charset=utf-8' }), `${a.id}-${s.name}.ics`.replace(/[\\/:*?"<>|\s]+/g, '_'));
  } } }, icon('calendar'), at('calendar')) : null;
  return h('div', { class: `al-place al-station${st === 'past' ? ' is-past' : ''}` },
    h('p', { class: 'al-place-title' }, h('span', null, s.name), badge),
    h('p', { class: 'al-place-meta' }, at('stDates', { dates: s.dates.map(short).join('、') })),
    h('p', { class: 'al-place-meta' }, at('stHours', { hours: s.hours.join('、') })),
    s.address ? h('p', { class: 'al-place-meta' }, s.address) : null,
    h('p', { class: 'al-actions' }, navLink(s), cal));
}

/** Full notice: area, places visited, stations, symptoms advice, source. */
export function alertCard(a: DengueAlert, onShow: ((a: DengueAlert) => void) | null): HTMLElement {
  const today = todayTaipei();
  const note = getLang() === 'en' ? a.noteEn : a.note;
  const ended = today > a.validUntil;
  return h('article', { class: `al-card${ended ? ' is-ended' : ''}` },
    h('h3', { class: 'al-title' }, icon('alert'), h('span', null, titleOf(a)), ended ? h('span', { class: 'al-badge al-past' }, at('statusEnded')) : null),
    h('p', { class: 'al-meta' }, `${at('issued', { issuer: a.issuer, date: fmtDate(a.issuedAt) })}・${at('validUntil', { date: fmtDate(a.validUntil) })}`),
    h('section', { class: 'al-sec' }, h('h4', null, at('area')), h('p', null, `${areaName(a)}：${a.villages.map(villageName).join(getLang() === 'en' ? ', ' : '、')}`)),
    a.exposureSites.length ? h('section', { class: 'al-sec' }, h('h4', null, at('sites')), ...a.exposureSites.map((s) => h('div', { class: 'al-place' },
      h('p', { class: 'al-place-title' }, h('span', null, s.name), h('span', { class: 'al-period' }, at('sitePeriod', { from: short(s.from), to: short(s.to) }))),
      s.address ? h('p', { class: 'al-place-meta' }, s.address) : null,
      s.note ? h('p', { class: 'al-place-meta' }, s.note) : null,
      h('p', { class: 'al-actions' }, navLink(s))))) : null,
    a.screeningStations.length ? h('section', { class: 'al-sec' }, h('h4', null, at('stations')),
      ...[...a.screeningStations].sort((x, y) => Number(stationStatus(x, today) === 'past') - Number(stationStatus(y, today) === 'past')).map((s) => stationBlock(a, s, true))) : null,
    h('p', { class: 'al-symptoms' }, at('symptoms')),
    note ? h('p', { class: 'al-note' }, note) : null,
    h('p', { class: 'al-foot' }, extLink(a.sourceUrl, at('source')), h('span', null, at('disclaimer'))),
    onShow ? h('p', { class: 'al-actions' }, h('button', { type: 'button', class: 'btn', on: { click: () => onShow(a) } }, icon('pin'), at('showOnMap'))) : null);
}

/** "Am I inside a warning area?" — browser geolocation, compared on the device only. */
function locationCheck(alerts: DengueAlert[], onLocated: ((pt: [number, number]) => void) | null): HTMLElement {
  const out = h('p', { class: 'al-me-result', role: 'status', 'aria-live': 'polite' });
  const btn = h('button', { type: 'button', class: 'btn', on: { click: () => {
    if (!('geolocation' in navigator)) {
      out.textContent = at('meUnsupported');
      return;
    }
    out.textContent = at('meChecking');
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition((pos) => {
      btn.disabled = false;
      const { longitude: lng, latitude: lat } = pos.coords;
      const r = locateInAlerts(alerts, lng, lat);
      out.classList.toggle('is-inside', r.inside);
      if (r.inside) out.textContent = at('meInside', { area: areaName(r.alert), village: villageName(r.village) });
      else out.textContent = at('meOutside') + (r.nearest ? ` ${at('meNearest', { area: areaName(r.nearest.alert), village: villageName(r.nearest.village), km: (r.nearest.meters / 1000).toFixed(1) })}` : '');
      onLocated?.([lng, lat]);
    }, (err) => {
      btn.disabled = false;
      out.textContent = err.code === err.PERMISSION_DENIED ? at('meDenied') : at('meError');
    }, { enableHighAccuracy: false, timeout: 15_000, maximumAge: 60_000 });
  } } }, icon('pin'), at('meButton'));
  return h('section', { class: 'al-sec al-me' }, h('h4', null, at('meTitle')), h('p', { class: 'al-actions' }, btn), out, h('p', { class: 'al-place-meta' }, at('mePrivacy')));
}

/** Modal dialog with every notice in force (the chosen one first) and the location check. */
export function openAlertDialog(alerts: DengueAlert[], first: DengueAlert | null, opts: { onShow: ((a: DengueAlert) => void) | null; onLocated: ((pt: [number, number]) => void) | null }): void {
  const ordered = first ? [first, ...alerts.filter((a) => a !== first)] : alerts;
  // The location check is about notices in force; a past notice opened from the history has none.
  const today = todayTaipei();
  const inForce = alerts.filter((a) => a.issuedAt <= today && today <= a.validUntil);
  const dlg = h('dialog', { class: 'al-dialog', 'aria-labelledby': 'al-dialog-title' });
  const close = () => dlg.close();
  const show = opts.onShow ? (a: DengueAlert) => { close(); opts.onShow!(a); } : null;
  dlg.append(
    h('header', { class: 'al-dialog-head' }, h('h2', { id: 'al-dialog-title' }, at('dialogTitle')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': at('close'), title: at('close'), on: { click: close } }, icon('close'))),
    h('div', { class: 'al-dialog-body' },
      inForce.length ? locationCheck(inForce, opts.onLocated ? (pt) => opts.onLocated!(pt) : null) : null,
      ...ordered.map((a) => alertCard(a, show))));
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close(); // backdrop
  });
  document.body.append(dlg);
  dlg.showModal();
}

/** Floating chip over the map (absolutely positioned: no layout shift when the notices arrive). */
export function alertChip(alerts: DengueAlert[], onOpen: () => void): HTMLElement {
  const label = alerts.length > 1 ? at('chipMore', { title: titleOf(alerts[0]!), n: alerts.length - 1 }) : at('chip', { title: titleOf(alerts[0]!) });
  return h('button', { type: 'button', class: 'al-chip', title: at('chipOpen'), 'aria-haspopup': 'dialog', on: { click: onOpen } }, icon('alert'), h('span', null, label));
}

/** Compact list for the clusters panel. */
export function alertSection(alerts: DengueAlert[], onOpen: (a: DengueAlert) => void, extra: HTMLElement | null = null): HTMLElement {
  const today = todayTaipei();
  return h('section', { class: 'psec al-section' },
    h('h2', { class: 'psec-title' }, at('sectionTitle')),
    h('ul', { class: 'list-cards' }, ...alerts.map((a) => h('li', null, h('button', { type: 'button', class: 'card-btn al-card-btn', on: { click: () => onOpen(a) } },
      h('span', { class: 'card-title' }, h('span', null, titleOf(a)), a.screeningStations.some((s) => stationStatus(s, today) === 'today') ? h('span', { class: 'al-badge al-today' }, at('stationToday')) : null),
      h('span', { class: 'card-meta' }, h('span', null, at('cardMeta', { date: short(a.issuedAt), n: a.villages.length })), h('span', null, a.issuer)))))),
    h('p', { class: 'hint' }, at('sectionNote')),
    extra);
}

/**
 * History search: every notice ever published, filtered by county and year; the list loads when the section is
 * first opened (user action: no request and no layout shift on page load).
 */
export function alertHistory(onPick: (id: string) => void, selected: string | null = null): HTMLElement {
  const body = h('div', { class: 'al-hist-body' });
  const det = h('details', { class: 'table-details al-hist' }, h('summary', null, at('histTitle')), body);
  if (selected) det.open = true;
  let loaded = false;
  const load = async () => {
    if (loaded) return;
    loaded = true;
    body.replaceChildren(h('p', { class: 'hint' }, at('histLoading')));
    const index = await loadAlertIndex();
    if (!index) {
      loaded = false;
      body.replaceChildren(h('p', { class: 'hint' }, at('histError')));
      return;
    }
    renderList(index);
  };
  const renderList = (index: AlertIndexEntry[]) => {
    const today = todayTaipei();
    const en = getLang() === 'en';
    let county = '', year = '';
    const counties = [...new Map(index.map((e) => [e.county, en ? e.countyEn || e.countyZh : e.countyZh])).entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const years = [...new Set(index.map((e) => e.issuedAt.slice(0, 4)))].sort().reverse();
    const list = h('ul', { class: 'list-cards' });
    const count = h('p', { class: 'hint', role: 'status' });
    const draw = () => {
      const rows = index.filter((e) => (!county || e.county === county) && (!year || e.issuedAt.startsWith(year)));
      count.textContent = at('histCount', { n: rows.length });
      clear(list);
      if (!rows.length) list.append(h('li', { class: 'empty' }, at('histEmpty')));
      for (const e of rows) {
        const active = e.issuedAt <= today && today <= e.validUntil;
        list.append(h('li', null, h('button', { type: 'button', class: 'card-btn al-hist-item', 'aria-pressed': String(e.id === selected), dataset: { id: e.id }, on: { click: () => {
          selected = e.id;
          for (const b of list.querySelectorAll('.card-btn')) b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.id === e.id));
          onPick(e.id);
        } } },
          h('span', { class: 'card-title' }, h('span', null, en && e.titleEn ? e.titleEn : e.title),
            h('span', { class: `al-badge ${active ? 'al-today' : 'al-past'}` }, at(active ? 'statusActive' : 'statusEnded'))),
          h('span', { class: 'card-meta' }, at('histItemMeta', { from: short(e.issuedAt), to: short(e.validUntil), n: e.villages, issuer: e.issuer })))));
      }
    };
    const sel = (label: string, opts: [string, string][], on: (v: string) => void) => {
      const id = nextId('alh');
      const el = h('select', { id, class: 'select', on: { change: () => on(el.value) } }, ...opts.map(([v, l]) => h('option', { value: v }, l)));
      return h('div', { class: 'field' }, h('label', { for: id, class: 'field-label' }, label), h('div', { class: 'select-wrap' }, el, icon('chevronDown', 'icon select-chevron')));
    };
    body.replaceChildren(
      h('div', { class: 'field-row field-row-half' },
        sel(at('histCounty'), [['', at('histAllCounties')], ...counties], (v) => { county = v; draw(); }),
        sel(at('histYear'), [['', at('histAllYears')], ...years.map((y): [string, string] => [y, y])], (v) => { year = v; draw(); })),
      count, list);
    draw();
  };
  det.addEventListener('toggle', () => {
    if (det.open) void load();
  });
  if (selected) void load();
  return h('section', { class: 'psec al-section' }, det);
}

export { alertBBox };
export { loadActiveAlerts } from '../lib/alerts';
