/* Original low-poly car built from three.js primitives. Geometry uses the
   simulated vehicle's wheelbase, track, CG height and tyre radius. */
(function () {
  "use strict";
  const AR = (window.AR = window.AR || {});
  const T = window.THREE;

  function bodyShape(a, b, wc, R) {
    // side profile (x forward, y up) relative to CG, with wheel-arch notches
    const s = new T.Shape();
    const xr = -b - 0.95, xf = a + 0.95, yb = -0.27;
    const arch = (cx, from, to) => {
      const r = R + 0.06, n = 9;
      for (let k = 0; k <= n; k++) {
        const ang = from + (to - from) * (k / n);
        s.lineTo(cx + r * Math.cos(ang), Math.max(yb, wc + r * Math.sin(ang)));
      }
    };
    s.moveTo(xr, yb + 0.05);
    s.lineTo(xr + 0.12, yb);
    s.lineTo(-b - R - 0.06, yb);
    arch(-b, Math.PI, 0);
    s.lineTo(a - R - 0.06, yb);
    arch(a, Math.PI, 0);
    s.lineTo(xf - 0.12, yb);
    s.lineTo(xf, yb + 0.1);
    s.lineTo(xf + 0.02, 0.10);
    s.lineTo(xf - 0.18, 0.24);   // bonnet front
    s.lineTo(a - 0.25, 0.33);    // bonnet / windscreen base
    s.lineTo(-b - 0.55, 0.36);   // belt line to boot
    s.lineTo(xr + 0.05, 0.31);
    s.lineTo(xr, 0.20);
    s.closePath();
    return s;
  }

  function cabinShape(a, b) {
    const s = new T.Shape();
    s.moveTo(a - 0.30, 0.32);
    s.lineTo(a - 0.98, 0.80);
    s.lineTo(-b + 0.10, 0.82);
    s.lineTo(-b - 0.50, 0.35);
    s.closePath();
    return s;
  }

  function extrude(shape, depth, bevel) {
    const g = new T.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 4 });
    g.translate(0, 0, -depth / 2);
    return g;
  }

  function helixGeometry(turns = 6, radius = 0.075, tube = 0.012) {
    class Helix extends T.Curve {
      getPoint(t, target = new T.Vector3()) {
        const a = t * turns * 2 * Math.PI;
        return target.set(radius * Math.cos(a), t, radius * Math.sin(a));
      }
    }
    return new T.TubeGeometry(new Helix(), 96, tube, 5, false);
  }

  AR.makeCar = function (veh, color) {
    const a = veh.a, b = veh.b, R = veh.R0, h = veh.h_cg;
    const zwc0 = veh.wheel_centre_static_m;
    const wc = zwc0[0] - h;                      // wheel-centre height relative to CG (static)
    const xs = veh.x_corner, ys = veh.y_corner;
    const root = new T.Group();
    const body = new T.Group();
    body.rotation.order = "ZXY";
    root.add(body);

    const mats = [];
    const M = (opts) => { const m = new T.MeshStandardMaterial(Object.assign({ flatShading: true, roughness: 0.55, metalness: 0.1 }, opts)); mats.push(m); return m; };
    const paint = M({ color, roughness: 0.38, metalness: 0.25 });
    const glass = M({ color: 0x2b3c50, roughness: 0.12, metalness: 0.55 });
    const trim = M({ color: 0x15171a, roughness: 0.8 });
    const lamp = M({ color: 0xfff3d0, emissive: 0xffe9b0, emissiveIntensity: 0.9 });
    const tail = M({ color: 0xc81e1e, emissive: 0xa01010, emissiveIntensity: 0.8 });
    const rubber = M({ color: 0x141518, roughness: 0.9 });
    const rimM = M({ color: 0xb9bec6, roughness: 0.3, metalness: 0.8 });
    const springM = M({ color: 0xf2c14e, roughness: 0.4, metalness: 0.5 });
    const damperM = M({ color: 0x5d6673, roughness: 0.4, metalness: 0.6 });

    const hull = new T.Mesh(extrude(bodyShape(a, b, wc, R), 1.62, 0.06), paint);
    const cabin = new T.Mesh(extrude(cabinShape(a, b), 1.36, 0.05), glass);
    const roof = new T.Mesh(new T.BoxGeometry(1.1, 0.04, 1.30), paint);
    roof.position.set((a - 0.98 + (-b + 0.1)) / 2, 0.84, 0);
    const bumperF = new T.Mesh(new T.BoxGeometry(0.10, 0.10, 1.66), trim); bumperF.position.set(a + 0.95, -0.17, 0);
    const bumperR = new T.Mesh(new T.BoxGeometry(0.10, 0.10, 1.66), trim); bumperR.position.set(-b - 0.97, -0.13, 0);
    const sill = new T.Mesh(new T.BoxGeometry(a + b - 2 * R - 0.25, 0.06, 1.70), trim); sill.position.set((a - b) / 2, -0.25, 0);
    body.add(hull, cabin, roof, bumperF, bumperR, sill);
    for (const zz of [-0.58, 0.58]) {
      const l = new T.Mesh(new T.BoxGeometry(0.05, 0.07, 0.34), lamp); l.position.set(a + 0.94, 0.10, zz); body.add(l);
      const t = new T.Mesh(new T.BoxGeometry(0.05, 0.08, 0.38), tail); t.position.set(-b - 0.97, 0.20, zz); body.add(t);
    }
    root.add(body);

    // wheels (not rotated with the body: the sim's wheel bodies slide vertically)
    const wheels = [], springs = [], dampers = [], arrows = [], tyreArrows = [];
    const tyreG = new T.CylinderGeometry(R, R, 0.22, 16); tyreG.rotateX(Math.PI / 2);
    const rimG = new T.CylinderGeometry(R * 0.62, R * 0.62, 0.235, 10); rimG.rotateX(Math.PI / 2);
    const spokeG = new T.BoxGeometry(R * 1.12, 0.06, 0.24);
    const helix = helixGeometry();
    const damperG = new T.CylinderGeometry(0.03, 0.03, 1, 8); damperG.translate(0, 0.5, 0);
    for (let i = 0; i < 4; i++) {
      const w = new T.Group();
      const spin = new T.Group();
      spin.add(new T.Mesh(tyreG, rubber), new T.Mesh(rimG, rimM));
      for (let k = 0; k < 3; k++) { const sp = new T.Mesh(spokeG, rimM); sp.rotation.z = (k * Math.PI) / 3; spin.add(sp); }
      w.add(spin);
      w.userData.spin = spin;
      w.position.set(xs[i], zwc0[i], -ys[i]);
      root.add(w);
      wheels.push(w);
      const s = new T.Mesh(helix, springM); root.add(s); springs.push(s);
      const d = new T.Mesh(damperG, damperM); root.add(d); dampers.push(d);
      const ar = new T.ArrowHelper(new T.Vector3(0, 1, 0), new T.Vector3(), 0.5, 0x4fc3f7, 0.16, 0.10);
      root.add(ar); arrows.push(ar);
      const ta = new T.ArrowHelper(new T.Vector3(0, 1, 0), new T.Vector3(), 0.5, 0x8bd17c, 0.12, 0.08);
      root.add(ta); tyreArrows.push(ta);
    }
    // edges for ghost mode
    const edges = new T.LineSegments(new T.EdgesGeometry(hull.geometry, 25), new T.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }));
    edges.visible = false; body.add(edges);

    root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });

    const tmpTop = new T.Vector3(), tmpBot = new T.Vector3(), up = new T.Vector3(0, 1, 0), dir = new T.Vector3();
    const car = { root, body, wheels, meshes: [hull, cabin, roof], paint, edges };

    car.setColor = (c) => { paint.color.set(c); edges.material.color.set(c); };
    // X-ray: body shell translucent so springs, dampers and force arrows are visible
    const shell = [paint, glass, trim];
    car.setXray = (on) => {
      if (car._ghost) return;
      for (const m of shell) { m.transparent = on; m.opacity = on ? 0.28 : 1; m.depthWrite = !on; m.needsUpdate = true; }
      edges.visible = on;
    };
    car.setGhost = (on) => {
      car._ghost = on;
      body.scale.setScalar(on ? 1.015 : 1);   // avoid z-fighting with the coincident active car
      for (const m of mats) { m.transparent = on; m.opacity = on ? 0.22 : 1; m.depthWrite = !on; m.needsUpdate = true; }
      edges.visible = on;
      root.traverse((o) => { if (o.isMesh) o.castShadow = !on; });
    };

    /* s = {x, zs, pitch, roll, zu[4], fa[4], F[4], exag, laneZ, forces, tyre, fmax, F0[4]} */
    car.update = (s) => {
      const e = s.exag;
      root.position.set(s.x, 0, s.laneZ);
      body.position.set(0, h + s.zs * e, 0);
      body.rotation.set(s.roll * e, 0, -s.pitch * e);
      body.updateMatrix();
      for (let i = 0; i < 4; i++) {
        const w = wheels[i];
        w.position.y = zwc0[i] + s.zu[i] * e;
        w.userData.spin.rotation.z = -s.x / R;
        // strut from body top mount to hub
        tmpTop.set(xs[i], 0.18, -ys[i] * 0.86).applyMatrix4(body.matrix);
        tmpBot.set(xs[i], w.position.y, -ys[i] * 0.86);
        dir.subVectors(tmpTop, tmpBot);
        const L = dir.length();
        dir.normalize();
        springs[i].position.copy(tmpBot); springs[i].quaternion.setFromUnitVectors(up, dir); springs[i].scale.set(1, L, 1);
        dampers[i].position.copy(tmpBot); dampers[i].quaternion.copy(springs[i].quaternion); dampers[i].scale.set(1, L, 1);
        // actuator force arrow (u>0 pushes body up)
        const ar = arrows[i];
        ar.visible = s.forces && s.active;
        if (ar.visible) {
          const f = s.fa[i], mag = Math.min(1, Math.abs(f) / s.fmax);
          tmpTop.set(xs[i], 0.42, -ys[i] * 0.86).applyMatrix4(body.matrix);
          ar.position.copy(tmpTop);
          ar.setDirection(f >= 0 ? up : new T.Vector3(0, -1, 0));
          const len = 0.12 + 1.6 * mag;
          ar.setLength(len, Math.min(0.18, len * 0.45), 0.10);
          ar.setColor(f >= 0 ? 0x4fc3f7 : 0xff8a3d);
        }
        // tyre load arrow (dynamic load relative to static)
        const ta = tyreArrows[i];
        ta.visible = s.tyre;
        if (ta.visible) {
          const ratio = Math.max(0, s.F[i] / s.F0[i]);
          ta.position.set(xs[i] + 0.0, s.road[i] * e, -ys[i] + (ys[i] > 0 ? -0.2 : 0.2));
          const len = 0.05 + 0.55 * ratio;
          ta.setLength(len, 0.1, 0.07);
          ta.setColor(ratio < 0.05 ? 0xe5534b : ratio < 0.6 ? 0xe3b341 : 0x8bd17c);
        }
      }
    };
    return car;
  };
})();
