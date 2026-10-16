// Fails the build when the initial-load JavaScript exceeds the gzip budget.
// Initial = the entry script plus its modulepreloaded chunks in dist/index.html.
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const BUDGET_KB = 300;
const dist = process.argv[2] ?? 'dist';
const html = await readFile(join(dist, 'index.html'), 'utf8');

if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) {
  console.error('index.html contains an inline <script>, which the CSP forbids.');
  process.exit(1);
}

const base = '/denguemap/';
const refs = [...html.matchAll(/<(?:script[^>]*\bsrc|link[^>]*rel="modulepreload"[^>]*\bhref)="([^"]+\.js)"/g)]
  .map((m) => m[1].startsWith(base) ? m[1].slice(base.length) : m[1].replace(/^\//, ''));

let total = 0;
for (const ref of new Set(refs)) {
  const size = gzipSync(await readFile(join(dist, ref))).length;
  total += size;
  console.log(`${(size / 1024).toFixed(1).padStart(7)} KB gz  ${ref}`);
}
console.log(`${(total / 1024).toFixed(1).padStart(7)} KB gz  initial total (budget ${BUDGET_KB} KB)`);
if (total > BUDGET_KB * 1024) process.exit(1);
