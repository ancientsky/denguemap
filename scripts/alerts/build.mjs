// @ts-check
/**
 * Build the 防疫公告 data from content/alerts/*.json (run by `npm run build` / `npm run dev`):
 *   public/data/alerts.json        notices in force or ended within the last 7 days, in full (loaded by the views)
 *   public/data/alerts-index.json  every notice, summary only (history search)
 *   public/data/alerts/<id>.json   every notice in full (loaded when picked from the history)
 * Every file is validated; any problem fails the build with the list of problems (nothing is published half-valid).
 * Usage: node scripts/alerts/build.mjs [--check]   (--check: validate only, write nothing)
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVillages, publishAlert, validateAlert } from './lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** @param {{root?:string, today?:string, check?:boolean}} [opts] */
export async function buildAlerts(opts = {}) {
  const root = opts.root ?? ROOT;
  const dir = join(root, 'content/alerts');
  const today = opts.today ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  let names = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort(); } catch { /* no notices yet */ }
  const villages = await loadVillages();
  /** @type {string[]} */
  const problems = [];
  const alerts = [];
  const all = [];
  for (const n of names) {
    let a;
    try { a = JSON.parse(await readFile(join(dir, n), 'utf8')); } catch (e) {
      problems.push(`${n}: JSON 格式錯誤（${e instanceof Error ? e.message : String(e)}）`);
      continue;
    }
    const errs = validateAlert(a, villages, n.replace(/\.json$/, ''));
    if (errs.length) {
      problems.push(...errs.map((e) => `${n}: ${e}`));
      continue;
    }
    const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
    const pub = publishAlert(a, villages);
    all.push(pub);
    if (a.validUntil >= cutoff) alerts.push(pub);
  }
  if (problems.length) {
    const e = new Error(`防疫公告驗證失敗：\n${problems.map((p) => `- ${p}`).join('\n')}`);
    /** @type {any} */ (e).problems = problems;
    throw e;
  }
  const newest = (/** @type {any} */ x, /** @type {any} */ y) => (x.issuedAt < y.issuedAt ? 1 : x.issuedAt > y.issuedAt ? -1 : x.id.localeCompare(y.id));
  alerts.sort(newest);
  all.sort(newest);
  const out = { generatedAt: today, alerts };
  const index = {
    generatedAt: today,
    alerts: all.map((a) => ({
      id: a.id, title: a.title, titleEn: a.titleEn, county: a.county, town: a.town, countyZh: a.countyZh, countyEn: a.countyEn,
      townZh: a.townZh, townEn: a.townEn, issuedAt: a.issuedAt, validUntil: a.validUntil, issuer: a.issuer,
      villages: a.villages.length, stations: a.screeningStations.length,
    })),
  };
  if (!opts.check) {
    const data = join(root, 'public/data');
    await mkdir(data, { recursive: true });
    await writeFile(join(data, 'alerts.json'), JSON.stringify(out));
    await writeFile(join(data, 'alerts-index.json'), JSON.stringify(index));
    // per-notice files: rebuilt from scratch so a removed notice disappears
    await rm(join(data, 'alerts'), { recursive: true, force: true });
    await mkdir(join(data, 'alerts'), { recursive: true });
    for (const a of all) await writeFile(join(data, 'alerts', `${a.id}.json`), JSON.stringify(a));
  }
  return { ...out, index };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildAlerts({ check: process.argv.includes('--check') }).then(
    (out) => console.log(`alerts: ${out.index.alerts.length} notice(s), ${out.alerts.length} current${process.argv.includes('--check') ? ', all valid' : ' (public/data/alerts.json, alerts-index.json, alerts/)'}`),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
