/* CANProof application controller. Every number shown is computed from the
 * loaded DBC / trace by CANProof core (src/core.js); nothing is hard-coded. */
(function () {
  'use strict';
  const C = window.CANProof; const CH = window.CANProofCharts; const DATA = window.CANPROOF_DATA || { examples: [] };
  const $ = (s) => document.querySelector(s); const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const hex = (m) => '0x' + m.id.toString(16).toUpperCase().padStart(m.extended ? 8 : 3, '0');
  const ms = (ns, d = 3) => (Number.isFinite(ns) ? (ns / 1e6).toFixed(d) : '∞');
  const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
  const LABELS = { measured: 'measured', synthetic: 'synthetic', simulated: 'simulated', illustrative: 'illustrative', calculated: 'calculated', published: 'calculated' };
  const chip = (label, text) => `<span class="chip ${LABELS[label] || label}">${esc(text || label)}</span>`;

  // Built-in published example: Davis, Burns, Bril, Lukkien (2007), Sect. 3.
  const DAVIS_EXAMPLE = {
    id: 'davis2007', title: 'Published example — Davis et al. 2007 (3 messages, 125 kbit/s)', label: 'published', bitrate: 125000,
    set: [
      { key: 'A', name: 'A', id: 1, extended: false, dlc: 8, Cbits: 125, Tms: 2.5, Dms: 2.5, Jms: 0, sender: 'Node1', source: { T: 'paper', D: 'paper', J: 'paper' } },
      { key: 'B', name: 'B', id: 2, extended: false, dlc: 8, Cbits: 125, Tms: 3.5, Dms: 3.25, Jms: 0, sender: 'Node2', source: { T: 'paper', D: 'paper', J: 'paper' } },
      { key: 'C', name: 'C', id: 3, extended: false, dlc: 8, Cbits: 125, Tms: 3.5, Dms: 3.25, Jms: 0, sender: 'Node3', source: { T: 'paper', D: 'paper', J: 'paper' } },
    ],
    description: 'Motivating example from Davis, Burns, Bril & Lukkien, Real-Time Systems 35(3), 2007: each frame takes C = 1 ms (125 bits at 125 kbit/s). The original analysis reports R_C = 3.0 ms (schedulable); the revised analysis finds R_C = 3.5 ms > D = 3.25 ms. Switch "Analysis" to the original method to see the optimistic result.',
  };

  const S = {
    ex: null, dbc: null, baseSet: [], edits: {}, bitrate: 500000, method: 'davis',
    trace: null, traceLabel: null, traceMeta: null, meas: null,
    stress: { on: false, load: 1, jit: 1, bg: 0 },
    analysis: null, davis: null, sim: null, findings: [], cmp: null,
    playhead: 0, playing: true, speed: 0.01, source: 'sim', windowNs: 20e6,
    selectedKey: null, selectedFrame: null, hoverKey: null, filter: 'all', sort: null, cmpJ: 'J0',
  };
  let timeline, car;

  /* ---------------- helpers ---------------- */
  function toast(msg) { const t = $('#toast'); t.innerHTML = msg; t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 3200); }
  const tipEl = () => $('#tip');
  function tip(html, x, y) { const t = tipEl(); if (!html) { t.classList.remove('on'); return; } t.innerHTML = html; t.classList.add('on'); tipMove(x, y); }
  function tipMove(x, y) { const t = tipEl(); const w = t.offsetWidth, h = t.offsetHeight; t.style.left = Math.min(window.innerWidth - w - 8, x + 14) + 'px'; t.style.top = Math.min(window.innerHeight - h - 8, y + 14) + 'px'; }
  function download(name, data, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function csv(rows) { return rows.map((r) => r.map((v) => (v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v)).join(',')).join('\n') + '\n'; }

  /* ---------------- data loading ---------------- */
  function examples() { return [...(DATA.examples || []), DAVIS_EXAMPLE]; }
  function loadExample(ex) {
    S.ex = ex; S.edits = {}; S.selectedKey = null; closeDrawer();
    S.dbc = ex.dbc ? C.parseDBC(ex.dbc) : null;
    S.bitrate = ex.bitrate || (ex.summary && ex.summary.bitrate) || 500000;
    $('#bitrate').value = String(S.bitrate);
    if (S.dbc) S.baseSet = C.messageSetFromDBC(S.dbc);
    else if (ex.set) S.baseSet = ex.set.map((m) => Object.assign({}, m));
    S.trace = null; S.meas = null; S.traceLabel = null;
    if (ex.summary && ex.summary.excerpt) {
      S.trace = ex.summary.excerpt.map(([t, id, x, h]) => ({ t, id, extended: !!x, dlc: h.length / 2, data: hexToBytes(h) }));
      S.traceLabel = ex.label; S.traceMeta = ex.summary.provenance;
      S.meas = C.measureTrace(S.trace);
      if (!S.dbc && !ex.set) S.baseSet = C.messageSetFromTrace(S.meas);
    }
    S.source = 'sim'; $('#pSource').value = 'sim';
    S.playhead = 0;
    setNodes();
    recompute();
    renderBanner(); renderFooter();
  }
  function hexToBytes(h) { const b = new Uint8Array(h.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; }

  function setNodes() {
    const counts = new Map();
    for (const m of S.baseSet) { const s = m.sender && m.sender !== 'Vector__XXX' ? m.sender : 'Unattributed'; counts.set(s, (counts.get(s) || 0) + 1); }
    car && car.setNodes([...counts.entries()].map(([name, count]) => ({ name, count })));
  }

  /* ---------------- model ---------------- */
  function effectiveSet() {
    const st = S.stress;
    const out = S.baseSet.map((m) => {
      const e = S.edits[m.key] || {};
      const n = Object.assign({}, m, e);
      n.source = Object.assign({}, m.source);
      if (e.Tms != null) n.source.T = 'edited'; if (e.Dms != null) n.source.D = 'edited'; if (e.Jms != null) n.source.J = 'edited';
      if (st.on) {
        const implicitD = /assumed/.test(m.source && m.source.D || '') && e.Dms == null;
        n.Tms = n.Tms / st.load; if (implicitD) n.Dms = n.Tms;
        n.Jms = (n.Jms || 0) * st.jit;
      }
      return n;
    });
    if (S.stress.on && S.stress.bg > 0) {
      // background flood: one highest-priority 8-byte message with the requested utilisation (worst-case length)
      const Cns = C.worstCaseFrameBits(8, false) * 1e9 / S.bitrate;
      const Tms = Cns / (S.stress.bg / 100) / 1e6;
      out.push({ key: 'bg', id: 0, extended: false, name: 'STRESS_Background', sender: 'Unattributed', dlc: 8, Tms, Dms: Tms, Jms: 0, source: { T: 'stress', D: 'stress', J: 'stress' }, synthetic: true });
    }
    return out;
  }
  function recompute() {
    const set = effectiveSet();
    const t0 = performance.now();
    S.analysis = C.analyse(set, { bitrate: S.bitrate, method: S.method });
    S.davis = S.method === 'davis' ? S.analysis : C.analyse(set, { bitrate: S.bitrate, method: 'davis' });
    S.set = set;
    S.findings = [];
    if (S.dbc) S.findings.push(...C.checkLayout(S.dbc).map((f) => Object.assign(f, { key: keyByName(f.msg) })));
    const missingT = S.baseSet.filter((m) => !(m.Tms > 0));
    missingT.forEach((m) => S.findings.push({ severity: 'warning', code: 'NO_CYCLE', key: m.key, msg: m.name, text: `${m.name}: no cycle time (GenMsgCycleTime) — excluded from timing analysis` }));
    S.findings.push(...C.checkPriorities(set, S.davis, {}));
    // simulation for the timeline (synchronous release at t=0 approximates the critical instant)
    const maxT = Math.max(...set.filter((m) => m.Tms > 0).map((m) => m.Tms), 1);
    const dur = Math.min(1000, Math.max(100, 2 * Math.min(maxT, 250))) * 1e6;
    S.sim = C.simulate(set, { bitrate: S.bitrate, duration: dur, jitterMode: 'random', seed: 11 });
    S.sim.duration = dur;
    S.simFrames = S.sim.frames.map((f) => Object.assign(f, { name: (set.find((m) => m.key === f.key) || {}).name }));
    // trace comparison (model with J=0 and J=measured)
    if (S.meas) {
      const byKey = new Map(S.meas.ids.map((x) => [x.key, x]));
      const mk = (useJ) => set.filter((m) => m.key !== 'bg').map((m) => Object.assign({}, m, { Jms: useJ ? ((byKey.get(m.key) || {}).jitterSpread || 0) * 1000 : 0 }));
      const a0 = C.analyse(mk(false), { bitrate: S.bitrate, method: 'davis' });
      const aJ = C.analyse(mk(true), { bitrate: S.bitrate, method: 'davis' });
      S.cmp = { J0: C.compareTraceToModel(S.meas, a0, S.bitrate), Jm: C.compareTraceToModel(S.meas, aJ, S.bitrate) };
      S.loadSeries = C.loadTimeline(S.trace, S.bitrate, 0.1).map((x) => x.load);
      S.traceFrames = buildTraceFrames();
    } else { S.cmp = null; S.loadSeries = null; S.traceFrames = null; }
    S.computeMs = performance.now() - t0;
    if (S.playhead > replayDuration()) S.playhead = 0;
    renderAll();
  }
  function buildTraceFrames() {
    const tau = 1e9 / S.bitrate; const t0 = S.trace[0].t;
    const names = new Map(S.set.map((m) => [m.key, m.name]));
    return S.trace.map((f, k) => {
      const key = (f.extended ? 'x' : 's') + f.id; const bits = C.exactFrameBits(f.id, f.extended, f.data);
      const end = (f.t - t0) * 1e9; return { key, name: names.get(key) || hex(f), id: f.id, extended: f.extended, k, start: end - bits * tau, end, bits, data: f.data, logged: true };
    });
  }
  function keyByName(name) { const m = S.baseSet.find((x) => x.name === name); return m ? m.key : null; }
  function replayFrames() { return S.source === 'trace' && S.traceFrames ? S.traceFrames : S.simFrames; }
  function replayDuration() { const f = replayFrames(); return f && f.length ? f[f.length - 1].end : 1; }

  /* ---------------- rendering ---------------- */
  function renderAll() { renderKPIs(); renderTable(); renderFindings(); renderCharts(); renderSourceChips(); if (S.selectedKey) renderDrawer(); }

  function renderSourceChips() {
    const ex = S.ex || {};
    $('#dsChip').innerHTML = ex.label === 'published' ? chip('calculated', 'published example') : chip(ex.label === 'measured' ? 'measured' : 'synthetic', ex.label === 'measured' ? 'measured data' : 'synthetic data');
    if (S.traceLabel && S.traceLabel !== ex.label) $('#dsChip').innerHTML += ' ' + chip(S.traceLabel, S.traceLabel + ' trace');
    const rs = S.source === 'trace' && S.traceFrames ? chip(S.traceLabel, S.traceLabel + ' replay') : chip('simulated', 'simulated replay');
    $('#carSrc').innerHTML = rs; $('#tlSrc').innerHTML = rs;
    $('#loadSrc').innerHTML = S.trace ? chip(S.traceLabel, S.traceLabel) + ' ' + chip('calculated', 'prediction') : chip('calculated', 'prediction');
    $('#cmpSrc').innerHTML = S.trace ? chip(S.traceLabel, S.traceLabel) + ' ' + chip('assumed', 'D = T assumed') : '';
  }

  function renderKPIs() {
    const a = S.analysis; const r = a.results;
    const misses = r.filter((x) => !x.schedulable);
    const minSlack = r.reduce((m, x) => (x.slack < m.slack ? x : m), { slack: Infinity });
    const layoutErr = S.findings.filter((f) => ['OVERLAP', 'OUT_OF_FRAME', 'DUP_ID', 'ID_RANGE', 'DUP_SIGNAL', 'MOTOROLA_START', 'ZERO_LEN', 'TOO_LONG', 'DLC_FD', 'MULTI_MUX', 'NO_MUX', 'SYNTAX'].includes(f.code));
    const obs = S.cmp ? S.cmp.J0.load.observed : null;
    const nExt = S.set.filter((m) => m.extended).length;
    const k = [
      { k: 'Bus load · worst case', v: pct(a.load.worst), cls: a.load.worst > 0.7 ? 'bad' : a.load.worst > 0.5 ? 'warn' : 'ok', s: `no-stuffing ${pct(a.load.best)} · @ ${S.bitrate / 1000} kbit/s`, bar: a.load.worst, chipL: 'calculated' },
      { k: 'Bus load · observed', v: obs != null ? pct(obs, 2) : '—', cls: '', s: obs != null ? `${S.trace.length.toLocaleString()} frames · exact stuffing` : 'import a CAN log', bar: obs || 0, chipL: S.traceLabel },
      { k: 'Messages', v: String(r.length), s: `${r.length - nExt} × 11-bit · ${nExt} × 29-bit`, chipL: null },
      { k: 'Deadline misses', v: misses.length ? String(misses.length) : '0', cls: misses.length ? 'bad' : 'ok', s: misses.length ? misses.slice(0, 2).map((x) => x.name).join(', ') + (misses.length > 2 ? '…' : '') : (S.method === 'tindell' ? 'original analysis — not safe' : 'all deadlines met'), bar: misses.length ? 1 : 0, chipL: 'calculated', barColor: 'var(--bad)' },
      { k: 'Min slack', v: Number.isFinite(minSlack.slack) ? ms(minSlack.slack, 2) + ' ms' : '−∞', cls: minSlack.slack < 0 ? 'bad' : minSlack.slack < 0.1 * minSlack.D ? 'warn' : 'ok', s: minSlack.name || '', chipL: 'calculated' },
      { k: 'DBC layout errors', v: S.dbc ? String(layoutErr.length) : '—', cls: layoutErr.length ? 'bad' : 'ok', s: S.dbc ? `${S.dbc.messages.length} messages · ${S.dbc.messages.reduce((n, m) => n + m.signals.length, 0)} signals` : 'no DBC loaded', chipL: null },
    ];
    $('#kpis').innerHTML = k.map((x) => `<div class="kpi"><div class="k"><span>${x.k}</span>${x.chipL ? chip(x.chipL) : ''}</div><div class="v ${x.cls || ''}">${x.v}</div><div class="s">${esc(x.s)}</div>${x.bar != null ? `<div class="bar" style="width:${Math.min(100, x.bar * 100)}%;background:${x.barColor || (x.cls === 'bad' ? 'var(--bad)' : x.cls === 'warn' ? 'var(--warn)' : 'var(--accent)')}"></div>` : ''}</div>`).join('');
  }

  const COLS = [
    ['rank', 'Pri', 'r'], ['id', 'ID', 'l'], ['name', 'Message', 'l'], ['sender', 'Sender', 'l'], ['dlc', 'DLC', 'r'],
    ['T', 'T ms', 'r'], ['D', 'D ms', 'r'], ['J', 'J ms', 'r'], ['C', 'C ms', 'r'], ['U', 'U', 'r'], ['R', 'R ms', 'r'], ['slack', 'Slack', 'l'], ['st', 'Status', 'l'],
  ];
  function renderTable() {
    const a = S.analysis; const setBy = new Map(S.set.map((m) => [m.key, m]));
    let rows = a.results.map((r) => ({ r, m: setBy.get(r.key) }));
    if (S.sort) { const [k, dir] = S.sort; rows.sort((x, y) => dir * (sortVal(x, k) - sortVal(y, k) || String(sortVal(x, k)).localeCompare(String(sortVal(y, k))))); }
    const th = COLS.map(([k, t, al]) => `<th class="${al}" data-k="${k}">${t}${S.sort && S.sort[0] === k ? (S.sort[1] > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
    const body = rows.map(({ r, m }) => {
      const ratio = Number.isFinite(r.R) ? r.R / r.D : 2; const col = !r.schedulable ? 'var(--bad)' : ratio > 0.8 ? 'var(--warn)' : 'var(--ok)';
      const inp = (f, v, src) => `<input data-f="${f}" data-key="${r.key}" value="${+(+v).toFixed(3)}" class="${/assumed/.test(src || '') ? 'assumed' : ''}" title="${esc(src || '')}" inputmode="decimal" ${m.synthetic ? 'disabled' : ''}>`;
      return `<tr data-key="${r.key}" class="${r.schedulable ? '' : 'miss'} ${r.key === S.selectedKey ? 'sel' : ''}">
        <td>${r.priorityRank + 1}</td><td class="l">${hex(r)}${r.extended ? ' <span class="chip calculated" style="font-size:8.5px;padding:0 4px">29b</span>' : ''}</td><td class="l" style="font-family:var(--sans)">${esc(r.name)}${m.synthetic ? ' ' + chip('simulated', 'stress') : ''}</td><td class="l" style="font-family:var(--sans);color:var(--muted)">${esc(m.sender || '')}</td><td>${m.Cbits != null ? '—' : m.dlc}</td>
        <td>${inp('Tms', m.Tms, m.source && m.source.T)}</td><td>${inp('Dms', m.Dms, m.source && m.source.D)}</td><td>${inp('Jms', m.Jms || 0, m.source && m.source.J)}</td>
        <td>${ms(r.C)}</td><td>${(100 * r.C / r.T).toFixed(2)}%</td><td style="color:${col};font-weight:600">${ms(r.R)}</td>
        <td class="l"><span class="slack"><i style="width:${Math.max(2, Math.min(100, 100 * (1 - Math.min(1, ratio))))}%;background:${col}"></i></span>${Number.isFinite(r.slack) ? ms(r.slack, 2) : '−∞'}</td>
        <td class="l st">${r.schedulable ? '<span style="color:var(--ok)">✓ met</span>' : '✕ MISS'}</td></tr>`;
    }).join('');
    $('#msgTable').innerHTML = `<thead><tr>${th}</tr></thead><tbody>${body}</tbody>`;
    if (S.hoverKey) highlight(S.hoverKey);
  }
  function sortVal({ r, m }, k) {
    return { rank: r.priorityRank, id: C.arbKey(r), name: r.name, sender: m.sender || '', dlc: m.dlc, T: r.T, D: r.D, J: r.J, C: r.C, U: r.C / r.T, R: Number.isFinite(r.R) ? r.R : 1e18, slack: Number.isFinite(r.slack) ? r.slack : -1e18, st: r.schedulable ? 1 : 0 }[k];
  }

  function renderFindings() {
    const sevRank = { error: 0, warning: 1, info: 2 };
    const list = S.findings.filter((f) => S.filter === 'all' ? f.severity !== 'info' || S.findings.length < 30 : f.severity === S.filter).sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
    const el = $('#findings');
    if (!list.length) { el.innerHTML = `<div class="note">No findings at this level. ${S.method === 'tindell' ? '<b>Note:</b> original Tindell analysis is optimistic.' : ''}</div>`; return; }
    el.innerHTML = list.map((f, i) => `<div class="finding ${f.severity}" data-key="${f.key || ''}" data-i="${i}" style="animation-delay:${Math.min(i, 12) * 25}ms"><div class="ic">${f.severity === 'error' ? '!' : f.severity === 'warning' ? '△' : 'i'}</div><div><div class="c">${f.code}${f.msg ? ' · ' + esc(f.msg) : ''}${f.signal ? '.' + esc(f.signal) : ''}</div><div class="t">${esc(f.text)}</div>${f.order ? `<details class="note"><summary>Show feasible order (high → low)</summary>${f.order.map((k) => esc((S.set.find((m) => m.key === k) || {}).name || k)).join(' › ')}</details>` : ''}</div></div>`).join('');
  }

  function renderCharts() {
    const hooks = { hover: setHover, tip, tipMove, select: (k) => select(k) };
    CH.rdChart($('#rdChart'), S.analysis.results, hooks, S.selectedKey);
    const series = S.loadSeries;
    CH.loadChart($('#loadChart'), series, 0.1, { worst: S.cmp ? S.cmp.J0.load.predictedWorst : S.analysis.load.worst, best: S.cmp ? S.cmp.J0.load.predictedBest : S.analysis.load.best }, hooks, S.source === 'trace' ? S.playhead / 1e9 : null);
    if (S.cmp) {
      const L = S.cmp.J0.load; const peak = Math.max(...series);
      const within = L.observed >= L.predictedBest - 1e-9 && L.observed <= L.predictedWorst + 1e-9;
      $('#loadStats').innerHTML = `<div class="stat"><div class="k">observed avg</div><div class="v">${pct(L.observed, 2)}</div></div><div class="stat"><div class="k">predicted range</div><div class="v">${pct(L.predictedBest, 1)}–${pct(L.predictedWorst, 1)}</div></div><div class="stat"><div class="k">peak (100 ms)</div><div class="v">${pct(peak, 1)}</div></div>`;
      const notModelled = S.meas.ids.filter((x) => !S.set.some((m) => m.key === x.key)).length;
      $('#loadNote').innerHTML = (within ? `Observed average load lies <b>inside</b> the predicted range (exact per-frame stuffing vs. no-stuffing / worst-case bounds).` : `<b style="color:var(--bad)">Disagreement:</b> observed average load is <b>outside</b> the predicted range — the model's periods/DLCs do not describe this capture${notModelled ? ` (${notModelled} logged IDs are not in the model)` : ''}.`) + ` Observed load is computed from the ${S.traceLabel} capture with exact bit stuffing of each logged payload.`;
    } else { $('#loadStats').innerHTML = ''; $('#loadNote').innerHTML = 'Predicted load only. Import a CAN log (candump or CSV) to compare.'; }
    if (S.cmp) {
      const c = S.cmp[S.cmpJ];
      const names = new Map(S.set.map((m) => [m.key, m.name]));
      const rows = c.rows.map((r) => Object.assign({}, r, { label: (names.get(r.key) || ('0x' + r.id.toString(16))).slice(0, 14) }));
      CH.cmpChart($('#cmpChart'), rows, hooks, S.selectedKey);
      const dis = rows.filter((r) => r.status === 'DISAGREES'); const nm = rows.filter((r) => r.status === 'not-modelled').length;
      $('#cmpNote').innerHTML = `Dot = observed spread of arrival times around the fitted periodic grid; bar end = largest spread the model allows, <span class="mono">R<sub>m</sub> − C<sub>m,min</sub></span>. <b>${dis.length}</b> of ${rows.length - nm} IDs ${dis.length ? '<b style="color:var(--bad)">disagree</b>' : 'agree'} with the model (${S.cmpJ === 'J0' ? 'release jitter assumed 0' : 'jitter set to the measured spread — conservative, partly circular'}).${nm ? ` ${nm} IDs not modelled.` : ''} Deadlines are <b>assumed</b> (D = T) where the data has none.`;
    } else { CH.cmpChart($('#cmpChart'), [], hooks); $('#cmpNote').textContent = 'No trace loaded.'; }
  }

  function renderBanner() {
    const ex = S.ex; const b = $('#banner');
    let html = '';
    if (ex.label === 'synthetic') html = `<span class="chip synthetic">synthetic</span><div><b>Synthetic demo network.</b> ${esc(ex.description || '')} The real ROAD / CAN-Modes captures could not be downloaded in the build environment, so no measured example is bundled. Import your own DBC and candump/CSV log (or run <span class="mono">data/fetch.sh</span> and rebuild) for a measured comparison.</div>`;
    else if (ex.label === 'measured') html = `<span class="chip measured">measured</span><div><b>${esc(ex.title)}.</b> ${esc(ex.description || '')} Deadlines are <b>assumed</b> equal to the measured periods — the data does not provide them.</div>`;
    else html = `<span class="chip calculated">published</span><div>${esc(ex.description)}</div>`;
    if (S.method === 'tindell') html += `<div style="margin-left:auto"><span class="chip bad">unsafe method selected</span></div>`;
    b.innerHTML = html;
  }
  function renderFooter() {
    $('#methodText').innerHTML = `<p><b>Frame time.</b> Worst-case bits per frame C<sub>m</sub> = g + 8s<sub>m</sub> + 13 + ⌊(g + 8s<sub>m</sub> − 1)/4⌋ with g = 34 (11-bit) or 54 (29-bit) — 135 / 160 bits for 8 bytes. Observed load uses exact stuffing of each logged frame (CRC-15 and stuffing reconstructed bit by bit).</p>
      <p><b>Response time.</b> Revised analysis of Davis, Burns, Bril &amp; Lukkien, <i>Controller Area Network (CAN) schedulability analysis: Refuted, revisited and revised</i>, Real-Time Systems 35(3), 2007 (DOI 10.1007/s11241-007-9012-7): blocking B<sub>m</sub> = max lower-priority C<sub>k</sub>; level-m busy period t<sub>m</sub>; Q<sub>m</sub> = ⌈(t<sub>m</sub>+J<sub>m</sub>)/T<sub>m</sub>⌉ instances; w<sub>m</sub>(q) = B<sub>m</sub> + qC<sub>m</sub> + Σ<sub>hp</sub>⌈(w + J<sub>k</sub> + τ<sub>bit</sub>)/T<sub>k</sub>⌉C<sub>k</sub>; R<sub>m</sub> = max<sub>q</sub>(J<sub>m</sub> + w<sub>m</sub>(q) − qT<sub>m</sub> + C<sub>m</sub>). The original Tindell analysis is available only for comparison; it is optimistic and must not be used for sign-off. Assumes error-free bus, priority-ordered transmit queues in every node, no transmit-buffer priority inversion, and no FIFO/abort effects.</p>
      <p><b>Priorities.</b> Audsley's optimal priority assignment (valid for this analysis because R<sub>m</sub> depends only on the sets of higher- and lower-priority messages) decides whether a feasible order exists when deadlines are missed.</p>
      <p><b>Data vs model.</b> From a single bus tap, arrival times show queuing delay plus release jitter around a periodic grid. A spread larger than R<sub>m</sub> − C<sub>m,min</sub> means the model does not describe the traffic (unmodelled jitter, event-driven sends, clock drift, or a wrong period).</p>`;
    const p = S.ex.summary && S.ex.summary.provenance;
    $('#provText').innerHTML = `<p>Current example: <b>${esc(S.ex.title)}</b> — ${chip(S.ex.label === 'published' ? 'calculated' : S.ex.label, S.ex.label)}</p>${p ? '<ul>' + p.notes.map((n) => `<li>${esc(n)}</li>`).join('') + '</ul>' : ''}
      <p>Labels: ${chip('measured')} logged on a real bus; ${chip('synthetic')} generated, not measured; ${chip('simulated')} produced by CANProof's discrete-event bus simulator from the model; ${chip('calculated')} analytic result; ${chip('illustrative')} visual placement only; ${chip('assumed', 'assumed')} value not in the data.</p>
      <p>Limitations: Classical CAN only (no CAN FD), no error-frame model, no gateway end-to-end latency, node placement in the 3D view is not physical.</p>`;
  }

  /* ---------------- drawer ---------------- */
  function select(key, frame) {
    if (!key) return;
    S.selectedKey = key; S.selectedFrame = frame || null;
    $$('#msgTable tr').forEach((tr) => tr.classList.toggle('sel', tr.dataset.key === key));
    renderDrawer(); $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false');
    const r = S.set.find((m) => m.key === key);
    if (r && car) { const n = car.nodes.get(r.sender || 'Unattributed'); if (n) n.hot = 1; }
  }
  function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); S.selectedKey = null; $$('#msgTable tr').forEach((tr) => tr.classList.remove('sel')); }
  const FIELD_COLORS = { SOF: '#8394a6', ID: '#3cc8ff', 'ID-A': '#3cc8ff', 'ID-B': '#7be0ff', SRR: '#9b8cff', IDE: '#9b8cff', RTR: '#9b8cff', r0: '#566576', r1: '#566576', DLC: '#ffb547', CRC: '#ff8fa0', 'CRC-del': '#566576', ACK: '#3ddc97', 'ACK-del': '#566576', EOF: '#2f3d4c', IFS: '#1f2b38' };
  const SIG_COLORS = ['#3cc8ff', '#ffb547', '#3ddc97', '#ff7ab6', '#9b8cff', '#f2e05a', '#5ef2d0', '#ff9b5a', '#a1d6ff', '#c69bff', '#8fe36b', '#ff6b6b'];
  function renderDrawer() {
    const key = S.selectedKey; const r = S.analysis.results.find((x) => x.key === key); const m = S.set.find((x) => x.key === key);
    if (!r || !m) { closeDrawer(); return; }
    const dm = S.dbc ? S.dbc.messages.find((x) => (x.extended ? 'x' : 's') + x.id === key) : null;
    $('#dTitle').textContent = `${r.name} · ${hex(r)}`;
    $('#dChips').innerHTML = (r.extended ? chip('calculated', '29-bit') : chip('calculated', '11-bit')) + ' ' + (r.schedulable ? '<span class="chip measured" style="color:var(--ok)">deadline met</span>' : chip('bad', 'deadline miss'));
    // WCRT derivation
    const g = r.extended ? 54 : 34; const s = m.dlc; const bits = Math.round(r.C / r.tau);
    const blk = r.blockedBy ? S.set.find((x) => x.key === r.blockedBy) : null;
    let eq = '';
    if (m.Cbits != null) eq += `<span class="c">// C given directly by the published example</span>\nC   = ${bits} bits × τ ${(r.tau / 1000).toFixed(1)} µs = <span class="r">${ms(r.C)} ms</span>\n`;
    else eq += `<span class="c">// Davis et al. 2007 eq.(1), worst-case stuffing</span>\nC   = (g + 8s + 13 + ⌊(g + 8s − 1)/4⌋)·τ\n    = (${g} + ${8 * s} + 13 + ${Math.floor((g + 8 * s - 1) / 4)}) × ${(r.tau / 1000).toFixed(2)} µs = ${bits} bits = <span class="r">${ms(r.C)} ms</span>\n`;
    eq += `B   = max C(lower priority) = <span class="r">${ms(r.B)} ms</span>${blk ? ` <span class="c">(${esc(blk.name)})</span>` : ' <span class="c">(lowest priority)</span>'}\n`;
    if (r.method === 'davis') {
      eq += `t   = B + Σ_hep ⌈(t + J_k)/T_k⌉·C_k = <span class="r">${ms(r.busy)} ms</span>  <span class="c">(busy period, U_hep = ${pct(r.hepU, 1)})</span>\n`;
      eq += `Q   = ⌈(t + J)/T⌉ = <span class="r">${r.Q}</span> instance(s) to check\n`;
      (r.instances || []).slice(0, 8).forEach((ins) => {
        eq += `q=${ins.q}: w = ${ms(r.B)} + ${ins.q}×${ms(r.C)} + Σ_hp ⌈(w + J_k + τ)/T_k⌉C_k = ${ms(ins.w)} ms → R(q) = J + w − qT + C = ${ins.q === r.worstQ ? '<span class="r">' : ''}${ms(ins.R)} ms${ins.q === r.worstQ ? '</span>' : ''}\n`;
      });
      if ((r.instances || []).length > 8) eq += `<span class="c">… ${r.instances.length - 8} more instances</span>\n`;
    } else eq += `w   = ${r.method === 'sufficient' ? 'max(B, C)' : 'B'} + Σ_hp ⌈(w + J_k + τ)/T_k⌉C_k = ${ms(r.w)} ms\n<span class="c">// method: ${r.method}${r.method === 'tindell' ? ' — ORIGINAL, OPTIMISTIC: not valid for sign-off' : ''}</span>\n`;
    eq += `R   = <span class="${r.schedulable ? 'ok' : 'bad'}">${ms(r.R)} ms</span>  ${r.schedulable ? '≤' : '>'}  D = ${ms(r.D)} ms   → slack ${Number.isFinite(r.slack) ? ms(r.slack) : '−∞'} ms`;
    if (S.method !== 'davis') { const dv = S.davis.results.find((x) => x.key === key); eq += `\n<span class="c">// revised Davis analysis gives R = ${ms(dv.R)} ms</span>`; }
    const worstIns = r.instances && r.instances[r.worstQ];
    const interf = worstIns ? worstIns.interference.filter((x) => x.count > 0).sort((a, b) => b.total - a.total).slice(0, 10) : [];
    // payload: selected logged frame, or latest logged payload for this ID, else zeros
    let data = null; let dataLabel = null;
    if (S.selectedFrame && S.selectedFrame.data) { data = S.selectedFrame.data; dataLabel = chip(S.traceLabel, S.traceLabel + ' frame #' + S.selectedFrame.k); }
    else if (S.trace) { const f = findLatest(key); if (f) { data = f.data; dataLabel = chip(S.traceLabel, S.traceLabel + ' payload'); } }
    if (!data) { data = new Uint8Array(Math.min(8, m.dlc || 0)); dataLabel = chip('illustrative', 'zero payload — no log'); }
    const fr = C.buildFrame(r.id, r.extended, data);
    const bitsHtml = fr.bits.map((b) => `<div class="bit${b.stuff ? ' stuff' : ''}" style="background:${b.field.startsWith('D') && b.field.length <= 2 ? SIG_COLORS[(+b.field.slice(1)) % SIG_COLORS.length] + '99' : FIELD_COLORS[b.field] || '#566576'}" title="${b.field}${b.stuff ? ' (stuff bit)' : ''}">${b.v}</div>`).join('');
    const fieldsUsed = [...new Set(fr.bits.map((b) => (b.field.match(/^D\d$/) ? 'Data' : b.field)))];
    // signal layout & decode
    let layoutHtml = ''; let decHtml = '';
    if (dm) {
      const occ = new Map(); dm.signals.forEach((sg, i) => C.signalBits(sg).forEach((b) => { if (!occ.has(b)) occ.set(b, []); occ.get(b).push(i); }));
      const nbytes = Math.max(1, Math.min(8, dm.dlc));
      layoutHtml = `<div class="layout"><div></div>${[7, 6, 5, 4, 3, 2, 1, 0].map((b) => `<div class="hdr">${b}</div>`).join('')}` +
        Array.from({ length: nbytes }, (_, by) => `<div class="hdr">B${by}</div>` + [7, 6, 5, 4, 3, 2, 1, 0].map((bi) => { const p = by * 8 + bi; const o = occ.get(p) || []; const muxConflict = o.length > 1; return `<div class="cell ${o.length ? 'on' : ''} ${muxConflict ? 'overlap' : ''}" style="${o.length ? 'background:' + SIG_COLORS[o[0] % SIG_COLORS.length] : ''}" title="bit ${p}${o.length ? ': ' + o.map((i) => dm.signals[i].name).join(', ') : ''}">${p}</div>`; }).join('')).join('') + '</div>';
      const outside = dm.signals.filter((sg) => C.signalBits(sg).some((b) => b >= nbytes * 8));
      if (outside.length) layoutHtml += `<p class="note" style="color:var(--bad)">Outside payload: ${outside.map((x) => esc(x.name)).join(', ')}</p>`;
      const dec = C.decodeMessage(dm, data);
      decHtml = `<table class="kv">${dec.map((d) => { const i = dm.signals.indexOf(d.sig); return `<tr><td><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${SIG_COLORS[i % SIG_COLORS.length]};margin-right:6px"></i>${esc(d.name)} <span style="color:var(--faint)">${d.sig.start}|${d.sig.length}@${d.sig.byteOrder === 'intel' ? '1' : '0'}${d.sig.signed ? '−' : '+'}</span></td><td>raw ${d.raw}</td><td>${+d.phys.toFixed(6)} ${esc(d.unit)}${d.label ? ' · ' + esc(d.label) : ''}</td></tr>`; }).join('')}</table>`;
    }
    const mx = S.meas ? S.meas.ids.find((x) => x.key === key) : null;
    const obsHtml = mx ? `<table class="kv"><tr><td>frames</td><td>${mx.count}</td></tr><tr><td>period (LSQ fit)</td><td>${(mx.fitPeriod * 1000).toFixed(4)} ms ${dm && dm.cycleTimeMs ? `<span style="color:var(--muted)">(DBC ${dm.cycleTimeMs} ms)</span>` : ''}</td></tr><tr><td>inter-arrival min / max</td><td>${(mx.minDelta * 1000).toFixed(3)} / ${(mx.maxDelta * 1000).toFixed(3)} ms</td></tr><tr><td>arrival spread (jitter)</td><td>${(mx.jitterSpread * 1000).toFixed(3)} ms</td></tr><tr><td>DLC observed</td><td>${mx.dlcMin === mx.dlcMax ? mx.dlcMax : mx.dlcMin + '–' + mx.dlcMax}</td></tr><tr><td>missing frames</td><td>${mx.missing}</td></tr></table>` : '<p class="note">Not present in the loaded trace.</p>';
    $('#dBody').innerHTML = `
      <section><h4>Worst-case response time ${chip('calculated')}</h4><div class="eq">${eq}</div>
        ${interf.length ? `<p class="note">Interference in the worst instance (q=${r.worstQ}): ${interf.map((x) => `${esc(x.name)} ×${x.count}`).join(', ')}</p>` : ''}</section>
      <section><h4>Frame on the wire ${dataLabel}</h4><div class="bits">${bitsHtml}</div>
        <div class="bitlegend">${fieldsUsed.map((f) => `<span><i style="background:${f === 'Data' ? SIG_COLORS[0] + '99' : FIELD_COLORS[f]}"></i>${f}</span>`).join('')}<span><i style="outline:2px solid var(--bad);outline-offset:-2px"></i>stuff bit</span></div>
        <p class="note">${fr.total} bits incl. 3-bit IFS · ${fr.stuffCount} stuff bits (worst case allowed ${C.worstCaseFrameBits(fr.dlc, r.extended) - C.minFrameBits(fr.dlc, r.extended)}) · CRC-15 0x${fr.crc.toString(16).toUpperCase().padStart(4, '0')} · bytes <span class="mono">${Array.from(data, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') || '—'}</span></p></section>
      ${dm ? `<section><h4>Signal layout (DBC)</h4>${layoutHtml}</section><section><h4>Decoded signals ${dataLabel}</h4>${decHtml || '<p class="note">No signals.</p>'}</section>` : ''}
      <section><h4>Observed in trace ${S.trace ? chip(S.traceLabel) : ''}</h4>${obsHtml}</section>
      <section><h4>Timing parameters</h4><table class="kv"><tr><td>Period T</td><td>${ms(r.T)} ms · ${esc(m.source && m.source.T)}</td></tr><tr><td>Deadline D</td><td>${ms(r.D)} ms · ${esc(m.source && m.source.D)}</td></tr><tr><td>Jitter J</td><td>${ms(r.J)} ms · ${esc(m.source && m.source.J)}</td></tr><tr><td>Priority rank</td><td>${r.priorityRank + 1} of ${S.analysis.results.length}</td></tr><tr><td>Utilisation</td><td>${pct(r.C / r.T, 2)}</td></tr></table></section>`;
  }
  function findLatest(key) {
    const tr = S.traceFrames; if (!tr) return null;
    const ph = S.source === 'trace' ? S.playhead : Infinity;
    let best = null; for (const f of tr) { if (f.key !== key) continue; if (f.end > ph && best) break; best = f; }
    return best;
  }

  /* ---------------- hover linking ---------------- */
  function setHover(key) { if (S.hoverKey === key) return; S.hoverKey = key; highlight(key); }
  function highlight(key) {
    $$('#msgTable tbody tr').forEach((tr) => tr.classList.toggle('hl', tr.dataset.key === key));
    $$('#rdChart g.row, #cmpChart g.row').forEach((g) => g.classList.toggle('hl', g.dataset.key === key || g.dataset.key === S.selectedKey));
    if (key && car) { const m = S.set.find((x) => x.key === key); const n = m && car.nodes.get(m.sender || 'Unattributed'); if (n) n.hot = Math.max(n.hot, 0.7); }
  }

  /* ---------------- playback loop ---------------- */
  let lastWall = performance.now(); let lastPlayhead = 0;
  function frameLoop(now) {
    const dt = Math.min(0.1, (now - lastWall) / 1000); lastWall = now;
    const frames = replayFrames(); const dur = replayDuration();
    if (S.playing && frames && frames.length) {
      S.playhead += dt * S.speed * 1e9;
      if (S.playhead > dur) { S.playhead = 0; lastPlayhead = 0; }
    }
    // emit pulses for frames whose transmission started since last tick
    if (frames && car && S.playhead >= lastPlayhead) {
      let emitted = 0; const setBy = new Map(S.set.map((m) => [m.key, m])); const n = S.analysis.results.length;
      const rank = new Map(S.analysis.results.map((r) => [r.key, r.priorityRank]));
      for (let i = lowerStart(frames, lastPlayhead); i < frames.length && frames[i].start <= S.playhead; i++) {
        const f = frames[i]; if (f.start < lastPlayhead) continue;
        if (emitted++ > 40) break;
        const m = setBy.get(f.key); const sender = (m && m.sender && m.sender !== 'Vector__XXX') ? m.sender : 'Unattributed';
        car.emit(sender, receiversOf(f.key), !!f.miss, 1 - (rank.get(f.key) || 0) / Math.max(1, n - 1));
      }
    }
    lastPlayhead = S.playhead;
    // bus load at playhead (10 ms window), from replay frames
    if (frames) {
      const w = 10e6; let busy = 0;
      for (let i = lowerStart(frames, S.playhead - w - 2e6); i < frames.length && frames[i].start <= S.playhead; i++) {
        const f = frames[i]; busy += Math.max(0, Math.min(f.end, S.playhead) - Math.max(f.start, S.playhead - w));
      }
      const load = S.playhead > 0 ? busy / Math.min(w, S.playhead) : 0;
      car && car.setLoad(load);
      $('#loadGauge').textContent = (load * 100).toFixed(1) + '%';
      $('#loadGauge').style.color = load > 0.8 ? 'var(--bad)' : load > 0.5 ? 'var(--warn)' : 'var(--ok)';
    }
    car && car.render(dt);
    drawTimeline();
    $('#pTime').textContent = (S.playhead / 1e6).toFixed(3) + ' ms';
    if (!scrubbing) $('#pScrub').value = String(Math.round(1000 * S.playhead / Math.max(1, dur)));
    requestAnimationFrame(frameLoop);
  }
  function lowerStart(fr, t) { let lo = 0, hi = fr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (fr[m].start < t) lo = m + 1; else hi = m; } return lo; }
  const rxCache = new Map();
  function receiversOf(key) {
    if (rxCache.has(key)) return rxCache.get(key);
    let rx = [];
    if (S.dbc) { const dm = S.dbc.messages.find((x) => (x.extended ? 'x' : 's') + x.id === key); if (dm) rx = [...new Set(dm.signals.flatMap((s) => s.receivers))].filter((x) => x !== 'Vector__XXX'); }
    rxCache.set(key, rx); return rx;
  }
  function drawTimeline() {
    const frames = replayFrames(); if (!frames || !timeline) return;
    const W = S.windowNs; const t0 = Math.max(0, S.playhead - 0.7 * W);
    const misses = new Set(S.analysis.results.filter((r) => !r.schedulable).map((r) => r.key));
    const rows = S.analysis.results.map((r) => ({ key: r.key, name: r.name, idHex: hex(r), miss: misses.has(r.key) }));
    const isTrace = S.source === 'trace' && S.traceFrames;
    timeline.draw({ frames, rows, t0, t1: t0 + W, playhead: S.playhead, selectedKey: S.selectedKey, hoverKey: S.hoverKey, maxLag: isTrace ? 0 : 3e7,
      note: isTrace ? 'Logged trace: only transmissions are observable — queuing and blocking are not.' : 'Simulated: synchronous release at t = 0 (critical-instant-like), random jitter within J, worst-case stuffing.',
      sourceLabel: isTrace ? S.traceLabel + ' trace' : 'simulated' });
    $('#tlSub').textContent = `window ${(W / 1e6).toFixed(W < 1e6 ? 2 : 0)} ms · ${frames.length.toLocaleString()} frames`;
  }

  /* ---------------- events ---------------- */
  let scrubbing = false;
  function bind() {
    $('#example').innerHTML = examples().map((e, i) => `<option value="${i}">${esc(e.title)}</option>`).join('');
    $('#example').addEventListener('change', (e) => loadExample(examples()[+e.target.value]));
    $('#bitrate').addEventListener('change', (e) => { S.bitrate = +e.target.value; rxCache.clear(); recompute(); });
    $('#method').addEventListener('change', (e) => { S.method = e.target.value; recompute(); renderBanner(); });
    $('#btnTheme').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
    $('#pPlay').addEventListener('click', togglePlay);
    $('#pStep').addEventListener('click', () => { const fr = replayFrames(); const i = lowerStart(fr, S.playhead + 1); if (fr[i]) { S.playhead = fr[i].start; S.playing = false; updatePlayBtn(); } });
    $('#pSpeed').addEventListener('change', (e) => { S.speed = +e.target.value; });
    $('#pSource').addEventListener('change', (e) => { if (e.target.value === 'trace' && !S.traceFrames) { toast('No trace loaded — import a CAN log first.'); e.target.value = 'sim'; return; } S.source = e.target.value; S.playhead = 0; lastPlayhead = 0; renderSourceChips(); renderCharts(); });
    const sc = $('#pScrub');
    sc.addEventListener('input', () => { scrubbing = true; S.playhead = (+sc.value / 1000) * replayDuration(); lastPlayhead = S.playhead; });
    sc.addEventListener('change', () => { scrubbing = false; });
    $('#tlZoomIn').addEventListener('click', () => zoom(0.6)); $('#tlZoomOut').addEventListener('click', () => zoom(1.6));
    $('#btnSpin').addEventListener('click', () => { car.spin = !car.spin; $('#btnSpin').classList.toggle('on', car.spin); });
    $('#msgTable').addEventListener('click', (e) => {
      const th = e.target.closest('th'); if (th) { const k = th.dataset.k; S.sort = S.sort && S.sort[0] === k ? (S.sort[1] > 0 ? [k, -1] : null) : [k, 1]; renderTable(); return; }
      if (e.target.tagName === 'INPUT') return;
      const tr = e.target.closest('tr[data-key]'); if (tr) select(tr.dataset.key);
    });
    $('#msgTable').addEventListener('change', (e) => {
      const inp = e.target; if (inp.tagName !== 'INPUT') return;
      const v = parseFloat(inp.value); if (!(v >= 0) || (inp.dataset.f === 'Tms' && v <= 0)) { toast('Enter a positive number (ms).'); renderTable(); return; }
      const base = S.baseSet.find((m) => m.key === inp.dataset.key);
      S.edits[inp.dataset.key] = Object.assign(S.edits[inp.dataset.key] || {}, { [inp.dataset.f]: S.stress.on && inp.dataset.f === 'Tms' ? v * S.stress.load : inp.dataset.f === 'Jms' && S.stress.on && S.stress.jit ? v / S.stress.jit : v });
      if (inp.dataset.f === 'Tms' && /assumed/.test(base.source.D) && !(S.edits[inp.dataset.key].Dms != null)) { /* implicit deadline follows period */ S.edits[inp.dataset.key].Dms = S.edits[inp.dataset.key].Tms; }
      recompute();
    });
    $('#msgTable').addEventListener('mouseover', (e) => { const tr = e.target.closest('tr[data-key]'); setHover(tr ? tr.dataset.key : null); });
    $('#msgTable').addEventListener('mouseleave', () => setHover(null));
    $('#findings').addEventListener('click', (e) => { const f = e.target.closest('.finding'); if (f && f.dataset.key) select(f.dataset.key); });
    $$('.filters .tbtn').forEach((b) => b.addEventListener('click', () => { S.filter = b.dataset.f; $$('.filters .tbtn').forEach((x) => x.classList.toggle('on', x === b)); renderFindings(); }));
    $('#cmpJ').addEventListener('change', (e) => { S.cmpJ = e.target.value; renderCharts(); });
    $('#dClose').addEventListener('click', closeDrawer);
    $('#dUp').addEventListener('click', () => swapPriority(-1)); $('#dDown').addEventListener('click', () => swapPriority(1));
    // stress
    $('#btnStress').addEventListener('click', () => setStress(!S.stress.on));
    const sl = (id, f, fmt) => $(id).addEventListener('input', (e) => { S.stress[f] = +e.target.value; $(id + 'V').textContent = fmt(+e.target.value); recomputeSoon(); });
    sl('#sLoad', 'load', (v) => v.toFixed(2) + '×'); sl('#sJit', 'jit', (v) => v.toFixed(1) + '×'); sl('#sBg', 'bg', (v) => v + ' %');
    $('#sReset').addEventListener('click', () => { Object.assign(S.stress, { load: 1, jit: 1, bg: 0 }); S.edits = {}; syncStressUI(); recompute(); });
    $('#sOPA').addEventListener('click', applyOPA);
    // export
    $('#btnExport').addEventListener('click', (e) => { e.stopPropagation(); $('#exportMenu').classList.toggle('on'); });
    document.addEventListener('click', () => $('#exportMenu').classList.remove('on'));
    $('#exportMenu').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) doExport(b.dataset.x); });
    $$('[data-svg]').forEach((b) => b.addEventListener('click', () => doExport('svg-' + b.dataset.svg)));
    $$('[data-png]').forEach((b) => b.addEventListener('click', () => doExport('png-' + b.dataset.png)));
    $$('[data-csv]').forEach((b) => b.addEventListener('click', () => doExport('csv-' + b.dataset.csv)));
    // import
    $('#file').addEventListener('change', (e) => importFiles([...e.target.files]));
    let dragN = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); dragN++; $('#drop').classList.add('on'); });
    window.addEventListener('dragleave', () => { if (--dragN <= 0) $('#drop').classList.remove('on'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => { e.preventDefault(); dragN = 0; $('#drop').classList.remove('on'); importFiles([...e.dataTransfer.files]); });
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === ' ') { e.preventDefault(); togglePlay(); } else if (e.key === 'Escape') { closeDrawer(); endTour(); }
    });
    $('#btnTour').addEventListener('click', startTour);
    $$('#tour [data-t]').forEach((b) => b.addEventListener('click', () => tourGo(b.dataset.t)));
    window.addEventListener('resize', () => { clearTimeout(bind._r); bind._r = setTimeout(() => { renderCharts(); if (tour.on) tourShow(); }, 120); });
  }
  let rcT = null; function recomputeSoon() { clearTimeout(rcT); rcT = setTimeout(recompute, 60); }
  function zoom(f) { S.windowNs = Math.max(0.5e6, Math.min(500e6, S.windowNs * f)); }
  function togglePlay() { S.playing = !S.playing; updatePlayBtn(); }
  function updatePlayBtn() { $('#pPlay').textContent = S.playing ? '❚❚' : '▶'; }
  function setTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem('canproof-theme', t); } catch (e) { /* storage unavailable */ } car && car.setTheme(); renderCharts(); }
  function setStress(on) { S.stress.on = on; $('#stress').classList.toggle('on', on); $('#btnStress').classList.toggle('on', on); recompute(); }
  function syncStressUI() { $('#sLoad').value = S.stress.load; $('#sLoadV').textContent = S.stress.load.toFixed(2) + '×'; $('#sJit').value = S.stress.jit; $('#sJitV').textContent = S.stress.jit.toFixed(1) + '×'; $('#sBg').value = S.stress.bg; $('#sBgV').textContent = S.stress.bg + ' %'; }
  function swapPriority(dir) {
    const order = S.analysis.results.filter((r) => r.key !== 'bg'); const i = order.findIndex((r) => r.key === S.selectedKey); const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    const a = S.set.find((m) => m.key === order[i].key); const b = S.set.find((m) => m.key === order[j].key);
    // swap identifiers (the engineering change that changes priority); keys stay stable
    S.edits[a.key] = Object.assign(S.edits[a.key] || {}, { id: b.id, extended: b.extended });
    S.edits[b.key] = Object.assign(S.edits[b.key] || {}, { id: a.id, extended: a.extended });
    toast(`${esc(a.name)} now uses ${hex(b)}, ${esc(b.name)} uses ${hex(a)} (what-if)`);
    recompute();
  }
  function applyOPA() {
    const set = S.set.filter((m) => m.key !== 'bg');
    const opa = C.optimalPriorityAssignment(set, { bitrate: S.bitrate });
    if (!opa.feasible) { toast('No feasible priority order exists at this load (Audsley OPA).'); return; }
    const ids = C.sortByPriority(set).map((m) => ({ id: m.id, extended: m.extended }));
    opa.order.forEach((k, i) => { S.edits[k] = Object.assign(S.edits[k] || {}, ids[i]); });
    toast('Identifiers re-assigned in Audsley-optimal order (what-if).'); recompute();
  }

  /* ---------------- import ---------------- */
  async function importFiles(files) {
    for (const f of files) {
      const text = await f.text();
      if (/\.dbc$/i.test(f.name) || /^\s*VERSION|BO_\s+\d+/m.test(text.slice(0, 5000))) {
        const dbc = C.parseDBC(text);
        if (!dbc.messages.length) { toast('No messages found in ' + esc(f.name)); continue; }
        S.dbc = dbc; S.baseSet = C.messageSetFromDBC(dbc); S.edits = {}; rxCache.clear();
        S.ex = { title: f.name, label: S.traceLabel === 'measured' ? 'measured' : 'measured', description: 'Imported DBC.', dbc: text, imported: true };
        S.ex.label = S.trace ? S.traceLabel : 'measured'; S.ex.labelNote = 'imported';
        setNodes(); toast(`Loaded ${dbc.messages.length} messages from ${esc(f.name)}`);
      } else {
        const log = C.parseLog(text);
        if (!log.frames.length) { toast('No CAN frames recognised in ' + esc(f.name)); continue; }
        S.trace = log.frames; S.traceLabel = 'measured'; S.meas = C.measureTrace(log.frames);
        const inf = C.inferBitrate(log.frames);
        if (inf && inf.snapped) { S.bitrate = inf.snapped; $('#bitrate').value = String(inf.snapped); if (![...$('#bitrate').options].some((o) => +o.value === inf.snapped)) { $('#bitrate').insertAdjacentHTML('beforeend', `<option value="${inf.snapped}">${inf.snapped / 1000} kbit/s</option>`); $('#bitrate').value = String(inf.snapped); } }
        const overlap = S.meas.ids.filter((x) => S.baseSet.some((m) => m.key === x.key)).length;
        if (!S.dbc || overlap < 0.5 * S.meas.ids.length) { S.dbc = null; S.baseSet = C.messageSetFromTrace(S.meas); setNodes(); }
        S.ex = { title: f.name, label: 'measured', description: `Imported capture (${log.frames.length.toLocaleString()} frames, format ${log.format}).`, summary: { provenance: { notes: ['Imported by the user; treated as measured.', 'Deadlines ASSUMED equal to measured periods unless a DBC provides them.', inf ? `Bitrate inferred: ${Math.round(inf.estimate)} bit/s → ${inf.snapped}` : 'Bitrate could not be inferred; check the selector.'] } } };
        toast(`Loaded ${log.frames.length.toLocaleString()} frames · ${S.meas.ids.length} IDs${inf ? ' · ' + inf.snapped / 1000 + ' kbit/s inferred' : ''}`);
      }
    }
    S.playhead = 0; recompute(); renderBanner(); renderFooter();
  }

  /* ---------------- export ---------------- */
  function svgString(svg) {
    const clone = svg.cloneNode(true); clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    let s = clone.outerHTML.replace(/var\(--([\w-]+)\)/g, (m, n) => css('--' + n));
    const w = svg.getAttribute('width'); const h = svg.getAttribute('height');
    s = s.replace(/<svg([^>]*)>/, `<svg$1><style>text{font:10px monospace;fill:${css('--muted')}}.grid line{stroke:${css('--line')}}</style><rect width="${w}" height="${h}" fill="${css('--panel')}"/>`);
    return s;
  }
  function svgToPng(s, w, h, name) {
    const img = new Image(); const scale = 2;
    img.onload = () => { const c = document.createElement('canvas'); c.width = w * scale; c.height = h * scale; const ctx = c.getContext('2d'); ctx.scale(scale, scale); ctx.drawImage(img, 0, 0); c.toBlob((b) => download(name, b)); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  }
  function doExport(x) {
    const base = 'canproof-' + (S.ex.title || 'export').replace(/[^\w]+/g, '_').slice(0, 40);
    const charts = { rd: '#rdChart', load: '#loadChart', cmp: '#cmpChart' };
    if (x.startsWith('svg-') && charts[x.slice(4)]) return download(`${base}-${x.slice(4)}.svg`, svgString($(charts[x.slice(4)])), 'image/svg+xml');
    if (x.startsWith('png-') && charts[x.slice(4)]) { const el = $(charts[x.slice(4)]); return svgToPng(svgString(el), +el.getAttribute('width'), +el.getAttribute('height'), `${base}-${x.slice(4)}.png`); }
    if (x === 'svg-timeline') return download(`${base}-timeline.svg`, timeline.toSVG(), 'image/svg+xml');
    if (x === 'png-timeline') return $('#tl').toBlob((b) => download(`${base}-timeline.png`, b));
    if (x === 'png-car') { car.render(0); return fetch(car.png()).then((r) => r.blob()).then((b) => download(`${base}-3d.png`, b)); }
    if (x === 'csv-results') {
      const rows = [['priority', 'id_hex', 'extended', 'name', 'sender', 'dlc', 'T_ms', 'T_source', 'D_ms', 'D_source', 'J_ms', 'J_source', 'C_ms', 'B_ms', 'busy_ms', 'Q', 'R_ms', 'slack_ms', 'schedulable', 'method', 'bitrate']];
      for (const r of S.analysis.results) { const m = S.set.find((q) => q.key === r.key); rows.push([r.priorityRank + 1, hex(r), r.extended, r.name, m.sender, m.dlc, r.T / 1e6, m.source.T, r.D / 1e6, m.source.D, r.J / 1e6, m.source.J, r.C / 1e6, r.B / 1e6, r.busy != null ? r.busy / 1e6 : '', r.Q, Number.isFinite(r.R) ? r.R / 1e6 : 'inf', Number.isFinite(r.slack) ? r.slack / 1e6 : '-inf', r.schedulable, S.method, S.bitrate]); }
      return download(`${base}-results.csv`, csv(rows), 'text/csv');
    }
    if (x === 'csv-trace') {
      if (!S.meas) return toast('No trace loaded.');
      const rows = [['id_hex', 'extended', 'count', 'median_period_ms', 'fit_period_ms', 'min_delta_ms', 'max_delta_ms', 'cv', 'jitter_spread_ms', 'missing', 'dlc_min', 'dlc_max', 'periodic', 'label']];
      for (const i of S.meas.ids) rows.push([hex(i), i.extended, i.count, i.medianPeriod * 1e3, i.fitPeriod && i.fitPeriod * 1e3, i.minDelta * 1e3, i.maxDelta * 1e3, i.cv, i.jitterSpread * 1e3, i.missing, i.dlcMin, i.dlcMax, i.periodic, S.traceLabel]);
      return download(`${base}-trace.csv`, csv(rows), 'text/csv');
    }
    if (x === 'csv-compare') {
      if (!S.cmp) return toast('No trace loaded.');
      const rows = [['id_hex', 'model_jitter', 'observed_spread_ms', 'bound_R_minus_Cmin_ms', 'R_ms', 'status', 'deadline_note']];
      for (const k of ['J0', 'Jm']) for (const r of S.cmp[k].rows) rows.push(['0x' + r.id.toString(16).toUpperCase(), k === 'J0' ? 'assumed 0' : 'measured spread', r.observedSpread != null ? r.observedSpread * 1e3 : '', r.predictedBound != null ? r.predictedBound * 1e3 : '', r.R != null ? r.R * 1e3 : '', r.status, 'D assumed = T where not in data']);
      rows.push([]); rows.push(['load_observed', S.cmp.J0.load.observed]); rows.push(['load_predicted_best', S.cmp.J0.load.predictedBest]); rows.push(['load_predicted_worst', S.cmp.J0.load.predictedWorst]);
      return download(`${base}-comparison.csv`, csv(rows), 'text/csv');
    }
    if (x === 'dbc') {
      if (!S.dbc || !S.ex.dbc) return toast('No DBC loaded.');
      let t = S.ex.dbc.replace(/^BA_ "(GenMsgCycleTime|GenMsgDeadline|GenMsgJitter)" BO_ .*$\n?/gm, '');
      const defs = ['BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;', 'BA_DEF_ BO_ "GenMsgDeadline" INT 0 65535;', 'BA_DEF_ BO_ "GenMsgJitter" FLOAT 0 1000;'].filter((d) => !t.includes(d.slice(0, 32)));
      const lines = S.baseSet.map((m) => { const e = Object.assign({}, m, S.edits[m.key] || {}); const raw = m.extended ? (m.id + 0x80000000) >>> 0 : m.id; return [`BA_ "GenMsgCycleTime" BO_ ${raw} ${Math.round(e.Tms)};`, /assumed/.test(m.source.D) && !(S.edits[m.key] || {}).Dms ? '' : `BA_ "GenMsgDeadline" BO_ ${raw} ${Math.round(e.Dms)};`, e.Jms ? `BA_ "GenMsgJitter" BO_ ${raw} ${e.Jms};` : ''].filter(Boolean).join('\n'); });
      t += '\n' + defs.join('\n') + '\n' + lines.join('\n') + '\n';
      return download(`${base}.dbc`, t, 'text/plain');
    }
  }

  /* ---------------- guided tour ---------------- */
  const tour = { on: false, i: 0, timer: null };
  const STEPS = [
    { sel: '#kpis', t: 'Timing at a glance', p: 'Worst-case bus load, observed load from the capture, deadline misses and minimum slack — all recomputed live from the DBC and log. Chips tell you whether a value is measured, synthetic, simulated or calculated.' },
    { sel: '#pCar', t: 'X-ray vehicle network', p: 'Each pulse is a frame from the replay leaving its sender ECU and propagating along the bus. The bus colour is the load in a 10 ms window at the playhead. ECU positions are illustrative — a DBC carries no physical location.' },
    { sel: '#pTimeline', t: 'Queuing, blocking, transmission', p: 'The timeline shows every frame: release, waiting behind a lower-priority frame already on the bus (blocking, amber), waiting for higher priorities (interference, violet), transmission, and the deadline tick. Hover any bar; click to inspect.' },
    { sel: '#pFind', t: 'Findings', p: 'Layout errors (overlapping signals, bits outside the payload), deadline-monotonic inversions and deadline misses. This demo network contains two clearly labelled planted errors.', before: () => { S.filter = 'all'; renderFindings(); } },
    { sel: '#drawer', t: 'Proof for one message', p: 'The drawer derives the worst-case response time step by step (blocking, busy period, every instance q), shows the exact frame on the wire with stuff bits, the signal layout and decoded values.', before: () => { const worst = S.analysis.results.slice().sort((a, b) => a.slack - b.slack)[0]; select(worst.key); } },
    { sel: '#stress', t: 'Stress mode', p: 'Scale the load, jitter or inject background traffic and watch deadline misses appear in the table, timeline and 3D view. "Apply optimal priorities" re-assigns identifiers with Audsley\'s algorithm.', before: () => { closeDrawer(); setStress(true); animateStress(1.6); } },
    { sel: '#pCmp', t: 'Data vs model', p: 'Observed arrival-time spread per ID against the analytical bound. Red dots are IDs where the model disagrees with the capture — reported, not hidden.', before: () => { Object.assign(S.stress, { load: 1, jit: 1, bg: 0 }); syncStressUI(); setStress(false); } },
    { sel: 'header.top', t: 'Your own network', p: 'Import a DBC and/or a candump / CSV log (or drag and drop). Edit T, D and J directly in the table, switch bitrate, and export CSV, SVG, PNG or an updated DBC. Everything runs offline.' },
  ];
  function animateStress(target) { const start = performance.now(); const from = S.stress.load; const step = (now) => { const k = Math.min(1, (now - start) / 1800); S.stress.load = from + (target - from) * k; syncStressUI(); recompute(); if (k < 1 && tour.on) requestAnimationFrame(step); }; requestAnimationFrame(step); }
  function startTour() { tour.on = true; tour.i = 0; $('#tour').classList.add('on'); tourShow(); }
  function endTour() { if (!tour.on) return; tour.on = false; clearInterval(tour.timer); $('#tour').classList.remove('on'); }
  function tourGo(a) { if (a === 'end') return endTour(); tour.i += a === 'next' ? 1 : -1; if (tour.i >= STEPS.length) return endTour(); tour.i = Math.max(0, tour.i); tourShow(); }
  function tourShow() {
    const st = STEPS[tour.i]; st.before && st.before();
    const el = $(st.sel);
    if (st.sel !== '#drawer') el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    clearInterval(tour.timer);
    setTimeout(() => {
      const r = el.getBoundingClientRect(); const spot = $('#tour .spot'); const card = $('#tour .card');
      Object.assign(spot.style, { left: r.left - 6 + 'px', top: r.top - 6 + 'px', width: r.width + 12 + 'px', height: Math.min(r.height, window.innerHeight - 20) + 12 + 'px' });
      card.querySelector('h3').textContent = `${tour.i + 1}/${STEPS.length} · ${st.t}`; card.querySelector('p').textContent = st.p;
      const cw = card.offsetWidth; const ch = card.offsetHeight;
      let top = r.bottom + 14; if (top + ch > window.innerHeight - 10) top = Math.max(10, r.top - ch - 14); if (top < 10 || st.sel === '#drawer') top = Math.max(10, window.innerHeight - ch - 16);
      let left = Math.min(window.innerWidth - cw - 16, Math.max(16, r.left)); if (st.sel === '#drawer') left = Math.max(16, r.left - cw - 16);
      if (window.innerWidth < 720) left = 16;
      Object.assign(card.style, { top: top + 'px', left: left + 'px' });
      card.querySelector('[data-t=next]').textContent = tour.i === STEPS.length - 1 ? 'Finish' : 'Next ▶';
      const bar = card.querySelector('.prog i'); let k = 0; bar.style.width = '0';
      tour.timer = setInterval(() => { k += 0.01; bar.style.width = Math.min(100, k * 100) + '%'; if (k >= 1) tourGo('next'); }, 90);
    }, st.sel === '#drawer' ? 420 : 380);
  }

  /* ---------------- boot ---------------- */
  function boot() {
    let theme = null; try { theme = localStorage.getItem('canproof-theme'); } catch (e) { /* ignore */ }
    if (!theme) theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    timeline = new CH.Timeline($('#tl'), { hover: setHover, tip, select: (k, f) => select(k, f && f.logged ? f : null), zoom });
    try { car = new window.CANProofCar.CarScene($('#car'), $('#labels'), { selectNode: (n) => { const m = S.set.find((x) => (x.sender || 'Unattributed') === n); if (m) select(m.key); } }); $('#btnSpin').classList.add('on'); }
    catch (e) { console.warn('WebGL unavailable', e); $('#car').innerHTML = '<p class="note" style="padding:20px">3D view unavailable (WebGL disabled). All analysis features still work.</p>'; car = null; }
    bind();
    const params = new URLSearchParams(location.search);
    const exs = examples(); const pick = Math.max(0, exs.findIndex((e) => e.id === params.get('example')));
    $('#example').value = String(pick);
    loadExample(exs[pick]);
    if (params.get('speed')) { S.speed = +params.get('speed'); $('#pSpeed').value = params.get('speed'); }
    if (params.get('t')) S.playhead = +params.get('t') * 1e6;
    if (params.get('paused')) { S.playing = false; updatePlayBtn(); }
    if (params.get('stress')) { setStress(true); S.stress.load = +params.get('stress'); syncStressUI(); recompute(); }
    if (params.get('select')) { const m = S.set.find((x) => x.name === params.get('select')); if (m) select(m.key); }
    if (params.get('tour')) startTour();
    requestAnimationFrame(frameLoop);
    window.__canproof = S; // for automated UI tests
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
