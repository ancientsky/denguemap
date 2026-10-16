// Minimal stand-in for cdcdengue.azurewebsites.net used by the end-to-end test.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import lz from 'lz-string';
import { feature } from 'topojson-client';
import {
  CLUSTER_FEATURE, GRAY_WEEKS, IMPORTED_RECORDS, NOTICE_RECORDS, VECTOR_RED,
} from '../fixtures/samples.mjs';

const require = createRequire(import.meta.url);

/** Points known to be inside Taiwan (lng, lat). */
const POINTS = [
  [120.3, 22.61], [121.5435, 25.033], [120.6736, 24.1477], [118.32, 24.45], [120.2, 22.99], [121.6, 23.97], [120.54640, 24.07601], [119.95, 26.15],
];

function pad(n) { return String(n).padStart(2, '0'); }

/** Deterministic location records for one year + flag. */
export function locationRecords(year, imp, todayIso = '2026-10-14') {
  const n = imp ? 3 + (year % 4) : year === 2021 ? 0 : 5 + (year % 7) * 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const month = 1 + ((i * 5 + year) % 12);
    const day = 1 + ((i * 7 + year) % 27);
    let date = `${year}/${pad(month)}/${pad(day)}`;
    if (date.replaceAll('/', '-') > todayIso) date = `${year}/01/${pad(day)}`;
    const [lng, lat] = POINTS[(i + year) % POINTS.length];
    out.push({ sickdate: date, lat: String(lat + 0.0000004), lng: String(lng), count: 1 + (i % 2) });
  }
  if (year === 2026 && !imp) out.push({ sickdate: '2026/02/02', lat: '0', lng: '0', count: 1 }); // invalid point
  return out;
}

function villageFeatures(count) {
  const topo = JSON.parse(readFileSync(require.resolve('taiwan-atlas/villages-10t.json'), 'utf8'));
  const feats = feature(topo, topo.objects.villages).features.slice(0, count);
  return feats.map((f, i) => {
    const g = f.geometry;
    const ring = (g.type === 'Polygon' ? g.coordinates : g.coordinates[0])[0];
    const [lng, lat] = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
    const red = i % 25 === 0;
    const weeks = GRAY_WEEKS.map((w, k) => ({ ...w, color: red && k === 0 ? 'red' : red && k === 2 ? 'yellow' : 'gray', b_pos: red && k === 0 ? 60 : null }));
    return {
      type: 'Feature',
      properties: {
        COUNTY: f.properties.COUNTYNAME, TOWN: f.properties.TOWNNAME, VILLAGE: f.properties.VILLNAME,
        weeks, background_color: red ? 'red' : 'gray',
      },
      geometry: { type: 'Point', coordinates: [lng, lat] },
    };
  });
}

function ns1Body() {
  const features = [];
  for (let i = 0; i < 1100; i++) {
    const [lng, lat] = POINTS[i % POINTS.length];
    features.push({
      type: 'Feature',
      properties: {
        city: '臺北市', hospName: `醫院${i}`, hospID: String(1000000000 + i), hospAddress: `臺北市某路${i}號`,
        latitude: String(lat), longitude: String(lng), hospTel: '02-1234', code: i % 2 ? '01' : '07',
      },
      geometry: { type: 'Point', coordinates: [lng, lat] },
    });
  }
  return lz.compressToUTF16(JSON.stringify({ type: 'FeatureCollection', features }));
}

/**
 * @param {{todayIso?: string, fail?: Set<string>, mutate?: (method:string, body:any, data:any)=>any, nsAsLiteral?: boolean}} [opts]
 */
export async function startMockServer(opts = {}) {
  const todayIso = opts.todayIso ?? '2026-10-14';
  const fail = opts.fail ?? new Set();
  const vectorFeatures = [VECTOR_RED, ...villageFeatures(1200)];
  const vector = {
    type: 'FeatureCollection', timestamp: '2026-10-11T20:00:02.534Z', features: vectorFeatures,
  };
  const ns1 = ns1Body();
  const state = { fail, requests: /** @type {string[]} */ ([]), mutate: opts.mutate ?? null };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const path = decodeURIComponent(req.url ?? '');
      state.requests.push(`${req.method} ${path}`);
      const send = (status, body, type = 'application/json') => {
        res.writeHead(status, { 'Content-Type': type });
        res.end(body);
      };
      if ([...state.fail].some((f) => path.includes(f))) return send(500, '{"Message":"There was an error processing the request."}');
      if (req.method === 'POST' && path.startsWith('/DengueData.asmx/')) {
        const method = path.split('/').pop();
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, '{}'); }
        let data = null;
        if (method === 'GetDengueLocation') {
          const y = Number(String(body.startDate).slice(0, 4));
          data = body.immigration === '2' ? [] : locationRecords(y, Number(body.immigration), todayIso);
        } else if (method === 'GetImportedData') data = IMPORTED_RECORDS;
        else if (method === 'GetIntEicdemic') data = body.countrycode === 'vn' ? NOTICE_RECORDS : [];
        else if (method === 'GetDengueCluster_New') {
          data = body.citycode === '32' ? { type: 'FeatureCollection', features: [CLUSTER_FEATURE] }
            : ['01', '03', '05', '07', '11', '12', '22', '31', '33', '35', '37', '38', '39', '40', '43'].includes(body.citycode) ? { type: 'FeatureCollection', features: [] } : null;
        } else return send(404, '{}');
        if (state.mutate) data = state.mutate(method, body, data);
        return send(200, JSON.stringify({ d: data === null ? null : JSON.stringify(data) }));
      }
      if (req.method === 'GET' && path === '/data/geojson/cdcdengueVillagePoint.json') return send(200, JSON.stringify(vector));
      if (req.method === 'GET' && path.startsWith('/data/ns1/')) return send(200, opts.nsAsLiteral ? JSON.stringify(ns1) : ns1, 'text/plain; charset=utf-8');
      return send(404, 'not found', 'text/plain');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    state,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
