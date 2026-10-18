// Data loading: manifest first (no-cache), everything else versioned with ?v=<hash> from the manifest.
import type { Topology } from 'topojson-specification';
import type { Manifest } from './types';
import { validateManifest, validateTopology } from './validate';

const BASE = `${import.meta.env.BASE_URL}data/`;

export class DataError extends Error {
  constructor(public readonly file: string, cause: unknown) {
    super(`${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'DataError';
  }
}

let manifest: Manifest | null = null;
const cache = new Map<string, Promise<unknown>>();

async function fetchJSON(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, { credentials: 'same-origin', mode: 'same-origin', ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (type && !/json|octet-stream|text\/plain/.test(type)) throw new Error(`unexpected content-type ${type}`);
  return res.json();
}

let manifestP: Promise<Manifest> | null = null;
/**
 * Fetch + validate the manifest once (memoised, so main.ts can start it before the app shell is built and
 * the shell reuses the same request). A failed load is forgotten so a later call retries.
 */
export function loadManifest(): Promise<Manifest> {
  manifestP ??= fetchJSON(`${BASE}manifest.json`, { cache: 'no-cache' })
    .then((raw) => (manifest = validateManifest(raw)))
    .catch((e: unknown) => {
      manifestP = null;
      throw new DataError('manifest.json', e);
    });
  return manifestP;
}

export function getManifest(): Manifest | null {
  return manifest;
}

/** Version key for a data path: manifest hash, else generatedAt-derived fallback. */
export function versionOf(path: string): string {
  const h = manifest?.files[path];
  if (h) return h;
  return manifest ? manifest.generatedAt.replace(/[^0-9]/g, '').slice(0, 12) : 'dev';
}

/**
 * Load and validate a data file once (memoised per path). Failed loads are evicted so a retry refetches.
 */
export function loadData<T>(path: string, validate: (v: unknown) => T): Promise<T> {
  let p = cache.get(path) as Promise<T> | undefined;
  if (!p) {
    p = fetchJSON(`${BASE}${path}?v=${encodeURIComponent(versionOf(path))}`, { cache: 'default' })
      .then((raw) => validate(raw))
      .catch((e: unknown) => {
        cache.delete(path);
        throw new DataError(path, e);
      });
    cache.set(path, p);
  }
  return p;
}

const ADMIN_TOPO = 'geo/admin.topo.json';
/**
 * The raw administrative-boundary topology (memoised like every loadData file). Split from lib/admin.ts
 * (which decodes it with topojson-client) so main.ts can start the download for map routes before that chunk loads.
 */
export function loadAdminTopo(): Promise<Topology> {
  return loadData(ADMIN_TOPO, (v) => validateTopology(v, ADMIN_TOPO, ['counties', 'towns']));
}
