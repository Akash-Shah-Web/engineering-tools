// Headless end-to-end check of the built page (run: node tests/ui.e2e.js).
// Uses the pre-installed Playwright/Chromium; works offline (file://).
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert/strict');
const url = 'file://' + path.join(__dirname, '..', 'index.html');

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, offline: true, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const S = () => page.evaluate(() => { const s = window.__canproof; return { misses: s.analysis.results.filter((r) => !r.schedulable).map((r) => r.name), load: s.analysis.load.worst, n: s.analysis.results.length, method: s.method, title: s.ex.title, trace: s.trace ? s.trace.length : 0, findings: s.findings.map((f) => f.code) }; });
  const pass = (m) => console.log('  ✓ ' + m);

  await page.goto(url);
  await page.waitForFunction(() => window.__canproof && window.__canproof.analysis);
  let s = await S();
  assert.equal(s.n, 29); assert.deepEqual(s.misses, ['ESC_ParkBrakeCmd']);
  assert.ok(s.findings.includes('OVERLAP') && s.findings.includes('OUT_OF_FRAME') && s.findings.includes('UNSAFE_PRIORITIES'));
  pass('synthetic demo loads automatically: 29 messages, planted deadline miss + layout errors found');

  // Edit a period in the table -> recomputation
  const inp = page.locator('#msgTable input[data-f="Tms"]').first();
  await inp.fill('2'); await inp.press('Enter'); await page.waitForTimeout(200);
  s = await S(); assert.ok(s.load > 0.3, 'load increases after editing period'); pass(`editing T in table recomputes (load ${(s.load * 100).toFixed(1)}%)`);
  await page.click('#btnStress'); await page.click('#sReset'); await page.waitForTimeout(200);

  // Stress: raise load until more misses appear
  await page.evaluate(() => { const el = document.querySelector('#sLoad'); el.value = '3.5'; el.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(400);
  s = await S(); assert.ok(s.misses.length > 1, 'stress produces more misses'); pass(`stress ×3.5 → ${s.misses.length} deadline misses`);
  await page.click('#sOPA'); await page.waitForTimeout(400);
  s = await S(); pass(`apply optimal priorities → ${s.misses.length} misses`);
  await page.click('#sReset'); await page.click('#btnStress'); await page.waitForTimeout(300);
  s = await S(); assert.deepEqual(s.misses, ['ESC_ParkBrakeCmd']); pass('reset restores baseline');

  // Method switch
  await page.selectOption('#method', 'tindell'); await page.waitForTimeout(200);
  assert.ok((await page.textContent('#banner')).includes('unsafe')); await page.selectOption('#method', 'davis');
  pass('original-analysis option is flagged unsafe');

  // Davis published example
  const idx = await page.$$eval('#example option', (o) => o.findIndex((x) => /Davis/.test(x.textContent)));
  await page.selectOption('#example', String(idx)); await page.waitForTimeout(300);
  let r = await page.evaluate(() => window.__canproof.analysis.results.map((x) => [x.name, x.R / 1e6]));
  assert.deepEqual(r, [['A', 2], ['B', 3], ['C', 3.5]]);
  await page.selectOption('#method', 'tindell'); await page.waitForTimeout(200);
  r = await page.evaluate(() => window.__canproof.analysis.results.map((x) => [x.name, x.R / 1e6]));
  assert.equal(r[2][1], 3.0);
  await page.selectOption('#method', 'davis');
  pass('published Davis et al. 2007 example: R_C = 3.5 ms (revised) vs 3.0 ms (original) in the UI');

  // Import a log file (synthetic log) and a DBC via file input
  await page.setInputFiles('#file', [path.join(__dirname, '../data/synthetic/demo_vehicle.dbc'), path.join(__dirname, '../data/synthetic/demo_vehicle.log')]);
  await page.waitForTimeout(1500);
  s = await S(); assert.equal(s.trace, 32580); assert.equal(s.n, 29); pass('import of DBC + candump log works, bitrate inferred');

  // Drawer & frame bits
  await page.click('#msgTable tbody tr:nth-child(2) td:nth-child(3)'); await page.waitForTimeout(300);
  assert.ok(await page.isVisible('#drawer.open')); assert.ok((await page.$$('#dBody .bit')).length > 100);
  pass('clicking a message opens the proof drawer with decoded bits');
  await page.click('#dClose');

  // Exports
  for (const x of ['csv-results', 'csv-trace', 'csv-compare', 'svg-rd', 'svg-timeline', 'svg-load', 'png-rd', 'png-timeline', 'png-car', 'dbc']) {
    console.log('    export ' + x);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.evaluate((k) => { document.querySelector(`#exportMenu [data-x="${k}"]`).click(); }, x)]);
    const p = await dl.path(); const size = require('fs').statSync(p).size;
    assert.ok(size > 100, x + ' export too small');
  }
  pass('all exports (CSV ×3, SVG ×3, PNG ×3, DBC) download non-empty files');

  // Tour runs through all steps
  await page.click('#btnTour'); await page.waitForTimeout(600);
  for (let i = 0; i < 8; i++) { await page.click('#tour [data-t=next]'); await page.waitForTimeout(700); }
  assert.ok(!(await page.isVisible('#tour.on'))); pass('guided demo runs through all steps');

  // Theme toggle
  await page.click('#btnTheme'); const th = await page.evaluate(() => document.documentElement.dataset.theme); await page.click('#btnTheme');
  pass('theme toggles (' + th + ')');

  assert.deepEqual(errors, [], 'page errors: ' + errors.join('; '));
  pass('no page errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
