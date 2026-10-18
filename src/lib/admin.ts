// Administrative boundaries (geo/admin.topo.json) → lookups + GeoJSON, built once.
import { feature, mesh } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import { loadAdminTopo } from './data';
import { bboxOf, type BBox } from './geo';

export interface Place {
  code: string;
  zh: string;
  en: string;
  bbox: BBox | null;
}
export interface Town extends Place {
  county: string;
}
export interface Admin {
  counties: Place[]; // sorted by code order commonly used (north → south roughly by code)
  countyByCode: Map<string, Place>;
  countyByZh: Map<string, Place>;
  towns: Map<string, Town>;
  countiesFC: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, { code: string }>;
  townsFC: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, { code: string; county: string }>;
  /** County / town boundary lines (built lazily: only the offline fallback basemap draws them). */
  readonly countyLines: GeoJSON.MultiLineString;
  readonly townLines: GeoJSON.MultiLineString;
}

// Conventional north-to-south ordering used by Taiwan government lists.
const ORDER = ['63000', '65000', '68000', '66000', '67000', '64000', '10017', '10018', '10004', '10005', '10007', '10008', '10009', '10020', '10010', '10013', '10002', '10015', '10014', '10016', '09020', '09007'];

const str = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 40) : '');

function build(topo: Topology): Admin {
  const cObj = topo.objects.counties as GeometryCollection<Record<string, unknown>>;
  const tObj = topo.objects.towns as GeometryCollection<Record<string, unknown>>;
  const cFC = feature(topo, cObj) as unknown as GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, Record<string, unknown>>;
  const tFC = feature(topo, tObj) as unknown as GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, Record<string, unknown>>;
  const counties: Place[] = [];
  const countyByCode = new Map<string, Place>();
  const countyByZh = new Map<string, Place>();
  const countiesFC: Admin['countiesFC'] = { type: 'FeatureCollection', features: [] };
  for (const f of cFC.features) {
    const code = str(f.properties?.code);
    if (!/^\d{5}$/.test(code) || !f.geometry) continue;
    const p: Place = { code, zh: str(f.properties?.zh), en: str(f.properties?.en), bbox: bboxOf(f.geometry) };
    counties.push(p);
    countyByCode.set(code, p);
    countyByZh.set(p.zh, p);
    countyByZh.set(p.zh.replace(/臺/g, '台'), p);
    countiesFC.features.push({ type: 'Feature', id: Number(code), properties: { code }, geometry: f.geometry });
  }
  counties.sort((a, b) => {
    const ia = ORDER.indexOf(a.code), ib = ORDER.indexOf(b.code);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.code.localeCompare(b.code);
  });
  const towns = new Map<string, Town>();
  const townsFC: Admin['townsFC'] = { type: 'FeatureCollection', features: [] };
  for (const f of tFC.features) {
    const code = str(f.properties?.code);
    if (!/^\d{8}$/.test(code) || !f.geometry) continue;
    const county = str(f.properties?.county) || code.slice(0, 5);
    towns.set(code, { code, county, zh: str(f.properties?.zh), en: str(f.properties?.en), bbox: bboxOf(f.geometry) });
    townsFC.features.push({ type: 'Feature', id: Number(code), properties: { code, county }, geometry: f.geometry });
  }
  // The boundary meshes are only drawn by the offline fallback basemap: build them on first use.
  let countyLines: GeoJSON.MultiLineString | undefined;
  let townLines: GeoJSON.MultiLineString | undefined;
  return {
    counties, countyByCode, countyByZh, towns, countiesFC, townsFC,
    get countyLines() {
      return (countyLines ??= mesh(topo, cObj) as GeoJSON.MultiLineString);
    },
    get townLines() {
      return (townLines ??= mesh(topo, tObj, (a, b) => a !== b) as GeoJSON.MultiLineString);
    },
  };
}

let adminP: Promise<Admin> | null = null;
export function loadAdmin(): Promise<Admin> {
  if (!adminP) {
    adminP = loadAdminTopo().then(build);
    adminP.catch(() => (adminP = null));
  }
  return adminP;
}
