// Unit tests for the LoopForge core maths.  Run: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const LF = require('../src/core.js');

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a} (tol ${tol})`);
const rel = (a, b, tol, msg) => close(a, b, Math.abs(b) * tol, msg);

/** Filter a sequence through a discrete transfer function num/den (highest power first). */
function lfilter(num, den, x) {
  const n = den.length - 1, pad = new Array(den.length - num.length).fill(0), b = pad.concat(num);
  const y = [];
  for (let k = 0; k < x.length; k++) {
    let acc = 0;
    for (let i = 0; i <= n; i++) if (k - i >= 0) acc += b[i] * x[k - i];
    for (let i = 1; i <= n; i++) if (k - i >= 0) acc -= den[i] * y[k - i];
    y.push(acc / den[0]);
  }
  return y;
}

test('CSV parser handles pandas index column, semicolons and comments', () => {
  const a = LF.parseCSV(',Time,T1,Q1\n0,0,20.1,0\n1,1.0,20.3,50\n');
  assert.deepEqual(a.headers, ['col0', 'Time', 'T1', 'Q1']);
  assert.equal(a.rows, 2);
  const b = LF.parseCSV('# comment\ntime;temp;heater\n0;1,5;2\n1;2;3\n2;3;4\n');
  assert.deepEqual(b.headers, ['time', 'temp', 'heater']);
  assert.equal(b.skipped, 1);           // decimal comma row rejected, not silently misread
  const g = LF.guessColumns(['Time', 'T1', 'T2', 'Q1', 'Q2']);
  assert.deepEqual(g, { t: 'Time', u: 'Q1', y: 'T1' });
});

test('FOPDT simulation matches analytic step response with fractional delay and irregular grid', () => {
  const m = { K: 0.8, tau1: 50, tau2: 0, theta: 7.3 };
  const t = [0]; for (let i = 1; i < 300; i++) t.push(t[i - 1] + 0.5 + 0.7 * ((i * 7919) % 13) / 13);
  const u = t.map(() => 40);
  const y = LF.simulateModel(m, t, u, 0);
  t.forEach((ti, i) => {
    const ex = ti > m.theta ? 0.8 * 40 * (1 - Math.exp(-(ti - m.theta) / 50)) : 0;
    close(y[i], ex, 1e-10, `t=${ti}`);
  });
});

test('SOPDT simulation matches analytic step response (distinct and equal time constants)', () => {
  for (const [t1, t2] of [[60, 9], [20, 20 * (1 - 1e-9)]]) {
    const m = { K: 1.3, tau1: t1, tau2: t2, theta: 3.25 };
    const t = Array.from({ length: 400 }, (_, i) => i * 0.75);
    const y = LF.simulateModel(m, t, t.map(() => 10), 0);
    t.forEach((ti, i) => {
      const s = ti - m.theta;
      let ex = 0;
      if (s > 0) ex = Math.abs(t1 - t2) < 1e-6 ? 13 * (1 - (1 + s / t1) * Math.exp(-s / t1))
        : 13 * (1 - (t1 * Math.exp(-s / t1) - t2 * Math.exp(-s / t2)) / (t1 - t2));
      close(y[i], ex, 1e-7, `t1=${t1} t=${ti}`);
    });
  }
});

test('FOPDT identification recovers synthetic parameters', () => {
  const truth = { K: 0.85, tau1: 130, tau2: 0, theta: 9.4 };
  const d = LF.synthStep(truth, { n: 901, noise: 0.08, seed: 7 });
  const r = LF.fitModel(d, { model: 'FOPDT' });
  rel(r.model.K, truth.K, 0.005, 'K'); rel(r.model.tau1, truth.tau1, 0.01, 'tau');
  close(r.model.theta, truth.theta, 0.5, 'theta'); close(r.model.y0, 23, 0.05, 'y0');
  close(r.metrics.rmse, 0.08, 0.01, 'rmse ≈ noise σ');
  // CI should cover the truth
  assert.ok(Math.abs(r.model.tau1 - truth.tau1) < 3 * r.model.ci95.tau1 + 1e-9);
});

test('SOPDT identification recovers synthetic parameters', () => {
  const truth = { K: 0.75, tau1: 150, tau2: 12, theta: 4 };
  const d = LF.synthStep(truth, { n: 901, noise: 0.05, seed: 3 });
  const r = LF.fitModel(d, { model: 'SOPDT' });
  rel(r.model.K, truth.K, 0.01, 'K'); rel(r.model.tau1, truth.tau1, 0.02, 'tau1');
  close(r.model.tau2, truth.tau2, 2, 'tau2'); close(r.model.theta, truth.theta, 2, 'theta');
  close(r.model.tau2 + r.model.theta, 16, 0.6, 'tau2+theta (well-determined combination)');
});

test('Tuning rules reproduce published formulas', () => {
  const f = { K: 2, tau1: 100, tau2: 0, theta: 10 };
  let r = LF.tune(f, 'SIMC', 'PI', 10);
  close(r.Kc, 100 / (2 * 20), 1e-12); close(r.Ti, 80, 1e-12);          // min(100, 4*20)
  r = LF.tune(f, 'lambda', 'PI', 30);
  close(r.Kc, 100 / (2 * 40), 1e-12); close(r.Ti, 100, 1e-12);
  r = LF.tune(f, 'lambda', 'PID', 30);
  close(r.Kc, 105 / (2 * 35), 1e-12); close(r.Ti, 105, 1e-12); close(r.Td, 1000 / 210, 1e-12);
  const s = { K: 2, tau1: 100, tau2: 20, theta: 5 };
  r = LF.tune(s, 'SIMC', 'PID', 5);
  // series: Kc=100/(2*10)=5, Ti=min(100,40)=40, Td=20 → ideal: f=1.5
  close(r.Kc, 7.5, 1e-12); close(r.Ti, 60, 1e-12); close(r.Td, 20 / 1.5, 1e-12);
  r = LF.tune(s, 'SIMC', 'PI', 5);   // half rule: tau=110, theta=15
  close(r.Kc, 110 / (2 * 20), 1e-12); close(r.Ti, 80, 1e-12);
});

test('Discrete plant reproduces continuous response at sample instants', () => {
  for (const m of [{ K: 0.8, tau1: 150, tau2: 0, theta: 15.7 }, { K: 0.78, tau1: 150, tau2: 11, theta: 4.1 }, { K: 1, tau1: 30, tau2: 5, theta: 6 }]) {
    for (const Ts of [0.5, 1, 2.5, 7]) {
      const P = LF.discretizePlant(m, Ts);
      const n = 200;
      const u = Array.from({ length: n }, (_, k) => Math.sin(0.05 * k) * 30 + (k > 20 ? 20 : 0));
      const t = Array.from({ length: n }, (_, k) => k * Ts);
      const cont = LF.simulateModel(m, t, u, 0);
      // u is held from sample k; before t=0 it is 0
      const disc = lfilter(P.num, P.den, u);
      for (let k = 0; k < n; k++) close(disc[k], cont[k], 1e-8 * (1 + Math.abs(cont[k])), `Ts=${Ts} k=${k}`);
    }
  }
});

test('Polynomial roots', () => {
  const r = LF.polyRoots(LF.polyMul(LF.polyMul([1, -0.5], [1, 0.9]), [1, -1.2, 0.72])).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  close(r[0][0], -0.9, 1e-12); close(r[1][0], 0.5, 1e-12);
  close(r[2][0], 0.6, 1e-12); close(Math.abs(r[2][1]), 0.6, 1e-12);
  assert.equal(LF.polyRoots([1, 0, 0, 0]).length, 3);
});

test('Margins of k e^{-θs}/s match analytic values', () => {
  const k = 0.2, th = 2;
  const f = w => LF.Cx.mul([0, -k / w], LF.Cx.exp([0, -w * th]));
  const fa = LF.frequencyAnalysis(f, 1e-3, 10, 4000);
  close(fa.wc, k, 1e-9, 'wc'); close(fa.pm, 90 - k * th * 180 / Math.PI, 1e-6, 'pm');
  const w180 = Math.PI / (2 * th);
  close(fa.w180, w180, 1e-8, 'w180'); close(fa.gm, w180 / k, 1e-6, 'gm');
  close(fa.delayMargin, (Math.PI / 2 - k * th) / k, 1e-6, 'delay margin');
});

test('Linear closed-loop simulation equals discrete transfer-function response', () => {
  const m = { K: 0.78, tau1: 150, tau2: 11, theta: 4.1 };
  const ctrl = Object.assign(LF.tune(m, 'SIMC', 'PID', 20), { N: 10, b: 1, antiWindup: 'none' });
  const Ts = 1.5;
  const sim = LF.simulateClosedLoop({ model: m, ctrl, Ts, umin: -1e9, umax: 1e9, y0: 0, uPre: 0, r0: 0, r1: 1, tStep: 0, tEnd: 600 });
  const A = LF.analyseLoop(m, ctrl, Ts);
  const r = sim.samples.r;
  const yTF = lfilter(A.Tnum, A.Tden, r);
  for (let k = 0; k < r.length; k++) close(sim.samples.y[k], yTF[k], 1e-7, `k=${k}`);
  assert.ok(A.stable);
});

test('Back-calculation anti-windup reduces overshoot under saturation', () => {
  const m = { K: 0.78, tau1: 150, tau2: 11, theta: 4.1 };
  const base = { model: m, Ts: 1, umin: 0, umax: 100, y0: 23, uPre: 0, r0: 23, r1: 60, tStep: 10, tEnd: 900 };
  const c = LF.tune(m, 'SIMC', 'PI', 10);
  const none = LF.simulateClosedLoop(Object.assign({}, base, { ctrl: Object.assign({}, c, { antiWindup: 'none' }) }));
  const bc = LF.simulateClosedLoop(Object.assign({}, base, { ctrl: Object.assign({}, c, { antiWindup: 'backcalc' }) }));
  const cl = LF.simulateClosedLoop(Object.assign({}, base, { ctrl: Object.assign({}, c, { antiWindup: 'clamp' }) }));
  assert.ok(none.summary.satFrac > 0.05, 'scenario saturates');
  assert.ok(bc.summary.overshoot < none.summary.overshoot - 1, `bc ${bc.summary.overshoot} vs none ${none.summary.overshoot}`);
  assert.ok(cl.summary.overshoot < none.summary.overshoot - 1);
  assert.ok(Math.max(...bc.samples.u) <= 100 && Math.min(...bc.samples.u) >= 0);
});

test('Fixed-point controller tracks floating-point controller', () => {
  const m = { K: 0.78, tau1: 150, tau2: 11, theta: 4.1 };
  for (const type of ['PI', 'PID']) for (const aw of ['none', 'clamp', 'backcalc']) {
    const ctrl = Object.assign(LF.tune(m, 'SIMC', type, 15), { N: 10, antiWindup: aw });
    const o = { model: m, ctrl, Ts: 1, umin: 0, umax: 100, y0: 23, uPre: 0, r0: 23, r1: 50, tStep: 5, dist: { t: 450, du: -20 }, tEnd: 900 };
    const fl = LF.simulateClosedLoop(o);
    const fx = LF.simulateClosedLoop(Object.assign({}, o, { arithmetic: 'fixed' }));
    let maxDu = 0, maxDy = 0;
    for (let k = 0; k < fl.n; k++) { maxDu = Math.max(maxDu, Math.abs(fl.samples.u[k] - fx.samples.u[k])); maxDy = Math.max(maxDy, Math.abs(fl.samples.y[k] - fx.samples.y[k])); }
    assert.ok(maxDu < 0.05 && maxDy < 0.01, `${type}/${aw}: du ${maxDu}, dy ${maxDy}`);
  }
});

test('Coefficient quantisation picks maximal fractional bits', () => {
  assert.equal(LF.fracBits(0.9), 30); assert.equal(LF.fracBits(1.5), 29); assert.equal(LF.fracBits(12.3), 26);
  const q = LF.quantCoeff(0.0066);
  close(q.q / 2 ** q.f, 0.0066, 2 ** -31);
});

test('Measured TCLab step test: fit quality is reported and validation runs disagree as documented', () => {
  const dir = path.join(__dirname, '..', 'data', 'samples');
  const f = path.join(dir, 'validation_experiment_env_2_step_50_run_1.csv');
  if (!fs.existsSync(f)) return;
  const load = n => { const c = LF.parseCSV(fs.readFileSync(path.join(dir, n), 'utf8')); return { t: c.cols.Time, u: c.cols.Q1, y: c.cols.T1, uPre: 0 }; };
  const r = LF.fitModel(load('validation_experiment_env_2_step_50_run_1.csv'), { model: 'SOPDT' });
  assert.ok(r.metrics.fitPct > 97);
  const v2 = LF.validateModel(r.model, load('validation_experiment_env_2_step_50_run_2.csv'));
  const v3 = LF.validateModel(r.model, load('validation_experiment_env_2_step_50_run_3.csv'));
  assert.ok(v2.metrics.fitPct > 90);
  assert.ok(v3.metrics.bias < -1.5, 'run 3 is systematically cooler than the model predicts');
});
