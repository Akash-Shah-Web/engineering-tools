// Dumps LoopForge JS results as JSON for tests/verify_python_control.py.
'use strict';
const fs = require('fs');
const path = require('path');
const LF = require('../src/core.js');

const dir = path.join(__dirname, '..', 'data', 'samples');
const load = n => { const c = LF.parseCSV(fs.readFileSync(path.join(dir, n), 'utf8')); return { t: c.cols.Time, u: c.cols.Q1, y: c.cols.T1, uPre: 0 }; };
const arr = a => Array.from(a);
const out = { fits: [], tuning: [], plants: [], loops: [], sims: [] };

const fitFile = 'validation_experiment_env_2_step_50_run_1.csv';
const fitData = load(fitFile);
const fitted = {};
for (const type of ['FOPDT', 'SOPDT']) {
  const r = LF.fitModel(fitData, { model: type });
  fitted[type] = r.model;
  out.fits.push({ file: fitFile, type, model: r.model, sse: r.metrics.sse, rmse: r.metrics.rmse, fitPct: r.metrics.fitPct });
}

const models = [
  fitted.FOPDT, fitted.SOPDT,
  { type: 'FOPDT', K: 2, tau1: 100, tau2: 0, theta: 10 },
  { type: 'SOPDT', K: -1.5, tau1: 40, tau2: 8, theta: 3 },
];
for (const m of models) for (const method of ['SIMC', 'lambda']) for (const type of ['PI', 'PID']) for (const tc of [m.theta || 1, 3 * (m.theta || 1), 60]) {
  out.tuning.push({ model: m, method, type, tauC: tc, result: LF.tune(m, method, type, tc) });
}

const plantCases = [];
for (const m of models) for (const Ts of [1, 2, 5, 0.7]) plantCases.push({ m, Ts });
plantCases.push({ m: { type: 'FOPDT', K: 1, tau1: 20, tau2: 0, theta: 4 }, Ts: 2 });   // integer delay
plantCases.push({ m: { type: 'SOPDT', K: 1, tau1: 20, tau2: 5, theta: 6 }, Ts: 1.5 });  // integer delay
for (const { m, Ts } of plantCases) {
  const P = LF.discretizePlant(m, Ts);
  out.plants.push({ model: m, Ts, d: P.d, thetaFrac: P.thetaFrac, num: P.num, den: P.den, Phi: P.Phi, Gamma0: P.Gamma0, Gamma1: P.Gamma1 });
}

for (const m of models) for (const type of ['PI', 'PID']) for (const Ts of [1, 3]) {
  const c = Object.assign(LF.tune(m, 'SIMC', type, Math.max(m.theta, 5)), { N: 10, b: type === 'PID' ? 0.7 : 1 });
  const F = LF.loopFrequency(m, c, Ts, 6000);
  const A = F.analysis;
  out.loops.push({
    model: m, ctrl: c, Ts,
    Lnum: A.Lnum, Lden: A.Lden, poles: A.poles, stable: A.stable,
    disc: { gm: F.discrete.gm, pm: F.discrete.pm, wc: F.discrete.wc, w180: F.discrete.w180, Ms: F.discrete.Ms },
    cont: { gm: F.continuous.gm, pm: F.continuous.pm, wc: F.continuous.wc, w180: F.continuous.w180, Ms: F.continuous.Ms },
  });
}

for (const m of [fitted.SOPDT, fitted.FOPDT]) for (const aw of ['none', 'clamp', 'backcalc']) for (const sat of [false, true]) {
  const c = Object.assign(LF.tune(m, 'SIMC', m.type === 'SOPDT' ? 'PID' : 'PI', 8), { N: 10, b: 1, antiWindup: aw });
  const o = { model: m, ctrl: c, Ts: 1.3, umin: sat ? 0 : -1e9, umax: sat ? 100 : 1e9, y0: 23, uPre: 0, r0: 23, r1: 60, tStep: 6.5, dist: { t: 403, du: -30 }, tEnd: 800 };
  const s = LF.simulateClosedLoop(o);
  const cc = LF.controllerCoeffs(c, o.Ts);
  out.sims.push({ opts: o, coeffs: cc, t: s.samples.t, y: s.samples.y, u: s.samples.u });
}

process.stdout.write(JSON.stringify(out, (k, v) => (v instanceof Float64Array ? arr(v) : (typeof v === 'number' && !isFinite(v) ? (v > 0 ? 'inf' : v < 0 ? '-inf' : 'nan') : v))));
