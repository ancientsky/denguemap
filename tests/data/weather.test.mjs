import { describe, expect, it } from 'vitest';
import { buildWeatherSource, COUNTY_STATION, dailyFromHourly, powerWeeks, weekIndex } from '../../scripts/data/sources/weather.mjs';
import { validateFileShape } from '../../scripts/data/validate.mjs';

const KEY = 'CWA-TEST-KEY-0000';
const NORMALS = { t: [17.9, 18.9, 21.4, 24.9, 27.6, 28.9, 29.5, 29.0, 28.4, 26.5, 23.4, 19.6], r: [20, 25, 35, 80, 180, 400, 350, 450, 200, 30, 15, 15] };

function hourly(fromIso, days, t = 28, r = 0.5) {
  const out = [];
  const d0 = Date.parse(`${fromIso}T00:00:00Z`);
  for (let h = 1; h <= days * 24; h++) {
    const dt = new Date(d0 + h * 3600_000).toISOString().slice(0, 13);
    out.push({ DateTime: `${dt}:00:00+08:00`, weatherElements: { AirTemperature: String(t), Precipitation: String(r) } });
  }
  return out;
}

function mockFetch(calls, { powerFails = false } = {}) {
  return async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization ?? null });
    const u = new URL(url);
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (u.hostname === 'power.larc.nasa.gov') {
      if (powerFails) return json({ message: 'down' }, 503);
      const T2M = {}, PREC = {};
      for (let d = Date.UTC(2001, 0, 1); d <= Date.UTC(2026, 9, 18); d += 86_400_000) {
        const k = new Date(d).toISOString().slice(0, 10).replace(/-/g, '');
        T2M[k] = 26; // 1 °C cooler than a flat 27 °C station normal → bias +1
        PREC[k] = 2;
      }
      return json({ properties: { parameter: { T2M, PRECTOTCORR: PREC } } });
    }
    const id = u.searchParams.get('StationID');
    if (u.pathname.endsWith('/C-B0074-001')) {
      return json({ success: 'true', records: { data: { stationStatus: { station: [...new Set(Object.values(COUNTY_STATION))].map((s, i) => ({
        StationID: s, status: '現存測站', StationName: `S${s}`, StationLatitude: String(22.5 + i * 0.1), StationLongitude: String(120.2 + i * 0.05),
      })) } } } });
    }
    if (u.pathname.endsWith('/C-B0027-001')) {
      return json({ success: 'true', records: { data: { surfaceObs: { location: [{ stationObsStatistics: {
        AirTemperature: { monthly: NORMALS.t.map((v, m) => ({ Month: String(m + 1), Mean: String(27) })) },
        Precipitation: { monthly: NORMALS.r.map((v, m) => ({ Month: String(m + 1), Accumulation: String(v) })) },
      } }] } } } });
    }
    if (u.pathname.endsWith('/C-B0024-001')) {
      return json({ success: 'true', records: { location: [{ station: { StationID: id }, stationObsTimes: { stationObsTime: hourly('2026-09-18', 31, 30, 1) } }] } });
    }
    return json({ message: 'not found' }, 404);
  };
}

describe('weather source', () => {
  it('daily aggregation assigns the 00:00 observation to the previous day', () => {
    const d = dailyFromHourly(hourly('2026-10-01', 2, 25, 1));
    expect(d.get('2026-10-01')).toEqual({ t: 25, r: 24 });
    expect(d.get('2026-10-02')).toEqual({ t: 25, r: 24 });
    expect(d.has('2026-10-03')).toBe(false);
  });

  it('POWER weeks are bias-corrected to the station normals', () => {
    const T2M = {}, PREC = {};
    for (let d = Date.UTC(2001, 0, 1); d < Date.UTC(2021, 0, 1); d += 86_400_000) {
      const k = new Date(d).toISOString().slice(0, 10).replace(/-/g, '');
      T2M[k] = 20;
      PREC[k] = 1;
    }
    const w = powerWeeks(T2M, PREC, { t: new Array(12).fill(22), r: new Array(12).fill(62) }, 10);
    expect(w.t[0]).toBe(220); // 20 °C + (22 − 20)
    expect(w.r[0]).toBeGreaterThan(12); // 1 mm/day × 7 × (62 / ~31)
    expect(w.r[0]).toBeLessThan(16);
  });

  it('builds a valid weather.json; the key goes to CWA only and is never written', async () => {
    const calls = [];
    const logs = [];
    const out = await buildWeatherSource({ todayIso: '2026-10-19', log: (m) => logs.push(m) }, { key: KEY, committed: null, history: false, fetchImpl: mockFetch(calls), backoffMs: 0 });
    const text = out.files['weather.json'];
    expect(() => validateFileShape('weather.json', text)).not.toThrow();
    expect(text).not.toContain(KEY);
    expect(logs.join('\n')).not.toContain(KEY);
    for (const c of calls) {
      const host = new URL(c.url).hostname;
      if (host === 'opendata.cwa.gov.tw') expect(c.auth).toBe(KEY);
      else expect(c.auth).toBeNull();
      expect(c.url).not.toContain(KEY);
    }
    const j = JSON.parse(text);
    const s = j.series['467410'];
    expect(j.county['67000']).toBe('467410');
    // history weeks: POWER 26 °C + bias (27 − 26) = 27 °C; last complete CWA weeks: 30 °C
    expect(s.t[weekIndex('2015-08-03')]).toBe(270);
    expect(s.s[weekIndex('2015-08-03')]).toBe('p');
    expect(s.t[weekIndex('2026-10-05')]).toBe(300);
    expect(s.s[weekIndex('2026-10-05')]).toBe('c');
    expect(s.r[weekIndex('2026-10-05')]).toBe(168);
    expect(s.t.length).toBe(j.weeks);
    expect(out.meta.historyFetched).toBe(Object.keys(j.series).length);
  });

  it('keeps going without history when POWER is down, and refuses to run without a key', async () => {
    const calls = [];
    const out = await buildWeatherSource({ todayIso: '2026-10-19', log: () => {} }, { key: KEY, committed: null, history: true, fetchImpl: mockFetch(calls, { powerFails: true }), backoffMs: 0 });
    const j = JSON.parse(out.files['weather.json']);
    expect(j.series['467410'].s[weekIndex('2015-08-03')]).toBe('-');
    expect(j.series['467410'].s[weekIndex('2026-10-05')]).toBe('c');
    await expect(buildWeatherSource({ todayIso: '2026-10-19', log: () => {} }, { key: '', committed: null, history: false })).rejects.toThrow(/CWA key/);
  });

  it('later runs keep the committed history and only add CWA weeks', async () => {
    const calls = [];
    const first = await buildWeatherSource({ todayIso: '2026-10-19', log: () => {} }, { key: KEY, committed: null, history: false, fetchImpl: mockFetch(calls), backoffMs: 0 });
    const calls2 = [];
    const second = await buildWeatherSource({ todayIso: '2026-10-26', log: () => {} }, { key: KEY, committed: JSON.parse(first.files['weather.json']), history: false, fetchImpl: mockFetch(calls2), backoffMs: 0 });
    expect(calls2.some((c) => c.url.includes('power.larc.nasa.gov'))).toBe(false);
    const j = JSON.parse(second.files['weather.json']);
    expect(j.weeks).toBe(JSON.parse(first.files['weather.json']).weeks + 1);
    expect(j.series['467410'].t[weekIndex('2015-08-03')]).toBe(270);
  });
});

describe('weather source: once a day', () => {
  it('skips the network when the committed file is from today', async () => {
    const calls = [];
    const first = await buildWeatherSource({ todayIso: '2026-10-19', log: () => {} }, { key: KEY, committed: null, history: false, fetchImpl: mockFetch(calls), backoffMs: 0 });
    const calls2 = [];
    const again = await buildWeatherSource({ todayIso: '2026-10-19', log: () => {} }, { key: KEY, committed: JSON.parse(first.files['weather.json']), history: false, fetchImpl: mockFetch(calls2), backoffMs: 0 });
    expect(calls2).toHaveLength(0);
    expect(again.files['weather.json']).toBe(first.files['weather.json']);
  });
});
