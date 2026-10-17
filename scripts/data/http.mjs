// @ts-check
/**
 * HTTP helpers for the (untrusted) CDC dengue backend.
 *  - ASP.NET asmx: POST JSON, response `{"d":"<json string>"}` (double parse)
 *  - retries with exponential backoff on network errors / 5xx / 429
 *  - per-request timeout, hard cap on response size
 */
import {
  BACKOFF_BASE_MS, MAX_ATTEMPTS, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS,
} from './config.mjs';
import { sha8 } from './util.mjs';

export class HttpError extends Error {
  /** @param {string} message @param {{status?:number, retryable?:boolean}} [opts] */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}

/**
 * @typedef {object} HttpClientOptions
 * @property {string} baseUrl
 * @property {typeof fetch} [fetchImpl]
 * @property {number} [timeoutMs]
 * @property {number} [maxBytes]
 * @property {number} [maxAttempts]
 * @property {number} [backoffMs]   base backoff; 0 disables waiting (tests)
 * @property {(msg:string)=>void} [log]
 */

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One HTTP exchange, for upstream diagnostics.  Cookie values are never kept here, only an 8-hex hash of the
 * App Service instance cookie (ARRAffinity), which identifies the backend instance that answered.
 * @typedef {object} DiagEntry
 * @property {number} seq
 * @property {string} tag        e.g. "GetDengueLocation 2023/0"
 * @property {number} attempt    HTTP-level attempt (1-based)
 * @property {number|null} status
 * @property {number} ms
 * @property {number} bytes
 * @property {string|null} date  response Date header
 * @property {string|null} inst  sha8 of the ARRAffinity cookie value
 * @property {string|null} instSS sha8 of the ARRAffinitySameSite cookie value
 * @property {string|null} server
 * @property {string|null} poweredBy
 * @property {number|null} records  array length of the decoded payload (asmx only)
 * @property {number|null} total    sum of the payload rows' `count` (missing = 1): the number of cases (asmx only)
 */

/** @param {Response} res @returns {string[]} */
function setCookies(res) {
  const h = /** @type {any} */ (res.headers);
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const one = res.headers.get('set-cookie');
  return one ? [one] : [];
}

/** @param {string[]} cookies @param {string} name @returns {string|null} raw value */
function cookieValue(cookies, name) {
  for (const c of cookies) {
    const m = new RegExp(`^\\s*${name}=([^;]*)`).exec(c);
    if (m) return m[1];
  }
  return null;
}

/**
 * Read a Response body as text with a hard byte cap.
 * @param {Response} res
 * @param {number} maxBytes
 */
export async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(`response too large (content-length ${declared})`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(`response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

/** @param {HttpClientOptions} opts */
export function createHttp(opts) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const backoff = opts.backoffMs ?? BACKOFF_BASE_MS;
  const log = opts.log ?? (() => {});
  const base = opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`;

  /** @type {DiagEntry[]} */
  const diag = [];
  /** instance hash -> raw cookie header value (memory only, used by the diagnostics probe; never logged) */
  const instanceCookies = new Map();
  let seq = 0;

  /**
   * @param {string} path
   * @param {RequestInit} init
   * @param {string} [tag] set for asmx calls: they are recorded in `diag` and logged
   * @returns {Promise<{text:string, entry:DiagEntry}>}
   */
  async function requestEx(path, init, tag) {
    const url = new URL(path, base).href;
    /** @type {unknown} */
    let lastErr;
    /** @type {DiagEntry} */
    let entry = { seq: 0, tag: tag ?? path, attempt: 0, status: null, ms: 0, bytes: 0, date: null, inst: null, instSS: null, server: null, poweredBy: null, records: null, total: null };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const t0 = Date.now();
      entry = { ...entry, seq: ++seq, attempt, status: null, bytes: 0 };
      if (tag) diag.push(entry);
      try {
        const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
        entry.status = res.status;
        entry.date = res.headers.get('date');
        entry.server = res.headers.get('server');
        entry.poweredBy = res.headers.get('x-powered-by');
        const cookies = setCookies(res);
        const aff = cookieValue(cookies, 'ARRAffinity');
        const affSS = cookieValue(cookies, 'ARRAffinitySameSite');
        entry.inst = aff ? sha8(aff) : null;
        entry.instSS = affSS ? sha8(affSS) : null;
        if (entry.inst) instanceCookies.set(entry.inst, [aff && `ARRAffinity=${aff}`, affSS && `ARRAffinitySameSite=${affSS}`].filter(Boolean).join('; '));
        if (!res.ok) {
          // drain/discard body quietly
          await res.body?.cancel().catch(() => {});
          entry.ms = Date.now() - t0;
          const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
          throw new HttpError(`HTTP ${res.status} for ${path}`, { status: res.status, retryable });
        }
        const text = await readCapped(res, maxBytes);
        entry.ms = Date.now() - t0;
        entry.bytes = Buffer.byteLength(text);
        if (tag) log(describeEntry(entry));
        return { text, entry };
      } catch (e) {
        lastErr = e;
        entry.ms = Date.now() - t0;
        if (tag) log(`${describeEntry(entry)} ERROR ${/** @type {Error} */ (e).message}`);
        // HttpError carries its own verdict; anything else (network, timeout) is retryable
        const retryable = e instanceof HttpError ? e.retryable : true;
        if (!retryable || attempt === maxAttempts) break;
        const wait = backoff * 3 ** (attempt - 1);
        log(`retry ${attempt}/${maxAttempts - 1} ${path}: ${/** @type {Error} */ (e).message}; waiting ${wait} ms`);
        if (wait > 0) await sleep(wait);
      }
    }
    const err = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    throw new HttpError(`${path}: ${err.message}`, { status: err instanceof HttpError ? err.status : undefined });
  }

  /** @param {string} path @param {RequestInit} init @returns {Promise<string>} */
  const request = async (path, init) => (await requestEx(path, init)).text;

  return {
    /** GET text. @param {string} path */
    getText: (path) => request(path, { method: 'GET', headers: { Accept: '*/*' } }),
    /** GET JSON. @param {string} path */
    async getJson(path) {
      const t = await request(path, { method: 'GET', headers: { Accept: 'application/json, */*' } });
      return parseJson(t, path);
    },
    /**
     * POST an asmx method and return the decoded `d` payload
     * (parsed JSON, or null when the server returns d:null).
     * @param {string} method e.g. "GetDengueLocation"
     * @param {object|null} body
     * @param {{headers?: Record<string,string>}} [extra] extra request headers (diagnostics probe only)
     */
    async asmx(method, body, extra = {}) {
      const path = `DengueData.asmx/${method}`;
      const b = /** @type {any} */ (body ?? {});
      const tag = b.startDate ? `${method} ${String(b.startDate).slice(0, 4)}/${b.immigration ?? ''}` : method;
      const { text, entry } = await requestEx(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json', ...extra.headers },
        body: JSON.stringify(body ?? {}),
      }, tag);
      const out = decodeAsmx(text, path);
      entry.records = Array.isArray(out) ? out.length : out === null ? 0 : null;
      if (Array.isArray(out)) entry.total = out.reduce((a, r) => a + (r && typeof r === 'object' && Number.isFinite(Number(r.count)) ? Number(r.count) : 1), 0);
      return out;
    },
    /** Every asmx exchange so far (attempt level), oldest first. */
    diag,
    /** Cookie header that routes to the instance with this hash, or null. @param {string} hash */
    cookieForInstance: (hash) => instanceCookies.get(hash) ?? null,
    /** Instance hashes seen so far, in order of first appearance. */
    instances: () => [...instanceCookies.keys()],
  };
}

/** One log line for an asmx exchange (no cookie values). @param {DiagEntry} e */
export function describeEntry(e) {
  return `asmx ${e.tag} #${e.attempt} -> ${e.status ?? 'ERR'} ${e.ms} ms ${e.bytes} B inst=${e.inst ?? '-'} date=${e.date ?? '-'} server=${e.server ?? '-'}${e.poweredBy ? ` x-powered-by=${e.poweredBy}` : ''}`;
}

/** @param {string} text @param {string} what */
export function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`${what}: response is not valid JSON`);
  }
}

/**
 * Decode an ASP.NET asmx response: `{"d": "<json>"}` (double encoded) —
 * also tolerates `d` already being an object/array.
 * @param {string} text
 * @param {string} what
 * @returns {unknown}
 */
export function decodeAsmx(text, what = 'asmx') {
  const outer = parseJson(text, what);
  if (!outer || typeof outer !== 'object' || Array.isArray(outer) || !('d' in outer)) {
    throw new HttpError(`${what}: missing "d" in response`);
  }
  const d = /** @type {{d:unknown}} */ (outer).d;
  if (d === null || d === undefined || d === '') return null;
  if (typeof d === 'string') return parseJson(d, `${what} (d)`);
  return d;
}
