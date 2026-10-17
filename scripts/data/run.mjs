// @ts-check
/**
 * Data pipeline entry point (`npm run data`).
 *
 * Fetches the CDC dengue backend, validates, and writes static JSON into
 * public/data/.  Each source is independent: on failure its previous files
 * stay untouched and the manifest flags it `stale`.  If every source fails
 * nothing is written and the process exits non-zero.
 *
 * Env: DENGUE_BASE_URL (default CDC host), TRAVEL_BASE_URL (safetravel raw files), DATA_OUT_DIR (default public/data),
 *      DATA_ALLOW_SHRINK=1 (skip the case-count shrink guard),
 *      DATA_TODAY=YYYY-MM-DD (simulate another Taiwan calendar day, e.g. a year rollover; tests / debugging only).
 */
import { appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_BASE_URL, DEFAULT_TRAVEL_BASE_URL, REFERENCE_COUNTS, SOURCE_NAMES, TRAVEL_MAX_BYTES,
} from './config.mjs';
import { loadGeo } from './geo.mjs';
import { createHttp } from './http.mjs';
import { buildCases, yearTotals } from './sources/cases.mjs';
import { buildClustersSource } from './sources/clusters.mjs';
import { buildImportedSource } from './sources/imported.mjs';
import { buildNs1Source } from './sources/ns1.mjs';
import { buildNoticesSource, recentCountriesFromImportedJson } from './sources/notices.mjs';
import { buildTravelSource } from './sources/travel.mjs';
import { buildVectorSource } from './sources/vector.mjs';
import { buildWorldFile } from './world.mjs';
import { toJson, isoUtc, twDate, parseYmd } from './util.mjs';
import {
  computeWarnings, ShrinkError, validateCases, validateFileShape, validateImported, validateNs1, validateTravel, validateVector,
} from './validate.mjs';
import {
  buildManifest, hashFiles, manifestChanged, manifestToJson, readJson, writeIfChanged,
} from './write.mjs';

/**
 * @typedef {object} Ctx
 * @property {ReturnType<typeof createHttp>} http
 * @property {ReturnType<typeof createHttp>} travelHttp  safetravel raw files
 * @property {Awaited<ReturnType<typeof loadGeo>>} geo
 * @property {string} todayIso  Taiwan calendar date
 * @property {(msg:string)=>void} log
 */

/**
 * @typedef {object} SourceResult
 * @property {string} name
 * @property {boolean} ok
 * @property {Record<string,string>} [files]
 * @property {any} [meta]
 * @property {string} [error]
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {string} [options.travelBaseUrl]
 * @param {string} [options.outDir]
 * @param {Date} [options.now]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.backoffMs]
 * @param {(msg:string)=>void} [options.log]
 * @param {{local:readonly number[], imported:readonly number[]}|null} [options.reference]
 * @param {boolean} [options.allowShrink]
 * @param {string|null} [options.summaryPath]
 * @param {()=>Promise<any>} [options.atlasLoader]
 * @param {number[]} [options.retryDelaysMs] waits before re-fetching a cases/imported source that failed the shrink guard (default 90 s, 180 s; 0 s when backoffMs is 0)
 * @param {string[]} [options.only] restrict to these source names (debug)
 */
export async function run(options = {}) {
  const log = options.log ?? ((m) => console.log(m));
  const now = options.now ?? clockFromEnv(process.env.DATA_TODAY) ?? new Date();
  const outDir = options.outDir ?? process.env.DATA_OUT_DIR ?? join(ROOT, 'public/data');
  const baseUrl = options.baseUrl ?? process.env.DENGUE_BASE_URL ?? DEFAULT_BASE_URL;
  const allowShrink = options.allowShrink ?? process.env.DATA_ALLOW_SHRINK === '1';
  const todayIso = twDate(now);
  const currentYear = /** @type {{y:number}} */ (parseYmd(todayIso)).y;
  const wanted = (/** @type {string} */ n) => !options.only || options.only.includes(n);

  const travelBaseUrl = options.travelBaseUrl ?? process.env.TRAVEL_BASE_URL ?? DEFAULT_TRAVEL_BASE_URL;
  const http = createHttp({ baseUrl, fetchImpl: options.fetchImpl, backoffMs: options.backoffMs, log });
  const travelHttp = createHttp({
    baseUrl: travelBaseUrl, fetchImpl: options.fetchImpl, backoffMs: options.backoffMs, log, maxBytes: TRAVEL_MAX_BYTES,
  });
  log(`data pipeline: ${todayIso} (Taiwan), base ${baseUrl}, out ${outDir}`);

  const prevManifest = await readJson(outDir, 'manifest.json');

  /** @type {Promise<Ctx>} */
  const ctxP = loadGeo(options.atlasLoader ? { atlasLoader: options.atlasLoader } : {}).then((geo) => ({ http, travelHttp, geo, todayIso, log }));
  ctxP.catch(() => {});

  // The backend sometimes answers with truncated history; it usually recovers within minutes.
  const retryDelays = options.retryDelaysMs ?? (options.backoffMs === 0 ? [0, 0] : [90_000, 180_000]);

  /**
   * @param {string} name
   * @param {(ctx:Ctx)=>Promise<{files:Record<string,string>, meta:any}>} fn
   * @param {{retryOnShrink?: boolean}} [opts] re-run `fn` after a ShrinkError (waits per retryDelays)
   * @returns {Promise<SourceResult>}
   */
  const guarded = async (name, fn, opts = {}) => {
    const t0 = Date.now();
    const maxAttempts = 1 + (opts.retryOnShrink ? retryDelays.length : 0);
    for (let attempt = 1; ; attempt++) {
      try {
        const ctx = await ctxP;
        const out = await fn(ctx);
        for (const [p, text] of Object.entries(out.files)) validateFileShape(p, text);
        log(`[${name}] ok in ${Date.now() - t0} ms${attempt > 1 ? ` (attempt ${attempt}/${maxAttempts})` : ''}: ${JSON.stringify(summarize(out.meta))}`);
        return { name, ok: true, files: out.files, meta: out.meta };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof ShrinkError && attempt < maxAttempts) {
          const wait = retryDelays[attempt - 1];
          log(`[${name}] attempt ${attempt}/${maxAttempts} below the committed counts (${msg}); re-fetching in ${wait} ms`);
          if (wait > 0) await new Promise((r) => { setTimeout(r, wait); });
          continue;
        }
        log(`[${name}] FAILED${maxAttempts > 1 ? ` after ${attempt}/${maxAttempts} attempt(s)` : ''}: ${msg}`);
        return { name, ok: false, error: msg };
      }
    }
  };

  const casesP = wanted('cases') ? guarded('cases', async (ctx) => {
    const out = await buildCases(ctx);
    /** @type {Record<number, {local:number,imported:number}|null>} */
    const prevTotals = {};
    for (const y of out.meta.years) {
      const prev = await readJson(outDir, `cases/${y}.json`);
      prevTotals[y] = prev ? yearTotals(prev) : null;
    }
    validateCases({ totals: out.meta.totals, meta: out.meta, years: out.meta.years }, {
      prevTotals, reference: options.reference === undefined ? REFERENCE_COUNTS : options.reference, allowShrink, currentYear,
    });
    return out;
  }, { retryOnShrink: true }) : null;

  const importedP = wanted('imported') ? guarded('imported', async (ctx) => {
    const out = await buildImportedSource(ctx);
    const prev = await readJson(outDir, 'imported.json');
    const prevRecords = prev ? Object.values(prev.countries ?? {}).reduce((a, c) => a + Object.values(/** @type {any} */ (c).byYear ?? {}).reduce((x, y) => x + Number(y), 0), 0) : null;
    validateImported(out.meta, prevRecords);
    return out;
  }, { retryOnShrink: true }) : null;

  const noticesP = wanted('notices') ? guarded('notices', async (ctx) => {
    const imp = importedP ? await importedP : null;
    /** @type {Array<{cc:string, zh:string}>} */
    let countries;
    if (imp?.ok) countries = imp.meta.recent;
    else {
      const prevImported = await readJson(outDir, 'imported.json');
      if (!prevImported) throw new Error('no imported data available to select countries');
      countries = recentCountriesFromImportedJson(prevImported, ctx.todayIso);
    }
    return buildNoticesSource(ctx, countries, await readJson(outDir, 'notices.json'));
  }) : null;

  const clustersP = wanted('clusters') ? guarded('clusters', async (ctx) =>
    buildClustersSource(ctx, await readJson(outDir, 'clusters.json'), isoUtc(now))) : null;

  const vectorP = wanted('vector') ? guarded('vector', async (ctx) => {
    const out = await buildVectorSource(ctx);
    validateVector(out.meta);
    return out;
  }) : null;

  const ns1P = wanted('ns1') ? guarded('ns1', async (ctx) => {
    const out = await buildNs1Source(ctx);
    validateNs1(out.meta);
    return out;
  }) : null;

  const adminP = wanted('admin') ? guarded('admin', async (ctx) => ({
    files: { 'geo/admin.topo.json': toJson(ctx.geo.buildAdminTopo()) },
    meta: { towns: ctx.geo.towns.length, counties: ctx.geo.counties.length },
  })) : null;

  const travelP = wanted('travel') ? guarded('travel', async (ctx) => {
    const out = await buildTravelSource(ctx);
    validateTravel(JSON.parse(out.files['travel.json']));
    return out;
  }) : null;

  // static: derived from the installed world-atlas package, no network, byte-stable
  const worldP = wanted('world') ? guarded('world', async () => {
    const w = await buildWorldFile();
    return { files: { 'geo/world.topo.json': w.json }, meta: { countries: w.countries, gzip: w.gzip } };
  }) : null;

  const settled = await Promise.all([casesP, importedP, noticesP, clustersP, vectorP, ns1P, adminP, travelP, worldP]);
  /** @type {Record<string, SourceResult>} */
  const results = {};
  for (const r of settled) if (r) results[r.name] = r;

  const manifestResults = SOURCE_NAMES.map((n) => results[n]).filter(Boolean);
  const okCount = manifestResults.filter((r) => r.ok).length;

  const summaryPath = options.summaryPath === undefined ? process.env.GITHUB_STEP_SUMMARY ?? null : options.summaryPath;

  if (okCount === 0) {
    log('ALL sources failed; nothing written');
    await writeSummary(summaryPath, results, null, [], prevManifest, todayIso);
    return { exitCode: 1, results, changed: [], manifest: null };
  }

  // ---- write data files (only changed ones touch the disk)
  /** @type {string[]} */
  const changed = [];
  for (const r of Object.values(results)) {
    if (!r.ok || !r.files) continue;
    for (const [rel, text] of Object.entries(r.files)) {
      if (await writeIfChanged(outDir, rel, text)) changed.push(rel);
    }
  }

  // ---- manifest
  const files = await hashFiles(outDir);
  const years = Object.keys(files).map((p) => /^cases\/(\d{4})\.json$/.exec(p)?.[1]).filter(Boolean).sort();
  /** @type {Record<string, any>} */
  const srcInfo = {};
  for (const n of SOURCE_NAMES) {
    const r = results[n];
    if (r?.ok) {
      const m = r.meta;
      /** @type {Record<string, unknown>} */
      const extra = {};
      if (n === 'vector') { extra.periodStart = m.periodStart; extra.periodEnd = m.periodEnd; }
      if (n === 'ns1') extra.sourceDate = m.sourceDate;
      if (n === 'travel') extra.updated = m.updated;
      srcInfo[n] = { ok: true, records: m.records, extra };
    } else srcInfo[n] = { ok: false };
  }
  const latestOnset = results.cases?.ok ? results.cases.meta.latestOnset : prevManifest?.latestOnset ?? '';
  // warnings describe the data as committed (so they also hold while a source is stale)
  /** @type {Record<number, {local:number, imported:number}>} */
  const casesTotals = {};
  for (const y of years) {
    const f = await readJson(outDir, `cases/${y}.json`);
    if (f) casesTotals[Number(y)] = yearTotals(f);
  }
  const impFile = await readJson(outDir, 'imported.json');
  /** @type {{total:number, byYear:Record<number, number>}|null} */
  let impTotals = null;
  if (impFile?.countries) {
    impTotals = { total: 0, byYear: {} };
    for (const c of Object.values(impFile.countries)) {
      for (const [y, n] of Object.entries(/** @type {any} */ (c).byYear ?? {})) {
        impTotals.byYear[Number(y)] = (impTotals.byYear[Number(y)] ?? 0) + Number(n);
        impTotals.total += Number(n);
      }
    }
  }
  const warnings = computeWarnings({ casesTotals, imported: impTotals });
  for (const w of warnings) log(`warning: ${JSON.stringify(w)}`);
  const manifest = buildManifest({
    now, prev: prevManifest, sources: srcInfo, latestOnset, years: /** @type {string[]} */ (years), files, warnings,
  });
  if (manifestChanged(prevManifest, manifest)) {
    await writeIfChanged(outDir, 'manifest.json', manifestToJson(manifest));
    changed.push('manifest.json');
  } else {
    log('manifest unchanged (no data hash or source flag changed)');
  }

  const failed = manifestResults.filter((r) => !r.ok);
  for (const f of failed) log(`::warning::source ${f.name} failed, kept previous data: ${f.error}`);
  log(`done: ${changed.length} file(s) changed${changed.length ? ` (${changed.join(', ')})` : ''}`);
  await writeSummary(summaryPath, results, manifest, changed, prevManifest, todayIso);
  return { exitCode: 0, results, changed, manifest };
}

/**
 * DATA_TODAY=YYYY-MM-DD → noon of that day in Taiwan (04:00 UTC); anything else → null (real clock).
 * @param {string|undefined} v
 */
export function clockFromEnv(v) {
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !parseYmd(v)) throw new Error(`DATA_TODAY must be YYYY-MM-DD, got ${JSON.stringify(v)}`);
  return new Date(`${v}T04:00:00Z`);
}

/** Compact, log-friendly view of a meta object (drops big arrays). */
function summarize(/** @type {any} */ meta) {
  if (!meta || typeof meta !== 'object') return meta;
  /** @type {Record<string, unknown>} */
  const o = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === 'totals' || k === 'recent' || k === 'years') continue;
    o[k] = v;
  }
  return o;
}

/**
 * Markdown summary for $GITHUB_STEP_SUMMARY.
 * @param {string|null} path
 * @param {Record<string, SourceResult>} results
 * @param {any|null} manifest
 * @param {string[]} changed
 * @param {any|null} prevManifest
 * @param {string} todayIso
 */
async function writeSummary(path, results, manifest, changed, prevManifest, todayIso) {
  if (!path) return;
  const lines = [`### Dengue data pipeline (${todayIso} Taiwan)`, '', '| source | status | records | detail |', '|---|---|---:|---|'];
  for (const n of [...SOURCE_NAMES, 'admin', 'world']) {
    const r = results[n];
    if (!r) continue;
    if (r.ok) {
      const m = r.meta;
      const detail = n === 'cases'
        ? `years ${m.years?.[0]}..${m.years?.at(-1)}, latest onset ${m.latestOnset}, dropped ${m.dropped}, points w/o town ${m.nullTown}/${m.uniquePts}`
        : n === 'vector' ? `period ${m.periodStart}..${m.periodEnd}, villCode match ${m.stats?.matched}/${m.stats?.outVillages}`
          : n === 'notices' ? `${m.countries} countries, ${m.failed} failed`
            : n === 'travel' ? `${m.countries} countries, updated ${m.updated}`
            : '';
      lines.push(`| ${n} | ok | ${m.records ?? m.towns ?? ''} | ${detail} |`);
    } else {
      const st = prevManifest?.sources?.[n] ? 'STALE (kept previous)' : 'FAILED (no previous data)';
      lines.push(`| ${n} | ${st} | | ${String(r.error).replaceAll('|', '\\|').slice(0, 300)} |`);
    }
  }
  const cases = changed.filter((c) => c.startsWith('cases/'));
  const others = changed.filter((c) => !c.startsWith('cases/'));
  const shown = [...others.map((c) => `\`${c}\``), ...(cases.length ? [`cases/*.json (${cases.length})`] : [])];
  lines.push('', `Changed files: ${shown.length ? shown.join(', ') : 'none'}`);
  if (manifest?.warnings?.length) {
    lines.push('', `Data-quality warnings (${manifest.warnings.length}):`, ...manifest.warnings.map((/** @type {any} */ w) => `- \`${JSON.stringify(w)}\``));
  }
  if (manifest) lines.push('', `latest onset: ${manifest.latestOnset}, years: ${manifest.years[0]}..${manifest.years.at(-1)}`);
  lines.push('');
  await appendFile(path, lines.join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(
    (r) => { process.exitCode = r.exitCode; },
    (e) => { console.error(e); process.exitCode = 1; },
  );
}

