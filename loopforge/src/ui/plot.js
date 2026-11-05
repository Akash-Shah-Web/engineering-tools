/* LoopForge plotting — small dependency-free SVG chart engine.
 * Linear/log axes, line/step/points/band series, linked crosshair hover,
 * playback cursor, regions, equal-aspect mode, SVG/PNG/CSV export. */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };

  /* ---------- linked hover hub ---------- */
  const hubs = {};
  const Hub = {
    on(key, fn) { (hubs[key] = hubs[key] || []).push(fn); },
    emit(key, value, src) { (hubs[key] || []).forEach(fn => fn(value, src)); },
  };

  /* ---------- ticks ---------- */
  function niceTicks(a, b, n) {
    if (!(b > a)) { b = a + 1; }
    const span = b - a, step0 = span / Math.max(1, n);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const r = step0 / mag;
    const step = (r >= 5 ? 10 : r >= 2 ? 5 : r >= 1 ? 2 : 1) * mag;
    const out = [];
    for (let v = Math.ceil(a / step - 1e-9) * step; v <= b + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return { ticks: out, step };
  }
  function fmtTick(v, step) {
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e5 || a < 1e-3) return v.toExponential(0).replace('e+', 'e');
    const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    return v.toFixed(Math.min(dec, 4));
  }
  function logTicks(a, b) {
    const out = [];
    for (let e = Math.floor(Math.log10(a)); e <= Math.ceil(Math.log10(b)); e++) {
      for (const m of [1, 2, 5]) { const v = m * Math.pow(10, e); if (v >= a * 0.999 && v <= b * 1.001) out.push({ v, major: m === 1 }); }
    }
    return out;
  }
  const fmtLog = v => {
    const e = Math.round(Math.log10(v));
    if (Math.abs(v - Math.pow(10, e)) < 1e-9 * v) return e >= -2 && e <= 3 ? String(+v.toPrecision(3)) : '1e' + e;
    return +v.toPrecision(2) + '';
  };

  function bisect(xs, x) {
    let lo = 0, hi = xs.length - 1;
    if (hi < 0) return -1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] < x) lo = m; else hi = m; }
    return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
  }
  // index of last x <= value (for step series)
  function bisectLeft(xs, x) {
    let lo = 0, hi = xs.length - 1;
    if (hi < 0 || x < xs[0]) return -1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
    return xs[hi] <= x ? hi : lo;
  }

  /* ---------- plot ---------- */
  function create(host, opt) {
    opt = Object.assign({ height: 220, x: {}, y: {}, link: null, margin: { l: 52, r: 14, t: 10, b: 34 } }, opt);
    const wrap = document.createElement('div');
    wrap.className = 'lf-plot';
    host.appendChild(wrap);
    const tip = document.createElement('div');
    tip.className = 'lf-tip';
    wrap.appendChild(tip);
    const svg = el('svg', { class: 'lf-svg', role: 'img', 'aria-label': opt.ariaLabel || opt.title || 'chart' });
    wrap.insertBefore(svg, tip);
    let W = 600, H = opt.height;
    let series = [], regions = [], vlines = [], hlines = [], overlays = [], cursorX = null, hoverKey = null, annotations = [];
    let sx, sy, dom;
    const state = { opt };

    function domain() {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const s of series) {
        if (s.noAuto) continue;
        for (let i = 0; i < s.x.length; i++) {
          const xv = s.x[i], yv = s.y[i];
          if (!isFinite(xv) || !isFinite(yv)) continue;
          if (opt.x.log && xv <= 0) continue;
          if (opt.y.log && yv <= 0) continue;
          if (xv < x0) x0 = xv; if (xv > x1) x1 = xv;
          if (yv < y0) y0 = yv; if (yv > y1) y1 = yv;
        }
        if (s.y2) for (let i = 0; i < s.y2.length; i++) { const v = s.y2[i]; if (isFinite(v)) { if (v < y0) y0 = v; if (v > y1) y1 = v; } }
      }
      if (opt.x.domain) [x0, x1] = opt.x.domain;
      if (opt.y.domain) [y0, y1] = opt.y.domain;
      if (opt.y.include) for (const v of opt.y.include) { y0 = Math.min(y0, v); y1 = Math.max(y1, v); }
      if (opt.x.include) for (const v of opt.x.include) { x0 = Math.min(x0, v); x1 = Math.max(x1, v); }
      if (!isFinite(x0)) { x0 = 0; x1 = 1; }
      if (!isFinite(y0)) { y0 = 0; y1 = 1; }
      if (x1 === x0) { x1 = x0 + 1; }
      if (y1 === y0) { y0 -= 1; y1 += 1; }
      if (!opt.y.domain && !opt.y.log) { const pad = (y1 - y0) * (opt.y.pad === undefined ? 0.06 : opt.y.pad); y0 -= pad; y1 += pad; }
      if (opt.aspect === 'equal') {
        const pw = W - opt.margin.l - opt.margin.r, ph = H - opt.margin.t - opt.margin.b;
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const sc = Math.max((x1 - x0) / pw, (y1 - y0) / ph) * 1.04;
        x0 = cx - sc * pw / 2; x1 = cx + sc * pw / 2; y0 = cy - sc * ph / 2; y1 = cy + sc * ph / 2;
      }
      return { x0, x1, y0, y1 };
    }

    function scales() {
      const m = opt.margin;
      const L = m.l, R = W - m.r, T = m.t, B = H - m.b;
      const lin = (a, b, p, q) => v => p + (v - a) / (b - a) * (q - p);
      const lg = (a, b, p, q) => v => p + (Math.log10(v) - Math.log10(a)) / (Math.log10(b) - Math.log10(a)) * (q - p);
      sx = (opt.x.log ? lg : lin)(dom.x0, dom.x1, L, R);
      sy = (opt.y.log ? lg : lin)(dom.y0, dom.y1, B, T);
      sx.inv = px => opt.x.log ? Math.pow(10, Math.log10(dom.x0) + (px - L) / (R - L) * (Math.log10(dom.x1) - Math.log10(dom.x0))) : dom.x0 + (px - L) / (R - L) * (dom.x1 - dom.x0);
      sy.inv = py => dom.y0 + (B - py) / (B - T) * (dom.y1 - dom.y0);
      return { L, R, T, B };
    }

    function pathFor(s) {
      const pts = [];
      const n = s.x.length;
      // decimate for very long series: keep min/max per pixel column
      const stride = n > 4 * W ? Math.floor(n / (2 * W)) : 1;
      let d = '', pen = false;
      const push = (X, Y) => { d += (pen ? 'L' : 'M') + X.toFixed(1) + ' ' + Y.toFixed(1); pen = true; };
      if (stride > 1 && s.kind !== 'step') {
        for (let i = 0; i < n; i += stride) {
          let mn = Infinity, mx = -Infinity, imn = i, imx = i;
          for (let j = i; j < Math.min(n, i + stride); j++) { const v = s.y[j]; if (v < mn) { mn = v; imn = j; } if (v > mx) { mx = v; imx = j; } }
          const a = imn < imx ? imn : imx, b = imn < imx ? imx : imn;
          for (const j of [a, b]) { if (isFinite(s.y[j])) push(sx(s.x[j]), sy(clampY(s.y[j]))); else pen = false; }
        }
        return d;
      }
      for (let i = 0; i < n; i++) {
        const xv = s.x[i], yv = s.y[i];
        if (!isFinite(xv) || !isFinite(yv) || (opt.x.log && xv <= 0)) { pen = false; continue; }
        const X = sx(xv), Y = sy(clampY(yv));
        if (s.kind === 'step' && pen) d += 'H' + X.toFixed(1);
        push(X, Y);
      }
      return d;
      function clampY(v) { return Math.max(dom.y0 - (dom.y1 - dom.y0) * 2, Math.min(dom.y1 + (dom.y1 - dom.y0) * 2, v)); }
    }

    function render() {
      W = Math.max(240, wrap.clientWidth || 600);
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      // legend first: lay out (wrapping) to know how much top margin it needs
      const named = series.filter(s => s.name && !s.hidden && !s.noLegend);
      let legendRows = 0;
      const lg = el('g', { class: 'lf-legend' });
      if (named.length >= 2 || opt.forceLegend) {
        svg.appendChild(lg);
        const L0 = opt.margin.l, R0 = W - opt.margin.r;
        let lx = L0, row = 0;
        for (const s of named) {
          const gi = el('g', {}, lg);
          const t = el('text', { x: 18, y: 0, class: 'lf-legend-text' }, gi); t.textContent = s.name;
          let tw = 0; try { tw = t.getComputedTextLength(); } catch (e) { tw = 0; }
          if (!(tw > 0)) tw = s.name.length * 6.2;
          if (lx > L0 && lx + 18 + tw > R0) { row++; lx = L0; }
          const ly = 13 + row * 15;
          gi.setAttribute('transform', `translate(${lx} ${ly})`);
          if (s.kind === 'points') el('circle', { cx: 6, cy: -4, r: s.symbol ? 4 : 3, style: `fill:${s.symbol === 'o' ? 'none' : s.color};stroke:${s.color}` }, gi);
          else el('line', { x1: 0, x2: 14, y1: -4, y2: -4, style: `stroke:${s.color}`, 'stroke-width': s.kind === 'band' ? 6 : 2, 'stroke-dasharray': s.dash || '', opacity: s.kind === 'band' ? 0.4 : 1 }, gi);
          lx += 30 + tw;
        }
        legendRows = row + 1;
      }
      opt.margin.t = legendRows ? 10 + legendRows * 15 : 10;
      H = opt.height + legendRows * 15;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.setAttribute('width', W); svg.setAttribute('height', H);
      dom = domain();
      const { L, R, T, B } = scales();
      const clipId = 'c' + Math.random().toString(36).slice(2);
      const defs = el('defs', {}, svg);
      const cp = el('clipPath', { id: clipId }, defs);
      el('rect', { x: L, y: T, width: R - L, height: B - T }, cp);
      el('rect', { x: 0, y: 0, width: W, height: H, class: 'lf-bg' }, svg);
      // grid + ticks
      const g = el('g', { class: 'lf-axis' }, svg);
      if (opt.x.log) {
        for (const t of logTicks(dom.x0, dom.x1)) {
          el('line', { x1: sx(t.v), x2: sx(t.v), y1: T, y2: B, class: t.major ? 'lf-grid' : 'lf-grid minor' }, g);
          if (t.major || (dom.x1 / dom.x0 < 300)) { const tx = el('text', { x: sx(t.v), y: B + 14, 'text-anchor': 'middle', class: 'lf-tick' }, g); tx.textContent = fmtLog(t.v); }
        }
      } else {
        const nt = niceTicks(dom.x0, dom.x1, Math.max(3, Math.floor((R - L) / 80)));
        for (const v of nt.ticks) {
          el('line', { x1: sx(v), x2: sx(v), y1: T, y2: B, class: 'lf-grid' }, g);
          const tx = el('text', { x: sx(v), y: B + 14, 'text-anchor': 'middle', class: 'lf-tick' }, g); tx.textContent = fmtTick(v, nt.step);
        }
      }
      if (opt.y.log) {
        for (const t of logTicks(dom.y0, dom.y1)) if (t.major) {
          el('line', { x1: L, x2: R, y1: sy(t.v), y2: sy(t.v), class: 'lf-grid' }, g);
          const tx = el('text', { x: L - 6, y: sy(t.v) + 4, 'text-anchor': 'end', class: 'lf-tick' }, g); tx.textContent = fmtLog(t.v);
        }
      } else {
        const nt = niceTicks(dom.y0, dom.y1, Math.max(2, Math.floor((B - T) / 42)));
        for (const v of nt.ticks) {
          el('line', { x1: L, x2: R, y1: sy(v), y2: sy(v), class: v === 0 && opt.y.zeroLine ? 'lf-grid zero' : 'lf-grid' }, g);
          const tx = el('text', { x: L - 6, y: sy(v) + 4, 'text-anchor': 'end', class: 'lf-tick' }, g); tx.textContent = fmtTick(v, nt.step);
        }
      }
      el('line', { x1: L, x2: R, y1: B, y2: B, class: 'lf-baseline' }, g);
      if (opt.x.label) { const t = el('text', { x: (L + R) / 2, y: H - 4, 'text-anchor': 'middle', class: 'lf-label' }, g); t.textContent = opt.x.label; }
      if (opt.y.label) { const t = el('text', { x: 12, y: (T + B) / 2, 'text-anchor': 'middle', class: 'lf-label', transform: `rotate(-90 12 ${(T + B) / 2})` }, g); t.textContent = opt.y.label; }

      const body = el('g', { 'clip-path': `url(#${clipId})` }, svg);
      for (const r of regions) {
        const x0 = sx(Math.max(r.x0, dom.x0)), x1 = sx(Math.min(r.x1, dom.x1));
        if (x1 > x0) el('rect', { x: x0, y: T, width: x1 - x0, height: B - T, class: 'lf-region ' + (r.cls || ''), fill: r.color || '' }, body);
        if (r.label && x1 - x0 > 50) { const t = el('text', { x: x0 + 4, y: T + 12, class: 'lf-region-label' }, body); t.textContent = r.label; }
      }
      for (const h of hlines) { el('line', { x1: L, x2: R, y1: sy(h.y), y2: sy(h.y), class: 'lf-hline ' + (h.cls || '') }, body); if (h.label) { const t = el('text', { x: R - 4, y: sy(h.y) - 4, 'text-anchor': 'end', class: 'lf-hline-label' }, body); t.textContent = h.label; } }
      for (const o of overlays) {
        if (o.type === 'circle') el('circle', { cx: sx(o.cx), cy: sy(o.cy), r: Math.abs(sx(o.cx + o.r) - sx(o.cx)), class: 'lf-overlay ' + (o.cls || '') }, body);
        if (o.type === 'cross') { const X = sx(o.x), Y = sy(o.y); el('path', { d: `M${X - 6} ${Y}H${X + 6}M${X} ${Y - 6}V${Y + 6}`, class: 'lf-critical' }, body); }
      }
      for (const s of series) {
        if (s.hidden) continue;
        if (s.kind === 'band') {
          let d = '';
          for (let i = 0; i < s.x.length; i++) d += (i ? 'L' : 'M') + sx(s.x[i]).toFixed(1) + ' ' + sy(s.y[i]).toFixed(1);
          for (let i = s.x.length - 1; i >= 0; i--) d += 'L' + sx(s.x[i]).toFixed(1) + ' ' + sy(s.y2[i]).toFixed(1);
          el('path', { d: d + 'Z', class: 'lf-band', style: `fill:${s.color}`, opacity: s.opacity || 0.18 }, body);
        } else if (s.kind === 'points') {
          const gp = el('g', { class: 'lf-points', style: `color:${s.color}` }, body);
          const r = s.r || 2;
          const stride = s.x.length > 3 * W ? Math.ceil(s.x.length / (3 * W)) : 1;
          for (let i = 0; i < s.x.length; i += stride) {
            if (!isFinite(s.y[i])) continue;
            const X = sx(s.x[i]), Y = sy(s.y[i]);
            if (s.symbol === 'x') el('path', { d: `M${X - 5} ${Y - 5}L${X + 5} ${Y + 5}M${X - 5} ${Y + 5}L${X + 5} ${Y - 5}`, class: 'lf-sym-x' }, gp);
            else if (s.symbol === 'o') el('circle', { cx: X, cy: Y, r: 5, class: 'lf-sym-o' }, gp);
            else el('circle', { cx: X, cy: Y, r, class: 'lf-dot', opacity: s.opacity || 0.7 }, gp);
          }
        } else {
          el('path', { d: pathFor(s), class: 'lf-line ' + (s.cls || ''), style: `stroke:${s.color}`, 'stroke-width': s.width || 2, 'stroke-dasharray': s.dash || '', opacity: s.opacity || 1 }, body);
        }
      }
      for (const v of vlines) {
        if (v.x < dom.x0 || v.x > dom.x1) continue;
        el('line', { x1: sx(v.x), x2: sx(v.x), y1: T, y2: B, class: 'lf-vline ' + (v.cls || '') }, body);
        if (v.label) { const t = el('text', { x: sx(v.x) + 4, y: B - 6, class: 'lf-vline-label' }, body); t.textContent = v.label; }
      }
      for (const a of annotations) {
        const X = sx(a.x), Y = sy(a.y);
        el('circle', { cx: X, cy: Y, r: 4, class: 'lf-anno-dot' }, body);
        const t = el('text', { x: X + (a.dx || 6), y: Y + (a.dy || -6), class: 'lf-anno', 'text-anchor': a.anchor || 'start' }, body); t.textContent = a.text;
      }
      if (legendRows) svg.appendChild(lg);   // keep legend above data
      // cursor + hover layer
      state.cursorG = el('g', { class: 'lf-cursor-g' }, svg);
      state.hoverG = el('g', { class: 'lf-hover-g' }, svg);
      drawCursor(); drawHover();
      const hit = el('rect', { x: L, y: T, width: R - L, height: B - T, class: 'lf-hit' }, svg);
      hit.addEventListener('mousemove', onMove);
      hit.addEventListener('touchstart', ev => onMove(ev.touches[0]), { passive: true });
      hit.addEventListener('touchmove', ev => onMove(ev.touches[0]), { passive: true });
      hit.addEventListener('mouseleave', () => { if (opt.link) Hub.emit(opt.link, null, api); else { hoverKey = null; drawHover(); } });
      if (opt.onClick) hit.addEventListener('click', ev => { const p = toLocal(ev); opt.onClick(sx.inv(p.x), sy.inv(p.y)); });
    }

    function toLocal(ev) {
      const r = svg.getBoundingClientRect();
      return { x: (ev.clientX - r.left) * W / r.width, y: (ev.clientY - r.top) * H / r.height };
    }

    function onMove(ev) {
      const p = toLocal(ev);
      let key;
      if (opt.parametric) {
        // nearest point in screen space among parametric series; key = parameter value
        let best = Infinity, bk = null;
        for (const s of series) if (s.param && !s.hidden) for (let i = 0; i < s.x.length; i++) {
          const dx = sx(s.x[i]) - p.x, dy = sy(s.y[i]) - p.y, dd = dx * dx + dy * dy;
          if (dd < best) { best = dd; bk = s.param[i]; }
        }
        key = bk;
      } else key = sx.inv(p.x);
      if (opt.link) Hub.emit(opt.link, key, api); else { hoverKey = key; drawHover(); }
    }

    function valueAt(s, key) {
      if (opt.parametric) { if (!s.param) return null; const i = bisect(s.param, key); return i < 0 ? null : { i, x: s.x[i], y: s.y[i] }; }
      const i = s.kind === 'step' ? bisectLeft(s.x, key) : bisect(s.x, key);
      if (i < 0) return null;
      return { i, x: s.x[i], y: s.y[i] };
    }

    function drawHover() {
      const g = state.hoverG; if (!g) return;
      while (g.firstChild) g.removeChild(g.firstChild);
      if (hoverKey === null || hoverKey === undefined || !dom) { tip.style.opacity = 0; return; }
      const { L, R, T, B } = scales();
      const rows = [];
      let anchorX = null, anchorY = null;
      if (!opt.parametric) {
        if (hoverKey < dom.x0 || hoverKey > dom.x1) { tip.style.opacity = 0; return; }
        const X = sx(hoverKey);
        el('line', { x1: X, x2: X, y1: T, y2: B, class: 'lf-crosshair' }, g);
        anchorX = X;
      }
      for (const s of series) {
        if (s.hidden || s.noHover || s.kind === 'band') continue;
        const v = valueAt(s, hoverKey);
        if (!v || !isFinite(v.y)) continue;
        if (!opt.parametric && Math.abs(sx(v.x) - sx(hoverKey)) > 40 && s.kind === 'points') continue;
        const X = sx(v.x), Y = sy(v.y);
        if (Y >= T - 2 && Y <= B + 2 && X >= L - 2 && X <= R + 2) {
          el('circle', { cx: X, cy: Y, r: 4.5, class: 'lf-hover-dot', style: `fill:${s.color}` }, g);
          if (anchorY === null) anchorY = Y;
          if (opt.parametric) { anchorX = X; anchorY = Y; }
        }
        rows.push({ name: s.name || s.id, color: s.color, v, s });
      }
      if (!rows.length) { tip.style.opacity = 0; return; }
      const fx = opt.x.fmt || (v => (+v).toPrecision(4));
      const fy = opt.y.fmt || (v => (+v).toPrecision(4));
      let html = '';
      if (opt.parametric) html += `<div class="lf-tip-h">${opt.paramLabel || 'p'} = ${(opt.paramFmt || fx)(hoverKey)}</div>`;
      else html += `<div class="lf-tip-h">${opt.x.short || opt.x.label || 'x'}: ${fx(hoverKey)}</div>`;
      for (const r of rows.slice(0, 8)) {
        const val = opt.parametric ? `${fx(r.v.x)}, ${fy(r.v.y)}` : (r.s.fmt || fy)(r.v.y);
        html += `<div class="lf-tip-r"><i style="background:${r.color}"></i><span>${r.name}</span><b>${val}</b></div>`;
      }
      tip.innerHTML = html;
      tip.style.opacity = 1;
      const rect = wrap.getBoundingClientRect(), scale = rect.width / W;
      const tw = tip.offsetWidth;
      let px = (anchorX || L) * scale + 14;
      if (px + tw > rect.width - 4) px = (anchorX || L) * scale - tw - 14;
      tip.style.left = Math.max(2, px) + 'px';
      tip.style.top = Math.max(2, ((anchorY || T) * scale) - 20) + 'px';
    }

    function drawCursor() {
      const g = state.cursorG; if (!g || !dom) return;
      while (g.firstChild) g.removeChild(g.firstChild);
      if (cursorX === null || opt.parametric || cursorX < dom.x0 || cursorX > dom.x1) return;
      const { T, B } = scales();
      const X = sx(cursorX);
      el('line', { x1: X, x2: X, y1: T, y2: B, class: 'lf-cursor' }, g);
      el('path', { d: `M${X - 5} ${T}L${X + 5} ${T}L${X} ${T + 6}Z`, class: 'lf-cursor-head' }, g);
      if (opt.cursorDots) for (const s of series) {
        if (s.hidden || s.kind === 'band' || s.noCursor) continue;
        const v = valueAt(s, cursorX); if (!v || !isFinite(v.y)) continue;
        el('circle', { cx: sx(v.x), cy: sy(Math.max(dom.y0, Math.min(dom.y1, v.y))), r: 3.5, class: 'lf-cursor-dot', style: `fill:${s.color}` }, g);
      }
    }

    if (opt.link) Hub.on(opt.link, (k) => { hoverKey = k; drawHover(); });
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') { let lastW = 0; ro = new ResizeObserver(() => { const w = wrap.clientWidth; if (Math.abs(w - lastW) > 2) { lastW = w; render(); } }); ro.observe(wrap); }

    const api = {
      el: wrap, opt,
      set(s, o) { series = s; if (o) { if (o.regions) regions = o.regions; if (o.vlines) vlines = o.vlines; if (o.hlines) hlines = o.hlines; if (o.overlays) overlays = o.overlays; if (o.annotations) annotations = o.annotations; } render(); },
      update(o) { Object.assign(opt, o); render(); },
      cursor(x) { cursorX = x; drawCursor(); },
      series: () => series,
      render,
      toSVG() {
        const clone = svg.cloneNode(true);
        clone.setAttribute('xmlns', NS);
        inlineStyles(svg, clone);
        return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
      },
      toCSV() {
        const ss = series.filter(s => s.x && s.x.length && !s.noExport);
        const cols = [];
        for (const s of ss) {
          const nm = (s.name || s.id || 'series').replace(/[",]/g, ' ');
          cols.push({ h: `${nm} [${opt.parametric ? 're' : opt.x.short || 'x'}]`, v: s.x });
          cols.push({ h: `${nm} [${opt.parametric ? 'im' : opt.y.short || 'y'}]`, v: s.y });
          if (s.param) cols.push({ h: `${nm} [${opt.paramLabel || 'param'}]`, v: s.param });
          if (s.y2) cols.push({ h: `${nm} [upper]`, v: s.y2 });
        }
        const n = Math.max(0, ...cols.map(c => c.v.length));
        const lines = [cols.map(c => '"' + c.h + '"').join(',')];
        for (let i = 0; i < n; i++) lines.push(cols.map(c => (i < c.v.length && isFinite(c.v[i]) ? +(+c.v[i]).toPrecision(10) : '')).join(','));
        return (opt.csvHeader ? opt.csvHeader.map(l => '# ' + l).join('\n') + '\n' : '') + lines.join('\n') + '\n';
      },
      toPNG(scale) {
        return new Promise((resolve, reject) => {
          const s = scale || 2;
          const img = new Image();
          const blob = new Blob([api.toSVG()], { type: 'image/svg+xml' });
          const url = URL.createObjectURL(blob);
          img.onload = () => {
            const c = document.createElement('canvas'); c.width = W * s; c.height = H * s;
            const ctx = c.getContext('2d'); ctx.scale(s, s); ctx.drawImage(img, 0, 0);
            URL.revokeObjectURL(url);
            c.toBlob(b => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
          };
          img.onerror = e => { URL.revokeObjectURL(url); reject(e); };
          img.src = url;
        });
      },
    };
    return api;
  }

  // copy computed presentation styles onto the clone so exported SVG is standalone
  const PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'fill-opacity', 'stroke-opacity', 'font-size', 'font-family', 'font-weight', 'color'];
  function inlineStyles(src, dst) {
    const a = src.querySelectorAll('*'), b = dst.querySelectorAll('*');
    for (let i = 0; i < a.length; i++) {
      const cs = getComputedStyle(a[i]);
      let st = '';
      for (const p of PROPS) st += `${p}:${cs.getPropertyValue(p)};`;
      b[i].setAttribute('style', st);
      if (b[i].classList && b[i].classList.contains('lf-hit')) b[i].setAttribute('style', 'fill:none;stroke:none');
    }
    const g = dst.querySelector('.lf-hover-g'); if (g) g.remove();
  }

  root.LFPlot = { create, Hub, niceTicks };
})(typeof self !== 'undefined' ? self : this);
