// @ts-check
/**
 * One-off probe of the CWA (Central Weather Administration) open-data API from GitHub Actions
 * (.github/workflows/cwa-probe.yml): which datasets the key can read, their structure and how far back they go.
 * Prints statuses and the JSON *shape* (key paths, array lengths, short sample values) only. The key is sent
 * in the Authorization header, never in a URL, and is never printed.
 */
const KEY = process.env.CWA_KEY ?? '';
const BASE = 'https://opendata.cwa.gov.tw/';
const DEFAULT = [
  'api/v1/rest/datastore/O-A0003-001?limit=2',
  'api/v1/rest/datastore/C-B0024-001?limit=2',
  'api/v1/rest/datastore/C-B0024-002?limit=2',
  'api/v1/rest/datastore/C-B0025-001?limit=2',
  'api/v1/rest/datastore/C-B0027-001?limit=2',
  'api/v1/rest/datastore/C-B0074-001?limit=2',
  'api/v1/rest/datastore/C-B0074-002?limit=2',
  'historyapi/v1/getDataId/',
  'historyapi/v1/getMetadata/C-B0024-001',
  'historyapi/v1/getMetadata/O-A0003-001',
];
const SAFE = /^(api\/v1\/rest\/datastore\/|historyapi\/v1\/)[A-Za-z0-9\-_/?=&.,:%]{0,300}$/;
const extra = (process.env.PROBE_PATHS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const paths = extra.length ? extra : DEFAULT;

/** Key paths of a JSON value with types, array lengths and short samples. */
function shape(v, path = '$', out = [], depth = 0) {
  if (out.length > 120) return out;
  if (Array.isArray(v)) {
    out.push(`${path}: array[${v.length}]`);
    if (v.length && depth < 11) shape(v[0], `${path}[0]`, out, depth + 1);
    if (v.length > 1 && depth < 11 && typeof v[0] !== 'object') out.push(`${path}[last]: ${sample(v[v.length - 1])}`);
  } else if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length > 40) out.push(`${path}: object{${keys.length} keys: ${keys.slice(0, 12).join(', ')}…}`);
    for (const k of keys.slice(0, 40)) shape(v[k], `${path}.${k}`, out, depth + 1);
  } else out.push(`${path}: ${sample(v)}`);
  return out;
}
const sample = (v) => {
  const s = typeof v === 'string' ? JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v) : String(v);
  return KEY && s.includes(KEY) ? '[redacted]' : s;
};

if (!KEY) {
  console.log('CWA_KEY is empty: is the CWA secret available to this workflow?');
  process.exit(1);
}
for (const p of paths) {
  if (!SAFE.test(p)) {
    console.log(`\n### ${p}\nrejected (not an allowed path)`);
    continue;
  }
  console.log(`\n### ${p}`);
  try {
    const res = await fetch(BASE + p, { headers: { Authorization: KEY, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    console.log(`HTTP ${res.status} ${res.headers.get('content-type') ?? ''} ${text.length} bytes`);
    try {
      for (const line of shape(JSON.parse(text))) console.log(line);
    } catch {
      console.log(`non-JSON: ${sample(text.slice(0, 300))}`);
    }
  } catch (e) {
    console.log(`error: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
}
