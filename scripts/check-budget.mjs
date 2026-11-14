// Fails the build when JavaScript for first load exceeds the gzip budgets.
//  - shell: the entry script plus its modulepreloaded chunks in dist/index.html
//  - map route (the default page): shell + every lazily-loaded chunk the map
//    view needs (budget 340 KB). MapLibre alone is ~282 KB gz and grows a little
//    with its releases, so our own code on that route (everything except the
//    MapLibre chunk) has its own, tighter budget: a regression in our code fails
//    here even while a library update still fits the total.
import { readFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const SHELL_BUDGET_KB = 60;
const MAP_BUDGET_KB = 340;
const MAP_OWN_BUDGET_KB = 50;
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

// Map route = shell + the map view chunk + the map host (MapLibre; the app imports it dynamically on every map
// route) + everything they import statically (followed recursively, so new shared chunks are counted
// automatically). Other dynamic import() targets are lazy and excluded.
const assets = await readdir(join(dist, 'assets'));
const mapEntry = assets.find((f) => /^map-[\w-]+\.js$/.test(f));
const hostEntry = assets.find((f) => /^host-[\w-]+\.js$/.test(f));
if (!mapEntry || !hostEntry) {
  console.error('map view chunk (assets/map-*.js) or map host chunk (assets/host-*.js) not found');
  process.exit(1);
}
const seen = new Set(refs.map((r) => r.replace(/^assets\//, '')));
const queue = [mapEntry, hostEntry];
let mapTotal = total;
let libSize = 0;
while (queue.length) {
  const f = queue.shift();
  if (seen.has(f)) continue;
  seen.add(f);
  const src = await readFile(join(dist, 'assets', f));
  const size = gzipSync(src).length;
  mapTotal += size;
  if (/^maplibre-[\w-]+\.js$/.test(f)) libSize += size;
  console.log(`${(size / 1024).toFixed(1).padStart(7)} KB gz  assets/${f} (map route)`);
  // static imports only: `import ... from"./x.js"` / `import"./x.js"` (not `import("./x.js")`)
  for (const m of src.toString().matchAll(/(?:from|import)\s*"\.\/([\w.-]+\.js)"/g)) queue.push(m[1]);
}
const own = mapTotal - libSize;
console.log(`${(own / 1024).toFixed(1).padStart(7)} KB gz  map route without MapLibre (budget ${MAP_OWN_BUDGET_KB} KB)`);
console.log(`${(mapTotal / 1024).toFixed(1).padStart(7)} KB gz  map route total (budget ${MAP_BUDGET_KB} KB)`);
if (!libSize) {
  console.error('MapLibre chunk (assets/maplibre-*.js) not found on the map route');
  process.exit(1);
}
if (total > SHELL_BUDGET_KB * 1024 || mapTotal > MAP_BUDGET_KB * 1024 || own > MAP_OWN_BUDGET_KB * 1024) process.exit(1);
