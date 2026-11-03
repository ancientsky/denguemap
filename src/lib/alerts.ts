// 防疫公告 (health-bureau dengue notices, data/alerts.json built from content/alerts at deploy time; docs/alerts.md):
// shape check, which notices are in force, station status, point-in-warning-area and calendar export. Pure (unit-tested).
import { isISODate, todayTaipei } from './dates';

export interface AlertVillage {
  code: string;
  zh: string;
  en: string;
  town: string;
}
export interface AlertPlace {
  name: string;
  address: string;
  lng: number | null;
  lat: number | null;
}
export interface ExposureSite extends AlertPlace {
  from: string;
  to: string;
  note: string;
}
export interface ScreeningStation extends AlertPlace {
  dates: string[];
  hours: string[];
}
export interface DengueAlert {
  id: string;
  title: string;
  titleEn: string;
  county: string;
  town: string;
  countyZh: string;
  countyEn: string;
  townZh: string;
  townEn: string;
  issuedAt: string;
  validUntil: string;
  issuer: string;
  sourceUrl: string;
  note: string;
  noteEn: string;
  villages: AlertVillage[];
  exposureSites: ExposureSite[];
  screeningStations: ScreeningStation[];
  area: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, { code: string }>;
}
export interface AlertsFile {
  generatedAt: string;
  alerts: DengueAlert[];
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const HOURS = /^\d{2}:\d{2}-\d{2}:\d{2}$/;

function place(p: Record<string, unknown>): AlertPlace | null {
  const name = str(p.name, 40), address = str(p.address, 80);
  if (!name || address === null) return null;
  const lng = num(p.lng), lat = num(p.lat);
  const ok = lng !== null && lat !== null && lng > 118 && lng < 123 && lat > 21 && lat < 27;
  return { name, address, lng: ok ? lng : null, lat: ok ? lat : null };
}

/** Defensive parse of alerts.json; notices that do not match the shape are dropped, not trusted. */
export function validateAlerts(v: unknown): AlertsFile {
  const j = v as Record<string, unknown>;
  if (!j || typeof j !== 'object' || !Array.isArray(j.alerts)) throw new Error('alerts: bad file');
  const alerts: DengueAlert[] = [];
  for (const raw of j.alerts as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    const id = str(a.id, 80), title = str(a.title, 60), issuer = str(a.issuer, 40), sourceUrl = str(a.sourceUrl, 300);
    if (!id || !title || !issuer || !sourceUrl || !isISODate(a.issuedAt) || !isISODate(a.validUntil)) continue;
    if (typeof a.county !== 'string' || !/^\d{5}$/.test(a.county) || typeof a.town !== 'string' || !/^\d{8}$/.test(a.town)) continue;
    const villages = (Array.isArray(a.villages) ? a.villages : []).filter((x): x is AlertVillage =>
      !!x && typeof x.code === 'string' && /^\d{11}$/.test(x.code) && !!str(x.zh, 20) && str(x.en, 60) !== null && str(x.town, 20) !== null);
    const area = a.area as DengueAlert['area'] | undefined;
    if (!villages.length || area?.type !== 'FeatureCollection' || !Array.isArray(area.features)) continue;
    const features = area.features.filter((f) => f && (f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon') && Array.isArray(f.geometry.coordinates));
    const exposureSites: ExposureSite[] = [];
    for (const s of (Array.isArray(a.exposureSites) ? a.exposureSites : []) as Record<string, unknown>[]) {
      const p = s && typeof s === 'object' ? place(s) : null;
      if (p && isISODate(s.from) && isISODate(s.to)) exposureSites.push({ ...p, from: s.from as string, to: s.to as string, note: str(s.note, 120) ?? '' });
    }
    const screeningStations: ScreeningStation[] = [];
    for (const s of (Array.isArray(a.screeningStations) ? a.screeningStations : []) as Record<string, unknown>[]) {
      const p = s && typeof s === 'object' ? place(s) : null;
      const dates = Array.isArray(s?.dates) ? (s.dates as unknown[]).filter(isISODate) : [];
      const hours = Array.isArray(s?.hours) ? (s.hours as unknown[]).filter((x): x is string => typeof x === 'string' && HOURS.test(x)) : [];
      if (p && dates.length && hours.length) screeningStations.push({ ...p, dates, hours });
    }
    alerts.push({
      id, title, titleEn: str(a.titleEn, 120) ?? '', county: a.county, town: a.town,
      countyZh: str(a.countyZh, 20) ?? '', countyEn: str(a.countyEn, 60) ?? '', townZh: str(a.townZh, 20) ?? '', townEn: str(a.townEn, 60) ?? '',
      issuedAt: a.issuedAt as string, validUntil: a.validUntil as string, issuer, sourceUrl, note: str(a.note, 400) ?? '', noteEn: str(a.noteEn, 600) ?? '',
      villages, exposureSites, screeningStations, area: { type: 'FeatureCollection', features },
    });
  }
  return { generatedAt: str(j.generatedAt, 10) ?? '', alerts };
}

/** Notices in force on `today` (Taiwan date): issued on or before it and valid through it. */
export const activeAlerts = (file: AlertsFile | null, today: string): DengueAlert[] =>
  (file?.alerts ?? []).filter((a) => a.issuedAt <= today && today <= a.validUntil);

export type StationStatus = 'today' | 'upcoming' | 'past';
export function stationStatus(s: ScreeningStation, today: string): StationStatus {
  if (s.dates.includes(today)) return 'today';
  return s.dates.some((d) => d > today) ? 'upcoming' : 'past';
}

function inRing(ring: GeoJSON.Position[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if (yi! > y !== yj! > y && x < ((xj! - xi!) * (y - yi!)) / (yj! - yi!) + xi!) inside = !inside;
  }
  return inside;
}
function inGeometry(g: GeoJSON.Polygon | GeoJSON.MultiPolygon, x: number, y: number): boolean {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.some((p) => inRing(p[0]!, x, y) && !p.slice(1).some((hole) => inRing(hole, x, y)));
}

const M_LAT = 110_574;
/** Distance (m) from a point to the nearest vertex of a geometry (good enough at village scale). */
function vertexDistance(g: GeoJSON.Polygon | GeoJSON.MultiPolygon, x: number, y: number): number {
  const kx = 111_320 * Math.cos((y * Math.PI) / 180);
  let best = Infinity;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const p of polys) for (const ring of p) for (const [px, py] of ring) best = Math.min(best, Math.hypot((px! - x) * kx, (py! - y) * M_LAT));
  return best;
}

export type Locate =
  | { inside: true; alert: DengueAlert; village: AlertVillage }
  | { inside: false; nearest: { alert: DengueAlert; village: AlertVillage; meters: number } | null };

/** Is the point inside any warning area? Otherwise the nearest one (distance to its boundary, approximately). */
export function locateInAlerts(alerts: readonly DengueAlert[], lng: number, lat: number): Locate {
  let nearest: { alert: DengueAlert; village: AlertVillage; meters: number } | null = null;
  for (const a of alerts) {
    for (const f of a.area.features) {
      const village = a.villages.find((v) => v.code === f.properties.code);
      if (!village) continue;
      if (inGeometry(f.geometry, lng, lat)) return { inside: true, alert: a, village };
      const m = vertexDistance(f.geometry, lng, lat);
      if (!nearest || m < nearest.meters) nearest = { alert: a, village, meters: m };
    }
  }
  return { inside: false, nearest };
}

/** Bounding box of a notice's warning area and places. */
export function alertBBox(a: DengueAlert): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number) => {
    b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
  };
  for (const f of a.area.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const p of polys) for (const [x, y] of p[0]!) add(x!, y!);
  }
  for (const p of [...a.exposureSites, ...a.screeningStations]) if (p.lng !== null && p.lat !== null) add(p.lng, p.lat);
  return b;
}

const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** Taiwan local date + HH:MM → iCalendar UTC stamp (Taiwan has no DST: UTC+8). */
const icsUtc = (date: string, hm: string) => {
  const t = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), +hm.slice(0, 2) - 8, +hm.slice(3, 5));
  return new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
};

/** iCalendar (RFC 5545) with one event per date and time slot of a screening station. */
export function stationIcs(a: DengueAlert, s: ScreeningStation, summary: string, description: string, stamp = new Date()): string {
  const now = stamp.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const events = s.dates.flatMap((d) => s.hours.map((hrs, i) => {
    const [from, to] = hrs.split('-') as [string, string];
    return [
      'BEGIN:VEVENT',
      `UID:${a.id}-${d}-${i}-${s.name.length}@denguemap`,
      `DTSTAMP:${now}`,
      `DTSTART:${icsUtc(d, from)}`,
      `DTEND:${icsUtc(d, to)}`,
      `SUMMARY:${icsText(summary)}`,
      `LOCATION:${icsText(`${s.name} ${s.address}`.trim())}`,
      `DESCRIPTION:${icsText(description)}`,
      'END:VEVENT',
    ].join('\r\n');
  }));
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//denguemap//alerts//ZH', 'CALSCALE:GREGORIAN', ...events, 'END:VCALENDAR', ''].join('\r\n');
}

// ------------------------------------------------------------------ loading
// data/alerts.json is built at deploy time from content/alerts and is not versioned by the manifest: revalidate it.
const URL_ALERTS = `${import.meta.env.BASE_URL}data/alerts.json`;
let fileP: Promise<AlertsFile | null> | null = null;

/** The notices file (null when there is none or it cannot be read: the views work without it). */
export function loadAlerts(): Promise<AlertsFile | null> {
  fileP ??= fetch(URL_ALERTS, { credentials: 'same-origin', mode: 'same-origin', cache: 'no-cache' })
    .then(async (r) => (r.ok && /json/.test(r.headers.get('content-type') ?? '') ? validateAlerts(await r.json()) : null))
    .catch(() => null)
    .then((f) => {
      if (!f) fileP = null; // retry on the next view
      return f;
    });
  return fileP;
}

/** Notices in force today (Taiwan time). */
export async function loadActiveAlerts(): Promise<DengueAlert[]> {
  return activeAlerts(await loadAlerts(), todayTaipei());
}

// ------------------------------------------------------------------ history
export interface AlertIndexEntry {
  id: string;
  title: string;
  titleEn: string;
  county: string;
  town: string;
  countyZh: string;
  countyEn: string;
  townZh: string;
  townEn: string;
  issuedAt: string;
  validUntil: string;
  issuer: string;
  villages: number;
  stations: number;
}

const ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/;
export const isAlertId = (s: unknown): s is string => typeof s === 'string' && s.length <= 80 && ID_RE.test(s);

/** Shape check of alerts-index.json; malformed entries are dropped. Newest first. */
export function validateAlertIndex(v: unknown): AlertIndexEntry[] {
  const j = v as { alerts?: unknown };
  if (!j || typeof j !== 'object' || !Array.isArray(j.alerts)) throw new Error('alerts-index: bad file');
  const out: AlertIndexEntry[] = [];
  for (const e of j.alerts as Record<string, unknown>[]) {
    if (!e || !isAlertId(e.id) || !str(e.title, 60) || !str(e.issuer, 40) || !isISODate(e.issuedAt) || !isISODate(e.validUntil)) continue;
    if (typeof e.county !== 'string' || !/^\d{5}$/.test(e.county) || typeof e.town !== 'string' || !/^\d{8}$/.test(e.town)) continue;
    out.push({
      id: e.id, title: e.title as string, titleEn: str(e.titleEn, 120) ?? '', county: e.county, town: e.town,
      countyZh: str(e.countyZh, 20) ?? '', countyEn: str(e.countyEn, 60) ?? '', townZh: str(e.townZh, 20) ?? '', townEn: str(e.townEn, 60) ?? '',
      issuedAt: e.issuedAt as string, validUntil: e.validUntil as string, issuer: e.issuer as string,
      villages: num(e.villages) ?? 0, stations: num(e.stations) ?? 0,
    });
  }
  return out.sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : a.issuedAt > b.issuedAt ? -1 : a.id.localeCompare(b.id)));
}

const noCache = (url: string) => fetch(url, { credentials: 'same-origin', mode: 'same-origin', cache: 'no-cache' })
  .then(async (r) => (r.ok && /json/.test(r.headers.get('content-type') ?? '') ? r.json() : null))
  .catch(() => null);

let indexP: Promise<AlertIndexEntry[] | null> | null = null;
/** Every notice ever published (summary), for the history search; null when unavailable. */
export function loadAlertIndex(): Promise<AlertIndexEntry[] | null> {
  indexP ??= noCache(`${import.meta.env.BASE_URL}data/alerts-index.json`).then((v) => {
    const out = v ? (() => { try { return validateAlertIndex(v); } catch { return null; } })() : null;
    if (!out) indexP = null;
    return out;
  });
  return indexP;
}

/** One notice in full by id (current or past); null when unknown or malformed. */
export async function loadAlertById(id: string): Promise<DengueAlert | null> {
  if (!isAlertId(id)) return null;
  const v = await noCache(`${import.meta.env.BASE_URL}data/alerts/${id}.json`);
  if (!v) return null;
  const a = validateAlerts({ alerts: [v] }).alerts[0];
  return a?.id === id ? a : null;
}
