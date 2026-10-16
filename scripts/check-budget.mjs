// Fails the build when JavaScript for first load exceeds the gzip budgets.
//  - shell: the entry script plus its modulepreloaded chunks in dist/index.html
//  - map route (the default page): shell + every lazily-loaded chunk the map
//    view needs. MapLibre alone is ~283 KB gz, so that budget is 330 KB.
import { readFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const SHELL_BUDGET_KB = 60;
const MAP_BUDGET_KB = 330;
// chunk name prefixes loaded by the map route (Vite names chunks after their entry module)
const MAP_CHUNKS = ['maplibre-', 'host-', 'map-', 'admin-', 'params-', 'aggregate-', 'ui-'];
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
console.log(`${(total / 1024).toFixed(1).padStart(7)} KB gz  shell total (budget ${SHELL_BUDGET_KB} KB)`);

const assets = await readdir(join(dist, 'assets'));
let mapTotal = total;
for (const prefix of MAP_CHUNKS) {
  const file = assets.find((f) => f.startsWith(prefix) && f.endsWith('.js'));
  if (!file) {
    console.error(`map chunk ${prefix}*.js not found; update MAP_CHUNKS in scripts/check-budget.mjs`);
    process.exit(1);
  }
  mapTotal += gzipSync(await readFile(join(dist, 'assets', file))).length;
}
console.log(`${(mapTotal / 1024).toFixed(1).padStart(7)} KB gz  map route total (budget ${MAP_BUDGET_KB} KB)`);
if (total > SHELL_BUDGET_KB * 1024 || mapTotal > MAP_BUDGET_KB * 1024) process.exit(1);
