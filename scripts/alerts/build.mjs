// @ts-check
/**
 * Build public/data/alerts.json from content/alerts/*.json (run by `npm run build` / `npm run dev`).
 * Every file is validated; any problem fails the build with the list of problems (nothing is published half-valid).
 * Notices whose validUntil is more than 7 days in the past are left out (the page hides expired ones anyway).
 * Usage: node scripts/alerts/build.mjs [--check]   (--check: validate only, write nothing)
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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
    if (a.validUntil >= cutoff) alerts.push(publishAlert(a, villages));
  }
  if (problems.length) {
    const e = new Error(`防疫公告驗證失敗：\n${problems.map((p) => `- ${p}`).join('\n')}`);
    /** @type {any} */ (e).problems = problems;
    throw e;
  }
  alerts.sort((x, y) => (x.issuedAt < y.issuedAt ? 1 : x.issuedAt > y.issuedAt ? -1 : x.id.localeCompare(y.id)));
  const out = { generatedAt: today, alerts };
  if (!opts.check) {
    await mkdir(join(root, 'public/data'), { recursive: true });
    await writeFile(join(root, 'public/data/alerts.json'), JSON.stringify(out));
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildAlerts({ check: process.argv.includes('--check') }).then(
    (out) => console.log(`alerts: ${out.alerts.length} notice(s)${process.argv.includes('--check') ? ' valid' : ' written to public/data/alerts.json'}`),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
