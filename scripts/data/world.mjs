// @ts-check
/**
 * World country boundaries for the globe: npm `world-atlas` (Natural Earth
 * 1:50m) -> geo/world.topo.json, object `countries`, properties {iso2}.
 *
 * Build-time only (no network).  The output is a pure function of the
 * installed world-atlas / i18n-iso-countries / topojson versions, so it is
 * byte-stable across runs and `writeIfChanged` leaves the file alone.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { bbox as topoBbox, feature, quantize } from 'topojson-client';
import { topology } from 'topojson-server';
import { presimplify, simplify, sphericalTriangleArea } from 'topojson-simplify';
import { cmp } from './util.mjs';

const require = createRequire(import.meta.url);

/** Spherical triangle area (steradians) below which vertices are dropped. */
export const WORLD_SIMPLIFY_WEIGHT = 1e-6;
export const WORLD_QUANTIZE = 2e4;
/** Countries that must survive simplification (small island states and Taiwan). */
export const WORLD_REQUIRED = Object.freeze(['sg', 'mv', 'tw']);
/** Max gzip size of the output (contract). */
export const WORLD_MAX_GZIP = 120 * 1024;

/**
 * @param {object} [opts]
 * @param {any} [opts.atlas] parsed countries-50m.json (default: from node_modules)
 * @param {(numeric:string)=>string|undefined} [opts.toAlpha2]
 * @param {number} [opts.weight] @param {number} [opts.quantize]
 */
export async function buildWorldTopo(opts = {}) {
  const atlas = opts.atlas ?? JSON.parse(await readFile(require.resolve('world-atlas/countries-50m.json'), 'utf8'));
  const toAlpha2 = opts.toAlpha2 ?? (await import('i18n-iso-countries')).default.numericToAlpha2;
  const fc = /** @type {any} */ (feature(atlas, atlas.objects.countries));
  /** @type {Map<string, any>} */
  const byCc = new Map();
  for (const f of fc.features) {
    if (f.id === undefined || f.id === null || !f.geometry) continue;
    const a2 = toAlpha2(String(f.id));
    if (!a2) continue;
    const iso2 = a2.toLowerCase();
    if (iso2 === 'aq' || !/^[a-z]{2}$/.test(iso2) || byCc.has(iso2)) continue;
    byCc.set(iso2, { type: 'Feature', properties: { iso2 }, geometry: f.geometry });
  }
  const features = [...byCc.keys()].sort(cmp).map((k) => byCc.get(k));
  const topo = /** @type {any} */ (topology({ countries: { type: 'FeatureCollection', features } }));
  const pre = /** @type {any} */ (presimplify(topo, sphericalTriangleArea));
  const s = /** @type {any} */ (simplify(pre, opts.weight ?? WORLD_SIMPLIFY_WEIGHT));
  s.arcs = s.arcs.map((/** @type {number[][]} */ arc) => arc.map(([x, y]) => [x, y]));
  delete s.transform;
  s.bbox = topoBbox(s);
  const out = /** @type {any} */ (quantize(s, opts.quantize ?? WORLD_QUANTIZE));
  for (const k of WORLD_REQUIRED) {
    const g = out.objects.countries.geometries.find((/** @type {any} */ x) => x.properties.iso2 === k);
    if (!g) throw new Error(`world topology: ${k} missing`);
  }
  return out;
}

/** Serialised topology + gzip-size gate. */
export async function buildWorldFile() {
  const topo = await buildWorldTopo();
  const json = JSON.stringify(topo);
  const gz = gzipSync(json, { level: 9 }).length;
  if (gz > WORLD_MAX_GZIP) throw new Error(`world topology too large: ${gz} bytes gzipped`);
  return { json, gzip: gz, countries: topo.objects.countries.geometries.length };
}
