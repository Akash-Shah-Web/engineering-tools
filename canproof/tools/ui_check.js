// Headless UI check: loads index.html offline, collects console errors, takes screenshots.
// Usage: node tools/ui_check.js <outdir> [query]
'use strict';
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const out = process.argv[2] || 'shots'; const q = process.argv[3] || '';
  const url = 'file://' + path.join(__dirname, '..', 'index.html') + q;
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const errors = [];
  for (const [name, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, offline: true });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${name}] ${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.message}`));
    page.on('request', (r) => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) errors.push(`[${name}] network request: ${r.url()}`); });
    const t0 = Date.now();
    await page.goto(url);
    await page.waitForFunction(() => window.__canproof && window.__canproof.analysis, null, { timeout: 15000 });
    console.log(`${name}: ready in ${Date.now() - t0} ms`);
    await page.waitForTimeout(2500);
    const sw = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    if (sw[0] > sw[1] + 1) errors.push(`[${name}] horizontal overflow: scrollWidth ${sw[0]} > ${sw[1]}`);
    await page.screenshot({ path: `${out}/${name}-top.png` });
    await page.screenshot({ path: `${out}/${name}-full.png`, fullPage: true });
    await ctx.close();
  }
  await browser.close();
  console.log(errors.length ? errors.join('\n') : 'no console errors, no network requests, no horizontal overflow');
})();
