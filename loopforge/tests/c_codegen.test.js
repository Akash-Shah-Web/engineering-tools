// Compiles the generated C with gcc (and clang if present) using strict warnings,
// then checks it against the JavaScript reference implementation:
//   * open-loop vectors: double build to 1e-12, float build to 1e-3 relative,
//     Q16.16 build bit-exact with the JS fixed-point mirror;
//   * closed loop with the sampled plant: C (double and Q16.16) vs JS simulation.
// Run: node --test tests/c_codegen.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const LF = require('../src/core.js');
const CG = require('../src/codegen.js');

const has = cmd => { try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } };
const compilers = ['gcc', 'clang'].filter(has);
const FLAGS = ['-std=c99', '-O2', '-Wall', '-Wextra', '-Wpedantic', '-Werror', '-Wconversion', '-Wshadow', '-Wdouble-promotion'];
const harness = path.join(__dirname, 'c', 'harness.c');
const g = CG.g17;

const MODEL = { type: 'SOPDT', K: 0.777, tau1: 150.2, tau2: 11.19, theta: 4.107 };   // ≈ TCLab run-1 fit
const CASES = [];
for (const type of ['PI', 'PID']) for (const aw of ['none', 'clamp', 'backcalc']) for (const Ts of [1, 3.7])
  CASES.push({ type, aw, Ts, model: type === 'PI' ? Object.assign({}, MODEL, { type: 'FOPDT', tau2: 0, theta: 15.7, tau1: 151.6, K: 0.7715 }) : MODEL });

function plantHeader(m, Ts, sc, n) {
  const P = LF.discretizePlant(m, Ts);
  const lines = [
    `#define PL_N ${n}`, `#define PL_TS ${g(Ts)}`, `#define PL_ORDER ${P.order}`, `#define PL_D ${P.d}`,
    `#define PL_PHI00 ${g(P.Phi[0][0])}`, `#define PL_G0_0 ${g(P.Gamma0[0])}`, `#define PL_G1_0 ${g(P.Gamma1[0])}`,
    `#define PL_PHI10 ${g(P.order === 2 ? P.Phi[1][0] : 0)}`, `#define PL_PHI11 ${g(P.order === 2 ? P.Phi[1][1] : 0)}`,
    `#define PL_G0_1 ${g(P.order === 2 ? P.Gamma0[1] : 0)}`, `#define PL_G1_1 ${g(P.order === 2 ? P.Gamma1[1] : 0)}`,
    `#define PL_Y0 ${g(sc.y0)}`, `#define PL_UPRE ${g(sc.uPre)}`, `#define PL_R0 ${g(sc.r0)}`, `#define PL_R1 ${g(sc.r1)}`,
    `#define PL_TSTEP ${g(sc.tStep)}`, `#define PL_TDIST ${g(sc.dist.t)}`, `#define PL_DU ${g(sc.dist.du)}`,
  ];
  return lines.join('\n') + '\n';
}

for (const cc of compilers) {
  for (const cs of CASES) {
    test(`${cc}: ${cs.type} / anti-windup ${cs.aw} / Ts=${cs.Ts}`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfc-'));
      const ctrl = Object.assign(LF.tune(cs.model, 'SIMC', cs.type, 12), { N: 10, b: 1, antiWindup: cs.aw });
      const sc = { y0: 23, uPre: 0, r0: 23, r1: 55, tStep: 5, dist: { t: 420, du: -25 }, tEnd: 800 };
      const cfg = { model: cs.model, ctrl, Ts: cs.Ts, umin: 0, umax: 100, source: 'test' };
      const out = CG.generate(cfg);
      out.files.forEach(f => fs.writeFileSync(path.join(dir, f.name), f.text));
      const sim = LF.simulateClosedLoop(Object.assign({ model: cs.model, ctrl, Ts: cs.Ts, umin: 0, umax: 100 }, sc));
      fs.writeFileSync(path.join(dir, 'plant.h'), plantHeader(cs.model, cs.Ts, sc, sim.n));
      const build = (name, defs) => {
        const exe = path.join(dir, name);
        execFileSync(cc, FLAGS.concat(defs, ['-I', dir, harness, '-o', exe, '-lm']), { stdio: 'pipe' });
        return exe;
      };
      const exeD = build('h_double', ['-DLF_USE_DOUBLE']);
      const exeF = build('h_float', []);
      const exeQ = build('h_fixed', ['-DLF_FIXED']);
      // example compiles (with stub declarations)
      fs.writeFileSync(path.join(dir, 'stubs.h'), 'float read_temperature_c(void);\nvoid set_heater_percent(float u);\nvoid start_periodic_timer_seconds(double ts);\n');
      execFileSync(cc, FLAGS.concat(['-c', '-include', path.join(dir, 'stubs.h'), '-I', dir, path.join(dir, 'example_main.c'), '-o', path.join(dir, 'ex.o')]), { stdio: 'pipe' });

      // ---- open-loop vectors from the JS closed-loop trajectory
      const S = sim.samples;
      const vec = `${g(sc.y0)} ${g(sc.uPre)}\n` + S.t.map((_, k) => `${g(S.r[k])} ${g(S.ym[k])}`).join('\n') + '\n';
      const run = exe => execFileSync(exe, ['vec'], { input: vec }).toString().trim().split('\n').map(l => l.split(' ').map(Number));
      const jsF = LF.makeFloatPID(ctrl, cs.Ts, { umin: 0, umax: 100 }); jsF.init(sc.y0, sc.uPre);
      const jsQ = LF.makeFixedPID(ctrl, cs.Ts, { umin: 0, umax: 100 }); jsQ.init(sc.y0, sc.uPre);
      const refF = S.t.map((_, k) => jsF.step(S.r[k], S.ym[k]).u);
      const refQ = S.t.map((_, k) => Number(jsQ.stepQ(BigInt(LF.toQ16(S.r[k])), BigInt(LF.toQ16(S.ym[k])))));
      const outD = run(exeD), outF = run(exeF), outQ = run(exeQ);
      assert.equal(outD.length, S.t.length);
      let eD = 0, eF = 0, mism = 0;
      for (let k = 0; k < S.t.length; k++) {
        eD = Math.max(eD, Math.abs(outD[k][0] - refF[k]));
        eF = Math.max(eF, Math.abs(outF[k][0] - refF[k]));
        if (outQ[k][1] !== refQ[k]) mism++;
      }
      assert.ok(eD < 1e-9, `double build differs from JS by ${eD}`);
      assert.ok(eF < 0.05, `float32 build differs from JS by ${eF} (% output)`);
      assert.equal(mism, 0, 'Q16.16 build must be bit-exact with the JS fixed-point mirror');

      // ---- closed loop in C vs JS
      const cl = exe => execFileSync(exe, ['cl']).toString().trim().split('\n').map(l => l.split(' ').map(Number));
      const clD = cl(exeD);
      let ey = 0, eu = 0;
      for (let k = 0; k < sim.n; k++) { ey = Math.max(ey, Math.abs(clD[k][1] - S.y[k])); eu = Math.max(eu, Math.abs(clD[k][2] - S.u[k])); }
      assert.ok(ey < 1e-8 && eu < 1e-7, `closed-loop double: dy ${ey}, du ${eu}`);
      const simQ = LF.simulateClosedLoop(Object.assign({ model: cs.model, ctrl, Ts: cs.Ts, umin: 0, umax: 100, arithmetic: 'fixed' }, sc));
      const clQ = cl(exeQ);
      let eyq = 0;
      for (let k = 0; k < sim.n; k++) eyq = Math.max(eyq, Math.abs(clQ[k][1] - simQ.samples.y[k]));
      assert.ok(eyq < 1e-3, `closed-loop fixed: dy ${eyq}`);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
}

test('a C compiler is available', () => { assert.ok(compilers.length > 0, 'install gcc to run the C tests'); });
