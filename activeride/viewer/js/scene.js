/* three.js stage: road from the logged profile, two cars, cameras. */
(function () {
  "use strict";
  const AR = (window.AR = window.AR || {});
  const T = window.THREE;
  const LANE = 1.8;               // lane-centre offset (m) of each car from the road centre
  const YS = [4.4, 3.65, 3.6, 2.58, 1.8, 1.02, 0.0, -1.02, -1.8, -2.58, -3.6, -3.65, -4.4];  // sim-y cross-section

  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  // sequential single-hue (amber) ramp for the roughness proxy
  const HEAT = [[0.17, 0.20, 0.25], [0.42, 0.29, 0.11], [0.77, 0.48, 0.07], [0.95, 0.69, 0.23], [1.0, 0.89, 0.63]];
  function heat(u) {
    u = Math.max(0, Math.min(0.9999, u)) * (HEAT.length - 1);
    const i = Math.floor(u), w = u - i, a = HEAT[i], b = HEAT[i + 1];
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
  }

  class Stage {
    constructor(el, data) {
      this.el = el;
      this.data = data;
      this.veh = data.vehicle;
      const r = (this.renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }));
      r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      r.shadowMap.enabled = true;
      r.shadowMap.type = T.PCFSoftShadowMap;
      r.outputColorSpace = T.SRGBColorSpace;
      r.toneMapping = T.ACESFilmicToneMapping;
      r.toneMappingExposure = 1.05;
      el.appendChild(r.domElement);
      this.scene = new T.Scene();
      this.camera = new T.PerspectiveCamera(42, 1, 0.05, 900);
      this.camera.position.set(-10, 3, 6);
      this.hemi = new T.HemisphereLight(0xcfe3ff, 0x1a2015, 0.85);
      this.sun = new T.DirectionalLight(0xfff1dc, 2.1);
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(2048, 2048);
      const sc = this.sun.shadow.camera; sc.left = -14; sc.right = 14; sc.top = 14; sc.bottom = -14; sc.near = 1; sc.far = 60;
      this.sun.shadow.bias = -0.0004;
      this.scene.add(this.hemi, this.sun, this.sun.target);
      this.ground = new T.Mesh(new T.PlaneGeometry(4000, 400), new T.MeshStandardMaterial({ color: 0x223322, roughness: 1 }));
      this.ground.rotation.x = -Math.PI / 2; this.ground.position.y = -0.18; this.ground.receiveShadow = true;
      this.scene.add(this.ground);
      this.roadGroup = new T.Group(); this.scene.add(this.roadGroup);
      this.propGroup = new T.Group(); this.scene.add(this.propGroup);
      this.carA = AR.makeCar(this.veh, 0x3987e5);
      this.carB = AR.makeCar(this.veh, 0xc98500);
      this.scene.add(this.carA.root, this.carB.root);
      this.controls = new window.THREE_OrbitControls(this.camera, r.domElement);
      this.controls.enabled = false; this.controls.enableDamping = true; this.controls.maxPolarAngle = Math.PI * 0.49;
      this.camMode = "chase";
      this.camPos = new T.Vector3(); this.camLook = new T.Vector3(); this.camInit = false;
      this.exag = 10; this.heatOn = false; this.ghost = false;
      this.cineT = 0;
      this.raycaster = new T.Raycaster();
      this._resize = () => this.resize();
      window.addEventListener("resize", this._resize);
      new ResizeObserver(this._resize).observe(el);
      this.resize();
      this.applyTheme();
    }

    resize() {
      const w = this.el.clientWidth, h = this.el.clientHeight;
      if (!w || !h) return;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.fov = w < 600 ? 55 : 42;
      this.camera.updateProjectionMatrix();
    }

    applyTheme() {
      const bg = new T.Color(cssVar("--scene-bg") || "#1a2433");
      const sky = cssVar("--scene-sky") || "#070a10";
      // vertical gradient sky: zenith colour -> horizon colour (= fog colour)
      const cv = document.createElement("canvas"); cv.width = 4; cv.height = 256;
      const g = cv.getContext("2d"), gr = g.createLinearGradient(0, 0, 0, 256);
      gr.addColorStop(0, sky); gr.addColorStop(0.62, "#" + bg.getHexString()); gr.addColorStop(1, "#" + bg.getHexString());
      g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
      const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace;
      if (this.scene.background && this.scene.background.dispose) this.scene.background.dispose();
      this.scene.background = tex;
      this.scene.fog = new T.Fog(bg, 70, 300);
      this.ground.material.color.set(cssVar("--scene-ground") || "#121a14");
      this.asphalt = new T.Color(cssVar("--scene-asphalt") || "#2b2f36");
      const light = document.documentElement.dataset.theme === "light";
      this.hemi.intensity = light ? 1.1 : 1.25;
      this.sun.intensity = light ? 2.1 : 2.6;
      if (this.sc) this.colorRoad();
      this.carA.setColor(cssVar("--c-a")); this.carB.setColor(cssVar("--c-b"));
    }

    /* ---------------- road ---------------- */
    setScenario(sc) {
      this.sc = sc;
      for (const g of [this.roadGroup, this.propGroup]) {
        while (g.children.length) { const c = g.children.pop(); c.geometry && c.geometry.dispose(); }
      }
      const step = 2;                                    // every 2nd profile sample (0.2 m)
      const n = Math.floor((sc.road.n - 1) / step) + 1;
      const pre = 40, post = 60;                         // flat road before/after the logged profile (m)
      const xs = [];
      for (let x = -pre; x < 0; x += 1) xs.push(x);
      for (let i = 0; i < n; i++) xs.push(i * step * sc.road.dx);
      const L = sc.length;
      for (let x = L + 1; x <= L + post; x += 1) xs.push(x);
      this.roadX = xs;
      const ny = YS.length, pos = new Float32Array(xs.length * ny * 3);
      const hL = new Float32Array(xs.length), hR = new Float32Array(xs.length);
      xs.forEach((x, i) => { hL[i] = sc.roadHeight(0, x); hR[i] = sc.roadHeight(1, x); });
      this.hL = hL; this.hR = hR;
      const hAt = (i, y) => {
        // each lane carries the same measured left/right wheel paths around its centre
        const local = y > 0 ? y - LANE : y + LANE;
        const w = Math.max(0, Math.min(1, (local + 0.78) / 1.56));
        return w * hL[i] + (1 - w) * hR[i];
      };
      for (let i = 0; i < xs.length; i++) {
        for (let j = 0; j < ny; j++) {
          const y = YS[j];
          let z = Math.abs(y) < 1e-6 ? 0.5 * (hAt(i, 0.001) + hAt(i, -0.001)) : hAt(i, y);
          if (Math.abs(y) > 3.62) z -= 0.012;
          const k = (i * ny + j) * 3;
          pos[k] = xs[i]; pos[k + 1] = z; pos[k + 2] = -y;
        }
      }
      const idx = [];
      for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ny - 1; j++) {
        const a = i * ny + j, b = a + 1, c = a + ny, d = c + 1;
        idx.push(a, b, c, b, d, c);          // counter-clockwise from above: normals point up
      }
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.BufferAttribute(pos, 3));
      g.setAttribute("color", new T.BufferAttribute(new Float32Array(pos.length), 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      this.roadGeom = g;
      this.road = new T.Mesh(g, new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.0, flatShading: false }));
      this.road.receiveShadow = true;
      this.roadGroup.add(this.road);
      // roughness proxy per row (max of both paths), normalised by the scenario's 98th percentile
      const rough = new Float32Array(xs.length);
      const rr = [];
      for (let i = 0; i < xs.length; i++) {
        const f = Math.round(xs[i] / sc.road.dx);
        const v = f >= 0 && f < sc.road.n ? Math.max(sc.road.roughL[f], sc.road.roughR[f]) : 0;
        rough[i] = v; rr.push(v);
      }
      rr.sort((p, q) => p - q);
      const p98 = rr[Math.floor(rr.length * 0.98)] || 1;
      this.rough = rough.map((v) => v / (p98 || 1));
      this.colorRoad();
      this.buildMarkings(xs, hAt);
      this.buildProps(L);
      this.setExag(this.exag);
    }

    colorRoad() {
      const col = this.roadGeom.attributes.color.array, ny = YS.length;
      const base = this.asphalt;
      for (let i = 0; i < this.roadX.length; i++) {
        const hc = heat(this.rough[i]);
        const jit = 0.97 + 0.06 * (((i * 7919) % 13) / 13);
        for (let j = 0; j < ny; j++) {
          const k = (i * ny + j) * 3, shoulder = Math.abs(YS[j]) > 3.62;
          let c = [base.r * jit, base.g * jit, base.b * jit];
          if (shoulder) c = [base.r * 0.8, base.g * 0.85, base.b * 0.75];
          else if (this.heatOn) c = hc;
          col[k] = c[0]; col[k + 1] = c[1]; col[k + 2] = c[2];
        }
      }
      this.roadGeom.attributes.color.needsUpdate = true;
    }

    buildMarkings(xs, hAt) {
      const strips = [
        { y: 3.5, dash: false }, { y: -3.5, dash: false }, { y: 0, dash: true },
      ];
      const pos = [], idx = [];
      const w = 0.07;
      for (const s of strips) {
        for (let i = 0; i < xs.length - 1; i++) {
          if (s.dash && Math.floor((xs[i] + 1000) / 3) % 4 !== 0) continue;
          const base = pos.length / 3;
          for (const [ii, dy] of [[i, -w], [i, w], [i + 1, -w], [i + 1, w]]) {
            const y = s.y + dy;
            const z = (s.y === 0 ? 0.5 * (hAt(ii, 0.001) + hAt(ii, -0.001)) : hAt(ii, y)) + 0.004;
            pos.push(xs[ii], z, -y);
          }
          idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
        }
      }
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      this.marks = new T.Mesh(g, new T.MeshStandardMaterial({ color: 0xe9e6dc, roughness: 0.6, emissive: 0x222222 }));
      this.marks.receiveShadow = true;
      this.roadGroup.add(this.marks);
    }

    buildProps(L) {
      const postG = new T.BoxGeometry(0.1, 1.0, 0.1); postG.translate(0, 0.5, 0);
      const refl = new T.BoxGeometry(0.11, 0.12, 0.11); refl.translate(0, 0.85, 0);
      const pm = new T.MeshStandardMaterial({ color: 0xdedbd2, roughness: 0.6 });
      const rm = new T.MeshStandardMaterial({ color: 0xff9a3c, emissive: 0x7a3a00, roughness: 0.4 });
      const count = Math.ceil((L + 100) / 25) * 2;
      const posts = new T.InstancedMesh(postG, pm, count), refls = new T.InstancedMesh(refl, rm, count);
      const m = new T.Matrix4();
      let k = 0;
      for (let x = -40; x < L + 60 && k < count; x += 25) for (const z of [-4.9, 4.9]) {
        m.makeTranslation(x, -0.05, z); posts.setMatrixAt(k, m); refls.setMatrixAt(k, m); k++;
      }
      posts.count = refls.count = k; posts.castShadow = true;
      this.propGroup.add(posts, refls);
      // distance boards every 100 m along the measured section
      for (let x = 0; x <= L; x += 100) {
        const c = document.createElement("canvas"); c.width = 256; c.height = 96;
        const g = c.getContext("2d");
        g.fillStyle = "#0f2a1c"; g.fillRect(0, 0, 256, 96); g.strokeStyle = "#e8e6dc"; g.lineWidth = 6; g.strokeRect(5, 5, 246, 86);
        g.fillStyle = "#e8e6dc"; g.font = "bold 46px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(`${x} m`, 128, 50);
        const tex = new T.CanvasTexture(c); tex.colorSpace = T.SRGBColorSpace;
        const board = new T.Mesh(new T.PlaneGeometry(1.2, 0.45), new T.MeshBasicMaterial({ map: tex, side: T.DoubleSide }));
        board.position.set(x, 1.5, 5.4); board.rotation.y = 0;
        const pole = new T.Mesh(new T.BoxGeometry(0.06, 1.5, 0.06), pm); pole.position.set(x, 0.7, 5.4);
        this.propGroup.add(board, pole);
      }
      // start/finish gantry of the measured section
      const gm = new T.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.6, roughness: 0.4 });
      for (const x of [0, L]) {
        const bar = new T.Mesh(new T.BoxGeometry(0.15, 0.15, 10.4), gm); bar.position.set(x, 5.2, 0);
        const l1 = new T.Mesh(new T.BoxGeometry(0.15, 5.2, 0.15), gm); l1.position.set(x, 2.6, 5.2);
        const l2 = l1.clone(); l2.position.z = -5.2;
        bar.castShadow = l1.castShadow = l2.castShadow = true;
        this.propGroup.add(bar, l1, l2);
      }
    }

    setExag(e) { this.exag = e; this.roadGroup.scale.y = e; }
    setHeat(on) { this.heatOn = on; if (this.sc) this.colorRoad(); }
    setGhost(on) { this.ghost = on; this.carA.setGhost(on); }
    setXray(on) { this.carB.setXray(on); if (!this.ghost) this.carA.setXray(on); }
    lanes() { return this.ghost ? [LANE, LANE] : [-LANE, LANE]; }   // three-z of car A, car B

    setCam(mode) {
      this.camMode = mode;
      this.controls.enabled = mode === "orbit";
      this.cineT = 0;
      if (mode === "orbit") {
        this.controls.target.copy(this.camLook);
      }
    }

    /* ---------------- per-frame ---------------- */
    update(stA, stB, dt) {
      const [zA, zB] = this.lanes();
      stA.laneZ = zA; stB.laneZ = zB;
      stA.exag = stB.exag = this.exag;
      this.carA.update(stA); this.carB.update(stB);
      const x = stB.x;
      const zMid = (zA + zB) / 2;
      this.sun.position.set(x - 8, 16, 10); this.sun.target.position.set(x, 0, 0);
      let mode = this.camMode;
      if (mode === "cinema") {
        this.cineT += dt;
        const seq = ["chase", "side", "wheel", "front"];
        mode = seq[Math.floor(this.cineT / 6.5) % seq.length];
      }
      const pos = new T.Vector3(), look = new T.Vector3();
      const a = this.veh.a;
      if (mode === "chase") { pos.set(x - 10.5, 3.6, zMid + (this.ghost ? 0 : 0.0) + 3.2); look.set(x + 5, 0.4, zMid); }
      else if (mode === "side") { pos.set(x + 0.6, 1.25, zB + 10.5); look.set(x + 0.2, 0.75, zMid); }
      else if (mode === "wheel") { pos.set(x + a + 2.9, 0.75, zB + 3.9); look.set(x + a - 0.35, 0.40, zB + 0.6); }
      else if (mode === "front") { pos.set(x + 9.5, 1.4, zMid - 5.5); look.set(x, 0.7, zMid); }
      if (mode === "orbit") {
        const dx = x - (this._lastX ?? x);
        this.camera.position.x += dx; this.controls.target.x += dx;
        this.controls.update();
        this.camLook.copy(this.controls.target);
      } else {
        const k = this.camInit ? 1 - Math.exp(-dt * (mode === "chase" ? 5 : 3)) : 1;
        // x follows exactly (car moves fast); y/z ease for cinematic cuts
        this.camPos.lerp(pos, k); this.camPos.x = pos.x + (this.camPos.x - pos.x) * (this.camInit ? 0.0 : 0);
        this.camLook.lerp(look, k); this.camLook.x = look.x;
        this.camera.position.copy(this.camPos);
        this.camera.lookAt(this.camLook);
        this.camInit = true;
      }
      this._lastX = x;
      this.renderer.render(this.scene, this.camera);
    }

    /* hover pick: returns {car: 'A'|'B', corner} or null */
    pick(clientX, clientY) {
      const rect = this.renderer.domElement.getBoundingClientRect();
      const v = new T.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(v, this.camera);
      const cand = [];
      for (const [tag, car] of [["A", this.carA], ["B", this.carB]]) {
        const hits = this.raycaster.intersectObject(car.root, true);
        if (hits.length) cand.push([hits[0].distance, tag, car, hits[0].point]);
      }
      if (!cand.length) return null;
      cand.sort((p, q) => p[0] - q[0]);
      const [, tag, car, p] = cand[0];
      const local = car.root.worldToLocal(p.clone());
      const xs = this.veh.x_corner, ys = this.veh.y_corner;
      let best = 0, bd = 1e9;
      for (let i = 0; i < 4; i++) {
        const d = (local.x - xs[i]) ** 2 + (local.z + ys[i]) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return { car: tag, corner: best };
    }

    snapshot() { return this.renderer.domElement.toDataURL("image/png"); }
  }

  AR.Stage = Stage;
})();
