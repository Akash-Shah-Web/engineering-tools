/* LoopForge application — wires data → model → tuning → loop → code. */
(function () {
  'use strict';
  const LF = window.LoopForge, CG = window.LoopForgeCodegen, P = window.LFPlot, DATA = window.LF_DATA;
  const $ = s => document.querySelector(s);
  const h = (tag, attrs, html) => { const e = document.createElement(tag); for (const k in attrs || {}) { if (k === 'class') e.className = attrs[k]; else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]); else e.setAttribute(k, attrs[k]); } if (html !== undefined) e.innerHTML = html; return e; };
  const NS = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
  const f = (x, d) => (typeof x === 'number' && Math.abs(x) < 1e-9 && x !== 0 ? f(0, d) : x === undefined || x === null || !isFinite(x) ? (x === Infinity ? '∞' : '—') : (Math.abs(x) >= 1e4 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(2) : x.toFixed(d === undefined ? 2 : d)));
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const store = { get(k) { try { return localStorage.getItem('loopforge.' + k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem('loopforge.' + k, v); } catch (e) { /* ignore */ } } };

  /* ================================================================== */
  /* State                                                              */
  /* ================================================================== */
  const S = {
    dataset: 'tclab', records: [], fitRec: null, viewRec: null, win: [0, 0],
    fits: {}, modelType: 'SOPDT', validations: [],
    tune: { method: 'SIMC', type: 'PID', tauC: 10, manual: false, Kc: 1, Ti: 100, Td: 0, N: 10, b: 1, rule: null },
    loop: { Ts: 1, umin: 0, umax: 100, aw: 'backcalc', arith: 'float', quant: 0, r1: 50, tStep: 10, distT: 450, distDu: -20, tEnd: 900 },
    play: { t: 0, playing: true, speed: 30, hwSource: 'sim' },
    res: {}, activeTags: [], codeTab: 0, ready: false,
  };

  /* ================================================================== */
  /* Datasets                                                           */
  /* ================================================================== */
  function recordFromCSV(text, meta, cols) {
    const c = LF.parseCSV(text);
    const g = cols || LF.guessColumns(c.headers);
    return Object.assign({ t: c.cols[g.t], u: c.cols[g.u], y: c.cols[g.y], uPre: meta.uPre !== undefined ? meta.uPre : c.cols[g.u][0], cols: g }, meta);
  }

  function loadTCLab() {
    return DATA.tclab.map(d => recordFromCSV(d.csv, { id: d.id, name: d.name, short: d.short, kind: 'measured', input: d.input, uPre: 0, file: d.file, desc: d.desc }));
  }

  function loadSynthetic() {
    // Clearly labelled synthetic benchmark: SOPDT truth + Gaussian noise + 0.32 °C quantisation.
    const truth = { K: 0.8, tau1: 120, tau2: 15, theta: 6 };
    const a = LF.synthStep(truth, { n: 901, Ts: 1, u1: 50, y0: 22, noise: 0.08, quant: 0.32, seed: 11 });
    // second synthetic record with a multi-step input (validation)
    const t = [], u = [];
    for (let i = 0; i < 901; i++) { t.push(i); u.push(i < 200 ? 30 : i < 450 ? 70 : i < 700 ? 20 : 55); }
    const x = LF.simulateModel(truth, t, u, 0), R = LF.rng(5);
    const y = Array.from(x, v => Math.round((22 + v + 0.08 * R.n()) / 0.32) * 0.32);
    return [
      Object.assign(a, { id: 'syn1', name: 'Synthetic step 0→50 %', short: 'syn step', kind: 'synthetic', input: 'step', truth, desc: 'Generated: SOPDT K=0.8, τ1=120 s, τ2=15 s, θ=6 s, σ=0.08 °C, quantised 0.32 °C.' }),
      { id: 'syn2', name: 'Synthetic multi-step', short: 'syn multi', kind: 'synthetic', input: 'multi-step', t, u, y, uPre: 0, truth, desc: 'Same synthetic plant, different input sequence and noise seed.' },
    ];
  }

  function setDataset(id, records) {
    S.dataset = id;
    S.records = records || (id === 'tclab' ? loadTCLab() : loadSynthetic());
    const fitRec = S.records[0];
    S.fitRec = fitRec.id; S.viewRec = fitRec.id;
    const t = fitRec.t;
    S.win = id === 'user' ? [t[0], t[0] + 0.7 * (t[t.length - 1] - t[0])] : [t[0], t[t.length - 1]];
    $('#datasetSel').value = id;
    runFit();
  }

  /* ================================================================== */
  /* Pipeline                                                           */
  /* ================================================================== */
  const rec = id => S.records.find(r => r.id === id);

  function runFit() {
    const r = rec(S.fitRec);
    const data = LF.sliceRecord({ t: r.t, u: r.u, y: r.y, uPre: r.uPre }, S.win[0], S.win[1]);
    S.fitData = data;
    S.fits = {};
    for (const type of ['FOPDT', 'SOPDT']) S.fits[type] = LF.fitModel(data, { model: type });
    // model selection by AIC (lower is better)
    S.modelType = S.fits.SOPDT.metrics.aic < S.fits.FOPDT.metrics.aic - 2 ? 'SOPDT' : 'FOPDT';
    S.modelAuto = S.modelType;
    computeValidation();
    const m = model();
    if (!S.tuneTouched) S.tune.tauC = Math.max(m.theta, 0.05 * m.tau1);
    S.loop.r1 = Math.round(m.y0 + Math.min(0.45 * Math.abs(m.K) * (S.loop.umax - S.loop.umin), 30));
    retune();
  }

  function computeValidation() {
    const out = [];
    const fr = rec(S.fitRec);
    for (const type of ['FOPDT', 'SOPDT']) {
      const m = S.fits[type].model;
      // identification window itself
      out.push({ rec: fr, type, role: 'fit', pred: S.fits[type].pred, predT: S.fitData.t, metrics: S.fits[type].metrics, y0: m.y0 });
      // held-out part of the same record (simulate full record with the full input history; score outside the window)
      const t = fr.t, idx = [];
      for (let i = 0; i < t.length; i++) if (t[i] < S.win[0] || t[i] > S.win[1]) idx.push(i);
      if (idx.length > 10) {
        const full = LF.predict(m, { t: fr.t, u: fr.u, uPre: fr.uPre }, m.y0);
        const yh = idx.map(i => fr.y[i]), ph = idx.map(i => full[i]);
        out.push({ rec: fr, type, role: 'holdout', pred: full, predT: fr.t, metrics: LF.fitMetrics(yh, ph, 0), y0: m.y0, idx });
      }
      for (const r of S.records) if (r.id !== fr.id) {
        const v = LF.validateModel(m, { t: r.t, u: r.u, y: r.y, uPre: r.uPre });
        out.push({ rec: r, type, role: 'validation', pred: v.pred, predT: r.t, metrics: v.metrics, y0: v.y0 });
      }
    }
    S.validations = out;
  }

  const model = () => S.fits[S.modelType].model;

  function retune() {
    const m = model();
    const r = LF.tune(m, S.tune.method, S.tune.type, S.tune.tauC);
    S.tune.rule = r;
    if (!S.tune.manual) { S.tune.Kc = r.Kc; S.tune.Ti = r.Ti; S.tune.Td = r.Td; }
    if (S.tune.type === 'PI') S.tune.Td = 0;
    recompute();
  }

  function ctrl() {
    return { Kc: S.tune.Kc, Ti: S.tune.Ti, Td: S.tune.type === 'PID' ? S.tune.Td : 0, N: S.tune.N, b: S.tune.b, antiWindup: S.loop.aw,
      method: S.tune.method, type: S.tune.type, tauC: S.tune.tauC, ref: S.tune.manual ? 'manual gains (started from ' + S.tune.rule.ref + ')' : S.tune.rule.ref };
  }

  let rafPending = false;
  function recompute() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; compute(); renderAll(); });
  }

  function compute() {
    const m = model(), c = ctrl(), L = S.loop;
    const y0 = m.y0;
    const scen = { model: m, ctrl: c, Ts: L.Ts, umin: L.umin, umax: L.umax, y0, uPre: m.uPre || 0, r0: y0, r1: L.r1, tStep: L.tStep, dist: { t: L.distT, du: L.distDu }, tEnd: L.tEnd, quant: L.quant, sub: Math.max(1, Math.min(8, Math.round(4 * L.Ts))) };
    S.res.scen = scen;
    S.res.sim = LF.simulateClosedLoop(Object.assign({}, scen, { arithmetic: L.arith }));
    S.res.simAlt = L.arith === 'fixed' ? LF.simulateClosedLoop(scen) : null;
    S.res.freq = LF.loopFrequency(m, c, L.Ts, 1600);
    const d = S.res.freq.discrete;
    const fit = S.fits[S.modelType];
    S.res.code = CG.generate({ model: m, ctrl: c, Ts: L.Ts, umin: L.umin, umax: L.umax, margins: { gmDb: d.gmDb, pm: d.pm, Ms: d.Ms },
      source: (rec(S.fitRec).kind === 'measured' ? 'measured ' : rec(S.fitRec).kind + ' ') + rec(S.fitRec).short, fitPct: fit.metrics.fitPct, rmse: fit.metrics.rmse, r1: L.r1 });
  }

  /* ================================================================== */
  /* Rendering                                                          */
  /* ================================================================== */
  const plots = {};
  function initPlots() {
    const tfmt = v => f(v, 1) + ' s';
    plots.fit = P.create($('#fitPlot'), { height: 250, x: { label: 'Time [s]', short: 't', fmt: tfmt }, y: { label: 'Output', short: 'y', fmt: v => f(v, 2) }, link: 'tFit', cursorDots: true, ariaLabel: 'Measured output with fitted models' });
    plots.res = P.create($('#resPlot'), { height: 120, x: { label: 'Time [s]', short: 't', fmt: tfmt }, y: { label: 'Residual', short: 'e', fmt: v => f(v, 3), zeroLine: true }, link: 'tFit', ariaLabel: 'Residuals' });
    plots.y = P.create($('#yPlot'), { height: 240, x: { label: 'Time [s]', short: 't', fmt: tfmt }, y: { label: 'Temperature / output', short: 'y', fmt: v => f(v, 2) }, link: 'tLoop', cursorDots: true, ariaLabel: 'Closed-loop output' });
    plots.u = P.create($('#uPlot'), { height: 160, x: { label: 'Time [s]', short: 't', fmt: tfmt }, y: { label: 'Actuator [%]', short: 'u', fmt: v => f(v, 1) }, link: 'tLoop', cursorDots: true, ariaLabel: 'Actuator command' });
    const wfmt = v => f(v, 4) + ' rad/s';
    plots.mag = P.create($('#magPlot'), { height: 170, x: { log: true, label: 'ω [rad/s]', short: 'ω', fmt: wfmt }, y: { label: '|L| [dB]', short: 'dB', fmt: v => f(v, 2) + ' dB', zeroLine: true }, link: 'freq', ariaLabel: 'Bode magnitude' });
    plots.ph = P.create($('#phPlot'), { height: 170, x: { log: true, label: 'ω [rad/s]', short: 'ω', fmt: wfmt }, y: { label: '∠L [deg]', short: 'deg', fmt: v => f(v, 1) + '°' }, link: 'freq', ariaLabel: 'Bode phase' });
    plots.nyq = P.create($('#nyqPlot'), { height: 340, parametric: true, aspect: 'equal', paramLabel: 'ω', paramFmt: wfmt, x: { label: 'Re L', short: 're', fmt: v => f(v, 3) }, y: { label: 'Im L', short: 'im', fmt: v => f(v, 3), pad: 0 }, link: 'freq', ariaLabel: 'Nyquist plot' });
    plots.pz = P.create($('#pzPlot'), { height: 340, aspect: 'equal', x: { label: 'Re z', short: 're', fmt: v => f(v, 4) }, y: { label: 'Im z', short: 'im', fmt: v => f(v, 4), pad: 0 }, ariaLabel: 'Pole-zero map' });
    plots.pz.opt.parametric = true; plots.pz.opt.paramLabel = '#'; plots.pz.opt.paramFmt = v => String(v);
    // exports
    document.querySelectorAll('.exports').forEach(box => {
      const target = box.dataset.target;
      for (const kind of ['PNG', 'SVG', 'CSV']) {
        if (target === 'diagram' && kind === 'CSV') { box.appendChild(h('button', { onclick: () => exportDiagramCSV(), title: 'Export simulated signals as CSV' }, 'CSV')); continue; }
        box.appendChild(h('button', { onclick: () => exportPlot(target, kind), title: `Export ${kind}` }, kind));
      }
    });
  }

  function plotByTarget(t) { return { fitPlot: plots.fit, resPlot: plots.res, yPlot: plots.y, uPlot: plots.u, magPlot: plots.mag, phPlot: plots.ph, nyqPlot: plots.nyq, pzPlot: plots.pz }[t]; }

  function download(name, data, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast('Saved ' + name);
  }

  function exportPlot(target, kind) {
    if (target === 'diagram') {
      const svg = $('#diagram svg'), clone = svg.cloneNode(true);
      clone.setAttribute('xmlns', NS);
      const a = svg.querySelectorAll('*'), b = clone.querySelectorAll('*');
      for (let i = 0; i < a.length; i++) { const cs = getComputedStyle(a[i]); b[i].setAttribute('style', ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-size', 'font-family', 'font-weight', 'font-style'].map(p => p + ':' + cs.getPropertyValue(p)).join(';')); }
      const txt = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
      if (kind === 'SVG') return download('loopforge-block-diagram.svg', txt, 'image/svg+xml');
      const vb = svg.viewBox.baseVal, img = new Image(), url = URL.createObjectURL(new Blob([txt], { type: 'image/svg+xml' }));
      img.onload = () => { const c = document.createElement('canvas'); c.width = vb.width * 2; c.height = vb.height * 2; const x = c.getContext('2d'); x.fillStyle = css('--bg-2'); x.fillRect(0, 0, c.width, c.height); x.scale(2, 2); x.drawImage(img, 0, 0); URL.revokeObjectURL(url); c.toBlob(bl => download('loopforge-block-diagram.png', bl)); };
      img.src = url; return;
    }
    const p = plotByTarget(target);
    const base = 'loopforge-' + target.replace('Plot', '');
    if (kind === 'SVG') download(base + '.svg', p.toSVG(), 'image/svg+xml');
    else if (kind === 'CSV') download(base + '.csv', p.toCSV(), 'text/csv');
    else p.toPNG(2).then(b => download(base + '.png', b)).catch(() => toast('PNG export failed in this browser'));
  }

  function exportDiagramCSV() {
    const S2 = S.res.sim.samples;
    const lines = ['# LoopForge simulated closed loop (SIMULATED, fitted ' + S.modelType + ' model)', 't_s,r,y,y_measured,e,u,v_unsaturated,P,I,D,disturbance,saturated'];
    for (let k = 0; k < S2.t.length; k++) lines.push([S2.t[k], S2.r[k], S2.y[k], S2.ym[k], S2.e[k], S2.u[k], S2.v[k], S2.p[k], S2.i[k], S2.d[k], S2.dist[k], S2.sat[k]].map(v => +(+v).toPrecision(10)).join(','));
    download('loopforge-closed-loop.csv', lines.join('\n') + '\n', 'text/csv');
  }

  function renderAll() {
    renderStages(); renderConsole(); renderFit(); renderLoop(); renderFreq(); renderCode(); buildDiagram(); buildHW(); renderFoot();
    S.ready = true;
    frame(true);
  }

  /* ---------- stage strip ---------- */
  function renderStages() {
    const r = rec(S.fitRec), fit = S.fits[S.modelType], m = fit.model, d = S.res.freq.discrete, A = S.res.freq.analysis;
    const vals = S.validations.filter(v => v.type === S.modelType && v.role !== 'fit');
    const worst = vals.length ? vals.reduce((a, b) => (b.metrics.fitPct < a.metrics.fitPct ? b : a)) : null;
    const st = [
      { n: 1, t: 'Data', v: `${r.short} · ${r.t.length} samples`, s: `${r.kind === 'measured' ? 'Measured TCLab log' : r.kind === 'synthetic' ? 'Synthetic (labelled)' : 'Imported CSV'} · Ts≈${f((r.t[r.t.length - 1] - r.t[0]) / (r.t.length - 1), 2)} s`, cls: 'done', to: '#ident' },
      { n: 2, t: 'Model · ' + S.modelType, v: m.type === 'SOPDT' ? `K ${f(m.K, 3)} τ ${f(m.tau1, 1)}/${f(m.tau2, 1)} θ ${f(m.theta, 1)}` : `K ${f(m.K, 3)} τ ${f(m.tau1, 1)} θ ${f(m.theta, 1)}`, s: `fit ${f(fit.metrics.fitPct, 1)} % · worst validation ${worst ? f(worst.metrics.fitPct, 1) + ' %' : '—'}`, cls: worst && worst.metrics.fitPct < 80 ? 'warn' : 'done', to: '#ident' },
      { n: 3, t: 'Tuning · ' + (S.tune.manual ? 'manual' : S.tune.method + ' ' + S.tune.type), v: `Kc ${f(S.tune.Kc, 3)} Ti ${f(S.tune.Ti, 1)}${S.tune.type === 'PID' ? ' Td ' + f(S.tune.Td, 2) : ''}`, s: `τc/λ ${f(S.tune.tauC, 1)} s · Ts ${f(S.loop.Ts, 2)} s`, cls: 'done', to: '#room' },
      { n: 4, t: 'Loop · sampled', v: A.stable ? `PM ${f(d.pm, 1)}° GM ${f(d.gmDb, 1)} dB` : 'UNSTABLE', s: A.stable ? `Ms ${f(d.Ms, 2)} · max |pole| ${f(A.maxPoleRadius, 4)}` : `max |pole| ${f(A.maxPoleRadius, 4)} ≥ 1`, cls: !A.stable ? 'bad' : d.Ms > 2 ? 'warn' : 'done', to: '#bode' },
    ];
    const nav = $('#stages'); nav.innerHTML = '';
    for (const x of st) nav.appendChild(h('button', { class: 'stage ' + x.cls, onclick: () => document.querySelector(x.to).scrollIntoView({ behavior: 'smooth', block: 'start' }) }, `<span class="n">${x.cls === 'bad' ? '!' : x.n}</span><div class="t">${x.t}</div><div class="v">${x.v}</div><div class="s">${x.s}</div>`));
  }

  /* ---------- console (sliders) ---------- */
  const sliders = {};
  function slider(id, o) {
    const wrap = h('div', { class: 'sl', 'data-tags': (o.tags || []).join(' ') });
    const lab = h('label', { for: 'sl-' + id }, `${o.label}${o.unit ? ' <em>' + o.unit + '</em>' : ''}`);
    const out = h('output', { id: 'out-' + id });
    const inp = h('input', { type: 'range', id: 'sl-' + id, min: 0, max: 1000, step: 1 });
    const toPos = v => o.log ? 1000 * (Math.log(v) - Math.log(o.min)) / (Math.log(o.max) - Math.log(o.min)) : 1000 * (v - o.min) / (o.max - o.min);
    const fromPos = p => o.log ? Math.exp(Math.log(o.min) + p / 1000 * (Math.log(o.max) - Math.log(o.min))) : o.min + p / 1000 * (o.max - o.min);
    const set = v => { const p = Math.max(0, Math.min(1000, toPos(v))); inp.value = p; inp.style.setProperty('--p', p / 10 + '%'); out.textContent = o.fmt ? o.fmt(v) : f(v, 2); };
    inp.addEventListener('input', () => { let v = fromPos(+inp.value); if (o.snap) v = o.snap(v); inp.style.setProperty('--p', inp.value / 10 + '%'); out.textContent = o.fmt ? o.fmt(v) : f(v, 2); o.onInput(v); setTags(o.tags); });
    const focusTags = () => setTags(o.tags);
    inp.addEventListener('focus', focusTags); wrap.addEventListener('mouseenter', focusTags);
    wrap.append(lab, out, inp);
    sliders[id] = { wrap, set, o };
    return wrap;
  }
  function seg(options, value, onPick, tags) {
    const box = h('div', { class: 'seg', role: 'group' });
    for (const [v, label] of options) {
      const b = h('button', { class: v === value ? 'on' : '', 'aria-pressed': v === value }, label);
      b.addEventListener('click', () => { box.querySelectorAll('button').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); }); b.classList.add('on'); b.setAttribute('aria-pressed', 'true'); onPick(v); setTags(tags); });
      box.appendChild(b);
    }
    if (tags) box.addEventListener('mouseenter', () => setTags(tags));
    return box;
  }

  let consoleBuilt = false;
  function renderConsole() {
    const box = $('#console');
    const m = model();
    if (!consoleBuilt) {
      consoleBuilt = true;
      box.innerHTML = '';
      box.append(h('h3', {}, 'Tuning rule'));
      box.append(S.ui_method = seg([['SIMC', 'SIMC'], ['lambda', 'Lambda / IMC']], S.tune.method, v => { S.tune.method = v; S.tune.manual = false; retune(); }, ['kc', 'ti', 'td']));
      box.append(S.ui_type = seg([['PI', 'PI'], ['PID', 'PID']], S.tune.type, v => { S.tune.type = v; S.tune.manual = false; retune(); }, ['td', 'n']));
      box.append(slider('tauC', { label: 'Closed-loop τc / λ', unit: 's', min: 0.5, max: 600, log: true, fmt: v => f(v, 1) + ' s', tags: ['kc', 'ti', 'td'], onInput: v => { S.tune.tauC = v; S.tune.manual = false; S.tuneTouched = true; retune(); } }));
      box.append(S.ui_rule = h('div', { class: 'rule' }));
      box.append(h('h3', {}, 'Gains (ideal form)'));
      box.append(slider('Kc', { label: 'Kc', unit: 'u per y', min: 0.01, max: 500, log: true, fmt: v => f(v, 3), tags: ['kc'], onInput: v => { S.tune.Kc = v; S.tune.manual = true; recompute(); } }));
      box.append(slider('Ti', { label: 'Ti', unit: 's', min: 1, max: 3000, log: true, fmt: v => f(v, 1) + ' s', tags: ['ti'], onInput: v => { S.tune.Ti = v; S.tune.manual = true; recompute(); } }));
      box.append(slider('Td', { label: 'Td', unit: 's', min: 0.05, max: 300, log: true, fmt: v => f(v, 2) + ' s', tags: ['td'], onInput: v => { S.tune.Td = v; S.tune.manual = true; recompute(); } }));
      box.append(slider('N', { label: 'Derivative filter N', min: 2, max: 40, snap: Math.round, fmt: v => f(v, 0), tags: ['n'], onInput: v => { S.tune.N = v; recompute(); } }));
      box.append(h('h3', {}, 'Implementation'));
      box.append(slider('Ts', { label: 'Sample time Ts', unit: 's', min: 0.1, max: 30, log: true, snap: v => +v.toPrecision(2), fmt: v => f(v, v < 1 ? 2 : 1) + ' s', tags: ['ts'], onInput: v => { S.loop.Ts = v; recompute(); } }));
      box.append(slider('umax', { label: 'Actuator max', unit: '%', min: 10, max: 100, snap: Math.round, fmt: v => f(v, 0) + ' %', tags: ['sat'], onInput: v => { S.loop.umax = v; recompute(); } }));
      const aw = h('div', { class: 'mini' }, '<span>Anti-windup</span>');
      const awSel = h('select', { id: 'awSel', 'aria-label': 'Anti-windup' }, '<option value="backcalc">back-calculation</option><option value="clamp">clamping</option><option value="none">none</option>');
      awSel.value = S.loop.aw; awSel.addEventListener('change', () => { S.loop.aw = awSel.value; setTags(['aw']); recompute(); }); awSel.addEventListener('focus', () => setTags(['aw']));
      aw.appendChild(awSel); box.append(aw);
      const ar = h('div', { class: 'mini' }, '<span>Arithmetic</span>');
      ar.appendChild(seg([['float', 'float'], ['fixed', 'Q16.16']], S.loop.arith, v => { S.loop.arith = v; if (v === 'fixed') { S.codeTab = 1; } recompute(); }, ['fixed']));
      box.append(ar);
      const q = h('label', { class: 'mini chk' }, '<span>ADC quantisation 0.322 °C <em style="color:var(--text-3);font-style:normal">(from data)</em></span>');
      const qc = h('input', { type: 'checkbox', id: 'quantChk' }); qc.addEventListener('change', () => { S.loop.quant = qc.checked ? 3.3 / 1024 / 0.01 : 0; recompute(); });
      q.prepend(qc); box.append(q);
    }
    sliders.tauC.set(S.tune.tauC); sliders.Kc.set(S.tune.Kc); sliders.Ti.set(S.tune.Ti); sliders.Td.set(S.tune.Td || 0.05); sliders.N.set(S.tune.N);
    sliders.Ts.set(S.loop.Ts); sliders.umax.set(S.loop.umax);
    sliders.Td.wrap.style.display = S.tune.type === 'PID' ? '' : 'none';
    sliders.N.wrap.style.display = S.tune.type === 'PID' ? '' : 'none';
    ['Kc', 'Ti', 'Td'].forEach(k => sliders[k].wrap.classList.toggle('manual', S.tune.manual));
    S.ui_rule.innerHTML = S.tune.manual
      ? `Manual gains (amber). <button id="resetRule">Reset to ${S.tune.method} rule</button>`
      : `${S.tune.rule.ref}.${S.tune.rule.series ? ` Series form: Kc ${f(S.tune.rule.series.Kc, 3)}, τI ${f(S.tune.rule.series.Ti, 1)} s, τD ${f(S.tune.rule.series.Td, 2)} s.` : ''} Model: ${S.modelType}, θ = ${f(m.theta, 2)} s.`;
    const rb = $('#resetRule'); if (rb) rb.onclick = () => { S.tune.manual = false; retune(); };
  }

  /* ---------- identification ---------- */
  function renderFit() {
    const tabs = $('#recTabs'); tabs.innerHTML = '';
    for (const r of S.records) {
      const role = r.id === S.fitRec ? 'fit' : 'val';
      const b = h('button', { class: r.id === S.viewRec ? 'on' : '', role: 'tab', 'aria-selected': r.id === S.viewRec, title: r.desc || '' }, `<i style="background:${role === 'fit' ? 'var(--accent)' : 'var(--s4)'}"></i>${r.short}`);
      b.onclick = () => { S.viewRec = r.id; renderFit(); };
      tabs.appendChild(b);
    }
    const r = rec(S.viewRec);
    const badge = $('#identBadge');
    badge.className = 'badge ' + (r.kind === 'measured' ? 'meas' : r.kind === 'synthetic' ? 'syn' : 'user');
    badge.textContent = (r.kind === 'measured' ? 'MEASURED' : r.kind === 'synthetic' ? 'SYNTHETIC' : 'USER DATA') + ' + MODEL';
    const vs = S.validations.filter(v => v.rec.id === r.id && v.role !== 'holdout');
    const series = [{ id: 'meas', name: (r.kind === 'measured' ? 'Measured ' : r.kind === 'synthetic' ? 'Synthetic ' : 'Logged ') + (r.cols ? r.cols.y : 'y'), x: r.t, y: r.y, kind: 'points', r: 1.6, color: 'var(--c-meas)', opacity: 0.75 }];
    for (const type of ['FOPDT', 'SOPDT']) {
      const v = vs.find(x => x.type === type);
      if (!v) continue;
      const full = r.id === S.fitRec ? S.validations.find(x => x.rec.id === r.id && x.type === type && x.role === 'holdout') : null;
      const px = full ? full.predT : v.predT, py = full ? full.pred : v.pred;
      series.push({ id: type, name: type + (type === S.modelType ? ' (selected)' : ''), x: px, y: py, color: type === 'SOPDT' ? 'var(--c-sopdt)' : 'var(--c-fopdt)', width: type === S.modelType ? 2.4 : 1.6, dash: type === S.modelType ? '' : '5 3' });
    }
    // input as secondary normalized trace is avoided (one axis rule) — shown in tooltip via CSV; regions mark identification window
    const regions = [];
    if (r.id === S.fitRec) {
      regions.push({ x0: S.win[0], x1: S.win[1], label: 'IDENTIFICATION WINDOW' });
      if (S.win[1] < r.t[r.t.length - 1]) regions.push({ x0: S.win[1], x1: r.t[r.t.length - 1], cls: 'hold', label: 'HELD OUT' });
      if (S.win[0] > r.t[0]) regions.push({ x0: r.t[0], x1: S.win[0], cls: 'hold', label: 'HELD OUT' });
    } else regions.push({ x0: r.t[0], x1: r.t[r.t.length - 1], cls: 'hold', label: 'VALIDATION — NOT USED FOR FITTING' });
    plots.fit.opt.y.label = (r.cols ? r.cols.y : 'y') + (r.kind !== 'user' ? ' [°C]' : '');
    plots.fit.opt.csvHeader = [`LoopForge identification export — record: ${r.name} (${r.kind.toUpperCase()})`, r.file ? `source file: ${r.file} (dowlinglab/pyomo-doe @ d250c5b, BSD-3-Clause)` : 'source: ' + (r.desc || 'user'), 'model columns are SIMULATED from the fitted parameters'];
    plots.fit.set(series, { regions });
    // residuals
    const rs = [];
    for (const type of ['FOPDT', 'SOPDT']) {
      const v = vs.find(x => x.type === type); if (!v) continue;
      const full = r.id === S.fitRec ? S.validations.find(x => x.rec.id === r.id && x.type === type && x.role === 'holdout') : null;
      const pr = full ? full.pred : v.pred;
      rs.push({ id: 'res' + type, name: type + ' residual', x: r.t, y: Array.from(r.y, (yv, i) => yv - pr[i]), kind: 'points', r: type === S.modelType ? 1.5 : 1.1, color: type === 'SOPDT' ? 'var(--c-sopdt)' : 'var(--c-fopdt)', opacity: type === S.modelType ? 0.9 : 0.5 });
    }
    plots.res.set(rs, { regions });
    renderFitControls();
    renderValTable();
    renderNotes();
  }

  function renderFitControls() {
    const box = $('#fitControls'); box.innerHTML = '';
    const r = rec(S.fitRec);
    const g1 = h('div', { class: 'grp' }, '<span>Fit on</span>');
    const sel = h('select', { 'aria-label': 'Identification record' });
    for (const x of S.records) sel.appendChild(h('option', { value: x.id }, x.short));
    sel.value = S.fitRec;
    sel.onchange = () => { S.fitRec = sel.value; const rr = rec(S.fitRec); S.win = [rr.t[0], rr.t[rr.t.length - 1]]; S.viewRec = S.fitRec; busy(runFit); };
    g1.appendChild(sel); box.appendChild(g1);
    const g2 = h('div', { class: 'grp' }, '<span>window</span>');
    const a = h('input', { type: 'number', value: f(S.win[0], 0), step: 10, 'aria-label': 'Window start [s]' });
    const b = h('input', { type: 'number', value: f(S.win[1], 0), step: 10, 'aria-label': 'Window end [s]' });
    const apply = () => { let x0 = +a.value, x1 = +b.value; if (!(x1 > x0 + 20)) { toast('Window must span more than 20 s'); return; } x0 = Math.max(r.t[0], x0); x1 = Math.min(r.t[r.t.length - 1], x1); S.win = [x0, x1]; busy(runFit); };
    a.onchange = apply; b.onchange = apply;
    g2.append(a, h('span', {}, '–'), b, h('span', {}, 's')); box.appendChild(g2);
    const g3 = h('div', { class: 'grp' }, '<span>Use model</span>');
    g3.appendChild(seg([['FOPDT', 'FOPDT'], ['SOPDT', 'SOPDT']], S.modelType, v => { S.modelType = v; retune(); renderFit(); }, ['kc', 'ti', 'td']));
    box.appendChild(g3);
    box.appendChild(h('span', { class: 'hint' }, `AIC prefers ${S.modelAuto}`));
  }

  function cls(fit) { return fit >= 90 ? 'good' : fit >= 75 ? 'mid' : 'poor'; }
  function renderValTable() {
    const t = $('#valTable');
    const fit = S.fits[S.modelType];
    const m = fit.model, ci = m.ci95 || {};
    let html = '<thead><tr><th>Record</th><th>Role</th><th>Model</th><th>Fit %</th><th>RMSE</th><th>max |e|</th><th>Bias</th><th>y0</th></tr></thead><tbody>';
    const rows = S.validations.slice().sort((a, b) => (a.role === 'fit' ? -1 : 0) - (b.role === 'fit' ? -1 : 0));
    for (const v of rows) {
      if (v.type !== S.modelType && !S.showBoth) continue;
      html += `<tr data-rec="${v.rec.id}" class="${v.rec.id === S.viewRec ? 'cur' : ''}"><td class="name">${v.rec.short}</td><td><span class="role ${v.role === 'fit' ? 'fit' : ''}">${v.role === 'fit' ? 'FIT' : v.role === 'holdout' ? 'HOLD-OUT' : 'VALID.'}</span></td><td>${v.type}</td>`
        + `<td class="${cls(v.metrics.fitPct)}">${f(v.metrics.fitPct, 1)}</td><td>${f(v.metrics.rmse, 3)}</td><td>${f(v.metrics.maxAbs, 2)}</td><td>${f(v.metrics.bias, 2)}</td><td>${f(v.y0, 2)}</td></tr>`;
    }
    html += '</tbody>';
    t.innerHTML = html;
    t.querySelectorAll('tr[data-rec]').forEach(tr => tr.onclick = () => { S.viewRec = tr.dataset.rec; renderFit(); });
    // parameter summary as caption row
    const p = m.type === 'SOPDT' ? [['K', m.K, ci.K, 4], ['τ1', m.tau1, ci.tau1, 2], ['τ2', m.tau2, ci.tau2, 2], ['θ', m.theta, ci.theta, 2], ['y0', m.y0, ci.y0, 2]] : [['K', m.K, ci.K, 4], ['τ', m.tau1, ci.tau1, 2], ['θ', m.theta, ci.theta, 2], ['y0', m.y0, ci.y0, 2]];
    const cap = h('p', { class: 'caption', id: 'paramCap' },
      `${m.type} fitted on <b>${rec(S.fitRec).short}</b> [${f(S.win[0], 0)}, ${f(S.win[1], 0)}] s: ` + p.map(([n, v, c, d]) => `${n} = ${f(v, d)}${c !== undefined && c !== null ? ' ± ' + f(c, d) : ''}`).join(', ')
      + `. ±: approx. 95 % intervals from the Gauss–Newton Hessian — optimistic, residuals are autocorrelated (lag-1 ρ = ${f(fit.metrics.residualLag1, 2)}). AIC FOPDT ${f(S.fits.FOPDT.metrics.aic, 0)}, SOPDT ${f(S.fits.SOPDT.metrics.aic, 0)}. Validation y0 = median of first 5 samples; no parameter is refitted.`);
    const old = $('#paramCap'); if (old) old.remove();
    t.parentNode.after(cap);
  }

  function renderNotes() {
    const box = $('#fitNotes'); box.innerHTML = '';
    const notes = [];
    const vs = S.validations.filter(v => v.type === S.modelType && v.role !== 'fit');
    const fr = rec(S.fitRec);
    if (fr.kind === 'synthetic') notes.push(['warn', `<b>Synthetic data.</b> These records are generated from a known SOPDT plant (K = 0.8, τ1 = 120 s, τ2 = 15 s, θ = 6 s); they test the algorithms, not the physics.`]);
    for (const v of vs) {
      const b = v.metrics.bias;
      if (v.metrics.fitPct < 75) notes.push(['bad', `<b>${v.rec.short}:</b> model disagrees with the data — fit ${f(v.metrics.fitPct, 1)} %, mean error ${f(b, 2)}${b < 0 ? ' (measured cooler than predicted)' : ' (measured hotter than predicted)'}. ${v.rec.input && v.rec.input.startsWith('sine') ? 'This input swings 0–100 %; TCLab heat loss is nonlinear (convection + radiation), so a gain identified from one 0→50 % step does not hold across the range.' : 'Same input as the fit run: the difference is between runs (ambient, initial board temperature, device), which a single linear model cannot capture.'}`]);
      else if (v.metrics.fitPct < 90) notes.push(['warn', `<b>${v.rec.short}:</b> moderate agreement (fit ${f(v.metrics.fitPct, 1)} %, bias ${f(b, 2)}).`]);
    }
    const lag = S.fits[S.modelType].metrics.residualLag1;
    if (lag > 0.5) notes.push(['warn', `<b>Residuals are not white</b> (lag-1 autocorrelation ${f(lag, 2)}): structured model error remains even on the fitting data.`]);
    if (S.modelType === 'SOPDT') notes.push(['ok', `<b>τ2 and θ trade off:</b> SOPDT τ2 + θ = ${f(model().tau2 + model().theta, 1)} s is well determined; their split is not (see ± intervals).`]);
    for (const [c, t] of notes) box.appendChild(h('div', { class: 'note ' + c }, t));
  }

  /* ---------- closed loop ---------- */
  function renderScenario() {
    const box = $('#scenario');
    if (box.dataset.built) { box.querySelectorAll('input').forEach(i => { i.value = S.loop[i.dataset.k]; }); return; }
    box.dataset.built = 1;
    const fld = (k, label, step, tags) => { const l = h('label', {}, label); const i = h('input', { type: 'number', step, 'data-k': k, value: S.loop[k] }); i.onchange = () => { S.loop[k] = +i.value; recompute(); }; i.onfocus = () => setTags(tags || []); l.appendChild(i); box.appendChild(l); };
    fld('r1', 'Setpoint', 1); fld('tStep', 'at t', 5); fld('distDu', 'Load disturbance Δu', 5); fld('distT', 'at t', 10); fld('tEnd', 'Horizon', 50);
  }

  function renderLoop() {
    renderScenario();
    const sim = S.res.sim, Sm = sim.samples, F = sim.fine;
    const ylab = rec(S.fitRec).kind === 'user' ? 'Output' : 'Temperature [°C]';
    plots.y.opt.y.label = ylab;
    const ser = [
      { id: 'r', name: 'Setpoint r', x: Sm.t, y: Sm.r, kind: 'step', color: 'var(--c-ref)', dash: '5 4', width: 1.4, opacity: 0.8 },
      { id: 'y', name: 'Output y (' + (S.loop.arith === 'fixed' ? 'Q16.16' : 'float') + ')', x: F.t, y: F.y, color: 'var(--c-sim)', width: 2.2 },
    ];
    if (S.loop.quant > 0) ser.push({ id: 'ym', name: 'ADC reading', x: Sm.t, y: Sm.ym, kind: 'step', color: 'var(--s7)', width: 1, opacity: 0.8 });
    if (S.res.simAlt) ser.push({ id: 'yf', name: 'float reference', x: S.res.simAlt.fine.t, y: S.res.simAlt.fine.y, color: 'var(--s1)', width: 1.2, dash: '3 3' });
    const satReg = [];
    let k0 = null;
    for (let k = 0; k <= Sm.t.length; k++) {
      const on = k < Sm.t.length && Sm.sat[k] !== 0;
      if (on && k0 === null) k0 = k;
      if (!on && k0 !== null) { satReg.push({ x0: Sm.t[k0], x1: (Sm.t[k] !== undefined ? Sm.t[k] : Sm.t[k - 1] + S.loop.Ts), cls: 'sat' }); k0 = null; }
    }
    plots.y.opt.csvHeader = ['LoopForge closed-loop simulation (SIMULATED) — fitted ' + S.modelType + ' model, Ts = ' + S.loop.Ts + ' s'];
    plots.y.set(ser, { regions: satReg, vlines: [{ x: S.loop.distT, label: 'disturbance' }] });
    const user = [
      { id: 'v', name: 'Demand v (unsaturated)', x: Sm.t, y: Sm.v, kind: 'step', color: 'var(--c-v)', width: 1.2, opacity: 0.85, dash: '4 3' },
      { id: 'u', name: 'Applied u', x: Sm.t, y: Sm.u, kind: 'step', color: 'var(--c-u)', width: 2 },
    ];
    plots.u.opt.y.include = [S.loop.umin, S.loop.umax];
    plots.u.opt.y.domain = null;
    const vmin = Math.min(...Sm.v), vmax = Math.max(...Sm.v);
    const span = S.loop.umax - S.loop.umin;
    plots.u.opt.y.domain = [Math.max(vmin, S.loop.umin - 0.6 * span) - 0.05 * span, Math.min(vmax, S.loop.umax + 0.6 * span) + 0.05 * span];
    plots.u.opt.csvHeader = plots.y.opt.csvHeader;
    plots.u.set(user, { regions: satReg, hlines: [{ y: S.loop.umax, cls: 'sat', label: 'u max' }, { y: S.loop.umin, cls: 'sat', label: 'u min' }] });
    const sm = sim.summary, d = S.res.freq.discrete;
    const k = (kk, v, unit, dd, c) => `<div class="kpi ${c || ''}"><div class="k">${kk}</div><div class="v">${v}<small> ${unit}</small></div><div class="d">${dd}</div></div>`;
    let maxDu = 0;
    if (S.res.simAlt) for (let i = 0; i < Sm.u.length; i++) maxDu = Math.max(maxDu, Math.abs(Sm.u[i] - S.res.simAlt.samples.u[i]));
    $('#loopKpis').innerHTML =
      k('Overshoot', f(sm.overshoot, 1), '%', 'setpoint step', sm.overshoot > 20 ? 'poor' : sm.overshoot > 5 ? 'mid' : 'good') +
      k('Rise 90 %', f(sm.rise, 0), 's', 'after step') +
      k('Settling 2 %', isFinite(sm.settle) ? f(sm.settle, 0) : '—', 's', 'before disturbance') +
      k('IAE', f(sm.iae, 0), '°C·s', 'whole horizon') +
      k('Saturated', f(100 * sm.satFrac, 0), '%', 'of samples', sm.satFrac > 0.3 ? 'mid' : '') +
      (S.res.simAlt ? k('Q16 vs float', f(maxDu, 4), '%', 'max |Δu|', maxDu < 0.05 ? 'good' : 'mid') : k('Delay margin', f(d.delayMargin, 1), 's', 'sampled loop'));
  }

  /* ---------- frequency ---------- */
  function renderFreq() {
    const F = S.res.freq, D = F.discrete, Cn = F.continuous, A = F.analysis;
    const cut = (o, wmax) => { const n = o.w.findIndex(w => w > wmax); return n < 0 ? o.w.length : n; };
    const nc = cut(Cn, F.wNyquist * 3);
    const contMag = Cn.magDb.slice(0, nc), contPh = Cn.phaseDeg.slice(0, nc), cw = Cn.w.slice(0, nc);
    plots.mag.set([
      { id: 'cont', name: 'continuous (analogue PID, exact delay)', x: cw, y: contMag, color: 'var(--c-cont)', width: 1.4, dash: '5 3' },
      { id: 'disc', name: `sampled, Ts = ${S.loop.Ts} s (ZOH)`, x: D.w, y: D.magDb, color: 'var(--c-disc)', width: 2.2 },
    ], { vlines: [{ x: F.wNyquist, label: 'Nyquist π/Ts' }].concat(isFinite(D.wc) ? [{ x: D.wc, cls: 'wc', label: 'ωc' }] : []), hlines: [] });
    const phMin = Math.max(Math.min(...D.phaseDeg), -720);
    plots.ph.opt.y.domain = [Math.max(phMin, -720) - 10, Math.max(...D.phaseDeg.slice(0, 50), -80) + 10];
    plots.ph.set([
      { id: 'cont', name: 'continuous', x: cw, y: contPh, color: 'var(--c-cont)', width: 1.4, dash: '5 3' },
      { id: 'disc', name: 'sampled', x: D.w, y: D.phaseDeg, color: 'var(--c-disc)', width: 2.2 },
    ], { hlines: [{ y: -180, label: '−180°' }], vlines: isFinite(D.wc) ? [{ x: D.wc, cls: 'wc', label: 'PM ' + f(D.pm, 1) + '°' }] : [] });
    const k = (kk, v, unit, dd, c) => `<div class="kpi ${c || ''}"><div class="k">${kk}</div><div class="v">${v}<small> ${unit}</small></div><div class="d">${dd}</div></div>`;
    $('#marginKpis').innerHTML =
      k('Phase margin', f(D.pm, 1), '°', `cont. ${f(Cn.pm, 1)}°`, D.pm < 30 ? 'poor' : D.pm < 45 ? 'mid' : 'good') +
      k('Gain margin', f(D.gmDb, 1), 'dB', `cont. ${f(Cn.gmDb, 1)} dB`, D.gmDb < 4 ? 'poor' : D.gmDb < 6 ? 'mid' : 'good') +
      k('Ms', f(D.Ms, 2), '', 'peak |S|', D.Ms > 2 ? 'poor' : D.Ms > 1.6 ? 'mid' : 'good') +
      k('ωc', f(D.wc, 4), 'rad/s', 'gain crossover') +
      k('Delay margin', f(D.delayMargin, 1), 's', 'extra dead time');
    // Nyquist: positive and negative frequencies of the sampled loop, clipped to a sensible window
    const re = D.re, im = D.im;
    const R = Math.max(2.5, Math.min(6, 1.6 * D.Ms));
    const clip = (v) => Math.max(-R * 1.6, Math.min(R * 1.6, v));
    const ser = [
      { id: 'neg', name: 'ω < 0 (mirror)', x: re.map(clip), y: im.map(v => -clip(v)), color: 'var(--c-disc)', width: 1, opacity: 0.45, dash: '3 3', noHover: true },
      { id: 'pos', name: 'L(e^{jωTs}), ω > 0', x: re.map(clip), y: im.map(clip), param: D.w, color: 'var(--c-disc)', width: 2.2 },
      { id: 'contN', name: 'continuous', x: Cn.re.slice(0, nc).map(clip), y: Cn.im.slice(0, nc).map(clip), param: cw, color: 'var(--c-cont)', width: 1.2, dash: '5 3' },
      { id: 'bounds', x: [-R, R], y: [-R, R], kind: 'points', r: 0, color: 'transparent', noLegend: true, noHover: true, noExport: true },
    ];
    plots.nyq.set(ser, { overlays: [{ type: 'circle', cx: -1, cy: 0, r: 1 / D.Ms, cls: 'ms' }, { type: 'circle', cx: 0, cy: 0, r: 1, cls: '' }, { type: 'cross', x: -1, y: 0 }] });
    plots.nyq.opt.x.domain = [-R, R]; plots.nyq.opt.y.domain = [-R, R];
    $('#nyqCap').innerHTML = `Sampled loop L(z) = C(z)·G(z) incl. ZOH and ${A.plant.d}·Ts + ${f(A.plant.thetaFrac, 2)} s delay. Red cross: −1. Red dashed circle: distance 1/Ms = ${f(1 / D.Ms, 3)} from −1. Hover links ω to the Bode plots.`;
    // pole-zero
    const poles = A.poles, zeros = A.zeros.filter(z => LF.Cx.abs(z) < 5);
    const circ = []; for (let i = 0; i <= 180; i++) { circ.push([Math.cos(i / 90 * Math.PI), Math.sin(i / 90 * Math.PI)]); }
    plots.pz.set([
      { id: 'uc', name: 'unit circle', x: circ.map(c => c[0]), y: circ.map(c => c[1]), color: 'var(--text-3)', width: 1, noHover: true, noLegend: true },
      { id: 'zeros', name: 'open-loop zeros of L', x: zeros.map(z => z[0]), y: zeros.map(z => z[1]), param: zeros.map((_, i) => i), kind: 'points', symbol: 'o', color: 'var(--c-zero)' },
      { id: 'poles', name: 'closed-loop poles', x: poles.map(z => z[0]), y: poles.map(z => z[1]), param: poles.map((_, i) => i), kind: 'points', symbol: 'x', color: A.stable ? 'var(--c-pole)' : 'var(--bad)' },
    ]);
    const dom = poles.slice().sort((a, b) => LF.Cx.abs(b) - LF.Cx.abs(a))[0];
    const tcon = dom ? -S.loop.Ts / Math.log(LF.Cx.abs(dom)) : NaN;
    $('#pzCap').innerHTML = `${poles.length} closed-loop poles of 1 + L(z) = 0 (exact sampled model, no Padé). ${A.stable ? 'All inside the unit circle — <b style="color:var(--ok)">stable</b>' : '<b style="color:var(--bad)">Pole outside unit circle — unstable</b>'}. Slowest pole |z| = ${f(LF.Cx.abs(dom), 4)} ⇒ time constant ≈ ${f(tcon, 1)} s.`;
  }

  /* ---------- code ---------- */
  const TAGS = [['kc', 'Kc'], ['ti', 'Ti'], ['td', 'Td'], ['n', 'N'], ['b', 'b'], ['ts', 'Ts'], ['sat', 'limits'], ['aw', 'anti-windup'], ['fixed', 'fixed-point'], ['model', 'model'], ['api', 'API']];
  function setTags(tags) {
    S.activeTags = tags || [];
    if (S.activeTags.includes('fixed') && S.codeTab !== 1) { S.codeTab = 1; renderCode(); return; }
    applyHighlight(true);
  }
  function hlC(line, st) {
    let out = '', rest = line;
    const esc = x => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const tok = x => esc(x)
      .replace(/\b(\d+\.?\d*(?:e[+-]?\d+)?[fLU]*)\b/gi, '<span class="tk-n">$1</span>')
      .replace(/\b(static|inline|void|const|return|if|else|typedef|struct|while|for)\b/g, '<span class="tk-k">$1</span>')
      .replace(/\b(int32_t|int64_t|float|double|lf_real|lf_pid_t|lf_pid_q16_t|int)\b/g, '<span class="tk-t">$1</span>');
    if (st.inC) { const e = rest.indexOf('*/'); if (e < 0) return '<span class="tk-c">' + esc(rest) + '</span>'; out += '<span class="tk-c">' + esc(rest.slice(0, e + 2)) + '</span>'; rest = rest.slice(e + 2); st.inC = false; }
    if (/^\s*#/.test(rest)) {
      const ci = rest.indexOf('/*');
      const code = ci >= 0 ? rest.slice(0, ci) : rest, com = ci >= 0 ? rest.slice(ci) : '';
      out += '<span class="tk-p">' + esc(code) + '</span>' + (com ? '<span class="tk-c">' + esc(com) + '</span>' : '');
      if (com && com.indexOf('*/') < 0) st.inC = true;
      return out;
    }
    while (rest.length) {
      const ci = rest.indexOf('/*');
      if (ci < 0) { out += tok(rest); break; }
      out += tok(rest.slice(0, ci));
      const e = rest.indexOf('*/', ci + 2);
      if (e < 0) { out += '<span class="tk-c">' + esc(rest.slice(ci)) + '</span>'; st.inC = true; break; }
      out += '<span class="tk-c">' + esc(rest.slice(ci, e + 2)) + '</span>'; rest = rest.slice(e + 2);
    }
    return out;
  }
  function renderCode() {
    const files = S.res.code.files;
    const tabs = $('#codeTabs'); tabs.innerHTML = '';
    files.forEach((fl, i) => { const b = h('button', { class: i === S.codeTab ? 'on' : '', role: 'tab', 'aria-selected': i === S.codeTab }, fl.name); b.onclick = () => { S.codeTab = i; renderCode(); }; tabs.appendChild(b); });
    const tb = $('#tagbar');
    if (!tb.dataset.built) {
      tb.dataset.built = 1;
      tb.appendChild(h('span', {}, 'Highlight code for:'));
      for (const [t, l] of TAGS) { const b = h('button', { 'data-tag': t }, l); b.onclick = () => setTags(S.activeTags.length === 1 && S.activeTags[0] === t ? [] : [t]); tb.appendChild(b); }
    }
    const fl = files[S.codeTab];
    const st = { inC: false };
    $('#codeView').innerHTML = fl.lines.map((l, i) => `<span class="ln" data-i="${i}" data-tags="${l.tags.join(' ')}">${hlC(l.text, st) || ' '}</span>`).join('');
    applyHighlight(false);
  }
  function applyHighlight(scroll) {
    const tags = S.activeTags;
    document.querySelectorAll('#tagbar button').forEach(b => b.classList.toggle('on', tags.includes(b.dataset.tag)));
    let first = null;
    document.querySelectorAll('#codeView .ln').forEach(ln => {
      const lt = ln.dataset.tags ? ln.dataset.tags.split(' ') : [];
      const on = tags.length && lt.some(t => tags.includes(t));
      if (on && !ln.classList.contains('hl')) { ln.classList.remove('flash'); void ln.offsetWidth; ln.classList.add('flash'); }
      ln.classList.toggle('hl', !!on);
      if (on && !first && !ln.dataset.tags.includes('model') && !/^\s?\*/.test(ln.textContent)) first = ln;
    });
    if (scroll && first) { const w = $('.code-wrap'); const top = first.offsetTop - w.clientHeight / 3; w.scrollTo({ top: Math.max(0, top), behavior: 'smooth' }); }
  }

  /* ---------- block diagram ---------- */
  const DG = {};
  function buildDiagram() {
    const host = $('#diagram');
    const m = model(), c = ctrl();
    host.innerHTML = '';
    const W = 780, H = 250;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'diagram', role: 'img', 'aria-label': 'Block diagram of the sampled control loop' }, host);
    const defs = s('defs', {}, svg);
    const mk = s('marker', { id: 'arr', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
    s('path', { d: 'M0 0L10 5L0 10z', class: 'arrow' }, mk);
    const blk = (x, y, w, hh, ttl, sub, tiny, id, tags) => {
      const g = s('g', { class: 'blk', id: 'blk-' + id, transform: `translate(${x} ${y})`, 'data-tags': (tags || []).join(' ') }, svg);
      s('rect', { class: 'box', width: w, height: hh, rx: 8 }, g);
      const t = s('text', { class: 'ttl', x: w / 2, y: 20, 'text-anchor': 'middle' }, g); t.textContent = ttl;
      if (sub) { const t2 = s('text', { class: 'sub', x: w / 2, y: 36, 'text-anchor': 'middle' }, g); t2.textContent = sub; }
      if (tiny) { const t3 = s('text', { class: 'tiny', x: w / 2, y: 50, 'text-anchor': 'middle' }, g); t3.textContent = tiny; }
      g.addEventListener('mouseenter', () => setTags(tags));
      return g;
    };
    const wire = (d, id, extra) => s('path', { d, class: 'wire ' + (extra || ''), id: 'w-' + id, 'marker-end': 'url(#arr)' }, svg);
    const yM = 92;
    // r source
    s('circle', { cx: 28, cy: yM, r: 13, class: 'sumj' }, svg); const rt = s('text', { x: 28, y: yM + 4, 'text-anchor': 'middle', class: 'sumtxt' }, svg); rt.textContent = 'r';
    wire(`M41 ${yM}H96`, 'r');
    s('circle', { cx: 110, cy: yM, r: 13, class: 'sumj' }, svg); const sj = s('text', { x: 110, y: yM + 4, 'text-anchor': 'middle', class: 'sumtxt' }, svg); sj.textContent = 'Σ';
    const pl = s('text', { x: 98, y: yM + 26, class: 'sumtxt' }, svg); pl.textContent = '−';
    wire(`M123 ${yM}H150`, 'e');
    blk(150, yM - 30, 132, 60, `${S.tune.type} controller`, `Kc ${f(c.Kc, 2)}  Ti ${f(c.Ti, 0)}s`, c.Td > 0 ? `Td ${f(c.Td, 1)}s  N ${c.N}  b ${c.b}` : `${S.tune.manual ? 'manual' : S.tune.method}  b ${c.b}`, 'pid', ['kc', 'ti', 'td', 'n', 'b']);
    wire(`M282 ${yM}H312`, 'v');
    const sat = blk(312, yM - 30, 78, 60, 'Limit', `${f(S.loop.umin, 0)}–${f(S.loop.umax, 0)} %`, '', 'sat', ['sat', 'aw']);
    s('path', { d: 'M18 50 L30 50 L48 38 L60 38', fill: 'none', stroke: 'var(--text-3)', 'stroke-width': 1.4 }, sat);
    wire(`M390 ${yM}H418`, 'u');
    blk(418, yM - 30, 72, 60, 'DAC·ZOH', `Ts ${f(S.loop.Ts, S.loop.Ts < 1 ? 2 : 1)} s`, S.loop.arith === 'fixed' ? 'Q16.16' : 'float', 'zoh', ['ts', 'fixed']);
    wire(`M490 ${yM}H528`, 'uz');
    // disturbance
    const dt = s('text', { x: 548, y: 26, class: 'wname', 'text-anchor': 'middle' }, svg); dt.textContent = 'd (load)';
    wire(`M548 32V${yM - 14}`, 'd');
    s('circle', { cx: 548, cy: yM, r: 12, class: 'sumj' }, svg); const sj2 = s('text', { x: 548, y: yM + 4, 'text-anchor': 'middle', class: 'sumtxt' }, svg); sj2.textContent = '+';
    wire(`M560 ${yM}H596`, 'w', 'delay');
    const dl = s('text', { x: 578, y: yM + 20, class: 'tiny', 'text-anchor': 'middle', style: 'font:9.5px var(--mono);fill:var(--text-3)' }, svg); dl.textContent = `θ ${f(m.theta, 1)}s`;
    blk(596, yM - 30, 132, 60, rec(S.fitRec).kind === 'user' ? 'Plant (model)' : 'Heater + sensor', m.type === 'SOPDT' ? `K ${f(m.K, 3)} τ ${f(m.tau1, 0)}/${f(m.tau2, 1)}` : `K ${f(m.K, 3)} τ ${f(m.tau1, 0)}s`, `${m.type} · fitted model`, 'plant', ['model']);
    wire(`M728 ${yM}H766`, 'y');
    const yt = s('text', { x: 768, y: yM - 8, class: 'wname', 'text-anchor': 'end' }, svg); yt.textContent = 'y';
    // feedback
    s('path', { d: `M752 ${yM}V196H490`, class: 'wire', id: 'w-fb1', 'marker-end': 'url(#arr)' }, svg);
    blk(418, 166, 72, 60, 'ADC', `Ts ${f(S.loop.Ts, S.loop.Ts < 1 ? 2 : 1)} s`, S.loop.quant > 0 ? 'q 0.32 °C' : 'ideal', 'adc', ['ts']);
    s('path', { d: `M418 196H110V${yM + 13}`, class: 'wire', id: 'w-fb2', 'marker-end': 'url(#arr)' }, svg);
    // labels for live values
    DG.lab = {};
    const lab = (id, x, y, anchor) => { const t = s('text', { x, y, class: 'wlabel', 'text-anchor': anchor || 'middle' }, svg); DG.lab[id] = t; };
    lab('r', 68, yM - 10); lab('e', 136, yM + 30); lab('v', 297, yM - 38); lab('u', 404, yM + 44); lab('d', 600, 30, 'start'); lab('y', 752, yM + 40, 'end'); lab('ym', 300, 214); lab('t', 14, 238, 'start');
    const nm = (txt, x, y) => { const t = s('text', { x, y, class: 'wname', 'text-anchor': 'middle' }, svg); t.textContent = txt; };
    nm('e', 136, yM - 10); nm('v', 297, yM - 52); nm('u', 404, yM - 10); nm('ŷ (sampled)', 300, 188);
    const note = s('text', { x: W - 8, y: 238, class: 'dnote', 'text-anchor': 'end' }, svg);
    note.textContent = 'Each dot = one controller sample from the simulation; transit across the dashed segment takes θ (model dead time).';
    DG.pkts = s('g', {}, svg);
    DG.svg = svg;
    DG.paths = { fwd: ['w-e', 'w-v', 'w-u', 'w-uz'].map(id => svg.getElementById ? svg.querySelector('#' + id) : null), delay: svg.querySelector('#w-w'), fb: ['w-fb1', 'w-fb2'].map(id => svg.querySelector('#' + id)) };
    DG.len = {};
    for (const k of ['fwd', 'fb']) DG.len[k] = DG.paths[k].map(p => p.getTotalLength());
    DG.len.delay = DG.paths.delay.getTotalLength();
  }

  function pointOn(paths, lens, frac) {
    const total = lens.reduce((a, b) => a + b, 0);
    let d = frac * total;
    for (let i = 0; i < paths.length; i++) { if (d <= lens[i] || i === paths.length - 1) return paths[i].getPointAtLength(Math.max(0, Math.min(lens[i], d))); d -= lens[i]; }
    return { x: 0, y: 0 };
  }

  function colorFor(v, lo, hi) {
    const t = Math.max(0, Math.min(1, (v - lo) / ((hi - lo) || 1)));
    // blue → amber → red (sequential warmth of heater power)
    const a = [57, 135, 229], b = [201, 133, 0], c = [230, 103, 103];
    const mix = (p, q, w) => p.map((x, i) => Math.round(x + (q[i] - x) * w));
    const col = t < 0.5 ? mix(a, b, t * 2) : mix(b, c, (t - 0.5) * 2);
    return `rgb(${col.join(',')})`;
  }

  function drawDiagram(t) {
    if (!DG.svg) return;
    const sim = S.res.sim, Sm = sim.samples, Ts = S.loop.Ts, m = model();
    const k = Math.max(0, Math.min(Sm.t.length - 1, Math.floor(t / Ts + 1e-9)));
    const set = (id, txt) => { if (DG.lab[id]) DG.lab[id].textContent = txt; };
    const unit = rec(S.fitRec).kind === 'user' ? '' : '°C';
    set('r', `${f(Sm.r[k], 1)}${unit}`); set('e', `${f(Sm.e[k], 2)}`); set('v', `${f(Sm.v[k], 1)} %`); set('u', `${f(Sm.u[k], 1)} %`);
    set('d', `${f(Sm.dist[k], 0)} %`); set('y', `${f(Sm.y[k], 2)}${unit}`); set('ym', `${f(Sm.ym[k], 2)}${unit}`); set('t', `t = ${f(t, 1)} s · sample k = ${k}`);
    const satNow = Sm.sat[k] !== 0;
    DG.svg.querySelector('#blk-sat').classList.toggle('sat', satNow);
    ['w-u', 'w-uz'].forEach(id => { const p = DG.svg.querySelector('#' + id); p.classList.toggle('satw', satNow); p.classList.toggle('live', !satNow); });
    ['w-e', 'w-v', 'w-w', 'w-r'].forEach(id => DG.svg.querySelector('#' + id).classList.add('live'));
    // packets: each sample k emits a dot. forward path takes 0.5 Ts, delay segment takes θ, feedback 0.5 Ts.
    const g = DG.pkts; while (g.firstChild) g.removeChild(g.firstChild);
    const fwdT = 0.5 * Ts, fbT = 0.5 * Ts, dlT = Math.max(m.theta, 1e-6);
    const lookback = Math.ceil(Math.max(fwdT, dlT, fbT) / Ts) + 1;
    const pxPerSample = S.play.speed * Ts;           // samples per second of wall-clock = speed/Ts
    const every = Math.max(1, Math.ceil(S.play.speed / Ts / 12));  // at most ~12 packets per second per wire
    for (let j = Math.max(0, k - lookback * every - every); j <= k; j++) {
      if (j % every) continue;
      const tj = Sm.t[j];
      const age = t - tj;
      if (age < 0) continue;
      const cu = colorFor(Sm.u[j], S.loop.umin, S.loop.umax);
      if (age <= fwdT) { const p = pointOn(DG.paths.fwd, DG.len.fwd, age / fwdT); s('circle', { cx: p.x, cy: p.y, r: 4.5, class: 'pkt', fill: cu }, g); }
      // the plant input packet (u[j] + d) departs the ZOH at tj and crosses the delay in θ
      if (age <= dlT) { const p = DG.paths.delay.getPointAtLength(age / dlT * DG.len.delay); s('circle', { cx: p.x, cy: p.y, r: 4.5, class: 'pkt', fill: cu }, g); }
      if (age <= fbT) { const p = pointOn(DG.paths.fb, DG.len.fb, age / fbT); s('circle', { cx: p.x, cy: p.y, r: 4, class: 'pkt', fill: 'var(--c-sim)' }, g); }
    }
    void pxPerSample;
    DG.every = every;
  }

  /* ---------- TCLab-style hardware ---------- */
  const HW = {};
  function buildHW() {
    const host = $('#hw'); host.innerHTML = '';
    const r = rec(S.fitRec);
    const head = h('div', { class: 'hw-h' }, `<span>${r.kind === 'user' ? 'Process view' : 'TCLab heater &amp; sensor'}</span>`);
    const srcSeg = seg([['sim', 'Simulated'], ['meas', r.kind === 'measured' ? 'Measured log' : r.kind === 'synthetic' ? 'Synthetic log' : 'Logged data']], S.play.hwSource, v => { S.play.hwSource = v; HW.badge.className = 'badge ' + badgeCls(); HW.badge.textContent = badgeTxt(); frame(true); });
    head.appendChild(srcSeg);
    host.appendChild(head);
    const badgeCls = () => S.play.hwSource === 'sim' ? 'sim' : (r.kind === 'measured' ? 'meas' : r.kind === 'synthetic' ? 'syn' : 'user');
    const badgeTxt = () => S.play.hwSource === 'sim' ? 'SIMULATED' : r.kind === 'measured' ? 'MEASURED' : r.kind === 'synthetic' ? 'SYNTHETIC' : 'USER DATA';
    const W = 280, H = 220;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Heater and temperature sensor visual' }, host);
    const defs = s('defs', {}, svg);
    const rg = s('radialGradient', { id: 'glow' }, defs);
    s('stop', { offset: '0%', 'stop-color': '#ffb347', 'stop-opacity': '1' }, rg); s('stop', { offset: '45%', 'stop-color': '#ff6a2a', 'stop-opacity': '.55' }, rg); s('stop', { offset: '100%', 'stop-color': '#ff3b1f', 'stop-opacity': '0' }, rg);
    // board
    s('rect', { x: 8, y: 30, width: 264, height: 150, rx: 10, fill: 'var(--pcb)', stroke: 'var(--pcb-2)', 'stroke-width': 3 }, svg);
    for (let i = 0; i < 6; i++) s('path', { d: `M${20 + i * 8} 170 V${120 - i * 6} H${70 + i * 4}`, stroke: 'var(--copper)', 'stroke-width': 1.2, fill: 'none', opacity: .45 }, svg);
    for (let i = 0; i < 10; i++) s('circle', { cx: 30 + i * 22, cy: 172, r: 3, fill: 'var(--copper)', opacity: .7 }, svg);
    const t1 = s('text', { x: 20, y: 48, fill: '#cfe9dc', style: 'font:600 10px var(--mono)', opacity: .8 }, svg); t1.textContent = 'HEATER 1 · TMP36';
    // heater glow + transistor
    HW.glow = s('circle', { cx: 92, cy: 100, r: 60, fill: 'url(#glow)', opacity: 0 }, svg);
    s('rect', { x: 74, y: 70, width: 36, height: 44, rx: 3, fill: '#1b1f24', stroke: '#3a434d' }, svg);
    s('rect', { x: 78, y: 62, width: 28, height: 10, rx: 2, fill: '#9aa3ad' }, svg);
    s('circle', { cx: 92, cy: 67, r: 2.5, fill: '#6b737c' }, svg);
    for (let i = 0; i < 3; i++) s('rect', { x: 80 + i * 10, y: 114, width: 4, height: 16, fill: '#b9c0c7' }, svg);
    const hl = s('text', { x: 92, y: 96, 'text-anchor': 'middle', fill: '#8e98a3', style: 'font:8px var(--mono)' }, svg); hl.textContent = 'Q1';
    // heat waves (amplitude ∝ u)
    HW.waves = [0, 1, 2].map(i => s('path', { fill: 'none', stroke: '#ff9a4a', 'stroke-width': 1.6, opacity: 0, 'stroke-linecap': 'round' }, svg));
    // sensor
    s('path', { d: 'M118 92 H150', stroke: '#9aa3ad', 'stroke-width': 2 }, svg);
    s('path', { d: 'M150 84 h12 a6 6 0 0 1 0 16 h-12 z', fill: '#1b1f24', stroke: '#3a434d' }, svg);
    // thermometer bar
    s('rect', { x: 236, y: 46, width: 16, height: 116, rx: 8, fill: '#0b1e17', stroke: '#2d6e55' }, svg);
    HW.bar = s('rect', { x: 239, y: 150, width: 10, height: 10, rx: 5, fill: 'var(--s2)' }, svg);
    HW.barSp = s('path', { d: '', stroke: 'var(--c-ref)', 'stroke-width': 2 }, svg);
    // readouts
    s('rect', { x: 176, y: 62, width: 52, height: 30, rx: 4, fill: '#071410', stroke: '#2d6e55' }, svg);
    HW.tTxt = s('text', { x: 202, y: 83, 'text-anchor': 'middle', fill: '#5ef0b4', style: 'font:600 14px var(--mono)' }, svg);
    const tl = s('text', { x: 202, y: 104, 'text-anchor': 'middle', fill: '#cfe9dc', style: 'font:9px var(--mono)', opacity: .7 }, svg); tl.textContent = 'T1 °C';
    s('rect', { x: 176, y: 112, width: 52, height: 30, rx: 4, fill: '#071410', stroke: '#2d6e55' }, svg);
    HW.uTxt = s('text', { x: 202, y: 133, 'text-anchor': 'middle', fill: '#ffb066', style: 'font:600 14px var(--mono)' }, svg);
    const ul = s('text', { x: 202, y: 154, 'text-anchor': 'middle', fill: '#cfe9dc', style: 'font:9px var(--mono)', opacity: .7 }, svg); ul.textContent = 'Q1 %';
    // LED
    HW.led = s('circle', { cx: 252, cy: 38, r: 4, fill: '#ff3b1f', opacity: .2 }, svg);
    HW.tAx = s('text', { x: 20, y: 205, fill: 'var(--text-3)', style: 'font:10px var(--mono)' }, svg);
    const foot = h('div', { class: 'hw-note' });
    HW.badge = h('span', { class: 'badge ' + badgeCls() }, badgeTxt());
    const p1 = h('div', {}, ''); p1.append(HW.badge, document.createTextNode(' Glow, LED and heat waves scale with heater power Q1; the bar and display show T1 at the playback time. Board artwork is illustrative; values are not.'));
    HW.stats = h('div', { class: 'hw-stats' });
    foot.append(p1, HW.stats);
    host.appendChild(foot);
    HW.svg = svg;
    const all = r.y.concat ? r.y : Array.from(r.y);
    HW.tMin = Math.min(...all, S.res.sim.samples.y[0]) - 2; HW.tMax = Math.max(...all, ...S.res.sim.fine.y, S.loop.r1) + 3;
  }

  function drawHW(t) {
    if (!HW.svg) return;
    const r = rec(S.fitRec);
    let T, U, SP = null, src;
    if (S.play.hwSource === 'sim') {
      const Sm = S.res.sim.samples, k = Math.max(0, Math.min(Sm.t.length - 1, Math.floor(t / S.loop.Ts + 1e-9)));
      const F = S.res.sim.fine; let i = 0; { let lo = 0, hi = F.t.length - 1; while (hi - lo > 1) { const mm = (lo + hi) >> 1; if (F.t[mm] <= t) lo = mm; else hi = mm; } i = lo; }
      T = F.y[i]; U = Sm.u[k]; SP = Sm.r[k]; src = 'sim';
    } else {
      const tt = r.t[0] + Math.min(t, r.t[r.t.length - 1] - r.t[0]);
      let lo = 0, hi = r.t.length - 1; while (hi - lo > 1) { const mm = (lo + hi) >> 1; if (r.t[mm] <= tt) lo = mm; else hi = mm; }
      T = r.y[lo]; U = r.u[lo]; src = 'log';
    }
    const p = Math.max(0, Math.min(1, U / 100));
    HW.glow.setAttribute('opacity', (0.1 + 0.9 * p).toFixed(3));
    HW.glow.setAttribute('r', (30 + 40 * p).toFixed(1));
    HW.led.setAttribute('opacity', (0.15 + 0.85 * p).toFixed(2));
    const ph = (performance.now() / 1000) * (0.6 + 1.6 * p);
    HW.waves.forEach((w, i) => {
      const yb = 56 - i * 9 - ((ph * 12) % 9);
      const amp = 2 + 4 * p;
      let d = `M76 ${yb.toFixed(1)}`;
      for (let x = 0; x <= 32; x += 4) d += ` L${76 + x} ${(yb + Math.sin(x / 5 + ph * 3 + i) * amp).toFixed(1)}`;
      w.setAttribute('d', d); w.setAttribute('opacity', (p * (0.9 - i * 0.25)).toFixed(2));
    });
    HW.tTxt.textContent = f(T, 1); HW.uTxt.textContent = f(U, 0);
    const fr = v => Math.max(0, Math.min(1, (v - HW.tMin) / (HW.tMax - HW.tMin)));
    const hh = 6 + 104 * fr(T);
    HW.bar.setAttribute('y', (156 - hh).toFixed(1)); HW.bar.setAttribute('height', hh.toFixed(1));
    HW.bar.setAttribute('fill', colorFor(T, HW.tMin, HW.tMax));
    HW.barSp.setAttribute('d', SP !== null ? `M232 ${(156 - 6 - 104 * fr(SP)).toFixed(1)} h24` : '');
    HW.tAx.textContent = `${src === 'sim' ? 'simulated' : 'logged'} · t = ${f(t, 0)} s${SP !== null ? ` · setpoint ${f(SP, 1)} °C` : ''}`;
    if (HW.stats) HW.stats.innerHTML = `<div class="hw-row"><span>Heater power</span><div class="hw-meter"><i style="width:${(100 * p).toFixed(1)}%"></i></div><b>${f(U, 1)} %</b></div>`
      + `<div class="hw-row"><span>Temperature</span><div class="hw-meter t"><i style="width:${(100 * fr(T)).toFixed(1)}%"></i></div><b>${f(T, 2)} °C</b></div>`
      + `<div class="hw-row"><span>Source</span><div></div><b>${src === 'sim' ? 'closed-loop sim' : r.short}</b></div>`;
  }

  /* ---------- readouts ---------- */
  function drawReadouts(t) {
    const Sm = S.res.sim.samples, k = Math.max(0, Math.min(Sm.t.length - 1, Math.floor(t / S.loop.Ts + 1e-9)));
    const ro = (kk, v, unit, c) => `<div class="ro ${c || ''}"><div class="k">${kk}</div><div class="v">${v}<small> ${unit}</small></div></div>`;
    const sat = Sm.sat[k] !== 0;
    $('#readouts').innerHTML = ro('setpoint r', f(Sm.r[k], 1), '') + ro('output y', f(Sm.y[k], 2), '') + ro('error e', f(Sm.e[k], 2), '') +
      ro('P + I + D', `${f(Sm.p[k], 0)}/${f(Sm.i[k], 0)}/${f(Sm.d[k], 0)}`, '') + ro('demand v', f(Sm.v[k], 1), '%', sat ? 'sat' : '') + ro(sat ? 'u · SATURATED' : 'actuator u', f(Sm.u[k], 1), '%', sat ? 'sat' : '');
  }

  /* ================================================================== */
  /* Playback                                                           */
  /* ================================================================== */
  let lastTs = null;
  function frame(force) {
    if (!S.ready) return;
    const tEnd = S.loop.tEnd;
    if (S.play.t > tEnd) S.play.t = 0;
    drawDiagram(S.play.t); drawHW(S.play.t); drawReadouts(S.play.t);
    plots.y.cursor(S.play.t); plots.u.cursor(S.play.t);
    const r = rec(S.viewRec);
    if (S.play.hwSource === 'meas' || force) plots.fit.cursor(r.t[0] + Math.min(S.play.t, r.t[r.t.length - 1] - r.t[0]));
    const sc = $('#scrub'); sc.value = Math.round(1000 * S.play.t / tEnd); sc.style.setProperty('--p', (100 * S.play.t / tEnd).toFixed(1) + '%');
    $('#ptime').textContent = `t = ${f(S.play.t, 0)} s`;
  }
  function loop(ts) {
    if (lastTs !== null && S.play.playing && S.ready) {
      const dt = Math.min(0.1, (ts - lastTs) / 1000);
      S.play.t += dt * S.play.speed;
      if (S.play.t > S.loop.tEnd) S.play.t = 0;
      frame();
    } else if (S.ready && S.play.hwSource) drawHW(S.play.t);
    lastTs = ts;
    requestAnimationFrame(loop);
  }
  function setPlaying(p) {
    S.play.playing = p;
    $('#playBtn').innerHTML = p ? '<svg viewBox="0 0 20 20"><path d="M7 4v12M13 4v12"/></svg>' : '<svg viewBox="0 0 20 20"><path d="M6 4l10 6-10 6z" style="fill:currentColor;stroke:none"/></svg>';
  }

  /* ================================================================== */
  /* Import                                                             */
  /* ================================================================== */
  function importText(text, name) {
    let c;
    try { c = LF.parseCSV(text); } catch (e) { toast('Could not read CSV: ' + e.message); return; }
    if (c.rows < 20) { toast('Need at least 20 numeric rows'); return; }
    const g = LF.guessColumns(c.headers);
    const panel = h('div', { class: 'import-panel' });
    panel.innerHTML = `<b>Import “${name.replace(/</g, '')}”</b> · ${c.rows} rows${c.skipped ? `, ${c.skipped} non-numeric rows skipped` : ''}.`;
    const mk = (lab, def) => { const l = h('label', {}, lab + ' '); const sel = h('select'); for (const hd of c.headers) sel.appendChild(h('option', { value: hd }, hd)); sel.value = def || c.headers[0]; l.appendChild(sel); panel.appendChild(l); return sel; };
    const st = mk('time', g.t), su = mk('input u', g.u || c.headers[1]), sy = mk('output y', g.y || c.headers[2]);
    const lp = h('label', {}, 'u before t0 '); const up = h('input', { type: 'number', step: 'any', value: 0 }); lp.appendChild(up); panel.appendChild(lp);
    const go = h('button', { class: 'btn sm primary' }, 'Fit this data'); const cancel = h('button', { class: 'btn sm' }, 'Cancel');
    panel.append(go, cancel, h('span', { class: 'hint' }, 'Input assumed held (ZOH) between samples. First 70 % is used for fitting, the rest is held out for validation.'));
    const host = $('#ident'); host.insertBefore(panel, $('#recTabs'));
    document.querySelector('#ident').scrollIntoView({ behavior: 'smooth' });
    cancel.onclick = () => panel.remove();
    go.onclick = () => {
      const t = c.cols[st.value], u = c.cols[su.value], y = c.cols[sy.value];
      for (let i = 1; i < t.length; i++) if (!(t[i] > t[i - 1])) { toast('Time column must be strictly increasing'); return; }
      const r = { id: 'user1', name: name, short: name.replace(/\.(csv|txt)$/i, '').slice(0, 24), kind: 'user', input: 'user', t, u, y, uPre: +up.value || 0, cols: { t: st.value, u: su.value, y: sy.value }, desc: 'Imported by the user; provenance unknown to LoopForge.' };
      panel.remove();
      const opt = $('#datasetSel').querySelector('option[value=user]'); opt.disabled = false; opt.textContent = 'Imported: ' + r.short;
      S.userRecords = [r];
      S.tuneTouched = false;
      busy(() => setDataset('user', [r]));
    };
  }

  /* ================================================================== */
  /* Guided demo                                                        */
  /* ================================================================== */
  const TOUR = [
    { sel: '#stages', title: 'Real data, already loaded', text: 'LoopForge opened a measured TCLab step test (heater 0→50 %, 900 s, ~1 s sampling) and ran the whole pipeline: model fit, tuning, sampled-loop analysis and C generation. Each card summarises one stage.', act: () => { if (S.dataset !== 'tclab') setDataset('tclab'); } },
    { sel: '#ident', title: 'Fit on one run, validate on others', text: 'FOPDT and SOPDT are fitted to run 1 only. Runs 2–3 and three sine tests are never used for fitting — the table scores the model on them without refitting. Click a record to see it.', act: () => { S.viewRec = S.records[0].id; renderFit(); } },
    { sel: '#ident', title: 'Where the model disagrees', text: 'Run 3 heats ~2 °C less than run 1 with the same input, and the sine tests swing the heater 0–100 %, exposing the nonlinear heat loss. A single linear model cannot match them; the notes say so instead of hiding it.', act: () => { const v = S.records.find(r => r.input && r.input.startsWith('sine')); if (v) { S.viewRec = v.id; renderFit(); } } },
    { sel: '#console', title: 'Tune with SIMC or lambda', text: 'The rule maps the model to Kc, Ti, Td. Move τc/λ to trade speed for robustness; everything — loop response, Bode, Nyquist, poles and C code — updates together.', act: () => { S.tune.method = 'SIMC'; S.tune.type = 'PID'; S.tune.manual = false; retune(); setTags(['kc', 'ti', 'td']); } },
    { sel: '#loop', title: 'Saturation and windup', text: 'The heater is limited to 0–100 %. With anti-windup off, the integrator keeps charging while the heater is pinned at 100 %, causing a large overshoot. Watch the dashed demand v leave the limits.', act: () => { S.loop.aw = 'none'; $('#awSel').value = 'none'; recompute(); setTags(['aw']); S.play.t = 0; } },
    { sel: '#loop', title: 'Back-calculation fixes it', text: 'Back-calculation bleeds the integrator by (u − v)·Ts/Tt whenever the output is clipped. Overshoot drops; the generated code contains exactly that line (highlighted).', act: () => { S.loop.aw = 'backcalc'; $('#awSel').value = 'backcalc'; recompute(); setTags(['aw']); S.play.t = 0; } },
    { sel: '#bode', title: 'Sample rate costs phase', text: 'The solid curve is the sampled loop (ZOH + discrete PID); dashed is the analogue ideal. At Ts = 8 s the ZOH adds ≈ ωTs/2 of lag at crossover and the margins shrink.', act: () => { S.loop.Ts = 8; recompute(); setTags(['ts']); } },
    { sel: '#pz', title: 'Poles of the real sampled loop', text: 'Closed-loop poles come from 1 + C(z)G(z) = 0 with the dead time as exact z-delays (no Padé). Verified against python-control to 1e-6.', act: () => { S.loop.Ts = 1; recompute(); } },
    { sel: '#code', title: 'Microcontroller-ready C', text: 'Header-only float and Q16.16 fixed-point controllers. Lines tied to the setting you touch are highlighted. Both are compiled with gcc/clang -Wall -Werror in the test suite and checked bit-exactly against this page’s simulation.', act: () => { S.loop.arith = 'fixed'; S.codeTab = 1; recompute(); setTags(['fixed']); } },
    { sel: '#room', title: 'Control room', text: 'Every dot on the diagram is one controller sample from the simulation; the heater visual can replay the simulated loop or the measured log. Use Import CSV to run your own step test.', act: () => { S.loop.arith = 'float'; S.codeTab = 0; recompute(); setTags([]); S.play.t = 0; setPlaying(true); } },
  ];
  let tourI = -1;
  function tourShow(i) {
    tourI = i;
    const st = TOUR[i];
    $('#tour').hidden = false;
    st.act && st.act();
    const target = $(st.sel);
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => placeTour(target), 420);
    $('#tourStep').textContent = `STEP ${i + 1} / ${TOUR.length}`;
    $('#tourTitle').textContent = st.title; $('#tourText').textContent = st.text;
    $('#tourPrev').disabled = i === 0; $('#tourNext').textContent = i === TOUR.length - 1 ? 'Finish' : 'Next';
  }
  function placeTour(target) {
    if (tourI < 0) return;
    const r = target.getBoundingClientRect();
    const spot = $('#tourSpot'); const pad = 6;
    const top = Math.max(4, r.top - pad), bottom = Math.min(innerHeight - 4, r.bottom + pad);
    Object.assign(spot.style, { left: (r.left - pad) + 'px', top: top + 'px', width: (r.width + 2 * pad) + 'px', height: Math.max(40, bottom - top) + 'px' });
    const card = $('#tourCard'); const cw = card.offsetWidth, ch = card.offsetHeight;
    let x = Math.min(innerWidth - cw - 12, Math.max(12, r.left + 12)), y = bottom + 12;
    if (y + ch > innerHeight - 8) y = Math.max(8, top - ch - 12);
    if (y < 8 || innerWidth < 700) { y = innerHeight - ch - 12; x = (innerWidth - cw) / 2; }
    card.style.left = x + 'px'; card.style.top = y + 'px';
  }
  function tourEnd() { tourI = -1; $('#tour').hidden = true; }

  /* ================================================================== */
  /* Misc UI                                                            */
  /* ================================================================== */
  let toastT = null;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); }
  function busy(fn) { document.body.style.cursor = 'progress'; setTimeout(() => { try { fn(); } finally { document.body.style.cursor = ''; } }, 20); }

  function renderFoot() {
    const r = rec(S.fitRec);
    $('#foot').innerHTML = `<div>${r.kind === 'measured' ? `Measured data: <a href="https://github.com/dowlinglab/pyomo-doe/tree/d250c5b0625afb35007c075df1e0f7125e74017d/data" rel="noopener">dowlinglab/pyomo-doe</a> (TCLab, Notre Dame), © 2024 Alexander Dowling, BSD-3-Clause.` : r.kind === 'synthetic' ? 'Synthetic data generated in-page from a known SOPDT model (labelled SYNTHETIC everywhere).' : 'User-imported data.'} Model, loop and code are calculated in this page; nothing is sent anywhere.</div><div>Verified against python-control 0.10.2 (109 checks) · C compiled with gcc &amp; clang, -Wall -Wextra -Werror · <a href="#" id="aboutLink">method, limitations &amp; licences</a></div>`;
    $('#aboutLink').onclick = e => { e.preventDefault(); openAbout(); };
  }

  function openAbout() {
    const lic = DATA.license.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    $('#aboutBody').innerHTML = `<h2 style="margin:0 0 4px">LoopForge</h2><p>Step-test CSV → FOPDT/SOPDT model → SIMC / lambda PI-PID → sampled closed-loop analysis → C code. Everything runs locally in this file.</p>
<h3>Method</h3><ul>
<li><b>Identification</b>: exact ZOH simulation of K·e<sup>−θs</sup>/((τ1s+1)(τ2s+1)); K and y0 by linear least squares inside a Nelder–Mead search over (τ1, τ2, θ) started from a grid.</li>
<li><b>Fit quality</b>: NRMSE fit % = 100(1 − ‖y − ŷ‖/‖y − ȳ‖), RMSE, max error, bias, AIC, residual autocorrelation, approximate 95 % parameter intervals.</li>
<li><b>Tuning</b>: SIMC (Skogestad 2003; half rule; improved SIMC τD = θ/3 for FOPDT, Grimholt &amp; Skogestad 2018) and lambda/IMC (Rivera, Morari &amp; Skogestad 1986). Gains are shown in ideal (ISA) form.</li>
<li><b>Controller</b>: u = Kc[b·r − y + (1/Ti)∫e − Td·dy_f/dt], forward-Euler integral, backward-difference derivative filtered with Tf = Td/N, back-calculation (Tt = √(Ti·Td) or Ti) or clamping anti-windup.</li>
<li><b>Loop analysis</b>: plant sampled exactly with ZOH, dead time split into d·Ts + fractional part (modified z-transform); margins, Ms, Nyquist and poles of the sampled loop. The dashed curves show the analogue loop with exact delay for comparison.</li>
<li><b>Fixed point</b>: Q16.16 signals, Q32.32 integrator, per-coefficient scaling; the page simulates the identical integer arithmetic.</li></ul>
<h3>Limitations</h3><ul><li>Linear time-invariant models fitted to one operating point; TCLab heat loss is nonlinear and run-to-run variation is several °C (see validation table).</li><li>Margins describe the model, not the hardware. Validate on the real plant with conservative settings first.</li><li>Sensor noise is not simulated; the optional ADC quantisation (0.322 °C, inferred from the data's step size) is.</li><li>Approximate confidence intervals ignore residual autocorrelation and are optimistic.</li></ul>
<h3>Data</h3><p>Six measured TCLab experiments (step 0→50 % runs 1–3, sine tests) from <a href="https://github.com/dowlinglab/pyomo-doe">dowlinglab/pyomo-doe</a> at commit d250c5b, fetched 2026-11-05. The APMonitor page suggested as a starting point (apmonitor.com/pdc/index.php/Main/TCLabFOPDT) was not reachable from the build environment (network policy), so its data files were not used.</p>
<h3>Licence of embedded data</h3><pre>${lic}</pre><p>LoopForge code: MIT. No third-party libraries are bundled.</p>`;
    $('#about').showModal();
  }

  function initTheme() {
    const saved = store.get('theme');
    const th = saved || 'dark';
    document.documentElement.setAttribute('data-theme', th);
    $('#themeBtn').onclick = () => {
      const n = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', n); store.set('theme', n);
      Object.values(plots).forEach(p => p.render()); buildDiagram(); buildHW(); frame(true);
    };
  }

  function wire() {
    $('#datasetSel').onchange = e => { const v = e.target.value; S.tuneTouched = false; busy(() => setDataset(v, v === 'user' ? S.userRecords : null)); };
    $('#importBtn').onclick = () => $('#fileInput').click();
    $('#fileInput').onchange = e => { const fl = e.target.files[0]; if (!fl) return; fl.text().then(t => importText(t, fl.name)); e.target.value = ''; };
    let dragN = 0;
    addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragN++; $('#drop').hidden = false; e.preventDefault(); } });
    addEventListener('dragover', e => e.preventDefault());
    addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; $('#drop').hidden = true; } });
    addEventListener('drop', e => { e.preventDefault(); dragN = 0; $('#drop').hidden = true; const fl = e.dataTransfer.files[0]; if (fl) fl.text().then(t => importText(t, fl.name)); });
    $('#demoBtn').onclick = () => tourShow(0);
    $('#tourNext').onclick = () => (tourI < TOUR.length - 1 ? tourShow(tourI + 1) : tourEnd());
    $('#tourPrev').onclick = () => tourI > 0 && tourShow(tourI - 1);
    $('#tourExit').onclick = tourEnd;
    addEventListener('keydown', e => { if (tourI < 0) return; if (e.key === 'ArrowRight') $('#tourNext').click(); else if (e.key === 'ArrowLeft') $('#tourPrev').click(); else if (e.key === 'Escape') tourEnd(); });
    addEventListener('resize', () => { if (tourI >= 0) placeTour($(TOUR[tourI].sel)); });
    addEventListener('scroll', () => { if (tourI >= 0) placeTour($(TOUR[tourI].sel)); }, { passive: true });
    $('#aboutBtn').onclick = openAbout;
    $('#playBtn').onclick = () => setPlaying(!S.play.playing);
    $('#stepBack').onclick = () => { setPlaying(false); S.play.t = Math.max(0, (Math.round(S.play.t / S.loop.Ts) - 1) * S.loop.Ts); frame(true); };
    $('#stepFwd').onclick = () => { setPlaying(false); S.play.t = Math.min(S.loop.tEnd, (Math.round(S.play.t / S.loop.Ts) + 1) * S.loop.Ts); frame(true); };
    $('#scrub').oninput = e => { setPlaying(false); S.play.t = +e.target.value / 1000 * S.loop.tEnd; frame(true); };
    $('#speedSel').onchange = e => { S.play.speed = +e.target.value; };
    $('#copyBtn').onclick = () => { const t = S.res.code.files[S.codeTab].text; (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Copied ' + S.res.code.files[S.codeTab].name), () => toast('Clipboard not available')); };
    $('#dlBtn').onclick = () => { const fl = S.res.code.files[S.codeTab]; download(fl.name, fl.text, 'text/x-c'); };
    $('#dlAllBtn').onclick = () => S.res.code.files.forEach((fl, i) => setTimeout(() => download(fl.name, fl.text, 'text/x-c'), i * 300));
    // time hover in loop plots also moves the diagram when paused
    P.Hub.on('tLoop', v => { if (!S.play.playing && v !== null && v !== undefined) { S.play.t = Math.max(0, Math.min(S.loop.tEnd, v)); frame(true); } });
  }

  /* ================================================================== */
  /* Boot                                                               */
  /* ================================================================== */
  function boot() {
    initTheme(); initPlots(); wire(); setPlaying(true);
    const sp = new URLSearchParams(location.search);
    if (sp.get('speed')) { S.play.speed = +sp.get('speed'); $('#speedSel').value = sp.get('speed'); }
    if (sp.get('t')) { S.play.t = +sp.get('t'); setPlaying(false); }
    setDataset(sp.get('dataset') === 'synthetic' ? 'synthetic' : 'tclab');
    requestAnimationFrame(loop);
    if (sp.get('demo') !== null) setTimeout(() => tourShow(+sp.get('demo') || 0), 600);
    window.LoopForgeApp = { S, plots, setTags, tourShow, tourEnd, setPlaying, frame, recompute, retune, importText };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
