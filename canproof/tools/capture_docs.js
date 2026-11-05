// Capture README screenshots + GIF frames from the built page (headless Chromium).
// node tools/capture_docs.js <outdir>   (then see README for the ffmpeg GIF command)
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const url = 'file://' + path.join(__dirname, '..', 'index.html');
(async () => {
  const out = process.argv[2] || path.join(__dirname, '..', 'docs');
  fs.mkdirSync(out, { recursive: true });
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const shot = async (name, q, opts = {}) => {
    const ctx = await b.newContext(Object.assign({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' }, opts.ctx || {}));
    const p = await ctx.newPage(); await p.goto(url + q); await p.waitForTimeout(opts.wait || 3500);
    if (opts.before) await opts.before(p);
    await p.screenshot({ path: path.join(out, name), fullPage: !!opts.full });
    await ctx.close();
  };
  await shot('desktop-dark.png', '?t=29.2&speed=0.002');
  await shot('desktop-light.png', '?t=29.2&speed=0.002', { ctx: { colorScheme: 'light' } });
  await shot('drawer.png', '?select=ESC_ParkBrakeCmd&t=29.2&paused=1');
  await shot('stress.png', '?stress=3.5&t=29.2&speed=0.002', {});
  await shot('phone.png', '?t=29.2&speed=0.002', { ctx: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' } });
  // GIF frames: 3D view + timeline replaying (real simulated frames)
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  const p = await ctx.newPage(); await p.goto(url + '?t=19.5&speed=0.003'); await p.waitForTimeout(2500);
  await p.evaluate(() => window.scrollTo(0, 250));
  const fdir = path.join(out, 'gif-frames'); fs.mkdirSync(fdir, { recursive: true });
  for (let i = 0; i < 60; i++) { await p.screenshot({ path: path.join(fdir, `f${String(i).padStart(3, '0')}.png`) }); await p.waitForTimeout(80); }
  await b.close();
  console.log('done');
})();
