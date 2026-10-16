// Local minimal basemap used when OpenFreeMap is unreachable: themed sea/land + county/town
// boundaries from data/geo/admin.topo.json (+ a graticule so the globe still reads as a globe).
// No glyphs/sprites → zero network dependencies beyond our own origin.
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Admin } from '../lib/admin';
import { graticule } from '../lib/geo';
import type { Palette } from './palette';

export const FALLBACK_NAME = 'dm-fallback';
export const BLANK_NAME = 'dm-blank';
const ADMIN_ATTR = '© 內政部國土測繪中心 (taiwan-atlas)';

export function blankStyle(p: Palette): StyleSpecification {
  return { version: 8, name: BLANK_NAME, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': p.sea } }] };
}

export function fallbackStyle(p: Palette, admin: Admin | null): StyleSpecification {
  const style: StyleSpecification = {
    version: 8,
    name: FALLBACK_NAME,
    sources: {
      'fb-grat': { type: 'geojson', data: graticule(15) },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': p.sea } },
      { id: 'grat', type: 'line', source: 'fb-grat', maxzoom: 7, paint: { 'line-color': p.border, 'line-opacity': 0.55, 'line-width': ['case', ['==', ['get', 'eq'], 1], 1.2, 0.6] } },
    ],
  };
  if (admin) {
    style.sources['fb-land'] = { type: 'geojson', data: admin.countiesFC, attribution: ADMIN_ATTR };
    style.sources['fb-tl'] = { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: admin.townLines } };
    style.sources['fb-cl'] = { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: admin.countyLines } };
    style.layers.push(
      { id: 'land', type: 'fill', source: 'fb-land', paint: { 'fill-color': p.land, 'fill-antialias': true } },
      { id: 'town-lines', type: 'line', source: 'fb-tl', minzoom: 7.2, paint: { 'line-color': p.border, 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.4, 12, 1.2] } },
      { id: 'county-lines', type: 'line', source: 'fb-cl', paint: { 'line-color': p.borderStrong, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 10, 1.8] } },
    );
  }
  return style;
}
