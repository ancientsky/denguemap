// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createHttp, decodeAsmx, readCapped } from '../../scripts/data/http.mjs';

const resp = (body, init = {}) => new Response(body, { status: 200, ...init });

describe('decodeAsmx', () => {
  it('double-parses the d string', () => {
    expect(decodeAsmx(JSON.stringify({ d: JSON.stringify([{ a: 1 }]) }))).toEqual([{ a: 1 }]);
  });
  it('returns null for d:null and empty string', () => {
    expect(decodeAsmx('{"d":null}')).toBeNull();
    expect(decodeAsmx('{"d":""}')).toBeNull();
  });
  it('accepts an already-parsed d', () => {
    expect(decodeAsmx('{"d":[1,2]}')).toEqual([1, 2]);
  });
  it('rejects error bodies and non-JSON', () => {
    expect(() => decodeAsmx('{"Message":"There was an error processing the request."}')).toThrow(/missing "d"/);
    expect(() => decodeAsmx('<html>Runtime Error</html>')).toThrow(/not valid JSON/);
    expect(() => decodeAsmx('{"d":"not json"}')).toThrow(/not valid JSON/);
  });
});

describe('createHttp', () => {
  it('posts JSON to the asmx path', async () => {
    const fetchImpl = vi.fn(async () => resp(JSON.stringify({ d: '[]' })));
    const http = createHttp({ baseUrl: 'https://x.test/', fetchImpl, backoffMs: 0 });
    expect(await http.asmx('GetDengueLocation', { citycode: 'all' })).toEqual([]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://x.test/DengueData.asmx/GetDengueLocation');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(init.body)).toEqual({ citycode: 'all' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries 5xx and network errors, then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(resp('boom', { status: 500 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(resp('{"d":"[1]"}'));
    const http = createHttp({ baseUrl: 'https://x.test/', fetchImpl, backoffMs: 0 });
    expect(await http.asmx('M', {})).toEqual([1]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxAttempts', async () => {
    const fetchImpl = vi.fn(async () => resp('x', { status: 503 }));
    const http = createHttp({ baseUrl: 'https://x.test/', fetchImpl, backoffMs: 0, maxAttempts: 3 });
    await expect(http.asmx('M', {})).rejects.toThrow(/HTTP 503/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry 4xx', async () => {
    const fetchImpl = vi.fn(async () => resp('nope', { status: 404 }));
    const http = createHttp({ baseUrl: 'https://x.test/', fetchImpl, backoffMs: 0 });
    await expect(http.getText('a')).rejects.toThrow(/HTTP 404/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses oversized responses (declared and streamed)', async () => {
    const big = vi.fn(async () => resp('x'.repeat(100)));
    const http = createHttp({ baseUrl: 'https://x.test/', fetchImpl: big, backoffMs: 0, maxBytes: 50 });
    await expect(http.getText('a')).rejects.toThrow(/exceeded|too large/);
    expect(big).toHaveBeenCalledTimes(1); // not retried
    const declared = new Response('x', { headers: { 'content-length': '999999' } });
    await expect(readCapped(declared, 10)).rejects.toThrow(/too large/);
  });

  it('times out hung requests', async () => {
    const fetchImpl = vi.fn((url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }));
    const http = createHttp({ baseUrl: 'https://x.test/', fetchImpl, backoffMs: 0, timeoutMs: 20, maxAttempts: 2 });
    await expect(http.getText('a')).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
