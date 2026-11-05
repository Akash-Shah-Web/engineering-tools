/*
 * LoopForge core maths — CSV parsing, FOPDT/SOPDT identification, PI/PID
 * tuning (SIMC, lambda/IMC), discrete-time loop analysis, closed-loop
 * simulation with saturation and anti-windup, and fixed-point mirror of the
 * generated C code.
 *
 * Pure JavaScript, no dependencies. Works in the browser (window.LoopForge)
 * and in Node (require('./core.js')).
 *
 * Conventions
 *  - Plant: y(t) = y0 + G(s) [u(t) - uPre],  G(s) = K e^{-θs} / ((τ1 s + 1)(τ2 s + 1))
 *    (FOPDT: τ2 = 0). Logged input is treated as zero-order hold between samples.
 *  - Controller (ideal/ISA form, derivative on measurement, setpoint weight b):
 *      u = Kc [ b r - y + (1/(Ti s)) (r - y) - Td s / (1 + Td s / N) y ]
 *    discretised with forward-Euler integral and backward-difference filtered
 *    derivative (Åström & Murray, Feedback Systems, 2nd ed., §11.5).
 *  - Polynomials are arrays of coefficients, highest power first (numpy style).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LoopForge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* CSV                                                                 */
  /* ------------------------------------------------------------------ */

  function parseCSV(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
      .filter(l => l.trim() !== '' && !/^\s*[#%]/.test(l));
    if (lines.length < 2) throw new Error('CSV needs a header row and at least one data row');
    const first = lines[0];
    const delim = [',', ';', '\t'].map(d => [d, first.split(d).length])
      .sort((a, b) => b[1] - a[1])[0][0];
    const split = l => l.split(delim).map(s => s.trim().replace(/^"(.*)"$/, '$1'));
    const headers = split(first).map((h, i) => h === '' ? 'col' + i : h);
    const cols = {};
    headers.forEach(h => { cols[h] = []; });
    let skipped = 0;
    for (let i = 1; i < lines.length; i++) {
      const parts = split(lines[i]);
      const vals = parts.map(Number);
      if (parts.length < headers.length || vals.slice(0, headers.length).some(v => !isFinite(v))) { skipped++; continue; }
      headers.forEach((h, j) => cols[h].push(vals[j]));
    }
    return { headers, cols, rows: cols[headers[0]].length, skipped };
  }

  function guessColumns(headers) {
    const find = (res) => {
      for (const re of res) { const h = headers.find(x => re.test(x)); if (h) return h; }
      return null;
    };
    const t = find([/^time/i, /^t(_?s|_?sec)?$/i, /^sec/i, /time/i]) || headers[0];
    const u = find([/^q1$/i, /^u1$/i, /^(u|mv|op|cv|heater|input|power|duty)/i, /^q/i, /^u/i]);
    const y = find([/^t1$/i, /^(y|pv|temp|temperature|output|meas)/i, /^t\d/i, /^y/i]);
    return { t, u, y };
  }

  /* ------------------------------------------------------------------ */
  /* Small numeric helpers                                               */
  /* ------------------------------------------------------------------ */

  const sum = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
  const mean = a => sum(a) / a.length;
  // (1 - e^{-x}) / x, stable near x = 0
  const g1 = x => (Math.abs(x) < 1e-8 ? 1 - x / 2 : -Math.expm1(-x) / x);
  // (e^{-a h} - e^{-b h}) / (b - a), stable for a ≈ b
  const phi = (a, b, h) => h * Math.exp(-a * h) * g1((b - a) * h);

  /* ------------------------------------------------------------------ */
  /* Plant: exact propagation under piecewise-constant input             */
  /* ------------------------------------------------------------------ */

  function modelOrder(m) { return m.tau2 > 0 ? 2 : 1; }

  /** Propagate state x (array) over h seconds with constant deviation input v. */
  function propagate(m, x, v, h) {
    if (h <= 0) return;
    const a = 1 / m.tau1;
    const ea = Math.exp(-a * h);
    if (!(m.tau2 > 0)) { x[0] = ea * x[0] + m.K * (1 - ea) * v; return; }
    const b = 1 / m.tau2;
    const eb = Math.exp(-b * h);
    const f = phi(a, b, h);
    const x1 = x[0];
    x[0] = ea * x1 + m.K * (1 - ea) * v;
    x[1] = eb * x[1] + m.K * v * (1 - eb) + b * (x1 - m.K * v) * f;
  }
  const outputOf = (m, x) => (m.tau2 > 0 ? x[1] : x[0]);

  /**
   * Simulate the model response to a logged input (ZOH between samples).
   * Exact for piecewise-constant input: breakpoints of u(t-θ) are honoured.
   * Returns deviation response (add y0 for absolute).
   */
  function simulateModel(m, t, u, uPre) {
    const n = t.length;
    const out = new Float64Array(n);
    const x = [0, 0];
    const th = Math.max(0, m.theta);
    // delayed input at time s: value of u at last sample j with t_j <= s - th
    let j = -1;                           // index of active delayed sample (-1 => uPre)
    while (j + 1 < n && t[j + 1] + th <= t[0]) j++;
    let s = t[0];
    out[0] = 0;
    for (let k = 1; k < n; k++) {
      const tk = t[k];
      while (s < tk) {
        const v = (j < 0 ? uPre : u[j]) - uPre;
        const nextEv = j + 1 < n ? t[j + 1] + th : Infinity;
        const sEnd = Math.min(tk, nextEv);
        propagate(m, x, v, sEnd - s);
        s = sEnd;
        if (s >= nextEv) j++;
      }
      out[k] = outputOf(m, x);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Linear least squares for [K, y0] given unit response                */
  /* ------------------------------------------------------------------ */

  function solveKy0(x, y, w, fixY0) {
    // minimise Σ w (y - y0 - K x)^2
    let Sw = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
    for (let i = 0; i < x.length; i++) {
      const wi = w ? w[i] : 1;
      Sw += wi; Sx += wi * x[i]; Sy += wi * y[i]; Sxx += wi * x[i] * x[i]; Sxy += wi * x[i] * y[i];
    }
    if (fixY0 !== undefined && fixY0 !== null) {
      const K = Sxx > 0 ? (Sxy - fixY0 * Sx) / Sxx : 0;
      return { K, y0: fixY0 };
    }
    const det = Sw * Sxx - Sx * Sx;
    if (Math.abs(det) < 1e-300) return { K: 0, y0: Sy / Sw };
    return { K: (Sw * Sxy - Sx * Sy) / det, y0: (Sxx * Sy - Sx * Sxy) / det };
  }

  /* ------------------------------------------------------------------ */
  /* Nelder–Mead                                                         */
  /* ------------------------------------------------------------------ */

  function nelderMead(f, x0, opt) {
    opt = opt || {};
    const n = x0.length, maxIt = opt.maxIter || 400 * n, tol = opt.tol || 1e-10;
    const step = opt.step || x0.map(v => (Math.abs(v) > 1e-3 ? 0.1 * Math.abs(v) : 0.05));
    let simplex = [x0.slice()];
    for (let i = 0; i < n; i++) { const p = x0.slice(); p[i] += step[i]; simplex.push(p); }
    let fs = simplex.map(f);
    let it = 0;
    for (; it < maxIt; it++) {
      const idx = fs.map((v, i) => i).sort((a, b) => fs[a] - fs[b]);
      simplex = idx.map(i => simplex[i]); fs = idx.map(i => fs[i]);
      if (Math.abs(fs[n] - fs[0]) <= tol * (Math.abs(fs[0]) + 1e-30)) {
        let spread = 0;
        for (let i = 1; i <= n; i++) for (let k = 0; k < n; k++) spread = Math.max(spread, Math.abs(simplex[i][k] - simplex[0][k]));
        if (spread < 1e-9) break;
      }
      const c = new Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) c[k] += simplex[i][k] / n;
      const pt = (a) => c.map((ck, k) => ck + a * (simplex[n][k] - ck));
      const xr = pt(-1), fr = f(xr);
      if (fr < fs[0]) {
        const xe = pt(-2), fe = f(xe);
        if (fe < fr) { simplex[n] = xe; fs[n] = fe; } else { simplex[n] = xr; fs[n] = fr; }
      } else if (fr < fs[n - 1]) { simplex[n] = xr; fs[n] = fr; }
      else {
        const outside = fr < fs[n];
        const xc = pt(outside ? -0.5 : 0.5), fc = f(xc);
        if (fc < (outside ? fr : fs[n])) { simplex[n] = xc; fs[n] = fc; }
        else {
          for (let i = 1; i <= n; i++) {
            simplex[i] = simplex[i].map((v, k) => simplex[0][k] + 0.5 * (v - simplex[0][k]));
            fs[i] = f(simplex[i]);
          }
        }
      }
    }
    let best = 0; for (let i = 1; i <= n; i++) if (fs[i] < fs[best]) best = i;
    return { x: simplex[best], f: fs[best], iterations: it };
  }

  /* ------------------------------------------------------------------ */
  /* Identification                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * data: {t, u, y, uPre}  — arrays; uPre = input before the first sample.
   * opts: {model: 'FOPDT'|'SOPDT', fitY0: true, tMin, tMax}
   */
  function fitModel(data, opts) {
    opts = Object.assign({ model: 'FOPDT', fitY0: true }, opts || {});
    const { t, u, y } = data;
    const uPre = data.uPre !== undefined ? data.uPre : u[0];
    const n = t.length;
    const T = t[n - 1] - t[0];
    const dt = T / (n - 1);
    const fixY0 = opts.fitY0 ? null : (opts.y0 !== undefined ? opts.y0 : y[0]);
    const order2 = opts.model === 'SOPDT';

    const mk = (tau1, tau2, theta) => ({ K: 1, tau1, tau2: order2 ? tau2 : 0, theta });
    const evalP = (tau1, tau2, theta) => {
      if (!(tau1 > 0) || (order2 && !(tau2 > 0)) || theta < 0 || !isFinite(tau1 + theta)) return { sse: Infinity };
      const m = mk(tau1, tau2, theta);
      const x = simulateModel(m, t, u, uPre);
      const { K, y0 } = solveKy0(x, y, null, fixY0);
      let sse = 0;
      for (let i = 0; i < n; i++) { const r = y[i] - y0 - K * x[i]; sse += r * r; }
      return { sse, K, y0 };
    };

    // ---- coarse grid for FOPDT
    let best = { sse: Infinity };
    const taus = [], thetas = [];
    for (let i = 0; i < 28; i++) taus.push(Math.pow(10, Math.log10(Math.max(dt, 1e-6)) + i * (Math.log10(10 * T / Math.max(dt, 1e-6)) / 27)));
    for (let i = 0; i < 24; i++) thetas.push(0.4 * T * Math.pow(i / 23, 2));
    for (const ta of taus) for (const th of thetas) {
      const r = evalP(ta, order2 ? ta / 4 : 0, th);
      if (r.sse < best.sse) best = Object.assign({ tau1: ta, tau2: order2 ? ta / 4 : 0, theta: th }, r);
    }
    // ---- refine with Nelder–Mead on transformed nonlinear parameters
    const fom = q => evalP(Math.exp(q[0]), order2 ? Math.exp(q[1]) : 0, q[order2 ? 2 : 1] * q[order2 ? 2 : 1]).sse;
    const starts = [];
    if (order2) {
      for (const split of [0.05, 0.2, 0.5]) {
        starts.push([Math.log(best.tau1 * (1 - split * 0.5)), Math.log(Math.max(best.tau1 * split, dt * 0.1)), Math.sqrt(best.theta)]);
        starts.push([Math.log(best.tau1 * (1 - split * 0.5)), Math.log(Math.max(best.tau1 * split, dt * 0.1)), Math.sqrt(best.theta * 0.5)]);
      }
    } else starts.push([Math.log(best.tau1), Math.sqrt(best.theta)]);
    let bestQ = null, bestF = Infinity;
    for (const s0 of starts) {
      let r = nelderMead(fom, s0, { step: s0.map(() => 0.3) });
      r = nelderMead(fom, r.x, { step: r.x.map(() => 0.05) });    // restart
      r = nelderMead(fom, r.x, { step: r.x.map(() => 0.01) });
      if (r.f < bestF) { bestF = r.f; bestQ = r.x; }
    }
    let tau1 = Math.exp(bestQ[0]), tau2 = order2 ? Math.exp(bestQ[1]) : 0;
    const theta = Math.pow(bestQ[order2 ? 2 : 1], 2);
    if (order2 && tau2 > tau1) { const tmp = tau1; tau1 = tau2; tau2 = tmp; }   // order: τ1 ≥ τ2
    const fin = evalP(tau1, tau2, theta);
    const model = { type: order2 ? 'SOPDT' : 'FOPDT', K: fin.K, tau1, tau2, theta, y0: fin.y0, uPre };
    const pred = predict(model, data, model.y0);
    const metrics = fitMetrics(y, pred, order2 ? 5 : 4 - (opts.fitY0 ? 0 : 1));
    model.ci95 = paramCI(model, data, metrics, opts.fitY0);
    return { model, pred, metrics };
  }

  function predict(model, data, y0) {
    const uPre = data.uPre !== undefined ? data.uPre : model.uPre;
    const x = simulateModel(model, data.t, data.u, uPre);
    const out = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = y0 + x[i];
    return out;
  }

  function fitMetrics(y, yhat, nParams) {
    const n = y.length, ym = mean(y);
    let sse = 0, sst = 0, sae = 0, maxe = 0, bias = 0;
    const res = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const r = y[i] - yhat[i]; res[i] = r;
      sse += r * r; sst += (y[i] - ym) * (y[i] - ym); sae += Math.abs(r); maxe = Math.max(maxe, Math.abs(r)); bias += r;
    }
    // lag-1 autocorrelation of residuals (whiteness indicator)
    const rm = bias / n; let c0 = 0, c1 = 0;
    for (let i = 0; i < n; i++) { c0 += (res[i] - rm) ** 2; if (i) c1 += (res[i] - rm) * (res[i - 1] - rm); }
    return {
      n, sse, rmse: Math.sqrt(sse / n), mae: sae / n, maxAbs: maxe, bias: bias / n,
      r2: 1 - sse / sst,
      fitPct: 100 * (1 - Math.sqrt(sse) / Math.sqrt(sst)),            // NRMSE fit (MATLAB "compare")
      aic: n * Math.log(sse / n) + 2 * nParams,
      residualLag1: c0 > 0 ? c1 / c0 : 0,
      residuals: res,
    };
  }

  /** Approximate 95% confidence half-widths from the Gauss–Newton Hessian. */
  function paramCI(model, data, metrics, fitY0) {
    const names = model.type === 'SOPDT' ? ['K', 'tau1', 'tau2', 'theta'] : ['K', 'tau1', 'theta'];
    if (fitY0) names.push('y0');
    const base = predict(model, data, model.y0);
    const n = base.length, p = names.length;
    const J = names.map(nm => {
      const m2 = Object.assign({}, model);
      const h = Math.max(Math.abs(model[nm]) * 1e-5, nm === 'theta' ? 1e-3 : 1e-7);
      m2[nm] = model[nm] + h;
      const yp = predict(m2, data, m2.y0);
      const col = new Float64Array(n);
      for (let i = 0; i < n; i++) col[i] = (yp[i] - base[i]) / h;
      return col;
    });
    const JtJ = names.map((_, a) => names.map((_, b) => { let s = 0; for (let i = 0; i < n; i++) s += J[a][i] * J[b][i]; return s; }));
    const inv = invertMatrix(JtJ);
    if (!inv) return null;
    const s2 = metrics.sse / Math.max(1, n - p);
    const out = {};
    names.forEach((nm, i) => { out[nm] = 1.96 * Math.sqrt(Math.max(0, inv[i][i] * s2)); });
    return out;
  }

  function invertMatrix(A) {
    const n = A.length, M = A.map((r, i) => r.concat(r.map((_, j) => (i === j ? 1 : 0))));
    for (let c = 0; c < n; c++) {
      let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-300) return null;
      [M[c], M[piv]] = [M[piv], M[c]];
      const d = M[c][c]; for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j]; }
    }
    return M.map(r => r.slice(n));
  }

  /** Validate a fitted model on another record without refitting anything.
   *  y0 = median of the first five samples (the record is assumed to start at
   *  steady state; this assumption is reported, and is violated by some runs). */
  function validateModel(model, data) {
    const first = Array.from(data.y.slice(0, 5)).sort((a, b) => a - b);
    const y0 = first[Math.floor(first.length / 2)];
    const pred = predict(model, data, y0);
    return { y0, pred, metrics: fitMetrics(data.y, pred, 0) };
  }

  /** Slice a record by time window [tMin, tMax]. uPre becomes the input just before tMin. */
  function sliceRecord(data, tMin, tMax) {
    const idx = [];
    for (let i = 0; i < data.t.length; i++) if (data.t[i] >= tMin && data.t[i] <= tMax) idx.push(i);
    const first = idx[0];
    return {
      t: idx.map(i => data.t[i]), u: idx.map(i => data.u[i]), y: idx.map(i => data.y[i]),
      uPre: first > 0 ? data.u[first - 1] : data.uPre,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Tuning                                                              */
  /* ------------------------------------------------------------------ */

  /** Convert series (interacting) PID to ideal/ISA parallel form. */
  function seriesToIdeal(Kc, Ti, Td) {
    const f = 1 + Td / Ti;
    return { Kc: Kc * f, Ti: Ti * f, Td: Td / f };
  }

  /**
   * method: 'SIMC' | 'lambda'; type: 'PI' | 'PID'; tauC: closed-loop time constant (τc or λ).
   * Returns ideal-form {Kc, Ti, Td, notes}.
   */
  function tune(model, method, type, tauC) {
    const K = model.K, th = model.theta, t1 = model.tau1, t2 = model.tau2 || 0;
    const sopdt = t2 > 0;
    let r, ref;
    if (method === 'SIMC') {
      if (type === 'PI') {
        // SOPDT → FOPDT by Skogestad's half rule
        const tau = sopdt ? t1 + t2 / 2 : t1, theta = sopdt ? th + t2 / 2 : th;
        r = { Kc: tau / (K * (tauC + theta)), Ti: Math.min(tau, 4 * (tauC + theta)), Td: 0 };
        ref = sopdt ? 'SIMC PI with half-rule reduction (Skogestad 2003)' : 'SIMC PI (Skogestad 2003)';
      } else if (sopdt) {
        const s = { Kc: t1 / (K * (tauC + th)), Ti: Math.min(t1, 4 * (tauC + th)), Td: t2 };
        r = seriesToIdeal(s.Kc, s.Ti, s.Td); r.series = s;
        ref = 'SIMC series PID, τD = τ2 (Skogestad 2003), converted to ideal form';
      } else {
        const tau = t1 + th / 3;
        const s = { Kc: tau / (K * (tauC + th)), Ti: Math.min(tau, 4 * (tauC + th)), Td: th / 3 };
        r = seriesToIdeal(s.Kc, s.Ti, s.Td); r.series = s;
        ref = 'improved SIMC PID for FOPDT, τD = θ/3 (Grimholt & Skogestad 2018), converted to ideal form';
      }
    } else {
      if (type === 'PI') {
        const tau = sopdt ? t1 + t2 / 2 : t1, theta = sopdt ? th + t2 / 2 : th;
        r = { Kc: tau / (K * (tauC + theta)), Ti: tau, Td: 0 };
        ref = sopdt ? 'Lambda (IMC) PI with half-rule reduction' : 'Lambda (IMC) PI: Kc = τ/(K(λ+θ)), Ti = τ';
      } else if (sopdt) {
        r = { Kc: (t1 + t2) / (K * (tauC + th)), Ti: t1 + t2, Td: t1 * t2 / (t1 + t2) };
        ref = 'Lambda (IMC) PID for SOPDT, ideal form';
      } else {
        r = { Kc: (t1 + th / 2) / (K * (tauC + th / 2)), Ti: t1 + th / 2, Td: t1 * th / (2 * t1 + th) };
        ref = 'Lambda (IMC) PID with first-order Padé delay (Rivera, Morari & Skogestad 1986)';
      }
    }
    r.method = method; r.type = type; r.tauC = tauC; r.ref = ref;
    return r;
  }

  /* ------------------------------------------------------------------ */
  /* Polynomials & complex arithmetic                                    */
  /* ------------------------------------------------------------------ */

  const C = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1]],
    mul: (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]],
    div: (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; },
    abs: a => Math.hypot(a[0], a[1]),
    arg: a => Math.atan2(a[1], a[0]),
    exp: a => { const e = Math.exp(a[0]); return [e * Math.cos(a[1]), e * Math.sin(a[1])]; },
  };

  const polyMul = (a, b) => {
    const r = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) r[i + j] += a[i] * b[j];
    return r;
  };
  const polyAdd = (a, b) => {
    const n = Math.max(a.length, b.length), r = new Array(n).fill(0);
    for (let i = 0; i < a.length; i++) r[n - a.length + i] += a[i];
    for (let i = 0; i < b.length; i++) r[n - b.length + i] += b[i];
    return r;
  };
  const polyScale = (a, k) => a.map(v => v * k);
  const polyTrim = a => { let i = 0; while (i < a.length - 1 && Math.abs(a[i]) < 1e-300) i++; return a.slice(i); };
  function polyEval(p, z) {
    let r = [0, 0];
    for (let i = 0; i < p.length; i++) r = C.add(C.mul(r, z), [p[i], 0]);
    return r;
  }

  /** All roots of a real polynomial (Aberth–Ehrlich iteration). */
  function polyRoots(p) {
    p = polyTrim(p);
    let zeros = 0;
    while (p.length > 1 && p[p.length - 1] === 0) { p = p.slice(0, -1); zeros++; }
    const n = p.length - 1;
    const out = [];
    for (let i = 0; i < zeros; i++) out.push([0, 0]);
    if (n < 1) return out;
    const a = p.map(v => v / p[0]);
    if (n === 1) { out.push([-a[1], 0]); return out; }
    const dp = a.slice(0, -1).map((v, i) => v * (n - i));
    // initial guesses on a circle (Cauchy bound)
    let R = 0; for (let i = 1; i <= n; i++) R = Math.max(R, Math.pow(Math.abs(a[i]), 1 / i));
    R = Math.max(R, 1e-12);
    let z = [];
    for (let k = 0; k < n; k++) { const ang = 2 * Math.PI * k / n + 0.4; z.push([R * Math.cos(ang), R * Math.sin(ang)]); }
    for (let it = 0; it < 500; it++) {
      let maxStep = 0;
      for (let k = 0; k < n; k++) {
        const pv = polyEval(a, z[k]), dv = polyEval(dp, z[k]);
        if (C.abs(pv) === 0) continue;
        const ratio = C.div(pv, dv);
        let s = [0, 0];
        for (let j = 0; j < n; j++) if (j !== k) s = C.add(s, C.div([1, 0], C.sub(z[k], z[j])));
        const w = C.div(ratio, C.sub([1, 0], C.mul(ratio, s)));
        z[k] = C.sub(z[k], w);
        maxStep = Math.max(maxStep, C.abs(w) / Math.max(1, C.abs(z[k])));
      }
      if (maxStep < 1e-15) break;
    }
    // polish with Newton and snap tiny imaginary parts
    z = z.map(r => {
      for (let i = 0; i < 3; i++) { const dv = polyEval(dp, r); if (C.abs(dv) > 0) r = C.sub(r, C.div(polyEval(a, r), dv)); }
      if (Math.abs(r[1]) < 1e-10 * Math.max(1, Math.abs(r[0]))) r = [r[0], 0];
      return r;
    });
    return out.concat(z);
  }

  /* ------------------------------------------------------------------ */
  /* Discrete-time models                                                */
  /* ------------------------------------------------------------------ */

  /**
   * ZOH-sampled plant (deviation form) with delay θ = d·Ts + θf, 0 ≤ θf < Ts:
   *   x[k+1] = Φ x[k] + Γ0 u[k-d] + Γ1 u[k-d-1],   y[k] = C x[k]
   * Returns matrices and the transfer function G(z) = num/den.
   */
  function discretizePlant(m, Ts) {
    const d = Math.floor(m.theta / Ts + 1e-12);
    let thf = m.theta - d * Ts; if (thf < 1e-12 * Ts) thf = 0;
    const order = modelOrder(m);
    const stepResp = h => { const x = [0, 0]; propagate(m, x, 1, h); return x.slice(0, order); };
    const transition = h => {
      const cols = [];
      for (let i = 0; i < order; i++) { const x = [0, 0]; x[i] = 1; propagate(m, x, 0, h); cols.push(x.slice(0, order)); }
      return cols[0].map((_, r) => cols.map(c => c[r]));     // Φ[r][c]
    };
    const Phi = transition(Ts);
    const G0 = stepResp(Ts - thf);
    const Pr = transition(Ts - thf), Gf = stepResp(thf);
    const G1 = Pr.map(row => row.reduce((s, v, c) => s + v * Gf[c], 0));
    let num, den;
    if (order === 1) {
      const p = Phi[0][0];
      num = [G0[0], G1[0]];                 // (Γ0 z + Γ1) / (z^{d+1} (z - p))
      den = [1, -p];
    } else {
      const p = Phi[0][0], q = Phi[1][0], r = Phi[1][1];
      // C(zI-Φ)^{-1} = [q, z-p] / ((z-p)(z-r))
      num = polyAdd(polyScale([G0[0], G1[0]], q), polyMul([1, -p], [G0[1], G1[1]]));
      den = polyMul([1, -p], [1, -r]);
    }
    for (let i = 0; i < d + 1; i++) den = den.concat([0]);  // × z^{d+1}
    return { Ts, d, thetaFrac: thf, Phi, Gamma0: G0, Gamma1: G1, order, num: polyTrim(num), den };
  }

  /** Discrete controller coefficients (as implemented in the generated C). */
  function controllerCoeffs(ctrl, Ts) {
    const Kc = ctrl.Kc, Ti = ctrl.Ti, Td = ctrl.Td || 0, N = ctrl.N || 10, b = ctrl.b === undefined ? 1 : ctrl.b;
    const hasD = Td > 0;
    const Tf = hasD ? Td / N : 0;
    const Tt = ctrl.Tt || (hasD ? Math.sqrt(Ti * Td) : Ti);   // Åström–Hägglund rule of thumb
    return {
      kp: Kc, kb: b * Kc, ki: Ti > 0 && isFinite(Ti) ? Kc * Ts / Ti : 0,
      ad: hasD ? Tf / (Tf + Ts) : 0, bd: hasD ? Kc * Td / (Tf + Ts) : 0,
      kt: Ts / Tt, Tt, Tf, hasD,
    };
  }

  /** Feedback part Cy(z) (u = Cr r − Cy y) and setpoint part Cr(z) of the discrete PID. */
  function controllerTF(ctrl, Ts) {
    const c = controllerCoeffs(ctrl, Ts);
    // Cy = kp + ki/(z-1) + bd (z-1)/(z-ad);  Cr = kb + ki/(z-1)
    let numY, denY;
    if (c.hasD) {
      denY = polyMul([1, -1], [1, -c.ad]);
      numY = polyAdd(polyAdd(polyScale(denY, c.kp), polyScale([1, -c.ad], c.ki)), polyScale(polyMul([1, -1], [1, -1]), c.bd));
    } else { denY = [1, -1]; numY = polyAdd(polyScale([1, -1], c.kp), [c.ki]); }
    const numR = polyAdd(polyScale([1, -1], c.kb), [c.ki]), denR = [1, -1];
    return { numY, denY, numR, denR, coeffs: c };
  }

  /** Loop transfer L(z) = Cy(z) G(z), closed loop r → y, and closed-loop poles. */
  function analyseLoop(model, ctrl, Ts) {
    const P = discretizePlant(model, Ts);
    const K = controllerTF(ctrl, Ts);
    const Lnum = polyMul(K.numY, P.num), Lden = polyMul(K.denY, P.den);
    const charPoly = polyAdd(Lden, Lnum);
    const poles = polyRoots(charPoly);
    // T(z) = Cr G / (1 + Cy G) = numR numP denY / (denR (denY denP + numY numP))
    const Tnum = polyMul(polyMul(K.numR, P.num), K.denY);
    const Tden = polyMul(K.denR, charPoly);
    const zeros = polyRoots(Lnum);
    const maxPole = Math.max(...poles.map(C.abs));
    return { plant: P, ctrl: K, Lnum, Lden, charPoly, poles, zeros, Tnum, Tden, stable: maxPole < 1, maxPoleRadius: maxPole };
  }

  /* ------------------------------------------------------------------ */
  /* Frequency response & margins                                        */
  /* ------------------------------------------------------------------ */

  function evalDiscrete(num, den, w, Ts) {
    const z = C.exp([0, w * Ts]);
    return C.div(polyEval(num, z), polyEval(den, z));
  }

  /** Continuous loop with exact delay and analogue PID (filtered derivative on y). */
  function evalContinuousLoop(model, ctrl, w) {
    const s = [0, w];
    const N = ctrl.N || 10;
    let G = C.div([model.K, 0], C.mul(C.add(C.mul([model.tau1, 0], s), [1, 0]), model.tau2 > 0 ? C.add(C.mul([model.tau2, 0], s), [1, 0]) : [1, 0]));
    G = C.mul(G, C.exp([0, -w * model.theta]));
    let Cs = C.add([1, 0], C.div([1, 0], C.mul([ctrl.Ti, 0], s)));
    if (ctrl.Td > 0) Cs = C.add(Cs, C.div(C.mul([ctrl.Td, 0], s), C.add([1, 0], C.mul([ctrl.Td / N, 0], s))));
    return C.mul(G, C.mul([ctrl.Kc, 0], Cs));
  }

  function logspace(a, b, n) { const r = []; for (let i = 0; i < n; i++) r.push(Math.pow(10, a + (b - a) * i / (n - 1))); return r; }

  /**
   * Frequency response of a loop function f(w) → complex on grid, with
   * unwrapped phase, and gain/phase margins, Ms, delay margin.
   */
  function frequencyAnalysis(f, wMin, wMax, n) {
    n = n || 3000;
    const w = logspace(Math.log10(wMin), Math.log10(wMax), n);
    const L = w.map(f);
    const mag = L.map(C.abs);
    const ph = [];
    let prev = null, off = 0;
    for (const v of L) {
      let a = C.arg(v);
      if (prev !== null) { while (a + off - prev > Math.PI) off -= 2 * Math.PI; while (a + off - prev < -Math.PI) off += 2 * Math.PI; }
      ph.push(a + off); prev = a + off;
    }
    // shift so that low-frequency phase lies in (-2π, 0]  (integrator → -90°)
    const shift = -2 * Math.PI * Math.ceil(ph[0] / (2 * Math.PI) - 1e-9);
    for (let i = 0; i < ph.length; i++) ph[i] += shift;

    const refineRoot = (g, a, b) => { let ga = g(a); for (let i = 0; i < 80; i++) { const m = Math.sqrt(a * b), gm = g(m); if ((gm > 0) === (ga > 0)) { a = m; ga = gm; } else b = m; } return Math.sqrt(a * b); };
    const phaseNear = (wq, ref) => { let a = C.arg(f(wq)); while (a - ref > Math.PI) a -= 2 * Math.PI; while (a - ref < -Math.PI) a += 2 * Math.PI; return a; };
    // gain crossovers
    const gainX = [];
    for (let i = 1; i < n; i++) if ((mag[i - 1] - 1) * (mag[i] - 1) <= 0 && mag[i - 1] !== mag[i]) {
      const wc = refineRoot(x => C.abs(f(x)) - 1, w[i - 1], w[i]);
      const p = phaseNear(wc, ph[i]);
      gainX.push({ w: wc, phase: p, pm: (p + Math.PI - 2 * Math.PI * Math.round((p + Math.PI) / (2 * Math.PI))) * 180 / Math.PI });
    }
    // phase crossovers at -180° - k·360°
    const phaseX = [];
    for (let i = 1; i < n; i++) {
      const k0 = Math.floor((ph[i - 1] + Math.PI) / (2 * Math.PI)), k1 = Math.floor((ph[i] + Math.PI) / (2 * Math.PI));
      if (k0 !== k1) {
        const target = -Math.PI + 2 * Math.PI * Math.max(k0, k1);
        const wp = refineRoot(x => phaseNear(x, target) - target, w[i - 1], w[i]);
        const m = C.abs(f(wp));
        phaseX.push({ w: wp, mag: m, gm: 1 / m, gmDb: -20 * Math.log10(m) });
      }
    }
    // sensitivity peak
    let Ms = 0, wMs = w[0];
    for (let i = 0; i < n; i++) { const s = 1 / C.abs(C.add([1, 0], L[i])); if (s > Ms) { Ms = s; wMs = w[i]; } }
    const pmMin = gainX.length ? gainX.reduce((a, b) => (b.pm < a.pm ? b : a)) : null;
    const gmMin = phaseX.length ? phaseX.reduce((a, b) => (b.gm < a.gm ? b : a)) : null;
    return {
      w, re: L.map(v => v[0]), im: L.map(v => v[1]), mag, magDb: mag.map(m => 20 * Math.log10(m)), phaseDeg: ph.map(p => p * 180 / Math.PI),
      gainCrossovers: gainX, phaseCrossovers: phaseX,
      pm: pmMin ? pmMin.pm : Infinity, wc: pmMin ? pmMin.w : NaN,
      gm: gmMin ? gmMin.gm : Infinity, gmDb: gmMin ? gmMin.gmDb : Infinity, w180: gmMin ? gmMin.w : NaN,
      Ms, wMs,
      delayMargin: pmMin && pmMin.pm > 0 ? (pmMin.pm * Math.PI / 180) / pmMin.w : 0,
    };
  }

  function loopFrequency(model, ctrl, Ts, n) {
    const A = analyseLoop(model, ctrl, Ts);
    const wN = Math.PI / Ts;
    const wMin = 1e-3 / Math.max(model.tau1, Ts);
    const disc = frequencyAnalysis(w => evalDiscrete(A.Lnum, A.Lden, w, Ts), wMin, wN * 0.9999, n);
    const cont = frequencyAnalysis(w => evalContinuousLoop(model, ctrl, w), wMin, wN * 10, n);
    return { analysis: A, discrete: disc, continuous: cont, wNyquist: wN };
  }

  /* ------------------------------------------------------------------ */
  /* Controller step functions (float & fixed-point mirror of C)          */
  /* ------------------------------------------------------------------ */

  const AW = { none: 0, clamp: 1, backcalc: 2 };

  function makeFloatPID(ctrl, Ts, lim) {
    const c = controllerCoeffs(ctrl, Ts);
    const aw = AW[ctrl.antiWindup || 'backcalc'];
    const st = { i: 0, d: 0, yPrev: 0 };
    return {
      coeffs: c,
      init(y0, u0) { st.d = 0; st.yPrev = y0; st.i = u0 - c.kb * y0 + c.kp * y0; },
      state: st,
      step(r, y) {
        const e = r - y;
        const p = c.kb * r - c.kp * y;
        if (c.hasD) st.d = c.ad * st.d - c.bd * (y - st.yPrev);
        const v = p + st.i + st.d;
        const u = v > lim.umax ? lim.umax : v < lim.umin ? lim.umin : v;
        const di = c.ki * e;
        if (aw === 2) st.i += di + c.kt * (u - v);
        else if (aw === 1) { if (!((v > lim.umax && di > 0) || (v < lim.umin && di < 0))) st.i += di; }
        else st.i += di;
        st.yPrev = y;
        return { u, v, p, i: st.i, d: st.d, e };
      },
    };
  }

  /* Fixed-point: signals Q16.16 in int32, integrator Q32.32 in int64,
     each coefficient with its own fractional-bit count (≤ 30). */
  const Q = 16;
  const toQ16 = x => Math.floor(x * 65536 + 0.5);
  function fracBits(c) {
    if (c === 0) return 30;
    const f = 30 - Math.max(0, Math.ceil(Math.log2(Math.abs(c) + 1e-300) + 1e-12));
    return Math.max(0, Math.min(30, f));
  }
  function quantCoeff(c) { const f = fracBits(c); const q = Math.floor(c * Math.pow(2, f) + 0.5); return { q: Math.max(-2147483647, Math.min(2147483647, q)), f }; }

  function fixedCoeffs(ctrl, Ts, lim) {
    const c = controllerCoeffs(ctrl, Ts);
    return {
      kp: quantCoeff(c.kp), kb: quantCoeff(c.kb), ki: quantCoeff(c.ki), ad: quantCoeff(c.ad), bd: quantCoeff(c.bd), kt: quantCoeff(c.kt),
      umin: toQ16(lim.umin), umax: toQ16(lim.umax), hasD: c.hasD, aw: AW[ctrl.antiWindup || 'backcalc'], float: c,
    };
  }

  // round-half-up arithmetic right shift (matches LF_RSHIFT in the generated C)
  const rsh = (x, s) => (s > 0 ? (x + (1n << BigInt(s - 1))) >> BigInt(s) : x << BigInt(-s));
  const I32MIN = -2147483648n, I32MAX = 2147483647n;
  const sat32 = x => (x > I32MAX ? I32MAX : x < I32MIN ? I32MIN : x);

  function makeFixedPID(ctrl, Ts, lim) {
    const fc = fixedCoeffs(ctrl, Ts, lim);
    const B = o => ({ q: BigInt(o.q), f: o.f });
    const kp = B(fc.kp), kb = B(fc.kb), ki = B(fc.ki), ad = B(fc.ad), bd = B(fc.bd), kt = B(fc.kt);
    const umin = BigInt(fc.umin), umax = BigInt(fc.umax);
    const mulQ16 = (k, x) => rsh(k.q * x, k.f);               // → Q16.16 (int64)
    const st = { i: 0n, d: 0n, yPrev: 0n };                    // i in Q32.32
    return {
      coeffs: fc,
      init(y0, u0) {
        const y = BigInt(toQ16(y0)), u = BigInt(toQ16(u0));
        st.yPrev = y; st.d = 0n;
        st.i = (u - mulQ16(kb, y) + mulQ16(kp, y)) << 16n;
      },
      state: st,
      stepQ(rq, yq) {                                          // BigInt Q16.16 in/out
        const e = sat32(rq - yq);
        const p = mulQ16(kb, rq) - mulQ16(kp, yq);
        if (fc.hasD) st.d = sat32(mulQ16(ad, st.d) - mulQ16(bd, sat32(yq - st.yPrev)));
        let v = p + rsh(st.i, 16) + st.d;
        v = sat32(v);
        const u = v > umax ? umax : v < umin ? umin : v;
        const di = rsh(ki.q * e, ki.f - 16);                    // Q32.32
        if (fc.aw === 2) st.i += di + rsh(kt.q * sat32(u - v), kt.f - 16);
        else if (fc.aw === 1) { if (!((v > umax && di > 0n) || (v < umin && di < 0n))) st.i += di; }
        else st.i += di;
        st.yPrev = yq;
        return u;
      },
      step(r, y) { const u = this.stepQ(BigInt(toQ16(r)), BigInt(toQ16(y))); return { u: Number(u) / 65536 }; },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Closed-loop simulation                                              */
  /* ------------------------------------------------------------------ */

  /**
   * opts: {model, ctrl:{Kc,Ti,Td,N,b,antiWindup,Tt}, Ts, umin, umax,
   *        y0 (ambient), uPre (input at steady state y0, normally 0),
   *        r0, r1, tStep, dist:{t, du}, tEnd, sub (intersample points),
   *        quant (ADC resolution, 0 = none), arithmetic: 'float'|'fixed'}
   * Input deviation seen by plant: w = u + du − uPre, delayed by θ.
   * Returns sample-instant and intersample trajectories.
   */
  function simulateClosedLoop(o) {
    const m = o.model, Ts = o.Ts, sub = o.sub || 4;
    const n = Math.floor(o.tEnd / Ts + 1e-9) + 1;
    const d = Math.floor(m.theta / Ts + 1e-12);
    let thf = m.theta - d * Ts; if (thf < 1e-12 * Ts) thf = 0;
    const lim = { umin: o.umin, umax: o.umax };
    const pid = o.arithmetic === 'fixed' ? makeFixedPID(o.ctrl, Ts, lim) : makeFloatPID(o.ctrl, Ts, lim);
    const uPre = o.uPre || 0;
    pid.init(o.y0, uPre);
    const x = [0, 0];
    const wHist = new Float64Array(n);           // applied plant input deviation per sample
    const getW = k => (k < 0 ? 0 : wHist[k]);
    const S = { t: [], r: [], y: [], ym: [], u: [], v: [], p: [], i: [], d: [], e: [], dist: [], sat: [] };
    const F = { t: [], y: [], w: [] };
    for (let k = 0; k < n; k++) {
      const tk = k * Ts;
      const yTrue = o.y0 + outputOf(m, x);
      const ym = o.quant > 0 ? Math.round(yTrue / o.quant) * o.quant : yTrue;
      const r = tk >= o.tStep ? o.r1 : o.r0;
      const du = o.dist && tk >= o.dist.t ? o.dist.du : 0;
      const res = pid.step(r, ym);
      wHist[k] = res.u + du - uPre;
      S.t.push(tk); S.r.push(r); S.y.push(yTrue); S.ym.push(ym); S.u.push(res.u); S.v.push(res.v !== undefined ? res.v : res.u);
      S.p.push(res.p || 0); S.i.push(res.i || 0); S.d.push(res.d || 0); S.e.push(r - ym); S.dist.push(du);
      S.sat.push(res.u >= o.umax - 1e-12 ? 1 : res.u <= o.umin + 1e-12 ? -1 : 0);
      if (k === n - 1) { F.t.push(tk); F.y.push(yTrue); F.w.push(getW(k - d)); break; }
      // propagate over [tk, tk+Ts): first θf with w[k-d-1], then the rest with w[k-d]
      const segs = thf > 0 ? [[thf, getW(k - d - 1)], [Ts - thf, getW(k - d)]] : [[Ts, getW(k - d)]];
      let tt = tk;
      for (const [len, wv] of segs) {
        const h = len / sub;
        for (let s = 0; s < sub; s++) {
          F.t.push(tt); F.y.push(o.y0 + outputOf(m, x)); F.w.push(wv);
          propagate(m, x, wv, h); tt += h;
        }
      }
    }
    // performance summary
    const iae = S.e.reduce((a, e) => a + Math.abs(e) * Ts, 0);
    const satFrac = S.sat.filter(v => v !== 0).length / n;
    const stepIdx = S.t.findIndex(t => t >= o.tStep);
    let overshoot = 0, settle = NaN, rise = NaN;
    const span = o.r1 - o.r0;
    if (span !== 0 && stepIdx >= 0) {
      const tEndStep = o.dist && o.dist.t > o.tStep ? o.dist.t : Infinity;
      let peak = 0, lastOut = stepIdx;
      for (let k = stepIdx; k < n && S.t[k] < tEndStep; k++) {
        const fr = (S.y[k] - o.r0) / span;
        peak = Math.max(peak, fr);
        if (isNaN(rise) && fr >= 0.9) rise = S.t[k] - o.tStep;
        if (Math.abs(fr - 1) > 0.02) lastOut = k;
      }
      overshoot = Math.max(0, (peak - 1) * 100);
      settle = lastOut + 1 < n ? S.t[lastOut + 1] - o.tStep : NaN;
    }
    return { samples: S, fine: F, n, Ts, d, thetaFrac: thf, summary: { iae, satFrac, overshoot, rise, settle } };
  }

  /* ------------------------------------------------------------------ */
  /* Synthetic data (clearly labelled; for tests and demos only)          */
  /* ------------------------------------------------------------------ */

  /** Deterministic PRNG (mulberry32) and Gaussian via Box–Muller. */
  function rng(seed) {
    let a = seed >>> 0;
    const u = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    return { u, n: () => Math.sqrt(-2 * Math.log(u() + 1e-300)) * Math.cos(2 * Math.PI * u()) };
  }
  function synthStep(model, opts) {
    const o = Object.assign({ Ts: 1, n: 601, uPre: 0, u1: 50, y0: 23, noise: 0.1, quant: 0, seed: 1 }, opts || {});
    const t = [], u = [];
    for (let i = 0; i < o.n; i++) { t.push(i * o.Ts); u.push(o.u1); }
    const x = simulateModel(model, t, u, o.uPre);
    const R = rng(o.seed);
    const y = Array.from(x, v => { let yv = o.y0 + v + o.noise * R.n(); if (o.quant) yv = Math.round(yv / o.quant) * o.quant; return yv; });
    return { t, u, y, uPre: o.uPre };
  }

  return {
    parseCSV, guessColumns, simulateModel, predict, fitModel, fitMetrics, validateModel, sliceRecord,
    tune, seriesToIdeal, discretizePlant, controllerCoeffs, controllerTF, analyseLoop,
    evalDiscrete, evalContinuousLoop, frequencyAnalysis, loopFrequency,
    makeFloatPID, makeFixedPID, fixedCoeffs, quantCoeff, fracBits, toQ16, simulateClosedLoop,
    polyRoots, polyMul, polyAdd, polyEval, nelderMead, synthStep, rng, propagate, logspace, Cx: C,
  };
});
