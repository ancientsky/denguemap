// Temperature input of the forecast (weather.json, see docs/data-contract.md v4).
// Transmission potential of Aedes aegypti-borne dengue against temperature follows the relative R0(T) curve of
// Mordecai et al. 2017 (PLoS NTD): zero below 17.8 °C and above 34.6 °C, peak at 29.1 °C. A Briere-type curve
// T·(T − Tmin)·(Tmax − T)^(1/m) with those limits peaks at 29.1 °C for 1/m ≈ 0.676.
import { isISODate } from '../dates';

export interface WeatherStation {
  name: string;
  lat: number;
  lng: number;
  normals: { t: number[]; r: number[] };
  /** Weekly mean temperature × 10 (°C) / rainfall (mm), Monday blocks from week0. */
  t: (number | null)[];
  r: (number | null)[];
  s: string;
  daily: { start: string; t: (number | null)[]; r: (number | null)[] };
}
export interface WeatherFile {
  updated: string;
  week0: string;
  weeks: number;
  county: Record<string, string>;
  series: Record<string, WeatherStation>;
}

const T_MIN = 17.8, T_MAX = 34.6, EXP = 0.6757;
const DAY_MS = 86_400_000;

/** Relative transmission potential at temperature T (°C), 1 at the 29.1 °C optimum, 0 outside 17.8–34.6 °C. */
export function relR0(T: number): number {
  const raw = (x: number) => (x > T_MIN && x < T_MAX ? x * (x - T_MIN) * Math.pow(T_MAX - x, EXP) : 0);
  return raw(T) / raw(29.1);
}

const isNumOrNull = (v: unknown, lo: number, hi: number) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi);

/** Shape check of weather.json (the pipeline validates the same rules before writing). */
export function validateWeather(v: unknown): WeatherFile {
  const j = v as WeatherFile;
  if (!j || typeof j !== 'object' || !isISODate(j.updated) || j.week0 !== '2001-01-01' || !Number.isInteger(j.weeks)) throw new Error('weather: bad header');
  for (const [id, s] of Object.entries(j.series ?? {})) {
    if (!/^[0-9A-Z]{6}$/.test(id) || s.t?.length !== j.weeks || s.r?.length !== j.weeks || !s.t.every((x) => isNumOrNull(x, -100, 450))
      || s.normals?.t?.length !== 12 || !s.normals.t.every((x) => isNumOrNull(x, -10, 40)) || !isISODate(s.daily?.start) || !Array.isArray(s.daily.t)
      || !s.daily.t.every((x) => isNumOrNull(x, -200, 450))) throw new Error(`weather: bad station ${id}`);
  }
  for (const [c, id] of Object.entries(j.county ?? {})) if (!/^\d{5}$/.test(c) || !(id in j.series)) throw new Error('weather: bad county map');
  return j;
}

const epoch = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);

/** Climatological daily mean temperature: monthly normals interpolated between mid-month days. */
export function normalTemp(st: WeatherStation, day: number): number {
  const d = new Date(day * DAY_MS);
  const m = d.getUTCMonth(), dom = d.getUTCDate();
  const len = new Date(Date.UTC(d.getUTCFullYear(), m + 1, 0)).getUTCDate();
  const pos = m + (dom - 0.5) / len - 0.5; // months from mid-January
  const lo = Math.floor(pos), f = pos - lo;
  const a = st.normals.t[(lo + 12) % 12]!, b = st.normals.t[(lo + 13) % 12]!;
  return a + (b - a) * f;
}

/** Observed mean temperature of the 14 days up to `day`: daily window when it covers them, else complete weeks. */
export function recentTemp(w: WeatherFile, st: WeatherStation, day: number): number | null {
  const d0 = epoch(st.daily.start);
  const vals: number[] = [];
  for (let d = day - 13; d <= day; d++) {
    const v = st.daily.t[d - d0];
    if (v != null) vals.push(v / 10);
  }
  if (vals.length >= 7) return vals.reduce((a, b) => a + b, 0) / vals.length;
  const w0 = epoch(w.week0);
  const lastFull = Math.floor((day + 1 - w0) / 7) - 1; // last week ending on or before `day`
  const weeks: number[] = [];
  for (let k = lastFull; k >= lastFull - 2 && weeks.length < 2; k--) {
    const v = k >= 0 ? st.t[k] : null;
    if (v != null) weeks.push(v / 10);
  }
  return weeks.length ? weeks.reduce((a, b) => a + b, 0) / weeks.length : null;
}

export interface TempPath {
  station: string;
  /** Expected daily mean temperature for days 0 … horizon after the as-of day (normal + decaying anomaly). */
  temps: Float64Array;
  /** Observed 14-day mean and its anomaly against the normal. */
  recent: number;
  anomaly: number;
}

/** Temperature path for an area; null when the station has no recent data. Anomaly half-life: 14 days. */
export function tempPath(w: WeatherFile, stationId: string | undefined, asOf: number, horizon: number): TempPath | null {
  const st = stationId ? w.series[stationId] : undefined;
  if (!st) return null;
  const recent = recentTemp(w, st, asOf);
  if (recent == null) return null;
  let norm = 0;
  for (let d = asOf - 13; d <= asOf; d++) norm += normalTemp(st, d);
  const anomaly = recent - norm / 14;
  const temps = new Float64Array(horizon + 1);
  temps[0] = recent;
  for (let h = 1; h <= horizon; h++) temps[h] = normalTemp(st, asOf + h) + anomaly * Math.pow(0.5, h / 14);
  return { station: stationId!, temps, recent, anomaly };
}

/** Multiplier on R at each horizon day: (relR0(T(h)) / relR0(T(0)))^γ; 1 when γ = 0 or the start is too cold. */
export function tempFactors(path: TempPath | null, gamma: number, horizon: number): Float64Array | null {
  if (!path || gamma === 0) return null;
  const base = relR0(path.temps[0]!);
  if (base < 0.05) return null;
  const out = new Float64Array(horizon + 1);
  // Capped at 3×: a cool start (small relR0) must not turn a mild warming into an explosion.
  for (let h = 0; h <= horizon; h++) out[h] = Math.min(3, Math.pow(relR0(path.temps[h]!) / base, gamma));
  return out;
}
