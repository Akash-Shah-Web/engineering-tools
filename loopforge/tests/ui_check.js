// End-to-end UI check in headless Chromium (offline: every http(s) request is blocked).
// Run: node tests/ui_check.js      (requires the pre-installed playwright + chromium)
'use strict';
const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');
const { chromium } = require('playwright');
const LF = require('../src/core.js');

const url = 'file://' + path.join(__dirname, '..', 'index.html');
const results = [];
const check = (name, ok, info) => { results.push({ name, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const errors = [];
  await ctx.route(/^https?:/, r => { errors.push('network: ' + r.request().url()); r.abort(); });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => window.LoopForgeApp && window.LoopForgeApp.S.ready, null, { timeout: 15000 });
  check('page loads real example and finishes pipeline', true, `${Date.now() - t0} ms`);

  // displayed model equals Node computation on the same file
  const c = LF.parseCSV(fs.readFileSync(path.join(__dirname, '..', 'data', 'samples', 'validation_experiment_env_2_step_50_run_1.csv'), 'utf8'));
  const ref = LF.fitModel({ t: c.cols.Time, u: c.cols.Q1, y: c.cols.T1, uPre: 0 }, { model: 'SOPDT' }).model;
  const shown = await page.evaluate(() => { const m = window.LoopForgeApp.S; return m.fits.SOPDT.model; });
  check('browser fit == Node fit (same code, same data)', Math.abs(shown.K / ref.K - 1) < 1e-5 && Math.abs(shown.tau1 / ref.tau1 - 1) < 1e-5, `K ${shown.K.toFixed(5)}`);
  const stageTxt = await page.textContent('#stages');
  check('stage strip shows fitted K', stageTxt.includes(ref.K.toFixed(3)));

  // hover linking: fit plot -> residual plot crosshair; bode -> nyquist marker
  await page.locator('#fitPlot').scrollIntoViewIfNeeded();
  const box = await page.locator('#fitPlot .lf-hit').boundingBox();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.waitForTimeout(350);
  const tipVis = await page.evaluate(() => getComputedStyle(document.querySelector('#fitPlot .lf-tip')).opacity);
  const resCross = await page.locator('#resPlot .lf-crosshair').count();
  check('hover shows tooltip on fit plot', +tipVis > 0.9);
  check('hover links crosshair to residual plot', resCross === 1);
  await page.locator('#magPlot').scrollIntoViewIfNeeded();
  const bb = await page.locator('#magPlot .lf-hit').boundingBox();
  await page.mouse.move(bb.x + bb.width * 0.7, bb.y + bb.height * 0.5);
  await page.waitForTimeout(100);
  check('Bode hover links to phase plot and Nyquist', (await page.locator('#phPlot .lf-crosshair').count()) === 1 && (await page.locator('#nyqPlot .lf-hover-dot').count()) >= 1);

  // slider: Ts changes margins and generated code
  const before = await page.textContent('#marginKpis');
  const setSlider = async (id, pos) => page.evaluate(([i, p]) => { const el = document.getElementById('sl-' + i); el.value = p; el.dispatchEvent(new Event('input')); }, [id, pos]);
  await setSlider('Ts', 800);
  await page.waitForTimeout(300);
  const after = await page.textContent('#marginKpis');
  const tsNow = await page.evaluate(() => window.LoopForgeApp.S.loop.Ts);
  const code = await page.textContent('#codeView');
  check('Ts slider updates margins', before !== after, `Ts=${tsNow}`);
  check('Ts slider updates generated C', new RegExp(`#define LF_TS   ${tsNow}(\\.0)? `).test(code));
  check('Ts slider highlights related code lines', (await page.locator('#codeView .ln.hl').count()) > 0);
  await setSlider('Ts', Math.round(1000 * Math.log(1 / 0.1) / Math.log(30 / 0.1)));
  await page.waitForTimeout(300);

  // anti-windup off increases overshoot
  const ov = async () => page.evaluate(() => window.LoopForgeApp.S.res.sim.summary.overshoot);
  await page.evaluate(() => { const S = window.LoopForgeApp.S; S.loop.r1 = 70; window.LoopForgeApp.recompute(); });
  await page.waitForTimeout(300);
  const ovBC = await ov();
  await page.selectOption('#awSel', 'none'); await page.waitForTimeout(300);
  const ovNone = await ov();
  check('disabling anti-windup increases overshoot', ovNone > ovBC + 1, `back-calc ${ovBC.toFixed(1)} % vs none ${ovNone.toFixed(1)} %`);
  await page.selectOption('#awSel', 'backcalc'); await page.waitForTimeout(200);

  // fixed-point arithmetic
  await page.click('#console .mini .seg button:nth-child(2)');
  await page.waitForTimeout(300);
  const kp = await page.textContent('#loopKpis');
  check('Q16.16 mode shows fixed vs float deviation and switches code tab', kp.includes('Q16 vs float') && (await page.textContent('#codeTabs .on')) === 'loopforge_pid_q16.h');
  await page.click('#console .mini .seg button:nth-child(1)');

  // exports
  const dl = async (sel) => { const [d] = await Promise.all([page.waitForEvent('download'), page.click(sel)]); const p = await d.path(); return { name: d.suggestedFilename(), text: fs.readFileSync(p) }; };
  const csv = await dl('.exports[data-target=fitPlot] button:nth-child(3)');
  check('CSV export labels measured data and provenance', csv.text.toString().includes('MEASURED') && csv.text.toString().includes('pyomo-doe'), csv.name);
  const svg = await dl('.exports[data-target=nyqPlot] button:nth-child(2)');
  check('SVG export is standalone SVG', svg.text.toString().includes('<svg') && svg.text.toString().includes('xmlns'), svg.name);
  const png = await dl('.exports[data-target=yPlot] button:nth-child(1)');
  check('PNG export produces a PNG', png.text.slice(1, 4).toString() === 'PNG' && png.text.length > 5000, `${png.name} ${png.text.length} B`);
  const dpng = await dl('.exports[data-target=diagram] button:nth-child(1)');
  check('block diagram PNG export', dpng.text.slice(1, 4).toString() === 'PNG', dpng.name);
  const cfile = await dl('#dlBtn');
  check('code download', /lf_pid(_q16)?_step/.test(cfile.text.toString()), cfile.name);

  // unstable gains do not crash and are flagged
  await setSlider('Kc', 1000);
  await page.waitForTimeout(300);
  const st = await page.textContent('#stages');
  check('very high Kc flagged UNSTABLE', st.includes('UNSTABLE'));
  await page.evaluate(() => { const S = window.LoopForgeApp.S; S.tune.manual = false; window.LoopForgeApp.retune(); });
  await page.waitForTimeout(200);

  // PI + lambda
  await page.click('text=Lambda / IMC'); await page.click('#console .seg >> text=PI');
  await page.waitForTimeout(300);
  const tn = await page.evaluate(() => window.LoopForgeApp.S.tune);
  const m = await page.evaluate(() => { const S = window.LoopForgeApp.S; return S.fits[S.modelType].model; });
  const exp = LF.tune(m, 'lambda', 'PI', tn.tauC);
  check('lambda PI gains in UI equal core formula', Math.abs(tn.Kc - exp.Kc) < 1e-12 && tn.Td === 0);

  // import (synthetic file, clearly labelled)
  const synth = fs.readFileSync(path.join(__dirname, '..', 'data', 'synthetic', 'synthetic_sopdt_step.csv'), 'utf8');
  await page.evaluate(t => window.LoopForgeApp.importText(t, 'synthetic_sopdt_step.csv'), synth);
  await page.waitForTimeout(200);
  await page.fill('.import-panel input[type=number]', '10');
  await page.click('.import-panel >> text=Fit this data');
  await page.waitForFunction(() => window.LoopForgeApp.S.dataset === 'user', null, { timeout: 10000 });
  await page.waitForTimeout(500);
  const um = await page.evaluate(() => { const S = window.LoopForgeApp.S; return { m: S.fits.SOPDT.model, roles: S.validations.map(v => v.role) }; });
  check('imported CSV: SOPDT recovers known synthetic gain', Math.abs(um.m.K - 1.25) < 0.02, `K=${um.m.K.toFixed(4)} τ1=${um.m.tau1.toFixed(1)} θ=${um.m.theta.toFixed(2)}`);
  check('imported CSV: last 30 % held out for validation', um.roles.includes('holdout'));
  check('imported data labelled USER DATA', (await page.textContent('#identBadge')).includes('USER DATA'));

  // synthetic dataset
  await page.selectOption('#datasetSel', 'synthetic');
  await page.waitForFunction(() => window.LoopForgeApp.S.dataset === 'synthetic');
  await page.waitForTimeout(400);
  check('synthetic dataset labelled SYNTHETIC', (await page.textContent('#identBadge')).includes('SYNTHETIC'));
  await page.selectOption('#datasetSel', 'tclab');
  await page.waitForTimeout(600);

  // guided demo walks all steps
  await page.click('#demoBtn');
  let steps = 0;
  for (; steps < 20; steps++) {
    await page.waitForTimeout(500);
    const hidden = await page.evaluate(() => document.getElementById('tour').hidden);
    if (hidden) break;
    await page.click('#tourNext');
  }
  check('guided demo runs to completion', steps >= 9, `${steps} steps`);

  // theme toggle
  await page.click('#themeBtn');
  check('light theme applies', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
  await page.click('#themeBtn');

  check('no console/page errors and no network requests', errors.length === 0, errors.join(' | '));
  await browser.close();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} UI checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
