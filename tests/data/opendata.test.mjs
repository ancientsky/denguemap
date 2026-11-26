// @vitest-environment node
// Taiwan CDC open data (Dengue_Daily.csv): parsing, the point-by-point union with the backend, the imported
// union, and a pipeline run where the open data covers a backend gap and backfills a frozen year.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../scripts/data/run.mjs';
import { unionMax } from '../../scripts/data/sources/cases.mjs';
import { unionImported } from '../../scripts/data/sources/imported.mjs';
import { loadOpendata, parseOpendataCsv } from '../../scripts/data/sources/opendata.mjs';
import { locationRecords, startMockServer } from './helpers/mock-server.mjs';

const HEADER = '發病日,個案研判日,通報日,性別,年齡層,居住縣市,居住鄉鎮,居住村里,最小統計區,最小統計區中心點X,最小統計區中心點Y,一級統計區,二級統計區,感染縣市,感染鄉鎮,感染村里,是否境外移入,感染國家,確定病例數,居住村里代碼,感染村里代碼,血清型,內政部居住縣市代碼,內政部居住鄉鎮代碼,內政部感染縣市代碼,內政部感染鄉鎮代碼';
/** one CSV line; onset YYYY/MM/DD */
const line = ({ onset, judged = onset, imp = false, lng = '', lat = '', country = '', count = 1 }) => [
  onset, judged, onset, 'M', '30-34', '高雄市', '前鎮區', '', '', lng, lat, '', '', '', '', '', imp ? '是' : '否', country, count, '', '', '', '64', '6400700', '', '',
].join(',');
const csv = (rows) => `﻿${HEADER}\n${rows.map(line).join('\n')}\n`;

describe('parseOpendataCsv', () => {
  it('reads cases, coordinates and the newest confirmation date', () => {
    const od = parseOpendataCsv(csv([
      { onset: '2015/09/01', judged: '2015/09/03' },
      { onset: '2026/11/20', judged: '2026/11/25', lng: '120.3', lat: '22.6' },
      { onset: '2026/11/21', judged: '2026/11/24', imp: true, country: '越南', count: 2 },
    ]), 1);
    expect(od.newestJudged).toBe('2026-11-25');
    expect(od.cases).toEqual([
      expect.objectContaining({ onset: '2015/09/01', imp: 0, lng: null, lat: null }),
      expect.objectContaining({ onset: '2026/11/20', judged: '2026-11-25', imp: 0, lng: '120.3', lat: '22.6' }),
      expect.objectContaining({ imp: 1, country: '越南', count: 2 }),
    ]);
  });
  it('rejects a file without the expected columns or with too few rows', () => {
    expect(() => parseOpendataCsv('a,b\n1,2\n', 1)).toThrow(/missing column/);
    expect(() => parseOpendataCsv(csv([{ onset: '2026/01/01' }]))).toThrow(/only 1 rows/);
  });
  it('a local file: used unless its content looks frozen or it is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dengue-od-'));
    try {
      const f = join(dir, 'Dengue_Daily.csv.gz');
      await writeFile(f, gzipSync(csv([{ onset: '2026/10/01', judged: '2026/10/02' }])));
      const logs = [];
      expect(await loadOpendata({ file: f, todayIso: '2026-12-20', log: (m) => logs.push(m), minRows: 1 })).toBeNull();
      expect(logs.join('\n')).toMatch(/::warning::open data looks frozen/);
      expect((await loadOpendata({ file: f, todayIso: '2026-10-05', log: () => {}, minRows: 1 }))?.newestJudged).toBe('2026-10-02');
      expect(await loadOpendata({ file: join(dir, 'missing.csv'), todayIso: '2026-10-05', log: () => {} })).toBeNull();
      expect(await loadOpendata({ todayIso: '2026-10-05', log: () => {} })).toBeNull(); // not configured
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('loadOpendata from the release', () => {
  const URL_CSV = 'https://github.com/o/dengue-opendata/releases/download/latest/Dengue_Daily.csv.gz';
  const URL_META = 'https://github.com/o/dengue-opendata/releases/download/latest/Dengue_Daily.meta.json';
  const plain = Buffer.from(csv([{ onset: '2026/11/20', judged: '2026/11/25', lng: '120.3', lat: '22.6' }]));
  const sha = createHash('sha256').update(plain).digest('hex');
  /** fake fetch: release files redirect to the asset host */
  const fake = (files, host = 'release-assets.githubusercontent.com') => async (url) => {
    const body = files[url];
    const res = body === undefined ? new Response('Not Found', { status: 404 }) : new Response(body, { status: 200 });
    Object.defineProperty(res, 'url', { value: `https://${host}/x` });
    return res;
  };
  const load = (files, over = {}) => {
    const logs = [];
    return loadOpendata({ url: URL_CSV, fetchImpl: fake(files, over.host), todayIso: '2026-11-26', log: (m) => logs.push(m), minRows: 1 })
      .then((od) => ({ od, log: logs.join('\n') }));
  };
  const meta = (o = {}) => JSON.stringify({ downloadedAt: '2026-11-26T08:17:00+08:00', sha256: sha, lines: 2, ...o });

  it('uses a fresh, matching pair', async () => {
    const { od, log } = await load({ [URL_META]: meta(), [URL_CSV]: gzipSync(plain) });
    expect(od).toMatchObject({ newestJudged: '2026-11-25', downloadedAt: '2026-11-26T00:17:00.000Z' });
    expect(log).toMatch(/^open data: 1 rows/);
  });
  it('not published yet: a notice, not used', async () => {
    const { od, log } = await load({});
    expect(od).toBeNull();
    expect(log).toMatch(/::notice::open data not published yet/);
  });
  it('stale uploader, mismatched hash or a foreign host: a warning, not used', async () => {
    expect((await load({ [URL_META]: meta({ downloadedAt: '2026-11-20T08:00:00+08:00' }), [URL_CSV]: gzipSync(plain) })).log).toMatch(/::warning::open data is stale/);
    expect((await load({ [URL_META]: meta({ sha256: 'a'.repeat(64) }), [URL_CSV]: gzipSync(plain) })).log).toMatch(/does not match the SHA-256/);
    expect((await load({ [URL_META]: meta(), [URL_CSV]: gzipSync(plain) }, { host: 'evil.example' })).log).toMatch(/unexpected host evil\.example/);
  });
});

describe('unions', () => {
  const r = (date, lng, count, imp = 0) => ({ date, doy: 1, lng, lat: 22.6, imp, count });
  it('cases: per (date, type, point) the larger count, anything missing from either side kept', () => {
    const out = unionMax([r('2026-11-01', 120.3, 2), r('2026-11-02', 120.3, 1)], [r('2026-11-01', 120.3, 1), r('2026-11-03', 120.4, 1), r('2026-11-03', 120.4, 1)]);
    expect(out.map((x) => [x.date, x.lng, x.count])).toEqual([['2026-11-01', 120.3, 2], ['2026-11-02', 120.3, 1], ['2026-11-03', 120.4, 2]]);
  });
  it('imported: names matched to the backend (with aliases), unknown names left out', () => {
    const back = [{ date: '2025-03-01', cc: 'id', zh: '印度尼西亞(印尼)', lat: -2, lng: 118, count: 1 }];
    const u = unionImported(back, [
      { sickdate: '2025/03/01', country_name: '印尼', count: 2 },
      { sickdate: '2025/04/01', country_name: '中國', count: 1 },
      { sickdate: '2025/04/02', country_name: '亞特蘭提斯', count: 1 },
    ], { cn: { zh: '中國大陸', lat: 35, lng: 103 } });
    expect(u.rows).toEqual([
      { date: '2025-03-01', cc: 'id', zh: '印度尼西亞(印尼)', lat: -2, lng: 118, count: 2 },
      { date: '2025-04-01', cc: 'cn', zh: '中國大陸', lat: 35, lng: 103, count: 1 },
    ]);
    expect(u.added).toBe(2);
    expect(u.unmapped).toEqual({ 亞特蘭提斯: 1 });
  });
});

describe('pipeline with open data', () => {
  let server, dir, odFile;
  const common = (over = {}) => ({
    retryDelaysMs: [0, 0], baseUrl: server.baseUrl, travelBaseUrl: `${server.baseUrl}travel/`, outDir: dir, backoffMs: 0,
    log: () => {}, reference: null, summaryPath: null, only: ['cases', 'imported'], opendataMinRows: 1, ...over,
  });
  // the open data = the backend's 2026 local points + one 2023 case the backend never had (a frozen year)
  const odRows = () => [
    ...locationRecords(2026, 0, '2026-10-14').map((x) => ({ onset: x.sickdate, judged: '2026/10/14', lng: x.lng, lat: x.lat, count: Number(x.count) })),
    { onset: '2023/09/15', judged: '2023/09/18', lng: '120.31', lat: '22.61' },
  ];
  beforeAll(async () => {
    server = await startMockServer({ todayIso: '2026-10-14' });
    dir = await mkdtemp(join(tmpdir(), 'dengue-od-run-'));
    odFile = join(dir, '..', `od-${Date.now()}.csv`);
    await writeFile(odFile, csv(odRows()));
    const r = await run(common({ now: new Date('2026-10-16T04:00:00Z'), opendataFile: null }));
    expect(r.exitCode).toBe(0);
  }, 60_000);
  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(odFile, { force: true });
  });

  it('covers a backend gap in the current year and backfills the frozen year 2023', async () => {
    const before2023 = JSON.parse(await readFile(join(dir, 'cases/2023.json'), 'utf8'));
    server.state.calls.length = 0;
    server.state.mutate = (method, body, data) => (method === 'GetDengueLocation' && body.startDate.startsWith('2026') && body.immigration === '0' ? [] : data);
    const logs = [];
    const r = await run(common({ now: new Date('2026-10-16T05:00:00Z'), opendataFile: odFile, log: (m) => logs.push(m) }));
    server.state.mutate = null;
    expect(r.exitCode).toBe(0);
    // 2026 local came back empty, but the open data has all of it: no shrink, no retry, nothing kept
    expect(r.results.cases.meta).toMatchObject({ currentYearOk: true, keptYears: [], rejected: [] });
    expect(server.state.calls.filter((c) => c.method === 'GetDengueLocation' && c.body.startDate.startsWith('2026') && c.body.immigration === '0')).toHaveLength(1);
    const after2023 = JSON.parse(await readFile(join(dir, 'cases/2023.json'), 'utf8'));
    const total = (f) => f.c.reduce((a, c) => a + c[3], 0);
    expect(total(after2023)).toBe(total(before2023) + 1);
    expect(r.results.cases.meta.changedYears).toContain(2023);
    expect(r.results.cases.meta.opendata).toMatchObject({ newestJudged: '2026-10-14', added: expect.any(Number) });
    expect(logs.some((m) => m.startsWith('open data: '))).toBe(true);
  });

  it('a second identical run changes nothing', async () => {
    server.state.calls.length = 0;
    const r = await run(common({ now: new Date('2026-10-16T05:30:00Z'), opendataFile: odFile }));
    expect(r.results.cases.meta.changedYears).toEqual([]);
  });
});
