// Defensive validation of every data file (docs/data-contract.md). Structural problems throw a
// ValidationError (→ friendly error state); individual malformed rows are dropped.
import type { Topology } from 'topojson-specification';
import { isISODate } from './dates';
import type {
  CasePoint, CaseRow, CasesYear, Clusters, DataWarning, Hospital, Imported, ImportedCountry, LI, Manifest, NS1, Notice, Notices,
  SourceStatus, Summary, Trend, Vector, VectorVillage, VectorWeek,
} from './types';

export class ValidationError extends Error {
  constructor(file: string, what: string) {
    super(`${file}: ${what}`);
    this.name = 'ValidationError';
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const nonNeg = (v: unknown): number => (isNum(v) && v >= 0 ? v : 0);
const CODE_RE = /^\d{5}(\d{3})?$/;
const inTaiwanish = (lng: number, lat: number) => lng >= 116 && lng <= 124 && lat >= 20 && lat <= 27.5;

function need(cond: unknown, file: string, what: string): asserts cond {
  if (!cond) throw new ValidationError(file, what);
}

function li(v: unknown): LI {
  const o = isObj(v) ? v : {};
  return { local: nonNeg(o.local), imported: nonNeg(o.imported) };
}

// --------------------------------------------------------------------------- manifest
export function validateManifest(v: unknown): Manifest {
  const F = 'manifest.json';
  need(isObj(v), F, 'not an object');
  need(v.schema === 1, F, 'unsupported schema');
  need(typeof v.generatedAt === 'string' && !Number.isNaN(Date.parse(v.generatedAt)), F, 'generatedAt');
  need(isISODate(v.latestOnset), F, 'latestOnset');
  need(Array.isArray(v.years), F, 'years');
  const years = [...new Set(v.years.filter((y): y is number => isInt(y) && y >= 1990 && y <= 2100))].sort((a, b) => a - b);
  need(years.length > 0, F, 'no years');
  const sources: Record<string, SourceStatus> = {};
  if (isObj(v.sources)) {
    for (const [k, s] of Object.entries(v.sources)) {
      if (!/^[a-z0-9]{1,20}$/.test(k) || !isObj(s)) continue;
      const st: SourceStatus = {
        ok: s.ok === true,
        stale: s.stale === true,
        fetchedAt: typeof s.fetchedAt === 'string' && !Number.isNaN(Date.parse(s.fetchedAt)) ? s.fetchedAt : null,
        records: isNum(s.records) ? s.records : null,
      };
      if (isISODate(s.periodStart)) st.periodStart = s.periodStart;
      if (isISODate(s.periodEnd)) st.periodEnd = s.periodEnd;
      if (isISODate(s.sourceDate)) st.sourceDate = s.sourceDate;
      sources[k] = st;
    }
  }
  const warnings: DataWarning[] = [];
  if (Array.isArray(v.warnings)) {
    for (const w of v.warnings.slice(0, 100)) {
      if (!isObj(w) || typeof w.code !== 'string' || !/^[a-z0-9-]{1,40}$/.test(w.code) || !isNum(w.got) || !isNum(w.expected)) continue;
      warnings.push({
        code: w.code,
        year: isInt(w.year) && w.year >= 1990 && w.year <= 2100 ? w.year : null,
        type: w.type === 'local' || w.type === 'imported' ? w.type : null,
        got: Math.max(0, w.got),
        expected: Math.max(0, w.expected),
      });
    }
  }
  const files: Record<string, string> = {};
  if (isObj(v.files)) {
    for (const [k, h] of Object.entries(v.files)) {
      if (/^[a-z0-9/_.-]{1,80}$/i.test(k) && typeof h === 'string' && /^[0-9a-f]{6,64}$/i.test(h)) files[k] = h;
    }
  }
  return { schema: 1, generatedAt: v.generatedAt, latestOnset: v.latestOnset, years, sources, warnings, files, fixture: v.fixture === true };
}

// --------------------------------------------------------------------------- summary
export function validateSummary(v: unknown): Summary {
  const F = 'summary.json';
  need(isObj(v), F, 'not an object');
  need(isISODate(v.asOf), F, 'asOf');
  const byCounty: Record<string, LI> = {};
  if (isObj(v.byCounty)) for (const [k, c] of Object.entries(v.byCounty)) if (CODE_RE.test(k)) byCounty[k] = li(c);
  const topTowns14: [string, number, number][] = [];
  if (Array.isArray(v.topTowns14)) {
    for (const r of v.topTowns14) {
      if (Array.isArray(r) && typeof r[0] === 'string' && CODE_RE.test(r[0])) topTowns14.push([r[0], nonNeg(r[1]), nonNeg(r[2])]);
    }
  }
  return {
    asOf: v.asOf,
    latestOnset: isISODate(v.latestOnset) ? v.latestOnset : v.asOf,
    year: isInt(v.year) ? v.year : +v.asOf.slice(0, 4),
    ytd: li(v.ytd), last7: li(v.last7), last14: li(v.last14), last30: li(v.last30), prevYtd: li(v.prevYtd),
    byCounty, topTowns14: topTowns14.slice(0, 50),
  };
}

// --------------------------------------------------------------------------- cases/{year}
export function validateCases(v: unknown, expectYear?: number): CasesYear {
  const F = 'cases';
  need(isObj(v), F, 'not an object');
  need(isInt(v.year), F, 'year');
  need(expectYear == null || v.year === expectYear, F, 'year mismatch');
  need(Array.isArray(v.pts) && Array.isArray(v.c), F, 'pts/c');
  const pts: CasePoint[] = v.pts.map((p): CasePoint => {
    if (Array.isArray(p) && isNum(p[0]) && isNum(p[1]) && inTaiwanish(p[0], p[1])) {
      return [p[0], p[1], typeof p[2] === 'string' && CODE_RE.test(p[2]) ? p[2] : null];
    }
    return [NaN, NaN, null]; // keep indices stable; rows pointing here are dropped below
  });
  const c: CaseRow[] = [];
  let sorted = true;
  for (const r of v.c) {
    if (!Array.isArray(r)) continue;
    const [d, p, i, n] = r as unknown[];
    if (!isInt(d) || d < 1 || d > 366 || !isInt(p) || p < 0 || p >= pts.length || (i !== 0 && i !== 1) || !isInt(n) || n <= 0) continue;
    if (Number.isNaN(pts[p]![0])) continue;
    if (c.length && c[c.length - 1]![0] > d) sorted = false;
    c.push([d, p, i, n]);
  }
  if (!sorted) c.sort((a, b) => a[0] - b[0]);
  return { year: v.year, pts, c };
}

// --------------------------------------------------------------------------- trend
function numArray(v: unknown, len: number): number[] {
  const out = new Array<number>(len).fill(0);
  if (Array.isArray(v)) for (let i = 0; i < Math.min(len, v.length); i++) out[i] = nonNeg(v[i]);
  return out;
}
function sparse(v: unknown, len: number): [number, number][] {
  const out: [number, number][] = [];
  if (Array.isArray(v)) for (const r of v) if (Array.isArray(r) && isInt(r[0]) && r[0] >= 0 && r[0] < len && isNum(r[1]) && r[1] > 0) out.push([r[0], r[1]]);
  return out;
}
export function validateTrend(v: unknown): Trend {
  const F = 'trend.json';
  need(isObj(v), F, 'not an object');
  need(isISODate(v.start) && isISODate(v.end), F, 'start/end');
  const len = Math.round((Date.parse(v.end) - Date.parse(v.start)) / 86_400_000) + 1;
  need(len > 0 && len < 60_000, F, 'range');
  need(isObj(v.national), F, 'national');
  const county: Trend['county'] = {};
  if (isObj(v.county)) {
    for (const [k, c] of Object.entries(v.county)) {
      if (/^\d{5}$/.test(k) && isObj(c)) county[k] = { local: sparse(c.local, len), imported: sparse(c.imported, len) };
    }
  }
  return { start: v.start, end: v.end, national: { local: numArray(v.national.local, len), imported: numArray(v.national.imported, len) }, county };
}

// --------------------------------------------------------------------------- imported
function countMap(v: unknown, keyRe: RegExp): Record<string, number> {
  const out: Record<string, number> = {};
  if (isObj(v)) for (const [k, n] of Object.entries(v)) if (keyRe.test(k) && isNum(n) && n > 0) out[k] = n;
  return out;
}
export function validateImported(v: unknown): Imported {
  const F = 'imported.json';
  need(isObj(v), F, 'not an object');
  need(isISODate(v.from) && isISODate(v.to), F, 'from/to');
  need(isObj(v.countries), F, 'countries');
  const countries: Record<string, ImportedCountry> = {};
  for (const [cc, c] of Object.entries(v.countries)) {
    if (!/^[a-z]{2}$/.test(cc) || !isObj(c) || !isNum(c.lat) || !isNum(c.lng)) continue;
    if (Math.abs(c.lat) > 90 || Math.abs(c.lng) > 180) continue;
    countries[cc] = { zh: str(c.zh, 40) ?? cc.toUpperCase(), lat: c.lat, lng: c.lng, byYear: countMap(c.byYear, /^\d{4}$/), byMonth: countMap(c.byMonth, /^\d{4}-\d{2}$/) };
  }
  return { from: v.from, to: v.to, countries };
}

// --------------------------------------------------------------------------- notices
export const SAFE_NOTICE_URL = /^https:\/\/www\.cdc\.gov\.tw\/[^\s"'<>]*$/;
export function validateNotices(v: unknown): Notices {
  const F = 'notices.json';
  need(isObj(v), F, 'not an object');
  const out: Notices = {};
  for (const [cc, list] of Object.entries(v)) {
    if (!/^[a-z]{2}$/.test(cc) || !Array.isArray(list)) continue;
    const items: Notice[] = [];
    for (const n of list.slice(0, 10)) {
      if (!isObj(n)) continue;
      const headline = str(n.headline, 200);
      if (!headline) continue;
      const url = typeof n.url === 'string' && SAFE_NOTICE_URL.test(n.url) ? n.url : null;
      items.push({ date: isISODate(n.date) ? n.date : '', headline, text: str(n.text, 600) ?? '', url });
    }
    if (items.length) out[cc] = items;
  }
  return out;
}

// --------------------------------------------------------------------------- vector
const risk = (v: unknown): 0 | 1 | 2 | 3 => (v === 1 || v === 2 || v === 3 ? v : 0);
const optNum = (v: unknown): number | null => (isNum(v) ? v : null);
export function validateVector(v: unknown): Vector {
  const F = 'vector.json';
  need(isObj(v), F, 'not an object');
  need(Array.isArray(v.weeks) && Array.isArray(v.villages), F, 'weeks/villages');
  const weeks = v.weeks
    .filter((w): w is [string, string] => Array.isArray(w) && isISODate(w[0]) && isISODate(w[1]))
    .map((w): [string, string] => [w[0], w[1]])
    .slice(0, 8);
  need(weeks.length > 0, F, 'no weeks');
  const villages: VectorVillage[] = [];
  for (const r of v.villages) {
    if (!Array.isArray(r) || r.length < 8) continue;
    const [county, town, vill, lng, lat, code, overall, wd] = r as unknown[];
    if (typeof county !== 'string' || typeof town !== 'string' || typeof vill !== 'string' || !isNum(lng) || !isNum(lat) || !inTaiwanish(lng, lat)) continue;
    const wk: VectorWeek[] = weeks.map((_, i) => {
      const w = Array.isArray(wd) ? wd[i] : null;
      return Array.isArray(w) ? [risk(w[0]), optNum(w[1]), optNum(w[2]), optNum(w[3])] : [0, null, null, null];
    });
    villages.push([county.slice(0, 20), town.slice(0, 20), vill.slice(0, 20), lng, lat,
      typeof code === 'string' && /^\d{8,12}$/.test(code) ? code : null, risk(overall), wk]);
  }
  const surveyed: Vector['surveyed'] = {};
  if (isObj(v.surveyed)) {
    for (const [k, s] of Object.entries(v.surveyed)) {
      if (/^\d{5}$/.test(k) && isObj(s) && isNum(s.villages) && isNum(s.total) && s.total > 0) surveyed[k] = { villages: s.villages, total: s.total };
    }
  }
  return { updated: isISODate(v.updated) ? v.updated : weeks[0]![1], weeks, villages, surveyed };
}

// --------------------------------------------------------------------------- clusters
function validRing(r: unknown): r is number[][] {
  return Array.isArray(r) && r.length >= 4 && r.every((p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1]));
}
export function validateClusters(v: unknown): Clusters {
  const F = 'clusters.json';
  need(isObj(v) && v.type === 'FeatureCollection' && Array.isArray(v.features), F, 'not a FeatureCollection');
  const features: Clusters['features'] = [];
  for (const f of v.features) {
    if (!isObj(f) || !isObj(f.geometry) || !isObj(f.properties)) continue;
    const g = f.geometry;
    let geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon | null = null;
    if (g.type === 'Polygon' && Array.isArray(g.coordinates) && g.coordinates.every(validRing)) geometry = { type: 'Polygon', coordinates: g.coordinates as number[][][] };
    else if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates) && g.coordinates.every((p) => Array.isArray(p) && p.every(validRing))) geometry = { type: 'MultiPolygon', coordinates: g.coordinates as number[][][][] };
    if (!geometry) continue;
    const p = f.properties;
    features.push({ type: 'Feature', geometry, properties: {
      county: str(p.county, 20) ?? '', town: str(p.town, 20) ?? '', code1: str(p.code1, 40) ?? '',
      count: nonNeg(p.count), lastOnset: isISODate(p.lastOnset) ? p.lastOnset : '',
    } });
  }
  return { type: 'FeatureCollection', fetchedAt: typeof v.fetchedAt === 'string' ? v.fetchedAt : null, features };
}

// --------------------------------------------------------------------------- ns1
export function validateNS1(v: unknown): NS1 {
  const F = 'ns1.json';
  need(isObj(v) && Array.isArray(v.h), F, 'h');
  const h: Hospital[] = [];
  for (const r of v.h) {
    if (!Array.isArray(r)) continue;
    const [name, addr, tel, lng, lat, id, county] = r as unknown[];
    if (typeof name !== 'string' || !isNum(lng) || !isNum(lat) || !inTaiwanish(lng, lat)) continue;
    h.push([name.slice(0, 80), str(addr, 120) ?? '', str(tel, 40) ?? '', lng, lat, str(id, 20) ?? '', typeof county === 'string' && /^\d{5}$/.test(county) ? county : '']);
  }
  return { sourceDate: isISODate(v.sourceDate) ? v.sourceDate : '', h };
}

// --------------------------------------------------------------------------- topojson
export function validateTopology(v: unknown, file: string, objects: string[]): Topology {
  need(isObj(v) && v.type === 'Topology' && Array.isArray(v.arcs) && isObj(v.objects), file, 'not a Topology');
  for (const o of objects) {
    const obj = v.objects[o];
    need(isObj(obj) && obj.type === 'GeometryCollection' && Array.isArray(obj.geometries), file, `object ${o}`);
  }
  return v as unknown as Topology;
}
