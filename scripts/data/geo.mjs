// @ts-check
/**
 * Geography: taiwan-atlas (MOI 2021 boundaries) loading, point-in-polygon
 * lookup (bbox prefilter + nearest-town fallback for coastal points) and
 * generation of the TopoJSON files shipped to the browser.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { bbox as topoBbox, feature, quantize } from 'topojson-client';
import { topology } from 'topojson-server';
import { presimplify, simplify } from 'topojson-simplify';
import { NEAREST_TOWN_MAX_M } from './config.mjs';
import { cmp, normTai } from './util.mjs';

const require = createRequire(import.meta.url);

/** @typedef {number[][]} Ring */
/** @typedef {Ring[]} Polygon */

/** Weight (deg^2) below which vertices are dropped for the display topology. */
const ADMIN_SIMPLIFY_WEIGHT = 1e-6;
const ADMIN_QUANTIZE = 1e5;
const VILLAGE_SIMPLIFY_WEIGHT = 2e-7;
const VILLAGE_QUANTIZE = 1e5;

/**
 * @param {Ring} ring @param {number} x @param {number} y
 */
function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Even-odd across the rings of one polygon (handles holes). */
function polygonContains(/** @type {Polygon} */ poly, /** @type {number} */ x, /** @type {number} */ y) {
  let inside = false;
  for (const ring of poly) if (ringContains(ring, x, y)) inside = !inside;
  return inside;
}

const M_PER_DEG_LAT = 110574;
/** Distance in metres from (x,y) to segment a-b on a local equirectangular plane. */
function segDistM(/** @type {number[]} */ a, /** @type {number[]} */ b, /** @type {number} */ x, /** @type {number} */ y) {
  const kx = 111320 * Math.cos((y * Math.PI) / 180);
  const ax = (a[0] - x) * kx, ay = (a[1] - y) * M_PER_DEG_LAT;
  const bx = (b[0] - x) * kx, by = (b[1] - y) * M_PER_DEG_LAT;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/**
 * Polygon lookup with bbox prefilter.
 */
export class PolyIndex {
  /** @param {Polygon[][]} geoms one entry per feature: list of polygons */
  constructor(geoms) {
    this.geoms = geoms;
    /** @type {Float64Array} */
    this.bbox = new Float64Array(geoms.length * 4);
    geoms.forEach((polys, i) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const poly of polys) {
        for (const ring of poly) {
          for (const [x, y] of ring) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      this.bbox.set([x0, y0, x1, y1], i * 4);
    });
  }

  /** Index of the feature containing the point, or -1. */
  locate(/** @type {number} */ x, /** @type {number} */ y) {
    const bb = this.bbox;
    for (let i = 0; i < this.geoms.length; i++) {
      const o = i * 4;
      if (x < bb[o] || x > bb[o + 2] || y < bb[o + 1] || y > bb[o + 3]) continue;
      for (const poly of this.geoms[i]) if (polygonContains(poly, x, y)) return i;
    }
    return -1;
  }

  /**
   * Nearest feature (by boundary distance) within maxM metres.
   * @returns {{index:number, distM:number}|null}
   */
  nearest(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ maxM) {
    const padY = maxM / M_PER_DEG_LAT;
    const padX = maxM / (111320 * Math.cos((y * Math.PI) / 180));
    const bb = this.bbox;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.geoms.length; i++) {
      const o = i * 4;
      if (x < bb[o] - padX || x > bb[o + 2] + padX || y < bb[o + 1] - padY || y > bb[o + 3] + padY) continue;
      for (const poly of this.geoms[i]) {
        for (const ring of poly) {
          for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
            const d = segDistM(ring[j], ring[k], x, y);
            if (d < bestD) { bestD = d; best = i; }
          }
        }
      }
    }
    return best >= 0 && bestD <= maxM ? { index: best, distM: bestD } : null;
  }
}

/** @param {any} f GeoJSON feature @returns {Polygon[]} */
function polygonsOf(f) {
  const g = f.geometry;
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

/**
 * @param {string} file e.g. "towns-10t.json"
 * @returns {Promise<any>}
 */
async function readAtlas(file) {
  const p = require.resolve(`taiwan-atlas/${file}`);
  return JSON.parse(await readFile(p, 'utf8'));
}

/**
 * @typedef {object} TownMeta
 * @property {string} code @property {string} county @property {string} zh @property {string} en
 * @typedef {object} CountyMeta
 * @property {string} code @property {string} zh @property {string} en
 */

/**
 * @param {{atlasLoader?: (file:string)=>Promise<any>}} [opts]
 */
export async function loadGeo(opts = {}) {
  const load = opts.atlasLoader ?? readAtlas;
  const townsTopo = await load('towns-10t.json');

  /** @type {CountyMeta[]} */
  const counties = townsTopo.objects.counties.geometries
    .map((/** @type {any} */ g) => ({
      code: String(g.properties.COUNTYCODE),
      zh: normTai(String(g.properties.COUNTYNAME)),
      en: String(g.properties.COUNTYENG),
    }))
    .sort((/** @type {CountyMeta} */ a, /** @type {CountyMeta} */ b) => cmp(a.code, b.code));

  const townFeatures = /** @type {any[]} */ (feature(townsTopo, townsTopo.objects.towns).features);
  /** @type {TownMeta[]} */
  const towns = townFeatures.map((f) => ({
    code: String(f.properties.TOWNCODE),
    county: String(f.properties.COUNTYCODE),
    zh: normTai(String(f.properties.TOWNNAME)),
    en: String(f.properties.TOWNENG),
  }));
  const townIndex = new PolyIndex(townFeatures.map(polygonsOf));

  /** @type {Map<string, string|null>} */
  const townCache = new Map();
  const townStats = { exact: 0, nearest: 0, none: 0 };

  /**
   * Town code for a point: inside a polygon, else nearest town within
   * NEAREST_TOWN_MAX_M (coastal points), else null.
   */
  function locateTown(/** @type {number} */ lng, /** @type {number} */ lat) {
    const key = `${lng},${lat}`;
    const hit = townCache.get(key);
    if (hit !== undefined) return hit;
    let code = null;
    const i = townIndex.locate(lng, lat);
    if (i >= 0) {
      code = towns[i].code;
      townStats.exact++;
    } else {
      const n = townIndex.nearest(lng, lat, NEAREST_TOWN_MAX_M);
      if (n) { code = towns[n.index].code; townStats.nearest++; } else townStats.none++;
    }
    townCache.set(key, code);
    return code;
  }

  const countyByName = new Map(counties.map((c) => [c.zh, c]));
  const townsByCounty = new Map();
  for (const t of towns) {
    const key = `${t.county}|${t.zh}`;
    townsByCounty.set(key, t);
  }

  /** Display TopoJSON for counties + towns (simplified, quantized). */
  function buildAdminTopo() {
    const mapGeoms = (/** @type {any[]} */ geoms, /** @type {(p:any)=>any} */ propsFn, /** @type {(p:any)=>string} */ keyFn) =>
      geoms
        .map((g) => ({ ...g, properties: propsFn(g.properties) }))
        .sort((a, b) => cmp(keyFn(a.properties), keyFn(b.properties)));
    const objects = {
      counties: {
        type: 'GeometryCollection',
        geometries: mapGeoms(
          townsTopo.objects.counties.geometries,
          (p) => ({ code: String(p.COUNTYCODE), zh: normTai(String(p.COUNTYNAME)), en: String(p.COUNTYENG) }),
          (p) => p.code,
        ),
      },
      towns: {
        type: 'GeometryCollection',
        geometries: mapGeoms(
          townsTopo.objects.towns.geometries,
          (p) => ({ code: String(p.TOWNCODE), county: String(p.COUNTYCODE), zh: normTai(String(p.TOWNNAME)), en: String(p.TOWNENG) }),
          (p) => p.code,
        ),
      },
    };
    return simplifyAndQuantize(
      { type: 'Topology', arcs: townsTopo.arcs, transform: townsTopo.transform, objects },
      ADMIN_SIMPLIFY_WEIGHT,
      ADMIN_QUANTIZE,
    );
  }

  /** @type {Promise<ReturnType<typeof makeVillages>>|null} */
  let villagesP = null;
  function villages() {
    villagesP ??= load('villages-10t.json').then(makeVillages);
    return villagesP;
  }

  return {
    counties,
    towns,
    townStats,
    locateTown,
    countyByName,
    townsByCounty,
    buildAdminTopo,
    villages,
  };
}

/**
 * @param {any} topo villages-10t.json
 */
function makeVillages(topo) {
  const feats = /** @type {any[]} */ (feature(topo, topo.objects.villages).features);
  const meta = feats.map((f) => ({
    code: String(f.properties.VILLCODE),
    county: normTai(String(f.properties.COUNTYNAME)),
    town: normTai(String(f.properties.TOWNNAME)),
    name: normTai(String(f.properties.VILLNAME)),
    countyCode: String(f.properties.COUNTYCODE),
  }));
  const index = new PolyIndex(feats.map(polygonsOf));
  /** @type {Map<string, number[]>} */
  const byName = new Map();
  meta.forEach((m, i) => {
    const k = `${m.county}|${m.town}|${m.name}`;
    const a = byName.get(k);
    if (a) a.push(i); else byName.set(k, [i]);
  });

  /**
   * Match a source village (point + names) to an atlas village.
   * Prefers a unique name match; otherwise point-in-polygon.
   * @returns {{code:string|null, how:'both'|'name'|'pip'|'pipOnlyMismatch'|'none'}}
   */
  function match(/** @type {number} */ lng, /** @type {number} */ lat, /** @type {string} */ county, /** @type {string} */ town, /** @type {string} */ village) {
    const pip = index.locate(lng, lat);
    const names = byName.get(`${normTai(county)}|${normTai(town)}|${normTai(village)}`);
    const nameIdx = names && names.length === 1 ? names[0] : -1;
    if (pip >= 0 && nameIdx === pip) return { code: meta[pip].code, how: 'both' };
    if (nameIdx >= 0) return { code: meta[nameIdx].code, how: 'name' };
    if (pip >= 0) {
      // point is inside a village whose name differs from the source's
      const sameCounty = meta[pip].county === normTai(county);
      return sameCounty ? { code: meta[pip].code, how: 'pipOnlyMismatch' } : { code: null, how: 'none' };
    }
    return { code: null, how: 'none' };
  }

  /** TopoJSON with only the given village codes (properties {code}). */
  function buildVillageTopo(/** @type {Iterable<string>} */ codes) {
    const want = new Set(codes);
    const picked = feats
      .filter((f) => want.has(String(f.properties.VILLCODE)))
      .map((f) => ({ type: 'Feature', properties: { code: String(f.properties.VILLCODE) }, geometry: f.geometry }))
      .sort((a, b) => cmp(a.properties.code, b.properties.code));
    if (picked.length === 0) {
      return { type: 'Topology', objects: { villages: { type: 'GeometryCollection', geometries: [] } }, arcs: [] };
    }
    const topo2 = topology({ villages: { type: 'FeatureCollection', features: picked } }, VILLAGE_QUANTIZE);
    return simplifyAndQuantize(/** @type {any} */ (topo2), VILLAGE_SIMPLIFY_WEIGHT, VILLAGE_QUANTIZE);
  }

  return { meta, index, match, buildVillageTopo, count: meta.length };
}

/**
 * Drop vertices with small effective area, strip the Z dimension and
 * re-quantize so the output is a compact delta-encoded TopoJSON.
 * @param {any} topo
 * @param {number} weight
 * @param {number} q
 */
export function simplifyAndQuantize(topo, weight, q) {
  const pre = /** @type {any} */ (presimplify(topo));
  const s = /** @type {any} */ (simplify(pre, weight));
  s.arcs = s.arcs.map((/** @type {number[][]} */ arc) => arc.map(([x, y]) => [x, y]));
  delete s.transform;
  s.bbox = topoBbox(s);
  return /** @type {any} */ (quantize(s, q));
}
