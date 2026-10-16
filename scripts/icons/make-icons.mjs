#!/usr/bin/env node
// Renders public/icons/*.svg to PNG (192/512/180 + maskable 512) with headless Chromium.
// Usage: npm run icons   (PNG outputs are committed; re-run only when the SVGs change)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'icons');
const EXE = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const jobs = [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['icon.svg', 'apple-touch-icon.png', 180],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512],
];
const browser = await chromium.launch({ executablePath: EXE });
try {
  for (const [src, out, size] of jobs) {
    const svg = readFileSync(join(DIR, src), 'utf8');
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<html><body style="margin:0;background:transparent"><img style="width:${size}px;height:${size}px;display:block" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`);
    await page.screenshot({ path: join(DIR, out), omitBackground: true });
    await page.close();
    console.log(`  ${out} (${size}×${size})`);
  }
} finally {
  await browser.close();
}
