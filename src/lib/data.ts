// Data loading: manifest first (no-cache), everything else versioned with ?v=<hash> from the manifest.
import type { Manifest } from './types';
import { validateManifest } from './validate';

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

export async function loadManifest(): Promise<Manifest> {
  try {
    manifest = validateManifest(await fetchJSON(`${BASE}manifest.json`, { cache: 'no-cache' }));
    return manifest;
  } catch (e) {
    throw new DataError('manifest.json', e);
  }
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
