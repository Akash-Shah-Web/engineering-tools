/* ActiveRide replay viewer — application wiring. */
(function () {
  "use strict";
  const AR = window.AR;
  const $ = (s) => document.querySelector(s);
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const CTRL_ORDER = ["skyhook", "lqr", "preview", "passive"];
  const store = {
    get(k) { try { return localStorage.getItem("activeride." + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem("activeride." + k, v); } catch (e) { /* storage unavailable */ } },
  };

  let D, stage, plots;
  const S = { sc: null, ctrlA: "passive", ctrlB: "preview", t: 0, playing: true, speed: 1, hoverT: null,
              corner: 0, win: 10, exag: 10, forces: true, tyre: false, heat: false, ghost: false, endPause: 0 };

  /* ------------------------------------------------------------------ */
  function init() {
    D = AR.loadData();
    const savedTheme = store.get("theme");
    document.documentElement.dataset.theme = savedTheme || "dark";   // dark dashboard by default

    // scenario picker grouped by data kind
    const sel = $("#scenarioSel");
    for (const kind of ["measured", "synthetic"]) {
      const og = document.createElement("optgroup");
      og.label = kind === "measured" ? "MEASURED road (LiRA-CD)" : "SYNTHETIC obstacles";
      D.scenarios.forEach((s, i) => { if (s.kind === kind) { const o = new Option(`${s.label.replace("SYNTHETIC ", "")} · ${s.speed_kmh} km/h`, i); og.appendChild(o); } });
      sel.appendChild(og);
    }
    sel.addEventListener("change", () => setScenario(+sel.value, true));
    // controller switch (active car) and reference
    const seg = $("#ctrlSeg");
    for (const c of CTRL_ORDER) {
      const b = document.createElement("button");
      b.dataset.c = c; b.setAttribute("role", "radio");
      b.innerHTML = `<i style="background:var(--c-${c})"></i>${D.controllers[c]}`;
      b.addEventListener("click", () => setControllers(S.ctrlA, c));
      seg.appendChild(b);
    }
    const ref = $("#refSel");
    for (const c of ["passive", "skyhook", "lqr", "preview"]) ref.appendChild(new Option("vs " + D.controllers[c], c));
    ref.addEventListener("change", () => setControllers(ref.value, S.ctrlB));

    stage = new AR.Stage($("#view3d"), D);
    const C = () => S.corner, cn = () => ["FL", "FR", "RL", "RR"][S.corner];
    const specs = [
      { title: () => "Seat vertical acceleration", unit: "m/s²", d: 3, td: 1, range: "sym", get: (r, i) => r.ch.acc_seat[i] },
      { title: () => "Running a_w (Wk, 1 s window)", unit: "m/s²", d: 3, td: 2, range: "zero", get: (r, i) => r.ch.aw_run[i] },
      { title: () => "Body pitch (+ = nose down)", unit: "mrad", d: 2, td: 1, range: "sym", get: (r, i) => 1000 * r.ch.pitch[i] },
      { title: () => "Body roll (+ = left up)", unit: "mrad", d: 2, td: 0, range: "sym", get: (r, i) => 1000 * r.ch.roll[i] },
      { title: () => `Suspension stroke ${cn()} (+ = extension)`, unit: "mm", d: 2, td: 0, range: "sym", get: (r, i) => 1000 * r.ch["s" + C()][i] },
      { title: () => `Tyre load ${cn()}`, unit: "kN", d: 2, td: 1, get: (r, i) => r.ch["F" + C()][i] / 1000 },
      { title: () => `Actuator force ${cn()}`, unit: "kN", d: 3, td: 1, range: "sym", skipPassive: true, get: (r, i) => r.ch["fa" + C()][i] / 1000 },
      { title: () => `Road input at ${cn()} wheel`, unit: "mm", d: 2, td: 0, get: (r, i) => 1000 * r.ch["zr" + C()][i] },
      { title: () => "Actuator power (4 corners)", unit: "W", d: 0, td: 0, range: "sym", skipPassive: true, get: (r, i) => r.ch.power[i] },
    ];
    const bus = {
      seek: (t) => { S.t = t; S.endPause = 0; },
      hover: (t, plot, e) => {
        S.hoverT = t;
        const tip = $("#tipBox");
        if (t == null || !e) { tip.hidden = true; return; }
        const lv = plot.lastVals || {};
        tip.innerHTML = `<b>${plot.spec.title()}</b><div class="row"><span>t</span><span>${t.toFixed(2)} s</span></div>` +
          `<div class="row"><span style="color:var(--c-a)">${D.controllers[S.ctrlA]}</span><span>${lv.a} ${plot.spec.unit}</span></div>` +
          `<div class="row"><span style="color:var(--c-b)">${D.controllers[S.ctrlB]}</span><span>${lv.b} ${plot.spec.unit}</span></div>`;
        placeTip(tip, e.clientX, e.clientY);
      },
    };
    plots = new AR.Plots($("#plotGrid"), specs, bus);
    buildGauge();
    wireTransport();
    wireMisc();
    const start = D.scenarios.findIndex((s) => s.id === "m13_A");
    setScenario(start >= 0 ? start : 0, true);
    setControllers("passive", "preview");
    requestAnimationFrame(loop);
    setTimeout(() => $("#splash").classList.add("is-gone"), 150);
  }

  function placeTip(tip, x, y) {
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
    tip.style.left = Math.max(8, left) + "px"; tip.style.top = Math.max(8, top) + "px";
  }

  /* ------------------------------------------------------------------ */
  function setScenario(i, resetView) {
    S.sc = D.scenarios[i];
    $("#scenarioSel").value = i;
    const kind = S.sc.kind;
    const badge = $("#kindBadge");
    badge.textContent = kind.toUpperCase(); badge.className = "badge " + kind;
    $("#roadChip").innerHTML = `<i class="dot dot-${kind}"></i><span>ROAD · ${kind === "measured" ? "MEASURED (LiRA-CD P79)" : "SYNTHETIC (analytic shape)"}</span>`;
    stage.setScenario(S.sc);
    if (resetView) setExag(kind === "measured" ? 10 : 2);
    $("#tglHeat").disabled = kind !== "measured";
    if (kind !== "measured" && S.heat) setHeat(false);
    S.t = 0; S.endPause = 0;
    refreshRuns();
    buildProvenance();
  }

  function setControllers(a, b) {
    S.ctrlA = a; S.ctrlB = b;
    const root = document.documentElement.style;
    root.setProperty("--c-a", `var(--c-${a})`); root.setProperty("--c-b", `var(--c-${b})`);
    $("#refSel").value = a;
    document.querySelectorAll("#ctrlSeg button").forEach((x) => { const on = x.dataset.c === b; x.classList.toggle("is-on", on); x.setAttribute("aria-checked", on); });
    for (const [id, c, role] of [["#tagA", a, "reference"], ["#tagB", b, "active"]]) {
      $(id).querySelector("span").textContent = D.controllers[c];
      $(id).querySelector("small").textContent = role;
    }
    $("#nameA").textContent = $("#legA").textContent = D.controllers[a];
    $("#nameB").textContent = $("#legB").textContent = D.controllers[b];
    stage.carA.setColor(css("--c-" + a)); stage.carB.setColor(css("--c-" + b));
    refreshRuns();
  }

  function refreshRuns() {
    if (!S.sc) return;
    S.runA = S.sc.run(S.ctrlA); S.runB = S.sc.run(S.ctrlB);
    S.runA._passive = S.ctrlA === "passive"; S.runB._passive = S.ctrlB === "passive";
    S.T = Math.min(S.runA.duration, S.runB.duration);
    $("#tEnd").textContent = S.T.toFixed(2);
    plots.setRuns(S.runA, S.runB);
    buildKPI();
    buildMarks();
  }

  function buildMarks() {
    const m = $("#tlMarks"); m.innerHTML = "";
    const meta = S.sc.meta || {};
    if (meta.obstacle_at_m == null) return;
    const r = S.runB, a = D.vehicle.a, b = D.vehicle.b;
    for (const off of [a, -b]) {
      for (let i = 0; i < r.n; i++) if (r.ch.x[i] + off >= meta.obstacle_at_m) {
        const s = document.createElement("span"); s.style.left = (100 * r.t[i] / S.T) + "%";
        s.title = off > 0 ? "front axle reaches obstacle" : "rear axle reaches obstacle"; m.appendChild(s); break;
      }
    }
  }

  function buildKPI() {
    const tb = $("#kpiTable tbody"); tb.innerHTML = "";
    const mA = S.sc.metrics[S.ctrlA] || {}, mB = S.sc.metrics[S.ctrlB] || {};
    for (const M of AR.METRICS) {
      const a = mA[M.k], b = mB[M.k];
      if (a == null || b == null) continue;
      let dtxt = "", cls = "";
      if (M.better !== 0 && Math.abs(a) > 1e-9) {
        const d = (100 * (b - a)) / Math.abs(a);
        dtxt = (d > 0 ? "+" : "") + d.toFixed(0) + "%";
        const good = M.better < 0 ? d < -0.5 : d > 0.5, bad = M.better < 0 ? d > 0.5 : d < -0.5;
        cls = good ? "better" : bad ? "worse" : "";
      }
      const tr = document.createElement("tr");
      tr.innerHTML = `<td data-tip="${M.tip}">${M.label} <small>${M.unit}</small></td><td>${a.toFixed(M.d)}</td><td>${b.toFixed(M.d)}</td><td class="delta ${cls}">${dtxt}</td>`;
      tb.appendChild(tr);
    }
  }

  function buildProvenance() {
    const s = S.sc, dl = $("#provList");
    const rows = [["Road data", s.kind === "measured" ? `<b style="color:var(--measured)">MEASURED</b> · ${s.source}` : `<b style="color:var(--synthetic)">SYNTHETIC</b> · analytic ${s.meta.shape}, ${(s.meta.height * 1000).toFixed(0)} mm × ${s.meta.length} m, ${s.meta.side} wheel path`]];
    if (s.kind === "measured") {
      rows.push(["Section", `Danish motorway M13, chainage ${s.meta.chainage_start_m.toFixed(0)}–${s.meta.chainage_end_m.toFixed(0)} m`]);
      rows.push(["IRI (L / R)", `${s.iri_m_per_km[0].toFixed(2)} / ${s.iri_m_per_km[1].toFixed(2)} m/km (computed here)`]);
      rows.push(["Processing", "mm→m, per-path line removed, 12 m flat lead-in + 8 m taper; 0.25 m tyre envelope in the sim"]);
    }
    rows.push(["Speed", `${s.speed_kmh} km/h (constant)`]);
    rows.push(["Motion", `<b style="color:var(--simulated)">SIMULATED</b> · MuJoCo plant, 4 kHz; controllers on noisy sensors. Not tested on a real car.`]);
    rows.push(["Display", "Both lanes show the same wheel-path profile; vertical motion scaled ×N (illustrative)."]);
    dl.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  }

  /* ---------------- comfort gauge ---------------- */
  const G = { cx: 130, cy: 128, r: 100, max: 2.0 };
  const gAng = (v) => Math.PI * (1 - Math.sqrt(Math.max(0, Math.min(G.max, v)) / G.max));
  const gPt = (ang, r) => [G.cx + r * Math.cos(ang), G.cy - r * Math.sin(ang)];
  const BANDS = [[0, 0.315, "--good", "not uncomfortable"], [0.315, 0.63, "--measured", "a little uncomfortable"],
                 [0.63, 1.0, "--warn", "fairly uncomfortable"], [1.0, 1.6, "--skyhook-band", "uncomfortable"], [1.6, 2.0, "--bad", "very uncomfortable"]];
  function buildGauge() {
    const svg = $("#gauge");
    let s = "";
    const bandCol = ["#3fb98a", "#9cc46a", "#e3b341", "#e5853b", "#e5534b"];
    BANDS.forEach(([lo, hi], k) => {
      const [x1, y1] = gPt(gAng(lo), G.r), [x2, y2] = gPt(gAng(hi), G.r);
      s += `<path d="M${x1} ${y1} A${G.r} ${G.r} 0 0 1 ${x2} ${y2}" stroke="${bandCol[k]}" stroke-width="12" fill="none" opacity=".85"/>`;
    });
    for (const v of [0, 0.1, 0.315, 0.63, 1.0, 2.0]) {
      const [x1, y1] = gPt(gAng(v), G.r - 9), [x2, y2] = gPt(gAng(v), G.r - 17), [xt, yt] = gPt(gAng(v), G.r - 28);
      s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--muted)" stroke-width="1.2"/><text x="${xt}" y="${yt + 3}" font-size="9" text-anchor="middle" fill="var(--muted)" font-family="var(--mono)">${v}</text>`;
    }
    s += `<g id="needleA"><line x1="${G.cx}" y1="${G.cy}" x2="${G.cx}" y2="${G.cy - G.r + 22}" stroke="var(--c-a)" stroke-width="3" stroke-linecap="round"/></g>`;
    s += `<g id="needleB"><line x1="${G.cx}" y1="${G.cy}" x2="${G.cx}" y2="${G.cy - G.r + 10}" stroke="var(--c-b)" stroke-width="4" stroke-linecap="round"/></g>`;
    s += `<circle cx="${G.cx}" cy="${G.cy}" r="7" fill="var(--surface-3)" stroke="var(--border-strong)"/>`;
    s += `<text x="${G.cx}" y="${G.cy + 18}" text-anchor="middle" font-size="9.5" fill="var(--muted)">running a_w [m/s²] · √ scale</text>`;
    svg.innerHTML = s;
  }
  const smooth = { a: 0, b: 0 };
  function updateGauge(t, dt) {
    const a = S.runA.at("aw_run", t), b = S.runB.at("aw_run", t);
    const k = 1 - Math.exp(-dt * 10);
    smooth.a += (a - smooth.a) * k; smooth.b += (b - smooth.b) * k;
    for (const [id, v] of [["#needleA", smooth.a], ["#needleB", smooth.b]]) {
      const deg = 90 - (gAng(v) * 180) / Math.PI;
      $(id).setAttribute("transform", `rotate(${deg.toFixed(2)} ${G.cx} ${G.cy})`);
    }
    $("#awA").textContent = a.toFixed(3); $("#awB").textContent = b.toFixed(3);
    const band = BANDS.find(([lo, hi]) => b >= lo && b < hi) || BANDS[BANDS.length - 1];
    $("#bandText").innerHTML = `Active car now: <b>${band[3]}</b> <span style="color:var(--muted)">(indicative, ISO 2631-1 Annex C)</span>`;
  }

  /* ---------------- transport ---------------- */
  function setPlaying(p) {
    S.playing = p;
    $("#playIcon").innerHTML = p ? '<path d="M4 2.5h3v11H4zM9 2.5h3v11H9z"/>' : '<path d="M4 2.5v11l9-5.5z"/>';
    $("#playBtn").setAttribute("aria-label", p ? "Pause" : "Play");
  }
  function setSpeed(v) {
    S.speed = v;
    document.querySelectorAll("#speedSeg button").forEach((b) => b.classList.toggle("is-on", +b.dataset.speed === v));
  }
  function setExag(v) {
    S.exag = v; stage.setExag(v);
    $("#exag").value = v; $("#exagVal").textContent = "×" + v;
    $("#exagChip").innerHTML = `<i class="dot dot-illus"></i><span>${v === 1 ? "Vertical ×1 · true scale" : `Vertical ×${v} · illustrative scale`}</span>`;
  }
  function setHeat(on) { S.heat = on; $("#tglHeat").checked = on; stage.setHeat(on); $("#heatLegend").hidden = !on; }
  function setGhost(on) { S.ghost = on; $("#tglGhost").checked = on; stage.setGhost(on); if (!on && S.xray) stage.setXray(true); }
  function setXray(on) { S.xray = on; $("#tglXray").checked = on; stage.setXray(on); }
  function setCam(m) {
    if (m === "wheel" && !S.xray) setXray(true);
    stage.setCam(m); document.querySelectorAll(".cam-btn").forEach((b) => b.classList.toggle("is-on", b.dataset.cam === m)); }

  function wireTransport() {
    $("#playBtn").addEventListener("click", () => setPlaying(!S.playing));
    $("#restartBtn").addEventListener("click", () => { S.t = 0; setPlaying(true); });
    document.querySelectorAll("#speedSeg button").forEach((b) => b.addEventListener("click", () => setSpeed(+b.dataset.speed)));
    const tl = $("#timeline");
    const seek = (e) => { const r = tl.getBoundingClientRect(); S.t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * S.T; S.endPause = 0; };
    let drag = false;
    tl.addEventListener("pointerdown", (e) => { drag = true; tl.setPointerCapture(e.pointerId); seek(e); });
    tl.addEventListener("pointermove", (e) => drag && seek(e));
    tl.addEventListener("pointerup", () => (drag = false));
    $("#tglForces").addEventListener("change", (e) => (S.forces = e.target.checked));
    $("#tglTyre").addEventListener("change", (e) => (S.tyre = e.target.checked));
    $("#tglHeat").addEventListener("change", (e) => setHeat(e.target.checked));
    $("#tglGhost").addEventListener("change", (e) => setGhost(e.target.checked));
    $("#tglXray").addEventListener("change", (e) => setXray(e.target.checked));
    $("#exag").addEventListener("input", (e) => setExag(+e.target.value));
    document.querySelectorAll(".cam-btn").forEach((b) => b.addEventListener("click", () => setCam(b.dataset.cam)));
    document.querySelectorAll("#cornerSeg button").forEach((b) => b.addEventListener("click", () => {
      S.corner = +b.dataset.c; document.querySelectorAll("#cornerSeg button").forEach((x) => x.classList.toggle("is-on", x === b));
      plots.setRuns(S.runA, S.runB);
    }));
    document.querySelectorAll("#winSeg button").forEach((b) => b.addEventListener("click", () => {
      S.win = +b.dataset.w; document.querySelectorAll("#winSeg button").forEach((x) => x.classList.toggle("is-on", x === b));
    }));
  }

  /* ---------------- misc: theme, export, keyboard, hover ---------------- */
  function download(name, href) { const a = document.createElement("a"); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  function blobURL(text, type) { return URL.createObjectURL(new Blob([text], { type })); }
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._h); toast._h = setTimeout(() => (t.hidden = true), 2200); }

  function exportCSV() {
    const A = S.runA, B = S.runB, chs = D.meta.channels.filter((c) => c !== "t");
    const head = ["t_s", ...chs.map((c) => `${S.ctrlA}_${c}`), ...chs.map((c) => `${S.ctrlB}_${c}`)];
    const lines = [`# ActiveRide SIMULATED run data (MuJoCo). Scenario ${S.sc.id} (${S.sc.kind.toUpperCase()} road). Decimated to ${D.meta.rate_hz} Hz. SI units (m, rad, N, m/s^2, W).`, head.join(",")];
    for (let i = 0; i < Math.min(A.n, B.n); i++) {
      const row = [A.t[i].toFixed(4)];
      for (const c of chs) row.push(+A.ch[c][i].toPrecision(7));
      for (const c of chs) row.push(+B.ch[c][i].toPrecision(7));
      lines.push(row.join(","));
    }
    download(`activeride_${S.sc.id}_${S.ctrlA}_vs_${S.ctrlB}.csv`, blobURL(lines.join("\n"), "text/csv"));
  }
  function exportMetrics() {
    const keys = AR.METRICS.map((m) => m.k);
    const lines = ["# ActiveRide whole-run metrics (SIMULATION ONLY)", ["scenario", "road_kind", "controller", ...keys].join(",")];
    for (const s of D.scenarios) for (const c of ["passive", "skyhook", "lqr", "preview"]) if (s.metrics[c])
      lines.push([s.id, s.kind, c, ...keys.map((k) => s.metrics[c][k])].join(","));
    download("activeride_metrics.csv", blobURL(lines.join("\n"), "text/csv"));
  }
  function plotTitle() { return `${S.sc.label} — ${S.sc.speed_kmh} km/h`; }

  function wireMisc() {
    $("#themeBtn").addEventListener("click", () => {
      const t = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = t; store.set("theme", t);
      stage.applyTheme(); stage.carA.setColor(css("--c-" + S.ctrlA)); stage.carB.setColor(css("--c-" + S.ctrlB));
    });
    const menu = $("#exportMenu");
    $("#exportBtn").addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
    document.addEventListener("click", () => (menu.hidden = true));
    menu.addEventListener("click", (e) => {
      const k = e.target.dataset.export; if (!k) return;
      const ca = css("--c-" + S.ctrlA), cb = css("--c-" + S.ctrlB), la = D.controllers[S.ctrlA], lb = D.controllers[S.ctrlB];
      if (k === "png3d") download(`activeride_${S.sc.id}_3d.png`, stage.snapshot());
      if (k === "pngplots") download(`activeride_${S.sc.id}_plots.png`, plots.toPNG(plotTitle(), ca, cb, la, lb));
      if (k === "svgplots") download(`activeride_${S.sc.id}_plots.svg`, blobURL(plots.toSVG(plotTitle(), ca, cb, la, lb), "image/svg+xml"));
      if (k === "csv") exportCSV();
      if (k === "metrics") exportMetrics();
      toast("Exported " + e.target.textContent);
    });
    // generic hover tips
    document.addEventListener("pointerover", (e) => {
      const el = e.target.closest("[data-tip]"); const tip = $("#tipBox");
      if (!el) return;
      tip.innerHTML = el.dataset.tip; placeTip(tip, e.clientX, e.clientY);
      el.addEventListener("pointerleave", () => (tip.hidden = true), { once: true });
    });
    // 3D hover details
    const v = $("#view3d"), tip3 = $("#tip3d");
    v.addEventListener("pointermove", (e) => {
      if (e.buttons) { tip3.hidden = true; return; }
      const hit = stage.pick(e.clientX, e.clientY);
      if (!hit) { tip3.hidden = true; v.style.cursor = ""; return; }
      v.style.cursor = "help";
      const run = hit.car === "A" ? S.runA : S.runB, c = hit.car === "A" ? S.ctrlA : S.ctrlB, i = hit.corner, t = S.t;
      const cn = ["front-left", "front-right", "rear-left", "rear-right"][i];
      tip3.innerHTML = `<b style="color:var(--c-${hit.car === "A" ? "a" : "b"})">${D.controllers[c]} · ${cn}</b>` +
        `<div class="row"><span>Stroke</span><span>${(1000 * run.at("s" + i, t)).toFixed(2)} mm</span></div>` +
        `<div class="row"><span>Tyre load</span><span>${(run.at("F" + i, t) / 1000).toFixed(2)} kN</span></div>` +
        `<div class="row"><span>Actuator force</span><span>${c === "passive" ? "— (no actuator)" : run.at("fa" + i, t).toFixed(0) + " N"}</span></div>` +
        `<div class="row"><span>Road height</span><span>${(1000 * run.at("zr" + i, t)).toFixed(1)} mm</span></div>` +
        `<div class="row"><span>Seat acc.</span><span>${run.at("acc_seat", t).toFixed(3)} m/s²</span></div>`;
      tip3.hidden = false;
      const r = v.getBoundingClientRect();
      tip3.style.left = Math.min(r.width - 240, e.clientX - r.left + 14) + "px";
      tip3.style.top = Math.min(r.height - 150, e.clientY - r.top + 14) + "px";
    });
    v.addEventListener("pointerleave", () => (tip3.hidden = true));
    // keyboard
    window.addEventListener("keydown", (e) => {
      if (e.target.closest("select, input")) return;
      if (e.code === "Space") { e.preventDefault(); setPlaying(!S.playing); }
      else if (e.key === "ArrowRight") S.t = Math.min(S.T, S.t + (e.shiftKey ? 1 : 0.1));
      else if (e.key === "ArrowLeft") S.t = Math.max(0, S.t - (e.shiftKey ? 1 : 0.1));
      else if (["1", "2", "3", "4"].includes(e.key)) setControllers(S.ctrlA, CTRL_ORDER[+e.key - 1]);
      else if (e.key.toLowerCase() === "c") { const m = ["chase", "side", "wheel", "orbit", "cinema"]; setCam(m[(m.indexOf(stage.camMode) + 1) % m.length]); }
      else if (e.key.toLowerCase() === "d") Demo.toggle();
      else if (e.key.toLowerCase() === "g") setGhost(!S.ghost);
      else if (e.key.toLowerCase() === "h" && S.sc.kind === "measured") setHeat(!S.heat);
    });
    $("#demoBtn").addEventListener("click", () => Demo.toggle());
    $("#demoNext").addEventListener("click", () => Demo.go(Demo.i + 1));
    $("#demoPrev").addEventListener("click", () => Demo.go(Demo.i - 1));
    $("#demoExit").addEventListener("click", () => Demo.stop());
  }

  /* ---------------- guided demo ---------------- */
  const idOf = (id) => D.scenarios.findIndex((s) => s.id === id);
  const Demo = {
    on: false, i: 0, t: 0,
    steps: [
      { sc: "m13_A", a: "passive", b: "preview", cam: "chase", speed: 1, t0: 3, dur: 9, exag: 10,
        title: "A real motorway, measured", text: "The road is a profilometer measurement of the Danish M13 (LiRA-CD). Both lanes replay the same left/right wheel paths. Blue: passive car. Amber: preview LQR, which sees 6 m ahead with a noisy sensor." },
      { sc: "m13_A", a: "passive", b: "preview", cam: "chase", speed: 1, t0: 12, dur: 8, exag: 10, heat: true,
        title: "Where the road is rough", text: "The heat map colours the road by a 5 m RMS of measured profile slope (an illustrative proxy). Watch the comfort meter: the active car's running a_w stays lower on the rough patches." },
      { sc: "speed_bump", a: "passive", b: "lqr", cam: "side", speed: 0.25, t0: 2.4, dur: 10, exag: 2, forces: true,
        title: "Speed bump in slow motion", text: "A 70 mm SYNTHETIC bump at 25 km/h, ¼ speed. Arrows show simulated actuator force (blue up, orange down). LQR cuts seat a_w by about a third, but the ±2.5 kN limit saturates." },
      { sc: "pothole", a: "passive", b: "preview", cam: "wheel", speed: 0.25, t0: 1.7, dur: 9, exag: 2, forces: true, tyre: true,
        title: "Wheel close-up: pothole", text: "Left-wheel pothole (SYNTHETIC). Green arrows are tyre load; they collapse when the wheel briefly unloads. Preview pre-loads the actuator before the wheel arrives." },
      { sc: "one_sided_bump", a: "passive", b: "lqr", cam: "cinema", speed: 0.5, t0: 1.6, dur: 9, exag: 2, ghost: true,
        title: "An honest trade-off", text: "On a one-sided bump LQR cuts roll acceleration by ~70 %, yet seat a_w rises: the seat sits on the opposite side, where passive roll and heave partly cancelled. Ghost overlay: translucent = passive." },
      { sc: "m13_C", a: "lqr", b: "preview", cam: "chase", speed: 1, t0: 2, dur: 9, exag: 10,
        title: "Your turn", text: "Switch controllers, scenarios and cameras; hover any plot or the cars for values; export PNG/SVG/CSV. Everything shown is logged simulation output. No controller was tested on a real car." },
    ],
    toggle() { this.on ? this.stop() : this.start(); },
    start() { this.on = true; $("#demoCard").hidden = false; $("#demoBtn").querySelector("span").textContent = "Stop demo"; this.go(0); },
    stop() { this.on = false; $("#demoCard").hidden = true; $("#demoBtn").querySelector("span").textContent = "Guided demo"; setSpeed(1); },
    go(i) {
      if (i < 0) i = 0;
      if (i >= this.steps.length) { this.stop(); return; }
      this.i = i; this.t = 0;
      const s = this.steps[i];
      setScenario(idOf(s.sc), false);
      setControllers(s.a, s.b);
      setExag(s.exag); setSpeed(s.speed); setCam(s.cam);
      setHeat(!!s.heat); setGhost(!!s.ghost); setXray(s.cam === "wheel");
      S.forces = s.forces !== false; $("#tglForces").checked = S.forces;
      S.tyre = !!s.tyre; $("#tglTyre").checked = S.tyre;
      S.t = s.t0; setPlaying(true);
      $("#demoStep").textContent = `STEP ${i + 1} / ${this.steps.length}`;
      $("#demoTitle").textContent = s.title; $("#demoText").textContent = s.text;
      $("#demoNext").textContent = i === this.steps.length - 1 ? "Finish" : "Next";
    },
    tick(dt) {
      if (!this.on) return;
      this.t += dt;
      const s = this.steps[this.i];
      $("#demoBar").style.width = Math.min(100, (100 * this.t) / s.dur) + "%";
      if (this.t >= s.dur) this.go(this.i + 1);
    },
  };

  /* ---------------- main loop ---------------- */
  function carState(run, t, active) {
    const g = (c) => run.at(c, t);
    return { x: g("x"), zs: g("zs"), pitch: g("pitch"), roll: g("roll"), zu: [g("zu0"), g("zu1"), g("zu2"), g("zu3")],
             fa: [g("fa0"), g("fa1"), g("fa2"), g("fa3")], F: [g("F0"), g("F1"), g("F2"), g("F3")], road: [g("zr0"), g("zr1"), g("zr2"), g("zr3")],
             forces: S.forces, tyre: S.tyre, active, fmax: D.vehicle.fmax, F0: D.vehicle.static_tyre_N };
  }
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (S.playing && S.runA) {
      if (S.t >= S.T - 1e-6) {
        S.endPause += dt;
        if (S.endPause > 1.2) { S.t = 0; S.endPause = 0; }
      } else S.t = Math.min(S.T, S.t + dt * S.speed);
    }
    Demo.tick(dt);
    if (S.runA) {
      const t = S.t;
      stage.update(carState(S.runA, t, S.ctrlA !== "passive"), carState(S.runB, t, S.ctrlB !== "passive"), dt);
      const t0 = S.win ? Math.max(0, Math.min(t - S.win * 0.7, S.T - S.win)) : 0, t1 = S.win ? Math.min(S.T, t0 + S.win) : S.T;
      plots.draw(t, t0, Math.max(t1, t0 + 0.5), S.hoverT, css("--c-" + S.ctrlA), css("--c-" + S.ctrlB));
      updateGauge(t, dt);
      $("#tNow").textContent = t.toFixed(2);
      $("#xNow").textContent = Math.max(0, S.runB.at("x", t) - 12).toFixed(0);
      const u = (100 * t) / S.T;
      $("#tlFill").style.width = u + "%"; $("#tlKnob").style.left = u + "%";
    }
    requestAnimationFrame(loop);
  }

  window.addEventListener("DOMContentLoaded", () => {
    try { init(); }
    catch (err) { $("#splash").innerHTML = `<div style="color:var(--bad)">Viewer failed to start: ${err.message}</div>`; console.error(err); }
  });
})();
