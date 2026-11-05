/* CANProof 3D x-ray vehicle (three.js). The vehicle model and node positions
 * are ILLUSTRATIVE (a DBC carries no physical location). Pulse emission times,
 * sender/receiver nodes, deadline-miss flashes and bus heat colour are driven
 * by the replayed frames (simulated or logged) supplied by the app. Pulse
 * travel speed is slowed for visibility. */
(function () {
  'use strict';
  const THREE = window.THREE;
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  // Illustrative placements for common ECU roles (matched by name/prefix)
  const KNOWN = [
    [/^(ECM|ECU|PCM|ENG|EMS|DME)/i, [-1.95, 0.9, 0.5]],
    [/^(TCM|TCU|TRANS|GEAR)/i, [-1.15, 0.42, -0.45]],
    [/^(ESC|ABS|EBCM|ESP|BRK|EBS)/i, [-1.62, 0.62, -0.62]],
    [/^(EPS|STEER|PSCM|SAS)/i, [-1.42, 0.45, 0.22]],
    [/^(ADAS|CAM|RADAR|FCM|ACC|LKA)/i, [-0.38, 1.28, 0.0]],
    [/^(IPC|CLUSTER|DASH|IC|HMI)/i, [-0.7, 1.02, 0.5]],
    [/^(BCM|BODY|DOOR|LIGHT)/i, [-0.55, 0.62, -0.72]],
    [/^(GW|GATEWAY|CGW|DCU)/i, [0.0, 0.62, 0.35]],
    [/^(SRS|ACU|AIRBAG|RCM)/i, [0.6, 0.42, -0.25]],
    [/^(HVAC|CLIMATE|AC|CCM)/i, [-0.95, 0.8, -0.3]],
    [/^(BMS|BATT|OBC|HV)/i, [0.5, 0.36, 0.45]],
    [/^(TPMS|PARK|PAM)/i, [1.7, 0.55, -0.4]],
  ];

  class CarScene {
    constructor(container, labelsEl, hooks) {
      this.el = container; this.labelsEl = labelsEl; this.hooks = hooks;
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      container.appendChild(this.renderer.domElement);
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
      this.theta = -0.9; this.phi = 0.5; this.dist = 6.3; this.spin = true;
      this.nodes = new Map(); this.pulses = []; this.flashes = new Map();
      this.load = 0;
      this.buildCar(); this.buildBus();
      this.bindInput();
      this.resize();
      new ResizeObserver(() => this.resize()).observe(container);
    }
    colors() {
      return { accent: new THREE.Color(css('--accent')), text: new THREE.Color(css('--text')), muted: new THREE.Color(css('--muted')), bad: new THREE.Color(css('--bad')), line: new THREE.Color(css('--line2')), ok: new THREE.Color(css('--ok')) };
    }
    buildCar() {
      const c = this.colors();
      const g = new THREE.Group(); this.car = g; this.scene.add(g);
      const prof = [[-2.3, 0.32], [-2.32, 0.62], [-2.05, 0.8], [-0.95, 0.93], [-0.38, 1.38], [0.95, 1.43], [1.78, 1.02], [2.28, 0.94], [2.32, 0.5], [2.12, 0.3], [1.82, 0.3], [1.75, 0.55], [1.15, 0.55], [1.08, 0.3], [-1.08, 0.3], [-1.15, 0.55], [-1.75, 0.55], [-1.82, 0.3]];
      const shape = new THREE.Shape(); prof.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y))); shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 1.76, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.05, bevelSegments: 1 });
      geo.translate(0, 0, -0.88);
      this.shellMat = new THREE.MeshBasicMaterial({ color: c.accent, transparent: true, opacity: 0.045, depthWrite: false, side: THREE.DoubleSide });
      g.add(new THREE.Mesh(geo, this.shellMat));
      this.edgeMat = new THREE.LineBasicMaterial({ color: c.accent, transparent: true, opacity: 0.32 });
      g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), this.edgeMat));
      // greenhouse window lines (low-poly)
      const wpts = [[-0.3, 1.3], [0.9, 1.35], [1.62, 1.0], [-0.82, 0.95]];
      [-0.89, 0.89].forEach((z) => {
        const pts = wpts.concat([wpts[0]]).map(([x, y]) => new THREE.Vector3(x, y, z));
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), this.edgeMat));
      });
      // wheels
      this.innerMat = new THREE.LineBasicMaterial({ color: c.muted, transparent: true, opacity: 0.28 });
      const wgeo = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 12); wgeo.rotateX(Math.PI / 2);
      [[-1.45, 0.82], [-1.45, -0.82], [1.45, 0.82], [1.45, -0.82]].forEach(([x, z]) => {
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(wgeo), this.innerMat); e.position.set(x, 0.34, z); g.add(e);
        const disc = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(0.2, 0.2, 0.04, 10).rotateX(Math.PI / 2)), this.innerMat); disc.position.set(x, 0.34, z * 0.82); g.add(disc);
      });
      // illustrative internal systems
      const box = (sx, sy, sz, x, y, z) => { const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(sx, sy, sz)), this.innerMat); e.position.set(x, y, z); g.add(e); };
      box(0.62, 0.42, 0.66, -1.72, 0.62, -0.02); // engine
      box(0.55, 0.3, 0.32, -1.08, 0.48, -0.02); // transmission
      box(0.1, 0.1, 1.3, -1.45, 0.42, 0); // steering rack
      box(1.5, 0.12, 0.16, 0.02, 0.36, 0); // tunnel / driveshaft
      box(0.22, 0.2, 1.5, -0.62, 0.86, 0); // dashboard beam
      box(0.5, 0.45, 0.5, 0.25, 0.58, 0.42); box(0.5, 0.45, 0.5, 0.25, 0.58, -0.42); // seats
      box(1.0, 0.45, 1.3, 1.3, 0.6, 0); // rear bench/boot
      // floor grid
      const grid = new THREE.GridHelper(9, 18, c.line, c.line); grid.material.transparent = true; grid.material.opacity = 0.25; grid.position.y = 0.0; this.grid = grid; this.scene.add(grid);
    }
    buildBus() {
      const pts = [[-2.05, 0.5, 0.25], [-1.4, 0.4, -0.1], [-0.75, 0.48, 0.0], [-0.05, 0.44, 0.0], [0.8, 0.44, 0.02], [1.85, 0.56, 0.0]].map((p) => new THREE.Vector3(...p));
      this.curve = new THREE.CatmullRomCurve3(pts);
      this.samples = this.curve.getSpacedPoints(240);
      this.busMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(css('--ok')) });
      this.bus = new THREE.Mesh(new THREE.TubeGeometry(this.curve, 160, 0.024, 6, false), this.busMat);
      this.scene.add(this.bus);
      // terminations
      const tg = new THREE.SphereGeometry(0.045, 8, 6);
      [0, 1].forEach((u) => { const m = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ color: new THREE.Color(css('--muted')) })); m.position.copy(this.curve.getPointAt(u)); this.scene.add(m); });
      this.pulseGeo = new THREE.SphereGeometry(0.05, 10, 8);
    }
    nearestU(p) {
      let best = 0, bd = Infinity;
      this.samples.forEach((s, i) => { const d = s.distanceToSquared(p); if (d < bd) { bd = d; best = i; } });
      return best / (this.samples.length - 1);
    }
    /** nodes: [{name, count}] — placement is illustrative. */
    setNodes(list) {
      for (const n of this.nodes.values()) { this.scene.remove(n.mesh); this.scene.remove(n.stub); n.label.remove(); }
      this.nodes.clear();
      const c = this.colors();
      let auto = 0; const used = [];
      list.forEach((n) => {
        let pos = null;
        for (const [re, p] of KNOWN) if (re.test(n.name)) { pos = p; break; }
        if (pos && used.some((u) => Math.hypot(u[0] - pos[0], u[1] - pos[1], u[2] - pos[2]) < 0.15)) pos = null;
        if (!pos) { const u = 0.08 + ((auto++ * 0.161) % 0.84); const b = this.curve.getPointAt(u); pos = [b.x, b.y + 0.32 + (auto % 2) * 0.22, (auto % 2 ? 0.48 : -0.48)]; }
        used.push(pos);
        const v = new THREE.Vector3(...pos);
        const mat = new THREE.MeshBasicMaterial({ color: c.accent.clone(), transparent: true, opacity: 0.85 });
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.13), mat); mesh.position.copy(v);
        const edge = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: c.text })); mesh.add(edge);
        this.scene.add(mesh);
        const u = this.nearestU(v); const bp = this.curve.getPointAt(u);
        const stub = new THREE.Line(new THREE.BufferGeometry().setFromPoints([v, bp]), new THREE.LineBasicMaterial({ color: c.muted, transparent: true, opacity: 0.6 }));
        this.scene.add(stub);
        const label = document.createElement('div'); label.className = 'nodelabel'; label.textContent = n.name; label.title = `${n.name}: ${n.count} message(s) — position illustrative`;
        label.addEventListener('click', () => this.hooks.selectNode(n.name));
        this.labelsEl.appendChild(label);
        this.nodes.set(n.name, { name: n.name, pos: v, u, bp, mesh, mat, stub, label, hot: 0, miss: 0 });
      });
    }
    /** Emit a pulse for a frame: sender -> bus -> broadcast to both terminations. */
    emit(sender, receivers, miss, prioFrac) {
      const n = this.nodes.get(sender) || null;
      const c = this.colors();
      const color = miss ? c.bad : c.accent.clone().lerp(c.text, 0.55 * (1 - prioFrac));
      const mk = () => { const m = new THREE.Mesh(this.pulseGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 })); this.scene.add(m); return m; };
      const u0 = n ? n.u : 0.5;
      this.pulses.push({ age: 0, n, u0, a: mk(), b: mk(), s: mk(), receivers: receivers.map((r) => this.nodes.get(r)).filter(Boolean), miss });
      if (n) { n.hot = 1; if (miss) n.miss = 1; }
      if (this.pulses.length > 80) this.killPulse(this.pulses.shift());
    }
    killPulse(p) { [p.a, p.b, p.s].forEach((m) => { this.scene.remove(m); m.material.dispose(); }); }
    setLoad(load) { this.load = load; }
    heat(load) {
      const stops = [[0, '#2bd38a'], [0.3, '#c9e04a'], [0.55, '#ffb547'], [0.8, '#ff5a6e']];
      let i = 0; while (i < stops.length - 2 && load > stops[i + 1][0]) i++;
      const [a, ca] = stops[i]; const [b, cb] = stops[i + 1];
      const t = Math.max(0, Math.min(1, (load - a) / (b - a)));
      return new THREE.Color(ca).lerp(new THREE.Color(cb), t);
    }
    bindInput() {
      const cv = this.renderer.domElement; let drag = null;
      cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, t: this.theta, p: this.phi }; cv.setPointerCapture(e.pointerId); this.spin = false; this.hooks.spinChanged && this.hooks.spinChanged(false); });
      cv.addEventListener('pointermove', (e) => { if (!drag) return; this.theta = drag.t - (e.clientX - drag.x) * 0.008; this.phi = Math.max(0.05, Math.min(1.35, drag.p + (e.clientY - drag.y) * 0.006)); });
      cv.addEventListener('pointerup', () => { drag = null; });
      cv.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); this.dist = Math.max(4, Math.min(12, this.dist * (e.deltaY > 0 ? 1.08 : 0.92))); }, { passive: false });
    }
    resize() {
      const w = this.el.clientWidth, h = this.el.clientHeight; if (!w || !h) return;
      this.renderer.setSize(w, h, false); this.camera.aspect = w / h;
      this.dist = w < 520 ? 8.4 : 6.3;
      this.camera.updateProjectionMatrix();
    }
    setTheme() {
      const c = this.colors();
      this.shellMat.color.copy(c.accent); this.edgeMat.color.copy(c.accent); this.innerMat.color.copy(c.muted);
      this.edgeMat.opacity = document.documentElement.dataset.theme === 'light' ? 0.55 : 0.32;
      this.innerMat.opacity = document.documentElement.dataset.theme === 'light' ? 0.45 : 0.28;
      this.grid.material.color && this.grid.material.color.copy(c.line);
      for (const n of this.nodes.values()) n.stub.material.color.copy(c.muted);
    }
    render(dt) {
      if (this.spin) this.theta += dt * 0.12;
      const cam = this.camera;
      cam.position.set(Math.cos(this.theta) * Math.cos(this.phi) * this.dist, 0.55 + Math.sin(this.phi) * this.dist, Math.sin(this.theta) * Math.cos(this.phi) * this.dist);
      cam.lookAt(0, 0.6, 0);
      this.busMat.color.copy(this.heat(this.load));
      const c = this.colors();
      const TRAVEL = 0.75; // seconds of wall time for a pulse to cross the bus (visual only)
      for (let i = this.pulses.length - 1; i >= 0; i--) {
        const p = this.pulses[i]; p.age += dt;
        const k = p.age / TRAVEL;
        // phase 1 (k<0.2): sender -> bus along stub
        if (p.n && k < 0.2) { p.s.position.lerpVectors(p.n.pos, p.n.bp, k / 0.2); p.s.visible = true; p.a.visible = p.b.visible = false; }
        else {
          p.s.visible = false; p.a.visible = p.b.visible = true;
          const kk = Math.min(1, (k - (p.n ? 0.2 : 0)) / 0.8);
          const ua = p.u0 * (1 - kk); const ub = p.u0 + (1 - p.u0) * kk;
          p.a.position.copy(this.curve.getPointAt(Math.max(0, ua))); p.b.position.copy(this.curve.getPointAt(Math.min(1, ub)));
          for (const r of p.receivers) if (!r._rx && (r.u >= ua - 0.02 && r.u <= ub + 0.02)) { r.hot = Math.max(r.hot, 0.6); }
          const fade = Math.max(0, 1 - Math.max(0, kk - 0.75) / 0.25);
          p.a.material.opacity = p.b.material.opacity = fade;
        }
        if (k >= 1) { this.killPulse(p); this.pulses.splice(i, 1); }
      }
      const w = this.el.clientWidth, h = this.el.clientHeight;
      for (const n of this.nodes.values()) {
        n.hot = Math.max(0, n.hot - dt * 2.2); n.miss = Math.max(0, n.miss - dt * 0.8);
        const base = c.accent.clone().multiplyScalar(0.55);
        n.mat.color.copy(base.lerp(n.miss > 0.05 ? c.bad : c.text, Math.max(n.hot, n.miss)));
        n.mesh.scale.setScalar(1 + 0.35 * Math.max(n.hot, n.miss));
        const v = n.pos.clone().project(cam);
        n.label.style.left = ((v.x + 1) / 2 * w) + 'px'; n.label.style.top = ((1 - v.y) / 2 * h) + 'px';
        n.label.classList.toggle('tx', n.hot > 0.3); n.label.classList.toggle('miss', n.miss > 0.05);
        n.label.style.display = v.z < 1 ? '' : 'none';
      }
      this.renderer.render(this.scene, cam);
    }
    png() { return this.renderer.domElement.toDataURL('image/png'); }
  }
  window.CANProofCar = { CarScene };
})();
