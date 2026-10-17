#!/usr/bin/env node
// Smoke test: serve dist/ with `vite preview`, visit every route in zh+en × light+dark at desktop and
// mobile sizes, fail on console errors / page errors / CSP violations (except unreachable basemap
// tiles at tiles.openfreemap.org — the app must fall back to its local style), save screenshots.
//
//   npm run build && npm run smoke
//   SMOKE_ROUTES=map,trends SMOKE_LANGS=zh SMOKE_THEMES=dark SMOKE_DEVICES=mobile npm run smoke
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test-results', 'screens');
const PORT = 4173;
const BASE = `http://localhost:${PORT}/denguemap/`;
const EXE = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const list = (env, def) => (process.env[env] ? process.env[env].split(',') : def);
const ROUTES = list('SMOKE_ROUTES', ['map', 'clusters', 'vector', 'trends', 'imported', 'about']);
const LANGS = list('SMOKE_LANGS', ['zh', 'en']);
const THEMES = list('SMOKE_THEMES', ['light', 'dark']);
const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const DEVICE_NAMES = list('SMOKE_DEVICES', Object.keys(DEVICES));
const ALLOWED = /tiles\.openfreemap\.org/;
// SMOKE_DATA=<dir>: serve /denguemap/data/* from another directory (e.g. .fixtures/data) without touching public/data.
const DATA_DIR = process.env.SMOKE_DATA ? join(process.cwd(), process.env.SMOKE_DATA) : null;
async function prepare(ctx) {
  if (!process.env.SMOKE_REAL_TILES) await ctx.route(/tiles\.openfreemap\.org/, (r) => r.abort('internetdisconnected'));
  if (DATA_DIR) {
    const { readFile } = await import('node:fs/promises');
    await ctx.route(/\/denguemap\/data\//, async (r) => {
      const rel = new URL(r.request().url()).pathname.replace(/^.*\/denguemap\/data\//, '');
      try {
        await r.fulfill({ status: 200, contentType: 'application/json', body: await readFile(join(DATA_DIR, rel)) });
      } catch {
        await r.fulfill({ status: 404, body: 'not found' });
      }
    });
  }
}

mkdirSync(OUT, { recursive: true });

function startPreview() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    const onData = (b) => {
      const s = b.toString();
      if (!done && s.includes(String(PORT))) {
        done = true;
        resolve(proc);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (b) => process.stderr.write(b));
    proc.on('exit', (code) => !done && reject(new Error(`vite preview exited ${code}`)));
    setTimeout(() => !done && reject(new Error('vite preview did not start')), 20000);
  });
}

const preview = await startPreview();
const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});

const failures = [];
let pages = 0;
try {
  for (const device of DEVICE_NAMES) {
    for (const theme of THEMES) {
      for (const lang of LANGS) {
        const context = await browser.newContext({ ...DEVICES[device], colorScheme: theme, locale: lang === 'zh' ? 'zh-TW' : 'en-US', timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' });
        await context.addInitScript(([th, lg]) => {
          try {
            localStorage.setItem('denguemap.theme', th);
            localStorage.setItem('denguemap.lang', lg);
          } catch {}
          document.addEventListener('securitypolicyviolation', (e) => {
            console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI} (${e.sourceFile}:${e.lineNumber})`);
          });
        }, [theme, lang]);
        // Fail fast on the unreachable tile host so the fallback path is exercised deterministically.
        // (set SMOKE_REAL_TILES=1 to let requests through when the network allows it).
        await prepare(context);
        const page = await context.newPage();
        let current = '';
        page.on('console', (msg) => {
          if (msg.type() !== 'error') return;
          const text = msg.text();
          const url = msg.location()?.url ?? '';
          if (ALLOWED.test(text) || ALLOWED.test(url)) return;
          failures.push(`[${current}] console.error: ${text} ${url}`);
        });
        page.on('pageerror', (err) => failures.push(`[${current}] pageerror: ${err.message}`));
        page.on('requestfailed', (req) => {
          if (!ALLOWED.test(req.url())) failures.push(`[${current}] requestfailed: ${req.url()} ${req.failure()?.errorText}`);
        });
        page.on('response', (res) => {
          if (res.status() >= 400 && !ALLOWED.test(res.url())) failures.push(`[${current}] HTTP ${res.status()}: ${res.url()}`);
        });
        for (const route of ROUTES) {
          current = `${route}-${lang}-${theme}-${device}`;
          await page.goto(`${BASE}#/${route}`, { waitUntil: 'load' });
          await page.waitForFunction(() => document.body.dataset.ready === '1' && document.body.dataset.route, null, { timeout: 20000 }).catch(() => failures.push(`[${current}] app not ready`));
          const isMap = ['map', 'clusters', 'vector', 'imported'].includes(route);
          if (isMap) {
            // the map must render via the local fallback style
            await page.waitForFunction(() => document.querySelector('.map canvas') && document.body.dataset.mapIdle === '1', null, { timeout: 25000 })
              .catch(() => failures.push(`[${current}] map did not become idle`));
          } else if (route === 'trends') {
            await page.waitForFunction(() => document.querySelectorAll('.chart canvas').length >= 3, null, { timeout: 20000 })
              .catch(() => failures.push(`[${current}] charts not rendered`));
          }
          await page.waitForTimeout(isMap ? 700 : 300);
          // views must not end in an error state with valid data
          const errCards = await page.$$eval('.error-card', (els) => els.map((e) => e.textContent?.trim()));
          if (errCards.length) failures.push(`[${current}] error state shown: ${errCards.join(' | ')}`);
          // sanity: <html lang> and data-theme match
          const meta = await page.evaluate(() => ({ lang: document.documentElement.lang, theme: document.documentElement.dataset.theme, title: document.title }));
          if (meta.theme !== theme) failures.push(`[${current}] data-theme=${meta.theme}`);
          if (!(lang === 'en' ? /^en/ : /^zh-Hant/).test(meta.lang)) failures.push(`[${current}] html lang=${meta.lang}`);
          await page.screenshot({ path: join(OUT, `${current}.png`) });
          pages++;
        }
        await context.close();
      }
    }
  }
  // Interaction pass: runtime theme/language switching, controls, playback, CSV, keyboard.
  {
    const ctx = await browser.newContext({ ...DEVICES.desktop, colorScheme: 'light', reducedMotion: 'reduce', acceptDownloads: true });
    await ctx.addInitScript(() => {
      // only on first load: the pass switches theme/language itself and reloads to test persistence
      try { if (!localStorage.getItem('denguemap.lang')) { localStorage.setItem('denguemap.theme', 'light'); localStorage.setItem('denguemap.lang', 'zh'); } } catch {}
      document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
    });
    await prepare(ctx);
    const page = await ctx.newPage();
    let step = 'start';
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !ALLOWED.test(msg.text()) && !ALLOWED.test(msg.location()?.url ?? '')) failures.push(`[interact:${step}] console.error: ${msg.text()}`);
    });
    page.on('pageerror', (err) => failures.push(`[interact:${step}] pageerror: ${err.message}`));
    const idle = async () => {
      await page.waitForFunction(() => document.body.dataset.mapIdle === '1', null, { timeout: 20000 }).catch(() => failures.push(`[interact:${step}] map not idle`));
    };
    const resetIdle = () => page.evaluate(() => { delete document.body.dataset.mapIdle; });
    try {
      step = 'load';
      await page.goto(`${BASE}#/map`);
      await idle();
      step = 'theme';
      await resetIdle();
      await page.click('.theme-btn'); // light → dark
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await idle();
      if (!(await page.evaluate(() => document.querySelector('.theme-btn')?.getAttribute('aria-label')?.length))) failures.push('[interact] theme button lacks aria-label');
      step = 'lang';
      await page.click('.lang-btn');
      await page.waitForFunction(() => document.documentElement.lang === 'en' && document.querySelector('.panel-title')?.textContent === 'Dengue case map', null, { timeout: 10000 })
        .catch(() => failures.push('[interact] language switch did not re-render'));
      if (!/Dengue Map/.test(await page.title())) failures.push('[interact] document title not localised');
      step = 'controls';
      await page.check('input.seg-input[value="heat"]');
      await page.check('input.seg-input[value="towns"]');
      await page.check('input.seg-input[value="all"]');
      await page.getByRole('switch', { name: 'NS1 rapid-test clinics' }).check();
      await page.getByRole('switch', { name: 'Mosquito risk villages' }).check();
      await page.check('input.seg-input[value="type"]');
      await page.waitForTimeout(600);
      for (const k of ['type=all', 'mode=towns', 'ns1=1', 'mv=1', 'color=type']) if (!page.url().includes(k)) failures.push(`[interact] URL state missing ${k}: ${page.url()}`);
      await page.check('input.seg-input[value="recency"]');
      await page.check('input.seg-input[value="points"]');
      await page.waitForTimeout(300);
      if (!(await page.isVisible('.date-badge'))) failures.push('[interact] reference-date badge not shown in recency mode');
      if ((await page.$$('.legend .lg-ns1')).length !== 1) failures.push('[interact] NS1 legend entry missing');
      step = 'play';
      await page.click('.play-btn');
      await page.waitForTimeout(900);
      const playing = await page.evaluate(() => document.querySelector('.play-btn')?.getAttribute('aria-pressed'));
      if (playing !== 'true') failures.push('[interact] play did not start');
      await page.click('.play-btn');
      await page.click('button[aria-label^="Stop"]');
      step = 'keyboard';
      await page.focus('.r-from');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(200);
      if (!/from=3/.test(page.url())) failures.push(`[interact] keyboard slider did not update URL: ${page.url()}`);
      step = 'reload-state';
      await resetIdle();
      await page.reload();
      await idle();
      const restored = await page.evaluate(() => (document.querySelector('input.seg-input[value="points"]'))?.checked && (document.querySelector('input[role="switch"]'))?.checked);
      if (!restored) failures.push('[interact] state not restored after reload');
      step = 'trends-theme';
      await page.click('a[data-route="trends"]');
      await page.waitForFunction(() => document.querySelectorAll('.chart canvas').length >= 3, null, { timeout: 20000 });
      await page.click('.theme-btn'); // dark → system
      await page.click('.theme-btn'); // system → light
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light' && document.querySelectorAll('.chart canvas').length >= 3);
      await page.check('.year-chips input[value="2014"]');
      await page.waitForTimeout(300);
      if (!/years=/.test(page.url())) failures.push('[interact] trends years not in URL');
      step = 'imported';
      await resetIdle();
      await page.click('a[data-route="imported"]');
      await idle();
      await page.click('.rank-countries .rank-btn >> nth=0');
      await page.waitForSelector('.country-card', { timeout: 5000 }).catch(() => failures.push('[interact] country panel not shown'));
      if (!/country=/.test(page.url())) failures.push('[interact] country not in URL');
      if (!(await page.$('.country-card a[href^="https://ancientsky.github.io/safetravel/"]'))) failures.push('[interact] SafeTravel link missing');
      // animation controls (reduced motion: static, but play/pause/scrub must work)
      await page.click('.anim-box .play-btn');
      await page.waitForTimeout(500);
      await page.click('.anim-box .play-btn');
      await page.$eval('.scrubber', (el) => { el.value = String(Number(el.min) + 30); el.dispatchEvent(new Event('input', { bubbles: true })); });
      if (!/\d/.test((await page.textContent('.anim-counter')) ?? '')) failures.push('[interact] scrubber did not update the counter');
      // advisory tab + layer switch
      await page.click('[role="tab"]:has-text("Advisories")');
      await page.check('input.seg-input[value="all"]');
      await page.waitForTimeout(300);
      if (!page.url().includes('adv=all') || !page.url().includes('tab=adv')) failures.push(`[interact] advisory state not in URL: ${page.url()}`);
      // news feed: filter chip, paging, country button
      await page.click('[role="tab"]:has-text("World news")');
      const before = await page.$$eval('.tabpanel:not([hidden]) .news-item', (e) => e.length);
      if (before < 1) failures.push('[interact] news feed empty');
      if (await page.$('.more-btn')) {
        await page.click('.more-btn');
        const after = await page.$$eval('.tabpanel:not([hidden]) .news-item', (e) => e.length);
        if (after <= before) failures.push('[interact] "more" did not load more news');
      }
      await page.click('.fchip[data-d="dengue"]');
      const ds = await page.$$eval('.tabpanel:not([hidden]) .news-item', (els) => els.every((e) => e.querySelector('.d-dengue')));
      if (!ds) failures.push('[interact] disease filter not applied');
      await page.click('.tabpanel:not([hidden]) .cc-btn >> nth=0');
      await page.waitForSelector('.country-card');
      const badLinks = await page.$$eval('a[target="_blank"]', (as) => as.filter((a) => !/noopener/.test(a.rel) || !/noreferrer/.test(a.rel)).length);
      if (badLinks) failures.push(`[interact] ${badLinks} external links without rel=noopener noreferrer`);
      step = 'vector-csv';
      await resetIdle();
      await page.click('a[data-route="vector"]');
      await page.waitForSelector('.panel-vector .btn');
      await idle();
      await page.getByRole('switch', { name: 'Show recent cases' }).check();
      await page.waitForSelector('.case-note .legend', { timeout: 10000 }).catch(() => failures.push('[interact] recent cases overlay not loaded'));
      if (!page.url().includes('cases=1')) failures.push('[interact] cases toggle not in URL');
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('.panel-vector .btn:has-text("CSV")')]);
      const path = await dl.path();
      const { readFileSync } = await import('node:fs');
      const buf = readFileSync(path);
      if (!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)) failures.push('[interact] CSV lacks UTF-8 BOM');
      step = 'skip-link';
      await page.goto(`${BASE}#/about`);
      await page.reload(); // a hash-only goto keeps focus; reload gives a fresh document
      await page.waitForFunction(() => document.body.dataset.ready === '1');
      await page.keyboard.press('Tab');
      const skip = await page.evaluate(() => document.activeElement?.classList.contains('skip-link'));
      if (!skip) failures.push('[interact] first Tab does not reach the skip link');
      await page.keyboard.press('Enter');
      if (!(await page.evaluate(() => document.activeElement?.id === 'main'))) failures.push('[interact] skip link does not focus main');
    } catch (e) {
      failures.push(`[interact:${step}] ${e.message}`);
    }
    await ctx.close();
    console.log('interaction pass done');
  }
  // Regression (owner report): on phones, leaving the Imported globe left the map/vector views zoomed
  // out to Southeast Asia (MapLibre keeps camera padding from jumpTo; fitBounds added it again).
  {
    const ctx = await browser.newContext({ ...DEVICES.mobile, reducedMotion: 'reduce' });
    await prepare(ctx);
    const page = await ctx.newPage();
    const zoomAfter = async (route) => {
      await page.evaluate(() => { delete document.body.dataset.mapZoom; });
      await page.click(`a[href="#/${route}"]`);
      await page.waitForTimeout(1500);
      await page.waitForFunction(() => document.body.dataset.mapZoom, null, { timeout: 20000 });
      return Number(await page.evaluate(() => document.body.dataset.mapZoom));
    };
    try {
      await page.goto(`${BASE}#/imported`);
      await page.waitForFunction(() => document.body.dataset.mapIdle === '1', null, { timeout: 25000 });
      for (const route of ['vector', 'map']) {
        const z = await zoomAfter(route);
        if (!(z >= 5.5)) failures.push(`[mobile-zoom] ${route} after imported: zoom ${z} (expected Taiwan, >= 5.5)`);
      }
    } catch (e) {
      failures.push(`[mobile-zoom] ${e.message}`);
    }
    await ctx.close();
    console.log('mobile zoom regression pass done');
  }
  // Imported globe animation: capture mid-animation frames (motion allowed) in both themes.
  for (const theme of THEMES) {
    const ctx = await browser.newContext({ ...DEVICES.desktop, colorScheme: theme, reducedMotion: 'no-preference' });
    await ctx.addInitScript((th) => { try { localStorage.setItem('denguemap.theme', th); localStorage.setItem('denguemap.lang', 'zh'); } catch {} }, theme);
    await prepare(ctx);
    const page = await ctx.newPage();
    page.on('pageerror', (err) => failures.push(`[anim-${theme}] pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !ALLOWED.test(msg.text()) && !ALLOWED.test(msg.location()?.url ?? '')) failures.push(`[anim-${theme}] console.error: ${msg.text()}`);
    });
    await page.goto(`${BASE}#/imported`);
    await page.waitForFunction(() => document.body.dataset.mapIdle === '1', null, { timeout: 25000 }).catch(() => failures.push(`[anim-${theme}] map not idle`));
    const playing = await page.evaluate(() => document.querySelector('.anim-box .play-btn')?.getAttribute('aria-pressed'));
    if (playing !== 'true') failures.push(`[anim-${theme}] imported playback did not autoplay`);
    await page.click('.anim-box .seg-input[value="4"]', { force: true });
    for (const [i, ms] of [[1, 2500], [2, 2500], [3, 2500]]) {
      await page.waitForTimeout(ms);
      await page.screenshot({ path: join(OUT, `imported-anim-${i}-${theme}.png`) });
    }
    const counter = await page.textContent('.anim-counter');
    if (!/\d/.test(counter ?? '')) failures.push(`[anim-${theme}] counter not updating`);
    await ctx.close();
  }
  // Performance probe: the largest year (2015, ~43k local cases) with all case types.
  {
    const ctx = await browser.newContext({ ...DEVICES.desktop, reducedMotion: 'reduce' });
    await prepare(ctx);
    const page = await ctx.newPage();
    page.on('pageerror', (err) => failures.push(`[perf] pageerror: ${err.message}`));
    const t0 = Date.now();
    await page.goto(`${BASE}#/map?year=2015&type=all`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.mapIdle === '1' && /2015/.test(document.querySelector('.result-line')?.textContent ?? ''), null, { timeout: 30000 })
      .catch(() => failures.push('[perf] 2015 map did not render'));
    const loadMs = Date.now() - t0;
    // Drag the end handle across the year: 40 input events, measure main-thread time per update.
    const perStep = await page.evaluate(async () => {
      const el = document.querySelector('.r-to');
      if (!(el instanceof HTMLInputElement)) return -1;
      const t = performance.now();
      for (let v = 365; v > 165; v -= 5) {
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      return (performance.now() - t) / 40;
    });
    console.log(`perf: 2015 (all types) first render ${loadMs} ms; slider drag ≈ ${perStep.toFixed(1)} ms/frame (SwiftShader software GL — real GPUs are far faster)`);
    if (!process.env.SMOKE_NO_SCREENS) await page.screenshot({ path: join(OUT, 'perf-2015-desktop.png') });
    await ctx.close();
  }
  // Static check: built HTML must not contain inline scripts.
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const res = await p.goto(BASE);
  const html = await res.text();
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
  if (inline.length) failures.push(`index.html contains ${inline.length} inline <script>`);
  await ctx.close();
} finally {
  await browser.close();
  preview.kill();
}

console.log(`Visited ${pages} page states; screenshots in ${OUT}`);
if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n${[...new Set(failures)].join('\n')}`);
  process.exit(1);
}
console.log('Smoke test passed.');
