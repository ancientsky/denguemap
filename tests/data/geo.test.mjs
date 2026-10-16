// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { feature } from 'topojson-client';
import { loadGeo, PolyIndex } from '../../scripts/data/geo.mjs';

/** @type {Awaited<ReturnType<typeof loadGeo>>} */
let geo;
beforeAll(async () => { geo = await loadGeo(); });

describe('PolyIndex', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];
  const idx = new PolyIndex([[[square, hole]], [[[[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]]]]]);
  it('locates points, respecting holes and bbox', () => {
    expect(idx.locate(2, 2)).toBe(0);
    expect(idx.locate(5, 5)).toBe(-1); // inside the hole
    expect(idx.locate(25, 5)).toBe(1);
    expect(idx.locate(15, 5)).toBe(-1);
  });
  it('nearest honours the distance cap', () => {
    // ~0.01 deg east of the second square at the equator ~ 1.1 km
    const n = idx.nearest(30.01, 5, 3000);
    expect(n?.index).toBe(1);
    expect(n?.distM).toBeGreaterThan(900);
    expect(idx.nearest(15, 5, 3000)).toBeNull();
  });
});

describe('towns', () => {
  it('has the MOI hierarchy with 臺 spelling', () => {
    expect(geo.counties).toHaveLength(22);
    expect(geo.towns).toHaveLength(368);
    expect(geo.counties.find((c) => c.code === '64000')).toEqual({ code: '64000', zh: '高雄市', en: 'Kaohsiung City' });
    expect(geo.counties.find((c) => c.code === '63000')?.zh).toBe('臺北市');
    expect(geo.towns.find((t) => t.code === '64000090')).toEqual({ code: '64000090', county: '64000', zh: '前鎮區', en: 'Qianzhen District' });
    expect(geo.towns.some((t) => /台/.test(t.zh))).toBe(false);
    expect(geo.towns.every((t) => t.code.startsWith(t.county))).toBe(true);
  });

  it('point in polygon for mainland and outlying islands', () => {
    expect(geo.locateTown(120.3, 22.61)).toBe('64000090'); // Kaohsiung Qianzhen
    expect(geo.locateTown(121.5435, 25.033)).toBe('63000030'); // Taipei Da'an
    expect(geo.locateTown(118.32, 24.45)).toBe('09020040'); // Kinmen
    expect(geo.locateTown(119.95, 26.15)).toBe('09007010'); // Matsu (Lienchiang)
    expect(geo.locateTown(119.57, 23.57)).toBe('10016010'); // Penghu
  });

  it('falls back to the nearest town for coastal points, null for open sea', () => {
    const before = { ...geo.townStats };
    expect(geo.locateTown(120.15, 22.95)).toMatch(/^67000/); // just off the Tainan coast
    expect(geo.townStats.nearest).toBe(before.nearest + 1);
    expect(geo.locateTown(119.0, 23.0)).toBeNull(); // Taiwan Strait
  });
});

describe('admin.topo.json', () => {
  it('has counties/towns objects with the contract properties and valid geometry', () => {
    const topo = geo.buildAdminTopo();
    expect(Object.keys(topo.objects)).toEqual(['counties', 'towns']);
    const counties = feature(topo, topo.objects.counties).features;
    const towns = feature(topo, topo.objects.towns).features;
    expect(counties).toHaveLength(22);
    expect(towns).toHaveLength(368);
    expect(Object.keys(towns[0].properties).sort()).toEqual(['code', 'county', 'en', 'zh']);
    expect(Object.keys(counties[0].properties).sort()).toEqual(['code', 'en', 'zh']);
    expect(towns.find((t) => t.properties.code === '64000090').properties.zh).toBe('前鎮區');
    expect(JSON.stringify(topo)).not.toMatch(/台/);
    // simplification must not erase any town
    const area = (g) => {
      let a = 0;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      for (const p of polys) {
        p.forEach((ring, k) => {
          let s = 0;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
          a += (k === 0 ? 1 : -1) * Math.abs(s / 2);
        });
      }
      return a;
    };
    for (const t of towns) expect(area(t.geometry), t.properties.code).toBeGreaterThan(0);
  });
});

describe('villages', () => {
  it('matches by name and by point, and builds a compact topology', async () => {
    const v = await geo.villages();
    expect(v.count).toBe(7701);
    const sample = v.meta.find((m) => m.code === '10013010004');
    const via = v.match(120.48787510958061, 22.66994435786596, sample.county, sample.town, sample.name);
    expect(via.code).toBe('10013010004');
    // wrong name but point inside a village of the same county -> point wins, flagged
    const mismatch = v.match(120.48787510958061, 22.66994435786596, '屏東縣', '屏東市', '不存在里');
    expect(mismatch.how).toBe('pipOnlyMismatch');
    // right name, point nowhere near -> name wins
    const nameOnly = v.match(119.0, 23.0, sample.county, sample.town, sample.name);
    expect(nameOnly).toEqual({ code: '10013010004', how: 'name' });
    expect(v.match(119.0, 23.0, '屏東縣', '屏東市', '不存在里')).toEqual({ code: null, how: 'none' });
    // 台/臺 does not matter
    const taipei = v.meta.find((m) => m.county === '臺北市');
    expect(v.match(0, 0, taipei.county.replace('臺', '台'), taipei.town, taipei.name).code).toBe(taipei.code);
    const topo = v.buildVillageTopo(['10013010004', '63000030001', 'nonexistent']);
    const feats = feature(topo, topo.objects.villages).features;
    expect(feats.map((f) => f.properties)).toEqual([{ code: '10013010004' }, ...(feats.length > 1 ? [{ code: feats[1].properties.code }] : [])]);
    expect(v.buildVillageTopo([]).objects.villages.geometries).toEqual([]);
  });
});
