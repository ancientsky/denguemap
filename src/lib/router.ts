// Hash router: '#/route?key=value&…'. Pure parsing/serialisation (unit-tested) + a tiny binding.

export const ROUTES = ['map', 'clusters', 'vector', 'trends', 'imported', 'about'] as const;
export type Route = (typeof ROUTES)[number];
export type Params = Record<string, string>;

export const DEFAULT_ROUTE: Route = 'map';
const KEY_RE = /^[a-z0-9]{1,16}$/;
const MAX_VALUE = 120;

export function isRoute(s: string): s is Route {
  return (ROUTES as readonly string[]).includes(s);
}

/** Parse a location hash. Unknown routes fall back to the default route; params are sanitised. */
export function parseHash(hash: string): { route: Route; params: Params } {
  let s = hash.startsWith('#') ? hash.slice(1) : hash;
  if (s.startsWith('/')) s = s.slice(1);
  const q = s.indexOf('?');
  const path = (q >= 0 ? s.slice(0, q) : s).replace(/\/+$/, '').toLowerCase();
  const query = q >= 0 ? s.slice(q + 1) : '';
  const route: Route = isRoute(path) ? path : DEFAULT_ROUTE;
  const params: Params = {};
  if (query) {
    let usp: URLSearchParams;
    try {
      usp = new URLSearchParams(query);
    } catch {
      usp = new URLSearchParams();
    }
    for (const [k, v] of usp) {
      if (KEY_RE.test(k) && v.length <= MAX_VALUE && !(k in params)) params[k] = v;
    }
  }
  return { route, params };
}

/** Build '#/route?…' with keys in insertion order; empty values are omitted. */
export function buildHash(route: Route, params: Params = {}): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== '' && v != null && KEY_RE.test(k)) usp.set(k, v);
  }
  const qs = usp.toString();
  return `#/${route}${qs ? `?${qs}` : ''}`;
}

/**
 * True when the location hash already points at a different view than `current` — a navigation the router
 * has not handled yet (hashchange fires asynchronously). Writing view state in that window would clobber it.
 */
export function navigationPending(current: Route, hash: string): boolean {
  return isRouterHash(hash) && parseHash(hash).route !== current;
}

/** True when the hash is one the router owns (so in-page anchors like '#main' are ignored). */
export function isRouterHash(hash: string): boolean {
  return hash === '' || hash === '#' || hash.startsWith('#/');
}
