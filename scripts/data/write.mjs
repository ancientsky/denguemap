// @ts-check
/**
 * Output directory helpers: atomic writes, change detection, manifest.
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SOURCE_NAMES } from './config.mjs';
import { cmp, sha8, toJson } from './util.mjs';

/** Files the pipeline is allowed to publish (see docs/data-contract.md). */
export const FILE_PATTERNS = [
  /^cases\/\d{4}\.json$/,
  /^(trend|summary|imported|notices|vector|clusters|ns1)\.json$/,
  /^geo\/(admin|vector-villages)\.topo\.json$/,
];
export const isContractFile = (/** @type {string} */ p) => FILE_PATTERNS.some((re) => re.test(p));

/** @param {string} dir @param {string} rel @returns {Promise<string|null>} */
export async function readText(dir, rel) {
  try {
    return await readFile(join(dir, rel), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw e;
  }
}

/** @param {string} dir @param {string} rel @returns {Promise<any|null>} */
export async function readJson(dir, rel) {
  const t = await readText(dir, rel);
  if (t === null) return null;
  try { return JSON.parse(t); } catch { return null; }
}

/**
 * Atomically write `content` unless the file already has exactly that content.
 * @returns {Promise<boolean>} true when the file was (re)written
 */
export async function writeIfChanged(dir, rel, content) {
  const prev = await readText(dir, rel);
  if (prev === content) return false;
  const full = join(dir, rel);
  await mkdir(dirname(full), { recursive: true });
  const tmp = `${full}.tmp-${process.pid}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, full);
  return true;
}

/** All published data files currently on disk, relative paths, sorted. @param {string} dir */
export async function listDataFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const sub of ['', 'cases', 'geo']) {
    let names = [];
    try { names = await readdir(join(dir, sub)); } catch { continue; }
    for (const n of names) {
      const rel = sub ? `${sub}/${n}` : n;
      if (isContractFile(rel)) out.push(rel);
    }
  }
  return out.sort(cmp);
}

/**
 * Hash map {path: sha8} of the files currently on disk.
 * @param {string} dir
 */
export async function hashFiles(dir) {
  /** @type {Record<string,string>} */
  const files = {};
  for (const rel of await listDataFiles(dir)) {
    files[rel] = sha8(/** @type {string} */ (await readText(dir, rel)));
  }
  return files;
}

/**
 * @typedef {{ok:boolean, stale:boolean, fetchedAt:string|null, records:number} & Record<string, unknown>} SourceEntry
 */

/**
 * Assemble the manifest.
 * @param {object} p
 * @param {Date} p.now
 * @param {any|null} p.prev previous manifest
 * @param {Record<string, {ok:true, extra?:Record<string,unknown>, records:number}|{ok:false}>} p.sources
 * @param {string} p.latestOnset
 * @param {string[]} p.years
 * @param {Record<string,string>} p.files
 * @param {object[]} [p.warnings] data-quality warnings (see validate.computeWarnings)
 */
export function buildManifest({ now, prev, sources, latestOnset, years, files, warnings = [] }) {
  const nowIso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  /** @type {Record<string, SourceEntry>} */
  const out = {};
  for (const name of SOURCE_NAMES) {
    const s = sources[name];
    const old = prev?.sources?.[name];
    if (s && s.ok) {
      out[name] = { ok: true, stale: false, fetchedAt: nowIso, records: s.records, ...(s.extra ?? {}) };
    } else if (old && typeof old === 'object') {
      // keep the old facts (fetchedAt, records, ...) but flag the failure
      out[name] = { ...old, ok: false, stale: true };
    } else {
      out[name] = { ok: false, stale: false, fetchedAt: null, records: 0 };
    }
  }
  return {
    schema: 1,
    generatedAt: nowIso,
    latestOnset,
    years: years.map(Number),
    sources: out,
    warnings,
    files,
  };
}

/**
 * Rewrite the manifest only when a data file hash, the warnings or a source ok/stale flag changed.
 * @param {any|null} prev @param {any} next
 */
export function manifestChanged(prev, next) {
  if (!prev || prev.schema !== next.schema) return true;
  if (JSON.stringify(prev.files) !== JSON.stringify(next.files)) return true;
  if (JSON.stringify(prev.warnings ?? []) !== JSON.stringify(next.warnings ?? [])) return true;
  for (const name of SOURCE_NAMES) {
    const a = prev.sources?.[name], b = next.sources[name];
    if (!a || a.ok !== b.ok || a.stale !== b.stale) return true;
  }
  return false;
}

/** @param {any} manifest */
export const manifestToJson = (manifest) => toJson(manifest);
