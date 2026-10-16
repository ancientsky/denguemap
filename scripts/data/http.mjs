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

  /**
   * @param {string} path
   * @param {RequestInit} init
   * @returns {Promise<string>}
   */
  async function request(path, init) {
    const url = new URL(path, base).href;
    /** @type {unknown} */
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
        if (!res.ok) {
          // drain/discard body quietly
          await res.body?.cancel().catch(() => {});
          const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
          throw new HttpError(`HTTP ${res.status} for ${path}`, { status: res.status, retryable });
        }
        return await readCapped(res, maxBytes);
      } catch (e) {
        lastErr = e;
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
     */
    async asmx(method, body) {
      const path = `DengueData.asmx/${method}`;
      const text = await request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return decodeAsmx(text, path);
    },
  };
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
