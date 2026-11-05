/* CANProof charts: canvas timeline + SVG charts. All values come from the
 * analysis/simulation/trace objects passed in; nothing here is hard-coded. */
(function () {
  'use strict';
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const fmtMs = (ns, d = 3) => (ns / 1e6).toFixed(d);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------------- Timeline ---------------- */
  class Timeline {
    constructor(canvas, hooks) {
      this.c = canvas; this.ctx = canvas.getContext('2d'); this.hooks = hooks; this.view = null; this.hit = [];
      canvas.addEventListener('mousemove', (e) => this.onMove(e));
      canvas.addEventListener('mouseleave', () => { hooks.hover(null); hooks.tip(null); });
      canvas.addEventListener('click', (e) => { const h = this.pick(e); if (h) hooks.select(h.key, h.frame); });
      canvas.addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.shiftKey) return; e.preventDefault(); hooks.zoom(e.deltaY > 0 ? 1.25 : 0.8); }, { passive: false });
    }
    layout() {
      const r = this.c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (this.c.width !== Math.round(r.width * dpr) || this.c.height !== Math.round(r.height * dpr)) {
        this.c.width = Math.round(r.width * dpr); this.c.height = Math.round(r.height * dpr);
      }
      this.dpr = dpr; this.W = r.width; this.H = r.height;
    }
    geometry(v) {
      const small = this.W < 600;
      const left = small ? 74 : 150; const top = 30; const bottom = 22;
      const n = Math.max(1, v.rows.length);
      const rh = Math.max(6, Math.min(18, (this.H - top - bottom - 8) / n));
      return { left, top, bottom, rh, small, right: 10 };
    }
    draw(v) {
      this.view = v; this.layout();
      const ctx = this.ctx; const { W, H } = this; const g = this.geometry(v);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const col = { line: css('--line'), text: css('--text'), muted: css('--muted'), faint: css('--faint'), tx: css('--tx'), bad: css('--bad'), block: css('--block'), interf: css('--interf'), self: css('--self'), accent: css('--accent'), panel2: css('--panel2') };
      const x = (t) => g.left + (t - v.t0) / (v.t1 - v.t0) * (W - g.left - g.right);
      this.hit = [];
      // grid + axis
      ctx.font = '10px ' + css('--mono');
      const span = v.t1 - v.t0; const step = niceStep(span / (g.small ? 4 : 8));
      ctx.fillStyle = col.muted; ctx.strokeStyle = col.line; ctx.lineWidth = 1;
      for (let t = Math.ceil(v.t0 / step) * step; t <= v.t1; t += step) {
        const xx = Math.round(x(t)) + 0.5;
        ctx.beginPath(); ctx.moveTo(xx, g.top - 4); ctx.lineTo(xx, H - g.bottom); ctx.stroke();
        ctx.fillText((t / 1e6).toFixed(step < 1e5 ? 2 : step < 1e6 ? 1 : 0) + ' ms', xx + 3, H - 7);
      }
      // bus row
      ctx.fillStyle = col.muted; ctx.fillText('BUS', 8, g.top - 12);
      const rowIndex = new Map(v.rows.map((r, i) => [r.key, i]));
      const yOf = (i) => g.top + 8 + i * g.rh;
      // row labels and zebra
      v.rows.forEach((r, i) => {
        const y = yOf(i);
        if (r.key === v.selectedKey || r.key === v.hoverKey) { ctx.fillStyle = hexA(col.accent, r.key === v.selectedKey ? 0.14 : 0.08); ctx.fillRect(0, y, W, g.rh); }
        else if (i % 2) { ctx.fillStyle = hexA(col.panel2, 0.6); ctx.fillRect(0, y, W, g.rh); }
      });
      ctx.save(); ctx.beginPath(); ctx.rect(g.left, 0, W - g.left, H); ctx.clip();
      // frames
      const fr = v.frames; const lo = lowerBound(fr, v.t0 - (v.maxLag || 5e7));
      const pad = Math.max(1, g.rh * 0.15);
      for (let i = lo; i < fr.length; i++) {
        const f = fr[i];
        if ((f.release != null ? f.release : f.start) > v.t1) break;
        if (f.end < v.t0 - (v.maxLag || 0) && (f.release == null || f.release + f.D < v.t0)) continue;
        const ri = rowIndex.get(f.key); if (ri == null) continue;
        const y = yOf(ri); const h = g.rh - 2 * pad;
        const future = f.start > v.playhead;
        ctx.globalAlpha = future ? 0.28 : 1;
        if (f.waits && f.release != null) {
          // release marker
          const xr = x(f.release);
          ctx.fillStyle = col.muted; ctx.fillRect(xr, y + pad, 1, h);
          if (f.queued > f.release) { ctx.fillStyle = hexA(col.muted, 0.35); ctx.fillRect(xr, y + g.rh / 2 - 0.5, x(f.queued) - xr, 1); }
          for (const w of f.waits) {
            ctx.fillStyle = w.kind === 'blocking' ? col.block : w.kind === 'self' ? col.self : col.interf;
            const a = x(w.start), b = x(w.end);
            ctx.fillRect(a, y + g.rh * 0.36, Math.max(1, b - a), g.rh * 0.28);
          }
          // deadline tick
          const xd = x(f.release + f.D);
          if (xd >= g.left && xd <= W) { ctx.fillStyle = col.bad; ctx.fillRect(xd - 0.5, y + 1, 1.5, g.rh - 2); }
        }
        const a = x(f.start), b = x(f.end);
        ctx.fillStyle = f.miss ? col.bad : col.tx;
        ctx.fillRect(a, y + pad, Math.max(1.2, b - a), h);
        // bus row
        ctx.fillRect(a, g.top - 22, Math.max(1.2, b - a), 12);
        ctx.globalAlpha = 1;
        if (b >= g.left && a <= W) this.hit.push({ x0: a, x1: Math.max(a + 3, b), y0: y, y1: y + g.rh, key: f.key, frame: f });
      }
      ctx.globalAlpha = 1;
      // playhead
      const xp = x(v.playhead);
      if (xp >= g.left && xp <= W) {
        ctx.strokeStyle = col.accent; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(xp, g.top - 26); ctx.lineTo(xp, H - g.bottom); ctx.stroke();
        ctx.fillStyle = col.accent; ctx.beginPath(); ctx.moveTo(xp - 5, g.top - 28); ctx.lineTo(xp + 5, g.top - 28); ctx.lineTo(xp, g.top - 22); ctx.fill();
      }
      ctx.restore();
      v.rows.forEach((r, i) => {
        if (g.rh < 9) return;
        const y = yOf(i);
        ctx.fillStyle = r.miss ? col.bad : col.text; ctx.font = (g.rh >= 13 ? '11px ' : '9px ') + css('--mono');
        const lbl = g.small ? r.idHex : (r.idHex + ' ' + r.name);
        ctx.fillText(lbl.length > (g.small ? 10 : 22) ? lbl.slice(0, g.small ? 10 : 21) + '…' : lbl, 6, y + g.rh * 0.72);
      });
      ctx.strokeStyle = col.line; ctx.beginPath(); ctx.moveTo(g.left - 0.5, g.top - 26); ctx.lineTo(g.left - 0.5, H - g.bottom); ctx.stroke();
      ctx.fillStyle = col.faint; ctx.font = '10px ' + css('--sans');
      if (v.note) ctx.fillText(v.note, g.left + 4, H - g.bottom - 4);
    }
    pick(e) {
      const r = this.c.getBoundingClientRect(); const px = e.clientX - r.left; const py = e.clientY - r.top;
      let best = null; let bd = Infinity;
      for (const h of this.hit) {
        if (py < h.y0 || py > h.y1) continue;
        const d = px < h.x0 ? h.x0 - px : px > h.x1 ? px - h.x1 : 0;
        if (d < bd && d < 6) { bd = d; best = h; }
      }
      if (!best && this.view) {
        const g = this.geometry(this.view);
        const i = Math.floor((py - g.top - 8) / g.rh);
        if (px < g.left && i >= 0 && i < this.view.rows.length) return { key: this.view.rows[i].key, frame: null };
      }
      return best;
    }
    onMove(e) {
      const h = this.pick(e);
      this.hooks.hover(h ? h.key : null);
      if (h && h.frame) {
        const f = h.frame;
        const waits = (f.waits || []).reduce((a, w) => { a[w.kind] = (a[w.kind] || 0) + (w.end - w.start); return a; }, {});
        const rows = [['Frame', `${f.name || f.key} #${f.k != null ? f.k : ''}`]];
        if (f.release != null) rows.push(['Released', fmtMs(f.release) + ' ms']);
        rows.push(['Tx start', fmtMs(f.start) + ' ms'], ['Tx end', fmtMs(f.end) + ' ms'], ['Length', f.bits + ' bits']);
        if (f.release != null) {
          rows.push(['Response', `${fmtMs(f.R)} ms (D ${fmtMs(f.D)})`]);
          if (waits.blocking) rows.push(['Blocked', fmtMs(waits.blocking) + ' ms']);
          if (waits.interference) rows.push(['Interference', fmtMs(waits.interference) + ' ms']);
        }
        this.hooks.tip(`<div class="tt">${esc(f.name || f.key)} ${f.miss ? '<span class="chip bad">deadline miss</span>' : ''}</div><table>${rows.map((r) => `<tr><td>${r[0]}</td><td>${esc(r[1])}</td></tr>`).join('')}</table>`, e.clientX, e.clientY);
      } else this.hooks.tip(null);
    }
    toSVG() {
      const v = this.view; if (!v) return '';
      const W = Math.max(800, this.W); const g = Object.assign({}, this.geometry(v)); const H = g.top + 8 + v.rows.length * g.rh + g.bottom;
      const x = (t) => g.left + (t - v.t0) / (v.t1 - v.t0) * (W - g.left - g.right);
      const col = { text: css('--text'), muted: css('--muted'), line: css('--line'), tx: css('--tx'), bad: css('--bad'), block: css('--block'), interf: css('--interf'), self: css('--self'), bg: css('--panel'), accent: css('--accent') };
      const o = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="monospace" font-size="10"><rect width="100%" height="100%" fill="${col.bg}"/>`];
      o.push(`<text x="8" y="14" fill="${col.muted}">CANProof timeline — ${esc(v.sourceLabel || '')} — ${fmtMs(v.t0)}…${fmtMs(v.t1)} ms</text>`);
      const rowIndex = new Map(v.rows.map((r, i) => [r.key, i]));
      v.rows.forEach((r, i) => o.push(`<text x="6" y="${g.top + 8 + i * g.rh + g.rh * 0.72}" fill="${r.miss ? col.bad : col.text}">${esc(r.idHex + ' ' + r.name)}</text>`));
      for (const f of v.frames) {
        if (f.start > v.t1 || f.end < v.t0) continue;
        const ri = rowIndex.get(f.key); if (ri == null) continue;
        const y = g.top + 8 + ri * g.rh;
        for (const w of f.waits || []) o.push(`<rect x="${x(w.start).toFixed(1)}" y="${(y + g.rh * 0.36).toFixed(1)}" width="${Math.max(1, x(w.end) - x(w.start)).toFixed(1)}" height="${(g.rh * 0.28).toFixed(1)}" fill="${w.kind === 'blocking' ? col.block : w.kind === 'self' ? col.self : col.interf}"/>`);
        o.push(`<rect x="${x(f.start).toFixed(1)}" y="${y + 2}" width="${Math.max(1, x(f.end) - x(f.start)).toFixed(1)}" height="${g.rh - 4}" fill="${f.miss ? col.bad : col.tx}"/>`);
        if (f.release != null) o.push(`<rect x="${(x(f.release + f.D) - 0.5).toFixed(1)}" y="${y + 1}" width="1.5" height="${g.rh - 2}" fill="${col.bad}"/>`);
      }
      o.push(`<line x1="${x(v.playhead)}" x2="${x(v.playhead)}" y1="${g.top - 20}" y2="${H - g.bottom}" stroke="${col.accent}"/>`);
      o.push('</svg>');
      return o.join('');
    }
  }
  function lowerBound(fr, t) { let lo = 0, hi = fr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (fr[m].end < t) lo = m + 1; else hi = m; } return lo; }
  function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(x))); const m = x / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; }
  function hexA(c, a) {
    if (c.startsWith('#') && (c.length === 7)) { const n = parseInt(c.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
    return c;
  }

  /* ---------------- SVG helpers ---------------- */
  function svgEl(svg, w, h) { svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.setAttribute('width', w); svg.setAttribute('height', h); svg.style.height = 'auto'; svg.innerHTML = ''; return svg; }
  function logTicks(lo, hi) { const t = []; for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) [1, 2, 5].forEach((m) => { const v = m * Math.pow(10, e); if (v >= lo && v <= hi) t.push(v); }); return t; }
  const fmtTick = (v) => v >= 1 ? String(v) : v.toPrecision(1);

  /** Response vs deadline chart. results: analysis.results (priority order). */
  function rdChart(svg, results, hooks, sel) {
    const W = svg.parentElement.clientWidth - 4 || 400; const rh = 15; const top = 18; const left = W < 380 ? 70 : 118; const H = top + results.length * rh + 22;
    svgEl(svg, W, H);
    const vals = results.flatMap((r) => [r.C, Number.isFinite(r.R) ? r.R : r.D * 2, r.D, r.T]).map((x) => x / 1e6);
    const lo = Math.max(0.01, Math.min(...vals) * 0.7); const hi = Math.max(...vals) * 1.3;
    const x = (v) => left + (Math.log10(Math.max(lo, v)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * (W - left - 10);
    const out = [];
    for (const t of logTicks(lo, hi)) out.push(`<g class="grid"><line x1="${x(t)}" x2="${x(t)}" y1="${top - 4}" y2="${H - 20}"/></g><text x="${x(t)}" y="${H - 6}" text-anchor="middle">${fmtTick(t)}</text>`);
    out.push(`<text x="${W - 10}" y="11" text-anchor="end">ms (log)</text>`);
    results.forEach((r, i) => {
      const y = top + i * rh; const R = Number.isFinite(r.R) ? r.R / 1e6 : hi; const bad = !r.schedulable; const ratio = R / (r.D / 1e6);
      const color = bad ? 'var(--bad)' : ratio > 0.8 ? 'var(--warn)' : 'var(--ok)';
      out.push(`<g class="row${r.key === sel ? ' hl' : ''}" data-key="${r.key}" style="cursor:pointer">
        <rect class="bg" x="0" y="${y}" width="${W}" height="${rh}" fill="transparent"/>
        <text x="4" y="${y + 11}" style="fill:${bad ? 'var(--bad)' : 'var(--text)'}">${esc(r.name.length > (left > 100 ? 17 : 9) ? r.name.slice(0, left > 100 ? 16 : 8) + '…' : r.name)}</text>
        <rect x="${x(lo)}" y="${y + 6}" width="${x(r.T / 1e6) - x(lo)}" height="3" rx="1.5" style="fill:var(--line2)"/>
        <rect x="${x(lo)}" y="${y + 3}" width="${Math.max(1, x(R) - x(lo))}" height="9" rx="2" style="fill:${color};opacity:.9"><animate attributeName="width" from="0" to="${Math.max(1, x(R) - x(lo))}" dur=".5s" fill="freeze"/></rect>
        <rect x="${x(r.D / 1e6) - 1}" y="${y + 1}" width="2" height="13" style="fill:var(--text)"/>
      </g>`);
    });
    svg.innerHTML = out.join('');
    svg.querySelectorAll('g.row').forEach((g) => {
      const r = results.find((q) => q.key === g.dataset.key);
      g.addEventListener('mouseenter', (e) => { hooks.hover(r.key); hooks.tip(`<div class="tt">${esc(r.name)}</div><table><tr><td>R</td><td>${Number.isFinite(r.R) ? fmtMs(r.R) : '∞'} ms</td></tr><tr><td>D</td><td>${fmtMs(r.D)} ms</td></tr><tr><td>T</td><td>${fmtMs(r.T)} ms</td></tr><tr><td>C</td><td>${fmtMs(r.C)} ms</td></tr></table>`, e.clientX, e.clientY); });
      g.addEventListener('mousemove', (e) => hooks.tipMove(e.clientX, e.clientY));
      g.addEventListener('mouseleave', () => { hooks.hover(null); hooks.tip(null); });
      g.addEventListener('click', () => hooks.select(r.key));
    });
  }

  /** Observed load per window vs predicted best/worst average load. */
  function loadChart(svg, series, windowS, pred, hooks, playheadS) {
    const W = svg.parentElement.clientWidth - 4 || 400; const H = 170; const L = 38, R = 10, T = 10, B = 22;
    svgEl(svg, W, H);
    if (!series || !series.length) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">No trace loaded — import a CAN log to compare</text>`; return; }
    const maxY = Math.min(1, Math.max(pred.worst || 0, ...series) * 1.25);
    const x = (i) => L + i / Math.max(1, series.length - 1) * (W - L - R);
    const y = (v) => T + (1 - v / maxY) * (H - T - B);
    const out = [];
    for (let k = 0; k <= 4; k++) { const v = maxY * k / 4; out.push(`<g class="grid"><line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/></g><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${(v * 100).toFixed(0)}%</text>`); }
    const dur = series.length * windowS;
    const st = niceStep(dur / 6);
    for (let t = 0; t <= dur; t += st) out.push(`<text x="${L + t / dur * (W - L - R)}" y="${H - 6}" text-anchor="middle">${t.toFixed(st < 1 ? 1 : 0)} s</text>`);
    const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    out.push(`<polygon points="${L},${y(0)} ${pts} ${x(series.length - 1)},${y(0)}" style="fill:var(--accent);opacity:.18"/>`);
    out.push(`<polyline points="${pts}" style="fill:none;stroke:var(--accent);stroke-width:1.5"/>`);
    if (pred.worst != null) out.push(`<line x1="${L}" x2="${W - R}" y1="${y(pred.worst)}" y2="${y(pred.worst)}" style="stroke:var(--bad);stroke-dasharray:5 4"/><text x="${W - R}" y="${y(pred.worst) - 4}" text-anchor="end" style="fill:var(--bad)">predicted worst-case stuffing ${(pred.worst * 100).toFixed(1)}%</text>`);
    if (pred.best != null) out.push(`<line x1="${L}" x2="${W - R}" y1="${y(pred.best)}" y2="${y(pred.best)}" style="stroke:var(--ok);stroke-dasharray:2 3"/><text x="${W - R}" y="${y(pred.best) + 12}" text-anchor="end" style="fill:var(--ok)">no-stuffing ${(pred.best * 100).toFixed(1)}%</text>`);
    if (playheadS != null) { const xp = L + playheadS / dur * (W - L - R); out.push(`<line x1="${xp}" x2="${xp}" y1="${T}" y2="${H - B}" style="stroke:var(--accent2)"/>`); }
    out.push(`<rect id="lchit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>`);
    svg.innerHTML = out.join('');
    const hit = svg.querySelector('#lchit');
    hit.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect(); const sx = (e.clientX - r.left) * (W / r.width);
      const i = Math.max(0, Math.min(series.length - 1, Math.round((sx - L) / (W - L - R) * (series.length - 1))));
      hooks.tip(`<div class="tt">t = ${(i * windowS).toFixed(1)} s</div><table><tr><td>observed load</td><td>${(series[i] * 100).toFixed(2)} %</td></tr><tr><td>window</td><td>${windowS * 1000} ms</td></tr></table>`, e.clientX, e.clientY);
    });
    hit.addEventListener('mouseleave', () => hooks.tip(null));
  }

  /** Observed completion-time spread vs predicted bound per ID. */
  function cmpChart(svg, rows, hooks, sel) {
    const W = svg.parentElement.clientWidth - 4 || 400;
    const data = rows.filter((r) => r.observedSpread != null && r.predictedBound != null && Number.isFinite(r.predictedBound));
    const rh = 13; const top = 16; const left = W < 380 ? 64 : 90; const H = top + Math.max(1, data.length) * rh + 24;
    svgEl(svg, W, H);
    if (!data.length) { svg.innerHTML = `<text x="${W / 2}" y="30" text-anchor="middle">No comparable IDs (load a trace whose IDs match the model)</text>`; return; }
    const vals = data.flatMap((r) => [r.observedSpread, r.predictedBound]).filter((v) => v > 0).map((v) => v * 1000);
    const lo = Math.max(0.001, Math.min(...vals) * 0.6); const hi = Math.max(...vals) * 1.5;
    const x = (v) => left + (Math.log10(Math.max(lo, v)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * (W - left - 10);
    const out = [];
    for (const t of logTicks(lo, hi)) out.push(`<g class="grid"><line x1="${x(t)}" x2="${x(t)}" y1="${top - 4}" y2="${H - 20}"/></g><text x="${x(t)}" y="${H - 6}" text-anchor="middle">${fmtTick(t)}</text>`);
    out.push(`<text x="${W - 10}" y="10" text-anchor="end">ms (log)</text>`);
    data.forEach((r, i) => {
      const y = top + i * rh; const bad = r.status === 'DISAGREES';
      out.push(`<g class="row${r.key === sel ? ' hl' : ''}" data-key="${r.key}" style="cursor:pointer"><rect class="bg" x="0" y="${y}" width="${W}" height="${rh}" fill="transparent"/>
        <text x="4" y="${y + 10}" style="fill:${bad ? 'var(--bad)' : 'var(--text)'}">${esc(r.label)}</text>
        <rect x="${x(lo)}" y="${y + 4}" width="${Math.max(1, x(r.predictedBound * 1000) - x(lo))}" height="5" rx="2" style="fill:var(--line2)"/>
        <rect x="${x(r.predictedBound * 1000) - 1}" y="${y + 1}" width="2" height="11" style="fill:var(--text)"/>
        <circle cx="${x(Math.max(lo, r.observedSpread * 1000))}" cy="${y + 6.5}" r="4" style="fill:${bad ? 'var(--bad)' : 'var(--ok)'}"/></g>`);
    });
    svg.innerHTML = out.join('');
    svg.querySelectorAll('g.row').forEach((g) => {
      const r = data.find((q) => q.key === g.dataset.key);
      g.addEventListener('mouseenter', (e) => { hooks.hover(r.key); hooks.tip(`<div class="tt">${esc(r.label)} — ${r.status}</div><table><tr><td>observed spread</td><td>${(r.observedSpread * 1000).toFixed(3)} ms</td></tr><tr><td>bound R − C<sub>min</sub></td><td>${(r.predictedBound * 1000).toFixed(3)} ms</td></tr></table>`, e.clientX, e.clientY); });
      g.addEventListener('mousemove', (e) => hooks.tipMove(e.clientX, e.clientY));
      g.addEventListener('mouseleave', () => { hooks.hover(null); hooks.tip(null); });
      g.addEventListener('click', () => hooks.select(r.key));
    });
  }

  window.CANProofCharts = { Timeline, rdChart, loadChart, cmpChart, niceStep };
})();
