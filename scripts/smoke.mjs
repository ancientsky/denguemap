#!/usr/bin/env node
// Smoke test: serve dist/ with `vite preview`, visit every route in zh+en × light+dark at desktop and
// mobile sizes, fail on console errors / page errors / CSP violations (except unreachable basemap
// tiles at tiles.openfreemap.org — the app must fall back to its local style), save screenshots.
//
//   npm run build && npm run smoke
//   SMOKE_ROUTES=map,trends SMOKE_LANGS=zh SMOKE_THEMES=dark SMOKE_DEVICES=mobile npm run smoke
//   SMOKE_PASSES=embed npm run smoke      (matrix,interact,zoom,anim,perf,embed — default: all)
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
const PASSES = list('SMOKE_PASSES', ['matrix', 'interact', 'zoom', 'anim', 'perf', 'embed']);
const run = (name) => PASSES.includes(name);
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

// ---------------------------------------------------------------------------------------------
// Embed mode (docs/embedding.md): ?embed=1&theme=…&lang=… — chrome hidden, link to the full site, no
// persisted preferences, cooperative gestures, calm imported view; plus a real cross-origin iframe.
// ---------------------------------------------------------------------------------------------
const EMBED_ROUTES = ['map', 'vector', 'imported'];
const EMBED_DEVICES = {
  desktop: { viewport: { width: 800, height: 560 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  mobile: { viewport: { width: 390, height: 600 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const CSP_LISTENER = () => document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI} (${e.sourceFile}:${e.lineNumber})`));

/** Fresh context that does NOT pre-seed localStorage (embed must work, and write nothing, from a clean profile). */
async function embedContext(device, { theme, lang, motion = 'no-preference' }) {
  const ctx = await browser.newContext({
    ...(typeof device === 'string' ? EMBED_DEVICES[device] : device),
    // The OS/browser says the opposite of the URL: proves the URL parameters win.
    colorScheme: theme === 'dark' ? 'light' : 'dark',
    locale: lang === 'zh' ? 'en-US' : 'zh-TW',
    timezoneId: 'Asia/Taipei',
    reducedMotion: motion,
  });
  await ctx.addInitScript(CSP_LISTENER);
  await prepare(ctx);
  return ctx;
}

function watch(page, label) {
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (ALLOWED.test(text) || ALLOWED.test(msg.location()?.url ?? '')) return;
    failures.push(`[${label()}] console.error: ${text} ${msg.location()?.url ?? ''}`);
  });
  page.on('pageerror', (err) => failures.push(`[${label()}] pageerror: ${err.message}`));
  page.on('requestfailed', (req) => {
    if (!ALLOWED.test(req.url())) failures.push(`[${label()}] requestfailed: ${req.url()} ${req.failure()?.errorText}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && !ALLOWED.test(res.url())) failures.push(`[${label()}] HTTP ${res.status()}: ${res.url()}`);
  });
}

/** Wait until the app (or the given frame) has mounted a map view and the map is idle. */
async function mapReady(frame, label) {
  await frame.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 20000 }).catch(() => failures.push(`[${label}] app not ready`));
  await frame.waitForFunction(() => document.querySelector('.map canvas') && document.body.dataset.mapIdle === '1', null, { timeout: 25000 })
    .catch(() => failures.push(`[${label}] map did not become idle`));
}

/** Everything the embed UI promises, read from the page in one round-trip. */
function embedFacts() {
  const shown = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const a = document.querySelector('.embed-bar a.embed-open');
  let url = null;
  if (a) {
    const u = new URL(a.href);
    url = { origin: u.origin, path: u.pathname, search: u.search, hash: u.hash, target: a.getAttribute('target'), rel: a.getAttribute('rel'), text: a.textContent.trim() };
  }
  const store = {};
  try { for (let i = 0; i < localStorage.length; i++) store[localStorage.key(i)] = localStorage.getItem(localStorage.key(i)); } catch { /* blocked */ }
  const bar = document.querySelector('.embed-bar')?.getBoundingClientRect();
  const panelBody = document.querySelector('.panel .panel-body');
  return {
    topbar: shown('.topbar'), nav: shown('.primary-nav'), brand: shown('.brand'), bar: shown('.embed-bar'),
    barBottomGap: bar ? Math.round(innerHeight - bar.bottom) : null,
    barText: document.querySelector('.embed-data')?.textContent ?? '',
    link: url,
    dataEmbed: document.documentElement.dataset.embed ?? null,
    theme: document.documentElement.dataset.theme, themePref: document.documentElement.dataset.themePref, htmlLang: document.documentElement.lang,
    storage: store,
    overflowX: document.documentElement.scrollWidth - innerWidth,
    panelBodyShown: panelBody ? getComputedStyle(panelBody).display !== 'none' : null,
    gestureClass: !!document.querySelector('.maplibregl-cooperative-gestures'),
    gestureDesktop: document.querySelector('.maplibregl-desktop-message')?.textContent ?? '',
    gestureTouch: document.querySelector('.maplibregl-mobile-message')?.textContent ?? '',
    // nothing may navigate the host page: every link is an in-frame hash link or opens a new tab
    escapingLinks: [...document.querySelectorAll('a[href]')].filter((l) => !(l.getAttribute('href').startsWith('#') || l.target === '_blank')).map((l) => l.getAttribute('href')),
    playPressed: document.querySelector('.anim-box .play-btn')?.getAttribute('aria-pressed') ?? null,
    counter: document.querySelector('.anim-counter')?.textContent ?? null,
  };
}

function checkEmbedFacts(f, { route, lang, theme, device, label, expectPanelOpen }) {
  const bad = (m) => failures.push(`[${label}] ${m}`);
  if (f.dataEmbed !== '1') bad('html[data-embed] not set');
  if (f.topbar || f.brand) bad('site header is visible');
  if (f.nav) bad('primary nav / mobile tab bar is visible');
  if (!f.bar) bad('embed bar not visible');
  if (f.barBottomGap !== 0) bad(`embed bar not at the bottom edge (gap ${f.barBottomGap})`);
  if (f.theme !== theme) bad(`data-theme=${f.theme}, expected ${theme}`);
  if (f.themePref !== theme) bad(`data-theme-pref=${f.themePref}, expected ${theme}`);
  if (!(lang === 'en' ? /^en/ : /^zh-Hant/).test(f.htmlLang)) bad(`html lang=${f.htmlLang}`);
  if (Object.keys(f.storage).length) bad(`localStorage was written: ${JSON.stringify(f.storage)}`);
  if (f.overflowX > 0) bad(`horizontal overflow ${f.overflowX}px`);
  if (f.escapingLinks.length) bad(`links that could navigate the host: ${f.escapingLinks.join(', ')}`);
  const want = lang === 'en' ? /^Data: Taiwan CDC · updated \d/ : /^資料：衛生福利部疾病管制署｜更新 \d/;
  if (!want.test(f.barText)) bad(`data line wrong: "${f.barText}"`);
  const l = f.link;
  if (!l) return bad('"open full map" link missing');
  if (l.target !== '_blank' || !/\bnoopener\b/.test(l.rel ?? '') || !/\bnoreferrer\b/.test(l.rel ?? '')) bad(`open link target/rel wrong: ${l.target} ${l.rel}`);
  if (l.path !== '/denguemap/' || l.search !== '') bad(`open link should be the plain site URL, got ${l.path}${l.search}`);
  if (!l.text.startsWith(lang === 'en' ? 'Dengue Map' : '登革熱地圖')) bad(`open link text "${l.text}"`);
  const q = new URLSearchParams(l.hash.includes('?') ? l.hash.slice(l.hash.indexOf('?') + 1) : '');
  if (!l.hash.startsWith(`#/${route}`)) bad(`open link points at ${l.hash}, expected #/${route}`);
  if (q.has('embed')) bad(`open link still has embed: ${l.hash}`);
  if (q.get('lang') !== lang) bad(`open link lang=${q.get('lang')}`);
  if (q.get('theme') !== theme) bad(`open link theme=${q.get('theme')}`);
  if (!f.gestureClass) bad('cooperative gestures not enabled');
  if (lang === 'en' ? !/zoom the map/.test(f.gestureDesktop) || !/two fingers/.test(f.gestureTouch) : !/縮放地圖/.test(f.gestureDesktop) || !/兩指/.test(f.gestureTouch)) {
    bad(`gesture help not localised: "${f.gestureDesktop}" / "${f.gestureTouch}"`);
  }
  if (expectPanelOpen !== undefined && f.panelBodyShown !== expectPanelOpen) bad(`panel body shown=${f.panelBodyShown}, expected ${expectPanelOpen} (${device})`);
  if (route === 'imported' && f.playPressed !== 'false' && f.playPressed !== null) bad(`imported animation autoplayed (aria-pressed=${f.playPressed})`);
}

async function embedPass() {
  // 1. Matrix: 3 views × zh/en × light/dark × desktop 800×560 / mobile 390×600, all via URL params only.
  for (const device of Object.keys(EMBED_DEVICES)) {
    for (const theme of ['light', 'dark']) {
      for (const lang of ['zh', 'en']) {
        const ctx = await embedContext(device, { theme, lang });
        const page = await ctx.newPage();
        let label = '';
        watch(page, () => label);
        for (const route of EMBED_ROUTES) {
          label = `embed-${route}-${lang}-${theme}-${device}`;
          await page.goto(`${BASE}?embed=1&theme=${theme}&lang=${lang}#/${route}`, { waitUntil: 'load' });
          await mapReady(page, label);
          await page.waitForFunction(() => document.querySelector('.embed-data')?.textContent, null, { timeout: 10000 }).catch(() => failures.push(`[${label}] data line empty`));
          await page.waitForTimeout(700);
          const errCards = await page.$$eval('.error-card', (els) => els.map((e) => e.textContent?.trim()));
          if (errCards.length) failures.push(`[${label}] error state shown: ${errCards.join(' | ')}`);
          const facts = await page.evaluate(embedFacts);
          // phones start with the panel collapsed to its title row; 800×560 keeps it open
          checkEmbedFacts(facts, { route, lang, theme, device, label, expectPanelOpen: device !== 'mobile' });
          if (route === 'imported') {
            await page.waitForTimeout(1200);
            const again = await page.evaluate(embedFacts);
            if (again.counter !== facts.counter) failures.push(`[${label}] imported counter moved on its own: "${facts.counter}" -> "${again.counter}"`);
          }
          // the offline-basemap toast is an artifact of this network-less run: keep it out of the screenshots
          await page.evaluate(() => document.querySelectorAll('.toast').forEach((e) => e.remove()));
          await page.screenshot({ path: join(OUT, `${label}.png`) });
          pages++;
        }
        await ctx.close();
      }
    }
  }

  // 2. Interactions inside the embed.
  {
    const theme = 'dark', lang = 'en';
    let label = 'embed-interact';
    // 2a. Params only in the hash query; shareable state keeps them; in-frame navigation re-adds them.
    const ctx = await embedContext('desktop', { theme, lang });
    const page = await ctx.newPage();
    watch(page, () => label);
    try {
      label = 'embed-hash-params';
      await page.goto(`${BASE}#/map?embed=1&theme=dark&lang=en`, { waitUntil: 'load' });
      await mapReady(page, label);
      const f0 = await page.evaluate(embedFacts);
      checkEmbedFacts(f0, { route: 'map', lang, theme, device: 'desktop', label, expectPanelOpen: true });
      await page.check('input.seg-input[value="all"]');
      await page.waitForTimeout(500);
      const h1 = new URLSearchParams(await page.evaluate(() => location.hash.slice(location.hash.indexOf('?') + 1)));
      for (const [k, v] of [['embed', '1'], ['theme', 'dark'], ['lang', 'en'], ['type', 'all']]) if (h1.get(k) !== v) failures.push(`[${label}] hash lost ${k}=${v} after a control change: ${page.url()}`);
      const href1 = await page.getAttribute('.embed-open', 'href');
      if (!/type=all/.test(href1) || /embed/.test(href1)) failures.push(`[${label}] open link does not follow the state: ${href1}`);
      await page.evaluate(() => { delete document.body.dataset.mapIdle; location.hash = '#/vector'; }); // what an in-frame link click does
      await page.waitForFunction(() => document.body.dataset.route === 'vector' && /embed=1/.test(location.hash), null, { timeout: 10000 })
        .catch(() => failures.push(`[${label}] embed params not restored after in-frame navigation: ${page.url()}`));
      await mapReady(page, label);
      const hash2 = await page.evaluate(() => location.hash);
      if (!/theme=dark/.test(hash2) || !/lang=en/.test(hash2)) failures.push(`[${label}] theme/lang dropped from hash: ${hash2}`);
      if (!/#\/vector/.test(await page.getAttribute('.embed-open', 'href'))) failures.push(`[${label}] open link did not follow the view`);
      // a hostile hash is not reflected anywhere
      await page.evaluate(() => { delete document.body.dataset.mapIdle; location.hash = '#/map?embed=1&theme=%3Cimg%20src%3Dx%3E&lang=%22%3E%3Cb%3E&year=%3Cb%3E'; });
      await page.waitForFunction(() => document.body.dataset.route === 'map', null, { timeout: 10000 })
        .catch(async () => failures.push(`[${label}] hostile hash did not route to map: ${JSON.stringify(await page.evaluate(() => [document.body.dataset.route, location.hash]))}`));
      await mapReady(page, label);
      const hostile = await page.evaluate(() => ({ hash: location.hash, html: document.documentElement.outerHTML.includes('<img src=x') }));
      if (/img|%3C|%22/i.test(hostile.hash) || hostile.html) failures.push(`[${label}] hostile param reflected: ${hostile.hash}`);
      pages++;
    } catch (e) {
      failures.push(`[${label}] ${e.message}`);
    }
    await ctx.close();
  }
  {
    // 2b. Search params + view params in the hash (the documented iframe form).
    const label = 'embed-search-params';
    const ctx = await embedContext('desktop', { theme: 'dark', lang: 'en' });
    const page = await ctx.newPage();
    watch(page, () => label);
    try {
      await page.goto(`${BASE}?embed=1&theme=dark&lang=en#/vector?county=64000`, { waitUntil: 'load' });
      await mapReady(page, label);
      const f = await page.evaluate(embedFacts);
      checkEmbedFacts(f, { route: 'vector', lang: 'en', theme: 'dark', device: 'desktop', label, expectPanelOpen: true });
      if (!/county=64000/.test(f.link?.hash ?? '')) failures.push(`[${label}] open link lost the view state: ${f.link?.hash}`);
      if (!/embed=1/.test(page.url().split('#')[0])) failures.push(`[${label}] search params were removed from the URL: ${page.url()}`);
      pages++;
    } catch (e) {
      failures.push(`[${label}] ${e.message}`);
    }
    await ctx.close();
  }
  {
    // 2c. Compact panel in a short iframe (< 560 px): title row only, tap to open. Plus Play works on demand.
    const label = 'embed-compact';
    const ctx = await embedContext({ viewport: { width: 800, height: 480 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }, { theme: 'light', lang: 'zh' });
    const page = await ctx.newPage();
    watch(page, () => label);
    try {
      await page.goto(`${BASE}?embed=1&theme=light&lang=zh#/map`, { waitUntil: 'load' });
      await mapReady(page, label);
      if ((await page.evaluate(embedFacts)).panelBodyShown !== false) failures.push(`[${label}] panel should start collapsed in a short iframe`);
      await page.evaluate(() => document.querySelectorAll('.toast').forEach((e) => e.remove()));
      await page.screenshot({ path: join(OUT, 'embed-map-compact-zh-light-800x480.png') });
      await page.click('.sheet-handle');
      await page.waitForTimeout(300);
      if ((await page.evaluate(embedFacts)).panelBodyShown !== true) failures.push(`[${label}] panel did not open on tap`);
      await page.screenshot({ path: join(OUT, 'embed-map-compact-open-zh-light-800x480.png') });
      // imported: no autoplay, but the user's Play button works
      await page.goto(`${BASE}?embed=1&theme=light&lang=zh#/imported`, { waitUntil: 'load' });
      await mapReady(page, label);
      await page.click('.sheet-handle');
      if ((await page.getAttribute('.anim-box .play-btn', 'aria-pressed')) !== 'false') failures.push(`[${label}] imported autoplayed`);
      await page.click('.anim-box .play-btn');
      await page.waitForTimeout(600);
      if ((await page.getAttribute('.anim-box .play-btn', 'aria-pressed')) !== 'true') failures.push(`[${label}] Play did not start the animation`);
      await page.click('.anim-box .play-btn');
      pages++;
    } catch (e) {
      failures.push(`[${label}] ${e.message}`);
    }
    await ctx.close();
  }
  {
    // 2d. Not embed: invalid values are ignored; an explicit ?theme= applies once and is never saved.
    const label = 'embed-negative';
    const ctx = await browser.newContext({ ...DEVICES.desktop, colorScheme: 'light', reducedMotion: 'reduce' });
    await prepare(ctx);
    const page = await ctx.newPage();
    watch(page, () => label);
    try {
      await page.goto(`${BASE}?embed=yes&theme=blue&lang=fr#/map`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.body.dataset.ready === '1');
      let f = await page.evaluate(() => ({ embed: document.documentElement.dataset.embed ?? null, theme: document.documentElement.dataset.theme, topbar: getComputedStyle(document.querySelector('.topbar')).display, bar: !!document.querySelector('.embed-bar'), coop: !!document.querySelector('.maplibregl-cooperative-gestures') }));
      if (f.embed || f.theme !== 'light' || f.topbar === 'none' || f.bar || f.coop) failures.push(`[${label}] invalid params changed behaviour: ${JSON.stringify(f)}`);
      await page.goto(`${BASE}?theme=dark#/about`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.body.dataset.ready === '1');
      await page.reload();
      await page.waitForFunction(() => document.body.dataset.ready === '1');
      f = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, topbar: getComputedStyle(document.querySelector('.topbar')).display, store: Object.keys(localStorage).filter((k) => k.startsWith('denguemap.')) }));
      if (f.theme !== 'dark' || f.topbar === 'none') failures.push(`[${label}] ?theme=dark outside embed: ${JSON.stringify(f)}`);
      if (f.store.length) failures.push(`[${label}] ?theme= was persisted outside embed: ${f.store.join(',')}`);
      pages++;
    } catch (e) {
      failures.push(`[${label}] ${e.message}`);
    }
    await ctx.close();
  }

  // 3. A real cross-origin iframe on a fake host page: loads, and plain wheel scrolling is not hijacked.
  {
    const label = 'embed-iframe';
    const ctx = await embedContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }, { theme: 'dark', lang: 'zh' });
    // Two distinct fake origins (host.test embeds app.test); app.test is proxied to the local preview server.
    // (The proxy also sidesteps Chromium's private-network checks for a public page framing localhost.)
    const APP = 'http://app.test/denguemap/';
    await ctx.route('http://app.test/**', async (r) => {
      const u = new URL(r.request().url());
      await r.fulfill({ response: await r.fetch({ url: `http://localhost:${PORT}${u.pathname}${u.search}` }) });
    });
    const src = `${APP}?embed=1&theme=dark&lang=zh#/map`;
    const hostHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Host</title><body style="margin:0;font:16px system-ui;background:#fff;color:#111">
<h1 style="margin:0;padding:24px">Taiwan CDC prototype (fake host)</h1><p style="height:240px;padding:0 24px">Intro text above the map.</p>
<iframe id="dm" src="${src}" title="登革熱病例地圖" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="fullscreen" style="display:block;width:800px;height:560px;border:0;margin:0 24px"></iframe>
<p style="height:1400px;padding:0 24px">Text below the map.</p></body></html>`;
    await ctx.route('http://host.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: hostHtml }));
    const page = await ctx.newPage();
    watch(page, () => label);
    try {
      await page.goto('http://host.test/', { waitUntil: 'load' });
      await page.evaluate(() => document.getElementById('dm').scrollIntoView({ block: 'start' }));
      // loading="lazy": the iframe starts navigating once it is near the viewport, so poll for its frame
      let frame;
      for (let i = 0; i < 200 && !frame; i++) {
        frame = page.frames().find((f) => f.url().startsWith(APP));
        if (!frame) await page.waitForTimeout(100);
      }
      if (!frame) throw new Error('iframe did not navigate to the map');
      await mapReady(frame, label);
      const f = await frame.evaluate(embedFacts);
      checkEmbedFacts(f, { route: 'map', lang: 'zh', theme: 'dark', device: 'desktop', label, expectPanelOpen: true });
      await frame.evaluate(() => document.querySelectorAll('.toast').forEach((e) => e.remove()));
      await page.screenshot({ path: join(OUT, 'embed-iframe-host-dark.png') });
      const zoom = async () => Number(await frame.evaluate(() => document.body.dataset.mapZoom));
      const box = await (await page.$('#dm')).boundingBox();
      // aim at the map area to the right of the panel
      await page.mouse.move(box.x + box.width - 120, box.y + box.height / 2);
      const z0 = await zoom();
      const y0 = await page.evaluate(() => scrollY);
      await page.mouse.wheel(0, -300); // scroll "up": the map must not zoom, the host page scrolls instead
      await page.waitForTimeout(1500);
      const z1 = await zoom();
      const y1 = await page.evaluate(() => scrollY);
      if (Math.abs(z1 - z0) > 0.01) failures.push(`[${label}] plain wheel zoomed the map (${z0} -> ${z1})`);
      if (!(y1 < y0)) failures.push(`[${label}] plain wheel did not scroll the host page (scrollY ${y0} -> ${y1})`);
      // positive control: Ctrl + wheel does zoom
      await page.evaluate(() => document.getElementById('dm').scrollIntoView({ block: 'start' }));
      await page.mouse.move(box.x + box.width - 120, (await (await page.$('#dm')).boundingBox()).y + box.height / 2);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -400);
      await page.keyboard.up('Control');
      await frame.waitForFunction((z) => Math.abs(Number(document.body.dataset.mapZoom) - z) > 0.2, z1, { timeout: 8000 })
        .catch(() => failures.push(`[${label}] Ctrl + wheel did not zoom the map (zoom stayed ${z1})`));
      pages++;
    } catch (e) {
      failures.push(`[${label}] ${e.message}`);
    }
    await ctx.close();
  }
  console.log('embed pass done');
}
try {
  if (run('matrix')) for (const device of DEVICE_NAMES) {
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
  if (run('interact')) {
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
  if (run('zoom')) {
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
  if (run('anim')) for (const theme of THEMES) {
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
  if (run('perf')) {
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
  if (run('embed')) await embedPass();
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
