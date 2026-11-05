/* Lightweight linked time-series plots (canvas) with SVG/PNG export. */
(function () {
  "use strict";
  const AR = (window.AR = window.AR || {});
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  function niceTicks(lo, hi, n = 4) {
    const span = hi - lo || 1;
    const step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const err = step0 / mag;
    const step = (err >= 7 ? 10 : err >= 3 ? 5 : err >= 1.5 ? 2 : 1) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  const fmt = (v, d) => (Math.abs(v) < 1e-12 ? 0 : v).toFixed(d);

  class Plot {
    constructor(host, spec, bus) {
      this.spec = spec; this.bus = bus;
      this.el = document.createElement("div"); this.el.className = "plot";
      this.el.innerHTML = `<div class="plot-h"><b></b><span></span></div><canvas></canvas>`;
      host.appendChild(this.el);
      this.title = this.el.querySelector("b"); this.read = this.el.querySelector("span");
      this.cv = this.el.querySelector("canvas"); this.g = this.cv.getContext("2d");
      this.pad = { l: 44, r: 8, t: 6, b: 18 };
      const seek = (e) => { const t = this.tAt(e.clientX); if (t != null) bus.seek(t); };
      let drag = false;
      this.cv.addEventListener("pointerdown", (e) => { drag = true; this.cv.setPointerCapture(e.pointerId); seek(e); });
      this.cv.addEventListener("pointerup", () => (drag = false));
      this.cv.addEventListener("pointermove", (e) => { if (drag) seek(e); bus.hover(this.tAt(e.clientX), this, e); });
      this.cv.addEventListener("pointerleave", () => bus.hover(null, this));
    }
    setData(runA, runB, getter, range) {
      this.A = runA; this.B = runB; this.get = getter;
      // fixed y-range over the whole run (both cars) so the axes do not jump
      let lo = Infinity, hi = -Infinity;
      for (const r of [runA, runB]) if (r) for (let i = 0; i < r.n; i++) { const v = getter(r, i); if (v < lo) lo = v; if (v > hi) hi = v; }
      if (!isFinite(lo)) { lo = -1; hi = 1; }
      if (range === "sym") { const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1; lo = -m; hi = m; }
      if (range === "zero") lo = Math.min(0, lo);
      const padv = (hi - lo) * 0.08 || 0.1;
      this.lo = lo - padv; this.hi = hi + padv;
      this.ticks = niceTicks(this.lo, this.hi, 3);
    }
    size() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = this.cv.clientWidth, h = this.cv.clientHeight;
      if (this.cv.width !== Math.round(w * dpr) || this.cv.height !== Math.round(h * dpr)) {
        this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
      }
      this.dpr = dpr; this.w = w; this.h = h;
    }
    xOf(t) { return this.pad.l + ((t - this.t0) / (this.t1 - this.t0)) * (this.w - this.pad.l - this.pad.r); }
    yOf(v) { return this.pad.t + (1 - (v - this.lo) / (this.hi - this.lo)) * (this.h - this.pad.t - this.pad.b); }
    tAt(cx) {
      if (!this.w) return null;
      const r = this.cv.getBoundingClientRect();
      const u = (cx - r.left - this.pad.l) / (this.w - this.pad.l - this.pad.r);
      return this.t0 + Math.max(0, Math.min(1, u)) * (this.t1 - this.t0);
    }
    valAt(run, t) {
      if (!run) return null;
      const f = run.idx(t), i = Math.floor(f), w = f - i;
      return this.get(run, i) * (1 - w) + this.get(run, Math.min(run.n - 1, i + 1)) * w;
    }
    draw(t, t0, t1, hoverT, colA, colB) {
      this.size(); this.t0 = t0; this.t1 = t1;
      const g = this.g, p = this.pad;
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.clearRect(0, 0, this.w, this.h);
      g.font = "10.5px " + css("--mono"); g.textBaseline = "middle";
      g.strokeStyle = css("--plot-grid"); g.fillStyle = css("--muted"); g.lineWidth = 1;
      for (const v of this.ticks) {
        const y = Math.round(this.yOf(v)) + 0.5;
        g.beginPath(); g.moveTo(p.l, y); g.lineTo(this.w - p.r, y); g.stroke();
        g.textAlign = "right"; g.fillText(fmt(v, this.spec.td ?? 1), p.l - 6, y);
      }
      const tt = niceTicks(t0, t1, this.w < 360 ? 3 : 5);
      g.textAlign = "center"; g.textBaseline = "top";
      for (const v of tt) g.fillText(v.toFixed(t1 - t0 < 4 ? 1 : 0) + "s", this.xOf(v), this.h - p.b + 4);
      const series = [[this.A, colA, 1.4], [this.B, colB, 1.7]];
      g.save(); g.beginPath(); g.rect(p.l, p.t, this.w - p.l - p.r, this.h - p.t - p.b); g.clip();
      for (const [run, col, lw] of series) {
        if (!run || (this.spec.skipPassive && run._passive)) continue;
        const i0 = Math.max(0, Math.floor(run.idx(t0)) - 1), i1 = Math.min(run.n - 1, Math.ceil(run.idx(t1)) + 1);
        const stride = Math.max(1, Math.floor((i1 - i0) / (this.w * 1.5)));
        g.beginPath(); g.strokeStyle = col; g.lineWidth = lw; g.lineJoin = "round";
        for (let i = i0; i <= i1; i += stride) {
          const x = this.xOf(run.t[i]), y = this.yOf(this.get(run, i));
          i === i0 ? g.moveTo(x, y) : g.lineTo(x, y);
        }
        g.stroke();
      }
      g.restore();
      // play cursor
      const xc = this.xOf(t);
      g.strokeStyle = css("--accent"); g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(xc, p.t); g.lineTo(xc, this.h - p.b); g.stroke();
      // hover crosshair (linked)
      const th = hoverT != null ? hoverT : t;
      if (hoverT != null) {
        const xh = this.xOf(hoverT);
        g.setLineDash([3, 3]); g.strokeStyle = css("--text-2"); g.lineWidth = 1;
        g.beginPath(); g.moveTo(xh, p.t); g.lineTo(xh, this.h - p.b); g.stroke(); g.setLineDash([]);
        for (const [run, col] of series) {
          const v = this.valAt(run, hoverT); if (v == null || (this.spec.skipPassive && run._passive)) continue;
          g.fillStyle = col; g.strokeStyle = css("--surface"); g.lineWidth = 2;
          g.beginPath(); g.arc(xh, this.yOf(v), 4, 0, 2 * Math.PI); g.fill(); g.stroke();
        }
      }
      const a = this.valAt(this.A, th), b = this.valAt(this.B, th), d = this.spec.d ?? 2;
      this.title.textContent = this.spec.title();
      const sa = a == null || (this.spec.skipPassive && this.A._passive) ? "—" : fmt(a, d);
      const sb = b == null || (this.spec.skipPassive && this.B._passive) ? "—" : fmt(b, d);
      this.read.innerHTML = `<span style="color:${colA}">${sa}</span> · <span style="color:${colB}">${sb}</span> ${this.spec.unit}`;
      this.lastVals = { t: th, a: sa, b: sb };
    }
    toSVG(x0, y0, w, h, colA, colB) {
      const p = this.pad, X = (t) => x0 + p.l + ((t - this.t0) / (this.t1 - this.t0)) * (w - p.l - p.r);
      const Y = (v) => y0 + 20 + p.t + (1 - (v - this.lo) / (this.hi - this.lo)) * (h - 20 - p.t - p.b);
      let s = `<text x="${x0}" y="${y0 + 12}" class="t">${esc(this.spec.title())} [${esc(this.spec.unit)}]</text>`;
      for (const v of this.ticks) s += `<line x1="${x0 + p.l}" x2="${x0 + w - p.r}" y1="${Y(v)}" y2="${Y(v)}" class="g"/><text x="${x0 + p.l - 5}" y="${Y(v) + 3}" class="a" text-anchor="end">${fmt(v, this.spec.td ?? 1)}</text>`;
      for (const v of niceTicks(this.t0, this.t1, 5)) s += `<text x="${X(v)}" y="${y0 + h - 4}" class="a" text-anchor="middle">${v.toFixed(1)} s</text>`;
      for (const [run, col] of [[this.A, colA], [this.B, colB]]) {
        if (!run || (this.spec.skipPassive && run._passive)) continue;
        const i0 = Math.max(0, Math.floor(run.idx(this.t0))), i1 = Math.min(run.n - 1, Math.ceil(run.idx(this.t1)));
        const pts = [];
        for (let i = i0; i <= i1; i++) pts.push(`${X(run.t[i]).toFixed(1)},${Y(this.get(run, i)).toFixed(1)}`);
        s += `<polyline fill="none" stroke="${col}" stroke-width="1.4" points="${pts.join(" ")}"/>`;
      }
      return s;
    }
  }
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

  AR.Plots = class {
    constructor(host, specs, bus) { this.plots = specs.map((s) => new Plot(host, s, bus)); }
    setRuns(A, B) { for (const p of this.plots) p.setData(A, B, p.spec.get, p.spec.range); }
    draw(t, t0, t1, hoverT, colA, colB) { for (const p of this.plots) p.draw(t, t0, t1, hoverT, colA, colB); }
    toSVG(title, colA, colB, labA, labB) {
      const cols = 3, w = 420, h = 170, rows = Math.ceil(this.plots.length / cols);
      const W = cols * w + 40, H = rows * h + 90;
      let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">`;
      s += `<style>.t{font-size:12px;font-weight:600;fill:#0f141a}.a{font-size:10px;fill:#4c5866}.g{stroke:#e4e8ee;stroke-width:1}</style><rect width="100%" height="100%" fill="#fff"/>`;
      s += `<text x="20" y="26" style="font-size:15px;font-weight:700;fill:#0f141a">${esc(title)}</text>`;
      s += `<text x="20" y="46" class="a">SIMULATED (MuJoCo) · <tspan fill="${colA}">■ ${esc(labA)}</tspan>  <tspan fill="${colB}">■ ${esc(labB)}</tspan></text>`;
      this.plots.forEach((p, k) => { s += p.toSVG(20 + (k % cols) * w, 60 + Math.floor(k / cols) * h, w - 20, h - 10, colA, colB); });
      return s + "</svg>";
    }
    toPNG(title, colA, colB, labA, labB) {
      const cols = 3, w = 520, h = 200, rows = Math.ceil(this.plots.length / cols), sc = 2;
      const c = document.createElement("canvas");
      c.width = (cols * w + 40) * sc; c.height = (rows * h + 80) * sc;
      const g = c.getContext("2d"); g.scale(sc, sc);
      g.fillStyle = css("--surface"); g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = css("--text"); g.font = "bold 16px " + css("--font"); g.fillText(title, 20, 30);
      g.font = "12px " + css("--font"); g.fillStyle = css("--text-2");
      g.fillText(`SIMULATED (MuJoCo) · ${labA} vs ${labB}`, 20, 52);
      this.plots.forEach((p, k) => {
        const x = 20 + (k % cols) * w, y = 66 + Math.floor(k / cols) * h;
        g.fillStyle = css("--text"); g.font = "600 12px " + css("--font"); g.fillText(`${p.spec.title()} [${p.spec.unit}]`, x, y + 10);
        g.drawImage(p.cv, x, y + 16, w - 20, h - 26);
      });
      return c.toDataURL("image/png");
    }
  };
})();
