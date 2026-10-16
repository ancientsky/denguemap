// The ONE MapLibre instance shared by the map / clusters / vector / imported views.
// - Basemap: OpenFreeMap positron (light) / dark, label language switched per UI language.
// - Resilience: if the style fails or times out (8 s), or its tiles keep failing, switch to a local
//   minimal style (fallback.ts) so the app works without any third-party network access.
// - Views attach an Overlay; it is (re)installed after every style load (theme switch = new style).
import {
  AttributionControl, Map as MLMap, NavigationControl, Popup, ScaleControl, setWorkerUrl,
  type LngLatLike, type MapLayerMouseEvent,
} from 'maplibre-gl';
import type { ExpressionSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import 'maplibre-gl/dist/maplibre-gl.css';
// Served from our own origin (CSP worker-src 'self'); MapLibre 6 is ESM-only with a separate module worker.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { t, getLang, type Lang } from '../i18n';
import { loadAdmin, type Admin } from '../lib/admin';
import { prefersReducedMotion } from '../lib/dom';
import { TAIWAN_BOUNDS, type BBox } from '../lib/geo';
import { Emitter } from '../lib/prefs';
import { getTheme, type Theme } from '../theme';
import { BLANK_NAME, FALLBACK_NAME, blankStyle, fallbackStyle } from './fallback';
import { readPalette, type Palette } from './palette';

setWorkerUrl(workerUrl);

const STYLE_URL: Record<Theme, string> = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const STYLE_TIMEOUT_MS = 8000;
const OSM_ATTR =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener noreferrer">© OpenMapTiles</a> ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>';

export interface OverlayCtx {
  map: MLMap;
  palette: Palette;
  /** Insert data layers below this basemap layer (first label layer) so place names stay readable. */
  beforeId: string | undefined;
  fallback: boolean;
  theme: Theme;
}
export interface Overlay {
  projection?: 'globe' | 'mercator';
  install(ctx: OverlayCtx): void;
  uninstall(map: MLMap): void;
}

export type BasemapMode = 'remote' | 'fallback';
export type PaddingFn = () => { top: number; right: number; bottom: number; left: number };

export class MapHost {
  readonly map: MLMap;
  readonly ready = new Emitter<OverlayCtx>();
  readonly basemapChanged = new Emitter<BasemapMode>();
  mode: BasemapMode = 'remote';
  private overlay: Overlay | null = null;
  private styleReady = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tileErrors = 0;
  private tilesOk = false;
  private admin: Admin | null = null;
  private popup: Popup | null = null;
  private ctx: OverlayCtx | null = null;
  padding: PaddingFn = () => ({ top: 24, right: 24, bottom: 24, left: 24 });

  constructor(container: HTMLElement) {
    const palette = readPalette();
    this.map = new MLMap({
      container,
      style: blankStyle(palette),
      bounds: TAIWAN_BOUNDS as [number, number, number, number],
      fitBoundsOptions: { padding: 20 },
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
      minZoom: 1,
      maxZoom: 16,
      reduceMotion: prefersReducedMotion(),
      localIdeographFontFamily: '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif',
      fadeDuration: prefersReducedMotion() ? 0 : 200,
      cancelPendingTileRequestsWhileZooming: true,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();
    this.map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    this.map.addControl(new ScaleControl({ maxWidth: 96, unit: 'metric' }), 'bottom-right');
    this.map.addControl(new AttributionControl({ compact: true }), 'bottom-right');

    this.map.on('style.load', () => this.onStyleLoad());
    this.map.on('error', (e) => this.onError(e as unknown as { sourceId?: string; tile?: unknown }));
    this.map.on('sourcedata', (e) => {
      if (this.mode === 'remote' && e.sourceId === 'openmaptiles' && e.tile) this.tilesOk = true;
    });
    this.map.on('idle', () => {
      if (this.styleReady) document.body.dataset.mapIdle = '1';
    });
    loadAdmin().then((a) => (this.admin = a), () => undefined);
    this.loadRemote();
  }

  // ------------------------------------------------------------------ basemap
  private loadRemote(): void {
    this.mode = 'remote';
    this.styleReady = false;
    this.tileErrors = 0;
    this.tilesOk = false;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.styleReady) void this.useFallback();
    }, STYLE_TIMEOUT_MS);
    this.map.setStyle(STYLE_URL[getTheme()], {
      diff: false,
      transformStyle: (_prev, next) => {
        // Uniform, link-safe attribution for the OSM-derived sources.
        const sources = Object.fromEntries(
          Object.entries(next.sources).map(([k, s]) => [k, 'attribution' in s || s.type === 'vector' ? { ...s, attribution: OSM_ATTR } : s]),
        ) as StyleSpecification['sources'];
        return { ...next, sources };
      },
    });
  }

  private fallbackPending = false;
  private async useFallback(): Promise<void> {
    if (this.fallbackPending || (this.mode === 'fallback' && this.styleReady)) return;
    this.fallbackPending = true;
    clearTimeout(this.timer);
    const wasRemote = this.mode === 'remote';
    this.mode = 'fallback';
    this.styleReady = false;
    if (!this.admin) {
      try {
        this.admin = await loadAdmin();
      } catch {
        this.admin = null;
      }
    }
    this.fallbackPending = false;
    this.map.setStyle(fallbackStyle(readPalette(), this.admin), { diff: false });
    if (wasRemote) this.basemapChanged.emit('fallback');
  }

  private onError(e: { sourceId?: string; tile?: unknown }): void {
    if (this.mode !== 'remote') return; // our own style: nothing third-party can fail
    if (!this.styleReady) {
      void this.useFallback();
      return;
    }
    if (e.tile || e.sourceId === 'openmaptiles') {
      this.tileErrors++;
      if (!this.tilesOk && this.tileErrors >= 3) void this.useFallback();
    }
  }

  private onStyleLoad(): void {
    const name = this.map.getStyle()?.name;
    if (name === BLANK_NAME) return;
    if (this.mode === 'remote' && name === FALLBACK_NAME) return;
    clearTimeout(this.timer);
    this.styleReady = true;
    if (this.mode === 'remote') this.applyLabelLang(getLang());
    this.applyProjection();
    this.installOverlay();
  }

  /** Theme switch: new basemap style; overlays re-install on style.load with the new palette. */
  setTheme(): void {
    this.popup?.remove();
    if (this.mode === 'fallback') {
      this.styleReady = false;
      this.map.setStyle(fallbackStyle(readPalette(), this.admin), { diff: false });
    } else this.loadRemote();
  }

  setLang(lang: Lang): void {
    this.popup?.remove();
    if (this.styleReady && this.mode === 'remote') this.applyLabelLang(lang);
    this.map.getContainer().setAttribute('aria-label', t('map.regionLabel'));
  }

  private applyLabelLang(lang: Lang): void {
    const field: ExpressionSpecification =
      lang === 'en'
        ? ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']]
        : ['coalesce', ['get', 'name:zh-Hant'], ['get', 'name:zh'], ['get', 'name']];
    for (const layer of this.map.getStyle()?.layers ?? []) {
      if (layer.type !== 'symbol' || layer.id.startsWith('dm-')) continue;
      const tf = this.map.getLayoutProperty(layer.id, 'text-field') as unknown;
      if (tf && JSON.stringify(tf).includes('name')) this.map.setLayoutProperty(layer.id, 'text-field', field);
    }
  }

  private applyProjection(): void {
    const want = this.overlay?.projection ?? 'mercator';
    try {
      this.map.setProjection({ type: want });
    } catch {
      /* globe unsupported → stay mercator */
    }
    if (this.map.getLayer('grat')) this.map.setLayoutProperty('grat', 'visibility', want === 'globe' ? 'visible' : 'none');
  }

  // ------------------------------------------------------------------ overlays
  private firstLabelLayer(): string | undefined {
    if (this.mode !== 'remote') return undefined;
    return this.map.getStyle()?.layers.find((l) => l.type === 'symbol')?.id;
  }

  private installOverlay(): void {
    if (!this.overlay || !this.styleReady) return;
    this.ctx = { map: this.map, palette: readPalette(), beforeId: this.firstLabelLayer(), fallback: this.mode === 'fallback', theme: getTheme() };
    // Idempotent: clear anything a previous install left in this style before adding again.
    try {
      this.overlay.uninstall(this.map);
    } catch {
      /* nothing to remove */
    }
    this.overlay.install(this.ctx);
    this.ready.emit(this.ctx);
  }

  setOverlay(o: Overlay | null): void {
    this.popup?.remove();
    if (this.overlay && this.styleReady) {
      try {
        this.overlay.uninstall(this.map);
      } catch {
        /* style may have been replaced */
      }
    }
    this.overlay = o;
    if (this.styleReady) {
      this.applyProjection();
      this.installOverlay();
    }
  }

  isReady(): boolean {
    return this.styleReady;
  }
  getCtx(): OverlayCtx | null {
    return this.styleReady ? this.ctx : null;
  }

  // ------------------------------------------------------------------ camera & popups
  fit(b: BBox, maxZoom = 11): void {
    const pad = this.padding();
    this.map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: pad, maxZoom, duration: prefersReducedMotion() ? 0 : 700 });
  }

  jump(center: LngLatLike, zoom: number): void {
    if (prefersReducedMotion()) this.map.jumpTo({ center, zoom });
    else this.map.easeTo({ center, zoom, duration: 800 });
  }

  showPopup(lngLat: LngLatLike, content: HTMLElement, hover = false): Popup {
    this.popup?.remove();
    this.popup = new Popup({ closeButton: !hover, closeOnClick: true, maxWidth: '300px', offset: 10, className: 'dm-popup', focusAfterOpen: !hover })
      .setLngLat(lngLat)
      .setDOMContent(content)
      .addTo(this.map);
    return this.popup;
  }
  hidePopup(): void {
    this.popup?.remove();
    this.popup = null;
  }

  /** Pointer cursor + hover/click handlers for a layer. Returns an unbind function. */
  interactive(layerId: string, onPick: (e: MapLayerMouseEvent, hover: boolean) => void): () => void {
    const m = this.map;
    const hoverable = matchMedia('(hover: hover) and (pointer: fine)').matches;
    let hovering = false;
    let lastKey: unknown = undefined;
    const enter = () => (m.getCanvas().style.cursor = 'pointer');
    const leave = () => {
      m.getCanvas().style.cursor = '';
      lastKey = undefined;
      if (hovering) {
        hovering = false;
        this.hidePopup();
      }
    };
    const move = (e: MapLayerMouseEvent) => {
      if (!hoverable) return;
      const f = e.features?.[0];
      const key = f ? (f.id ?? JSON.stringify(f.properties)) : undefined;
      if (hovering && key === lastKey) return; // same feature: keep the popup, avoid churn
      lastKey = key;
      hovering = true;
      onPick(e, true);
    };
    const click = (e: MapLayerMouseEvent) => {
      hovering = false;
      lastKey = undefined;
      onPick(e, false);
    };
    m.on('mouseenter', layerId, enter);
    m.on('mouseleave', layerId, leave);
    m.on('mousemove', layerId, move);
    m.on('click', layerId, click);
    return () => {
      m.off('mouseenter', layerId, enter);
      m.off('mouseleave', layerId, leave);
      m.off('mousemove', layerId, move);
      m.off('click', layerId, click);
    };
  }

  resize(): void {
    this.map.resize();
  }
}

/** Remove layers then sources if present (tolerant of a replaced style). */
export function removeAll(map: MLMap, layers: string[], sources: string[]): void {
  for (const l of layers) if (map.getLayer(l)) map.removeLayer(l);
  for (const s of sources) if (map.getSource(s)) map.removeSource(s);
}
