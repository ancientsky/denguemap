import { describe, expect, it } from 'vitest';

// The href guard in src/lib/dom.ts (copied regex; dom.ts needs a DOM to import).
const ok = (s: string) => /^(#|\.\/|https:\/\/)/.test(s) || /^tel:[\d#*+]{3,20}$/.test(s);

describe('href guard', () => {
  it('allows hashes, relative, https and digit-only tel links', () => {
    for (const s of ['#/map', './x', 'https://www.cdc.gov.tw/', 'tel:1922', 'tel:0227135211']) expect(ok(s)).toBe(true);
  });
  it('rejects scriptable or malformed schemes', () => {
    for (const s of ['javascript:alert(1)', 'JaVaScRiPt:x', 'data:text/html,x', 'http://x', 'tel:1922;x', 'tel:abc', 'vbscript:x']) expect(ok(s)).toBe(false);
  });
});
