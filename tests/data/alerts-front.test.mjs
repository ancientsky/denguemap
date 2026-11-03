import { describe, expect, it } from 'vitest';
import { buildAlerts } from '../../scripts/alerts/build.mjs';
import { activeAlerts, alertBBox, locateInAlerts, stationIcs, stationStatus, validateAlerts } from '../../src/lib/alerts';

// What the build publishes from content/alerts (built here: tests run before `npm run build`), parsed by the page.
const file = validateAlerts(JSON.parse(JSON.stringify(await buildAlerts({ today: '2026-11-03', check: true }))));
const a = file.alerts.find((x) => x.id === '2026-11-02-kaohsiung-xiaogang');

describe('alerts', () => {
  it('parses the built file and drops malformed notices', () => {
    expect(a.villages).toHaveLength(8);
    expect(a.area.features).toHaveLength(8);
    const bad = validateAlerts({ alerts: [{ ...a, county: 'x' }, { ...a, villages: [] }, { ...a, issuedAt: '2026-13-01' }, a] });
    expect(bad.alerts).toHaveLength(1);
    expect(() => validateAlerts({})).toThrow();
  });
  it('is in force from the issue date through validUntil', () => {
    expect(activeAlerts(file, '2026-11-01')).not.toContain(a);
    expect(activeAlerts(file, '2026-11-02')).toContain(a);
    expect(activeAlerts(file, '2026-11-16')).toContain(a);
    expect(activeAlerts(file, '2026-11-17')).not.toContain(a);
  });
  it('station status by Taiwan date', () => {
    const s = a.screeningStations[0]; 
    expect(stationStatus(s, '2026-11-02')).toBe('upcoming');
    expect(stationStatus(s, '2026-11-04')).toBe('today');
    expect(stationStatus(s, '2026-11-05')).toBe('past');
  });
  it('locates a point inside the warning area, else the nearest village', () => {
    const f = a.area.features.find((x) => x.properties.code === '64000110007');  // 港南里
    const ring = (f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates[0])[0];
    // a point well inside: average of the ring vertices nudged towards the first vertex is not guaranteed inside,
    // so search the bbox for one the polygon test accepts
    const b = alertBBox(a);
    let hit = null;
    for (let i = 1; i < 40 && !hit; i++) for (let j = 1; j < 40 && !hit; j++) {
      const x = b[0] + ((b[2] - b[0]) * i) / 40, y = b[1] + ((b[3] - b[1]) * j) / 40;
      const r = locateInAlerts([a], x, y);
      if (r.inside && r.village.code === '64000110007') hit = r;
    }
    expect(hit).not.toBeNull();
    expect(ring.length).toBeGreaterThan(3);
    const far = locateInAlerts([a], 121.5, 25.03); // Taipei
    expect(far.inside).toBe(false);
    if (!far.inside) expect(far.nearest.meters).toBeGreaterThan(250_000);
  });
  it('calendar: one event per date and slot, Taiwan time in UTC, text escaped', () => {
    const ics = stationIcs(a, a.screeningStations[0], '登革熱採檢：小港衛生所', '公告, 說明; 第二行\n', new Date('2026-11-03T00:00:00Z'));
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(4);
    expect(ics).toContain('DTSTART:20261103T003000Z'); // 08:30 Taipei
    expect(ics).toContain('DTEND:20261104T083000Z'); // 16:30 Taipei
    expect(ics).toContain('DESCRIPTION:公告\\, 說明\\; 第二行\\n');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
});
