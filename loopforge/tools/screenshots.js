// Headless browser check: loads index.html offline (all external requests blocked),
// reports console errors, and saves screenshots. Usage: node tools/screenshots.js [outDir]
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const out = process.argv[2] || path.join(__dirname, '..', 'docs', 'screenshots');
fs.mkdirSync(out, { recursive: true });
const url = 'file://' + path.join(__dirname, '..', 'index.html');

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const shots = [
    { name: 'desktop', viewport: { width: 1440, height: 900 }, full: true, scale: 1 },
    { name: 'desktop-light', viewport: { width: 1440, height: 900 }, full: false, theme: 'light', scale: 1 },
    { name: 'phone', viewport: { width: 390, height: 844 }, full: true, scale: 1, mobile: true },
  ];
  for (const s of shots) {
    const ctx = await browser.newContext({ viewport: s.viewport, deviceScaleFactor: s.scale, isMobile: !!s.mobile, hasTouch: !!s.mobile });
    await ctx.route(/^https?:/, r => { errors.push(`[${s.name}] blocked network request ${r.request().url()}`); r.abort(); });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') errors.push(`[${s.name}] console: ${m.text()}`); });
    page.on('pageerror', e => errors.push(`[${s.name}] pageerror: ${e.message}`));
    if (s.theme) await page.addInitScript(t => { try { localStorage.setItem('loopforge.theme', t); } catch (e) {} }, s.theme);
    await page.goto(url + '?t=180');
    await page.waitForFunction(() => window.LoopForgeApp && window.LoopForgeApp.S.ready, null, { timeout: 15000 });
    await page.waitForTimeout(900);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) errors.push(`[${s.name}] horizontal overflow ${overflow}px`);
    await page.screenshot({ path: path.join(out, s.name + '.png'), fullPage: s.full });
    await ctx.close();
  }
  await browser.close();
  console.log(errors.length ? errors.join('\n') : 'no errors');
})();
