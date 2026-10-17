// Fails the build when JavaScript for first load exceeds the gzip budgets.
//  - shell: the entry script plus its modulepreloaded chunks in dist/index.html
//  - map route (the default page): shell + every lazily-loaded chunk the map
//    view needs. MapLibre alone is ~283 KB gz, so that budget is 330 KB.
import { readFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const SHELL_BUDGET_KB = 60;
const MAP_BUDGET_KB = 330;
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

// Map route = shell + the map view chunk + everything it imports statically (followed recursively,
// so new shared chunks are counted automatically). Dynamic import() targets are lazy and excluded.
const assets = await readdir(join(dist, 'assets'));
const mapEntry = assets.find((f) => /^map-[\w-]+\.js$/.test(f));
if (!mapEntry) {
  console.error('map view chunk (assets/map-*.js) not found');
  process.exit(1);
}
const seen = new Set(refs.map((r) => r.replace(/^assets\//, '')));
const queue = [mapEntry];
let mapTotal = total;
while (queue.length) {
  const f = queue.shift();
  if (seen.has(f)) continue;
  seen.add(f);
  const src = await readFile(join(dist, 'assets', f));
  const size = gzipSync(src).length;
  mapTotal += size;
  console.log(`${(size / 1024).toFixed(1).padStart(7)} KB gz  assets/${f} (map route)`);
  // static imports only: `import ... from"./x.js"` / `import"./x.js"` (not `import("./x.js")`)
  for (const m of src.toString().matchAll(/(?:from|import)\s*"\.\/([\w.-]+\.js)"/g)) queue.push(m[1]);
}
console.log(`${(mapTotal / 1024).toFixed(1).padStart(7)} KB gz  map route total (budget ${MAP_BUDGET_KB} KB)`);
if (total > SHELL_BUDGET_KB * 1024 || mapTotal > MAP_BUDGET_KB * 1024) process.exit(1);
