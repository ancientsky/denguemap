// @vitest-environment node
import { gzipSync } from 'node:zlib';
import { feature } from 'topojson-client';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateFileShape } from '../../scripts/data/validate.mjs';
import { WORLD_MAX_GZIP, buildWorldFile, buildWorldTopo } from '../../scripts/data/world.mjs';

describe('geo/world.topo.json', () => {
  let a, b, topo, fc;
  beforeAll(async () => {
    a = await buildWorldFile();
    b = await buildWorldFile();
    topo = JSON.parse(a.json);
    fc = feature(topo, topo.objects.countries);
  }, 60_000);

  it('is byte-stable across runs and within the gzip budget', () => {
    expect(b.json).toBe(a.json);
    expect(gzipSync(a.json).length).toBeLessThanOrEqual(WORLD_MAX_GZIP);
    expect(a.gzip).toBeLessThanOrEqual(WORLD_MAX_GZIP);
    validateFileShape('geo/world.topo.json', a.json);
  });

  it('has object `countries` with lower-case iso2 only, no Antarctica, no duplicates', () => {
    expect(Object.keys(topo.objects)).toEqual(['countries']);
    const codes = fc.features.map((f) => f.properties.iso2);
    expect(codes.every((c) => /^[a-z]{2}$/.test(c))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).not.toContain('aq');
    expect(codes.length).toBeGreaterThan(200);
    expect(Object.keys(fc.features[0].properties)).toEqual(['iso2']);
    expect(codes).toEqual([...codes].sort());
  });

  it('keeps Singapore, Maldives, Taiwan and the other small states, as valid rings', () => {
    const byCc = Object.fromEntries(fc.features.map((f) => [f.properties.iso2, f]));
    for (const cc of ['sg', 'mv', 'tw', 'mt', 'bh', 'mc', 'va', 'sm', 'li', 'nr', 'fr', 'us', 'vn']) expect(byCc[cc], cc).toBeTruthy();
    for (const f of fc.features) {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      expect(polys.length).toBeGreaterThan(0);
      for (const p of polys) for (const ring of p) expect(ring.length).toBeGreaterThanOrEqual(4);
    }
    // Singapore sits at about 103.8E / 1.35N
    const ring = byCc.sg.geometry.coordinates[0];
    const lng = ring.reduce((s, p) => s + p[0], 0) / ring.length, lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    expect(lng).toBeGreaterThan(103.5);
    expect(lng).toBeLessThan(104.2);
    expect(lat).toBeGreaterThan(1.1);
    expect(lat).toBeLessThan(1.6);
  });

  it('maps numeric ids via the given converter and drops unmapped / Antarctica', async () => {
    const sq = (x0, y0) => [[x0, y0], [x0 + 1, y0], [x0 + 1, y0 + 1], [x0, y0 + 1], [x0, y0]];
    const atlas = {
      type: 'Topology',
      objects: {
        countries: {
          type: 'GeometryCollection',
          geometries: [
            { type: 'Polygon', id: '702', arcs: [[0]] }, // sg
            { type: 'Polygon', id: '462', arcs: [[1]] }, // mv
            { type: 'Polygon', id: '158', arcs: [[2]] }, // tw
            { type: 'Polygon', id: '010', arcs: [[3]] }, // aq
            { type: 'Polygon', arcs: [[4]] }, // no id (Kosovo)
            { type: 'Polygon', id: '999', arcs: [[5]] }, // unmapped
          ],
        },
      },
      // identity transform with absolute coordinates encoded as deltas
      transform: { scale: [1, 1], translate: [0, 0] },
      arcs: [sq(10, 1), sq(70, 3), sq(120, 23), sq(0, -80), sq(20, 42), sq(30, 30)].map((r) => r.map((p, i) => (i === 0 ? p : [p[0] - r[i - 1][0], p[1] - r[i - 1][1]]))),
    };
    const alpha = { 702: 'SG', '462': 'MV', '158': 'TW', '010': 'AQ' };
    const t = await buildWorldTopo({ atlas, toAlpha2: (n) => alpha[n] });
    const out = feature(t, t.objects.countries);
    expect(out.features.map((f) => f.properties.iso2)).toEqual(['mv', 'sg', 'tw']);
    await expect(buildWorldTopo({ atlas, toAlpha2: (n) => (n === '702' ? undefined : alpha[n]) })).rejects.toThrow(/sg missing/);
  });
});
