'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const C = require('../src/core.js');

const ms = (x) => x * 1e6;

test('worst-case frame lengths match Davis et al. 2007 eq.(1)', () => {
  // 8-byte standard frame: 135 bits; 8-byte extended: 160 bits (well-known values)
  assert.equal(C.worstCaseFrameBits(8, false), 135);
  assert.equal(C.worstCaseFrameBits(8, true), 160);
  assert.equal(C.worstCaseFrameBits(0, false), 55);
  assert.equal(C.worstCaseFrameBits(0, true), 80);
  // general form 55 + 10s for s in 0..8 (11-bit) per Davis et al.
  for (let s = 0; s <= 8; s++) assert.equal(C.worstCaseFrameBits(s, false), 55 + 10 * s);
  assert.equal(C.minFrameBits(8, false), 111);
});

test('exact stuffing never exceeds the worst-case bound (random frames)', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < 20000; i++) {
    const ext = rnd() < 0.3;
    const id = ext ? Math.floor(rnd() * 0x20000000) : Math.floor(rnd() * 0x800);
    const s = Math.floor(rnd() * 9);
    const data = Array.from({ length: s }, () => (rnd() < 0.3 ? 0 : rnd() < 0.5 ? 255 : Math.floor(rnd() * 256)));
    const f = C.buildFrame(id, ext, data);
    assert.ok(f.total <= C.worstCaseFrameBits(s, ext), `frame ${id} ${data} total ${f.total}`);
    assert.ok(f.total >= C.minFrameBits(s, ext));
  }
});

test('CRC-15 known value and stuffing of all-zero frame', () => {
  // ID 0, DLC 0: SOF + 11 zeros + RTR,IDE,r0 zeros + DLC 0000 = 19 dominant bits -> stuff bits inserted
  const f = C.buildFrame(0, false, []);
  // no bit sequence of 6 identical values in stuffed region
  const stuffedRegion = f.bits.filter((b) => !['CRC-del', 'ACK', 'ACK-del', 'EOF', 'IFS'].includes(b.field)).map((b) => b.v).join('');
  assert.ok(!/000000|111111/.test(stuffedRegion));
  assert.equal(C.crc15([]), 0);
  // CRC of a frame computed over the unstuffed bits, appended, yields 0 remainder
  const raw = [0, ...Array(11).fill(0), 0, 0, 0, 0, 0, 0, 0];
  const crc = C.crc15(raw);
  const bits = raw.slice();
  for (let i = 14; i >= 0; i--) bits.push((crc >> i) & 1);
  assert.equal(C.crc15(bits), 0);
});

/*
 * Published example: Davis, Burns, Bril, Lukkien (2007), Section 3 —
 * three messages on a 125 kbit/s bus, each with transmission time C = 1 ms
 * (125 bits), periods A=2.5ms, B=3.5ms, C=3.5ms, deadlines A=2.5, B=3.25, C=3.25 ms.
 * The ORIGINAL (Tindell) analysis gives R_C = 3.0 ms (claimed schedulable);
 * the second instance of C actually completes 3.5 ms after its release, so
 * the deadline is missed. The revised analysis finds R_C = 3.5 ms.
 * NOTE: the paper could not be re-fetched from this build environment; the
 * parameters are as given in the paper's motivating example to the best of
 * our knowledge, and the result is independently re-derived below by an
 * exhaustive simulation of the critical instant.
 */
function davisExample() {
  return [
    { key: 'A', name: 'A', id: 1, extended: false, dlc: 8, Cbits: 125, Tms: 2.5, Dms: 2.5, Jms: 0 },
    { key: 'B', name: 'B', id: 2, extended: false, dlc: 8, Cbits: 125, Tms: 3.5, Dms: 3.25, Jms: 0 },
    { key: 'C', name: 'C', id: 3, extended: false, dlc: 8, Cbits: 125, Tms: 3.5, Dms: 3.25, Jms: 0 },
  ];
}

test('Davis et al. 2007 example: revised analysis finds the deadline miss', () => {
  const res = C.analyse(davisExample(), { bitrate: 125000, method: 'davis' });
  const R = Object.fromEntries(res.results.map((r) => [r.key, r.R / 1e6]));
  assert.equal(R.A, 2.0);
  assert.equal(R.B, 3.0);
  assert.equal(R.C, 3.5);
  const c = res.results.find((r) => r.key === 'C');
  assert.equal(c.Q, 2, 'busy period of C contains 2 instances');
  assert.equal(c.worstQ, 1, 'second instance is the worst');
  assert.equal(c.busy / 1e6, 7.0);
  assert.equal(c.schedulable, false);
  assert.equal(res.schedulable, false);
});

test('Davis et al. 2007 example: original Tindell analysis is optimistic (3.0 ms)', () => {
  const res = C.analyse(davisExample(), { bitrate: 125000, method: 'tindell' });
  const c = res.results.find((r) => r.key === 'C');
  assert.equal(c.R / 1e6, 3.0);
  assert.equal(c.schedulable, true); // the flaw
});

test('Davis et al. 2007 example: simulation of the critical instant reproduces 3.5 ms', () => {
  const sim = C.simulate(davisExample(), { bitrate: 125000, duration: ms(14), jitterMode: 'zero' });
  const cs = sim.frames.filter((f) => f.key === 'C');
  const maxR = Math.max(...cs.map((f) => f.R)) / 1e6;
  assert.equal(maxR, 3.5);
  assert.ok(cs.some((f) => f.miss));
});

test('Sufficient test (eq. 16) upper-bounds the exact analysis', () => {
  const set = randomSet(11, 25, 500000);
  const a = C.analyse(set, { bitrate: 500000, method: 'davis' });
  const s = C.analyse(set, { bitrate: 500000, method: 'sufficient' });
  for (let i = 0; i < a.results.length; i++) assert.ok(s.results[i].R >= a.results[i].R - 1e-6);
});

function randomSet(seed, n, bitrate) {
  let x = seed;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  const periods = [5, 10, 10, 20, 20, 50, 100, 100, 200, 1000];
  const ids = new Set();
  const out = [];
  while (out.length < n) {
    const id = Math.floor(rnd() * 0x7ff);
    if (ids.has(id)) continue;
    ids.add(id);
    const T = periods[Math.floor(rnd() * periods.length)];
    out.push({ key: 's' + id, name: 'M' + id, id, extended: rnd() < 0.2, dlc: Math.floor(rnd() * 9), Tms: T, Dms: T * (0.5 + rnd() * 0.5), Jms: rnd() < 0.5 ? 0 : T * 0.1 * rnd() });
  }
  return out;
}

test('Simulated response times never exceed the analytic bound (property test)', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const bitrate = [125000, 250000, 500000][seed % 3];
    const set = randomSet(seed, 12, bitrate);
    const a = C.analyse(set, { bitrate, method: 'davis' });
    const bound = new Map(a.results.map((r) => [r.key, r.R]));
    for (const jm of ['zero', 'max', 'random', 'critical']) {
      const sim = C.simulate(set, { bitrate, duration: ms(2000), jitterMode: jm, seed });
      for (const f of sim.frames) {
        const b = bound.get(f.key);
        if (Number.isFinite(b)) assert.ok(f.R <= b + 1e-3, `seed ${seed} ${jm} ${f.key} sim ${f.R} > bound ${b}`);
      }
    }
  }
});

test('Busy-period divergence is reported as unbounded', () => {
  const set = [
    { key: 'a', name: 'a', id: 1, extended: false, dlc: 8, Tms: 0.2, Dms: 0.2, Jms: 0 },
    { key: 'b', name: 'b', id: 2, extended: false, dlc: 8, Tms: 0.2, Dms: 0.2, Jms: 0 },
  ];
  const r = C.analyse(set, { bitrate: 500000 }); // 2*270us/200us > 1
  assert.equal(r.results[1].R, Infinity);
  assert.equal(r.schedulable, false);
});

test('Mixed 11/29-bit arbitration: standard beats extended with same base ID', () => {
  const s = { id: 0x100, extended: false };
  const x = { id: 0x100 << 18, extended: true };
  const x2 = { id: (0x0ff << 18) | 0x3ffff, extended: true };
  assert.ok(C.arbKey(s) < C.arbKey(x));
  assert.ok(C.arbKey(x2) < C.arbKey(s));
});

test('OPA finds a feasible order when ID assignment is unsafe', () => {
  const set = [
    { key: 'slow', name: 'slow', id: 0x10, extended: false, dlc: 8, Tms: 100, Dms: 100, Jms: 0 },
    { key: 'slow2', name: 'slow2', id: 0x11, extended: false, dlc: 8, Tms: 100, Dms: 100, Jms: 0 },
    { key: 'fast', name: 'fast', id: 0x20, extended: false, dlc: 8, Tms: 1, Dms: 0.6, Jms: 0 },
  ];
  const a = C.analyse(set, { bitrate: 500000 });
  assert.equal(a.schedulable, false);
  const opa = C.optimalPriorityAssignment(set, { bitrate: 500000 });
  assert.equal(opa.feasible, true);
  assert.equal(opa.order[0], 'fast');
  const f = C.checkPriorities(set, a, {});
  assert.equal(f[0].code, 'UNSAFE_PRIORITIES');
});

const DBC = `VERSION ""
BU_: ECU1 ECU2
BO_ 256 Engine: 8 ECU1
 SG_ RPM : 0|16@1+ (0.25,0) [0|16383.75] "rpm" ECU2
 SG_ Temp : 16|8@1- (1,-40) [-40|87] "degC" ECU2
 SG_ Clash : 20|8@1+ (1,0) [0|255] "" ECU2
 SG_ Moto : 39|12@0+ (1,0) [0|4095] "" ECU2
BO_ 2147484160 ExtMsg: 4 ECU2
 SG_ Mux M : 0|4@1+ (1,0) [0|15] "" ECU1
 SG_ A m0 : 8|8@1+ (1,0) [0|255] "" ECU1
 SG_ B m1 : 8|8@1+ (1,0) [0|255] "" ECU1
 SG_ Over : 30|8@1+ (1,0) [0|255] "" ECU1
BO_ 3000 BadStd: 2 GHOST
 SG_ X : 7|4@1+ (1,0) [0|100] "" ECU1
BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;
BA_DEF_DEF_ "GenMsgCycleTime" 0;
BA_ "GenMsgCycleTime" BO_ 256 10;
BA_ "GenMsgCycleTime" BO_ 2147484160 100;
CM_ SG_ 256 RPM "Engine speed";
VAL_ 2147484160 Mux 0 "Page0" 1 "Page1" ;
`;

test('DBC parsing: messages, extended IDs, cycle times, mux', () => {
  const d = C.parseDBC(DBC);
  assert.deepEqual(d.nodes, ['ECU1', 'ECU2']);
  assert.equal(d.messages.length, 3);
  const eng = d.messages[0];
  assert.equal(eng.id, 256); assert.equal(eng.extended, false); assert.equal(eng.cycleTimeMs, 10);
  const ext = d.messages[1];
  assert.equal(ext.extended, true); assert.equal(ext.id, 512); assert.equal(ext.cycleTimeMs, 100);
  assert.equal(ext.signals[0].mux.role, 'mux');
  assert.equal(ext.signals[1].mux.value, 0);
  assert.equal(eng.signals[0].comment, 'Engine speed');
  assert.equal(ext.signals[0].values['1'], 'Page1');
  assert.equal(d.messages[2].cycleTimeMs, null);
  assert.ok(d.errors.some((e) => e.code === 'ID_RANGE'));
});

test('DBC layout checks find overlap, out-of-frame, range and sender issues', () => {
  const d = C.parseDBC(DBC);
  const f = C.checkLayout(d);
  const codes = f.map((x) => x.code + ':' + (x.msg || ''));
  assert.ok(codes.includes('OVERLAP:Engine'), 'Temp/Clash overlap');
  assert.ok(codes.includes('OUT_OF_FRAME:ExtMsg'), 'Over exceeds 4 bytes');
  assert.ok(!codes.includes('OUT_OF_FRAME:BadStd'), 'X (bits 7..10) fits in 2 bytes');
  assert.ok(f.some((x) => x.code === 'ID_RANGE'));
  assert.ok(codes.includes('SENDER:BadStd'));
  // muxed A and B share bits but different mux values -> no overlap reported
  assert.ok(!f.some((x) => x.code === 'OVERLAP' && x.msg === 'ExtMsg'));
});

test('Signal decoding Intel/Motorola/signed', () => {
  const d = C.parseDBC(DBC);
  const eng = d.messages[0];
  const data = [0x10, 0x27, 0xF6, 0x00, 0xAB, 0xC0, 0, 0];
  const dec = Object.fromEntries(C.decodeMessage(eng, data).map((s) => [s.name, s]));
  assert.equal(dec.RPM.raw, 0x2710); assert.equal(dec.RPM.phys, 2500);
  assert.equal(dec.Temp.raw, -10); assert.equal(dec.Temp.phys, -50);
  // Motorola start 39 (byte4 bit7) length 12: byte4 = 0xAB, then byte5 high nibble 0xC -> 0xABC
  assert.equal(dec.Moto.raw, 0xABC);
});

test('Log parsing (candump formats + CSV) and per-ID measurement', () => {
  const lines = [];
  for (let k = 0; k < 200; k++) {
    lines.push(`(${(1000 + k * 0.01 + (k % 3) * 0.0001).toFixed(6)}) can0 100#1122334455667788`);
    if (k % 2 === 0) lines.push(`(${(1000.002 + k * 0.01).toFixed(6)}) can0 18FEF100#0102`);
  }
  const log = C.parseLog(lines.join('\n'));
  assert.equal(log.format, 'candump');
  assert.equal(log.frames.length, 300);
  const meas = C.measureTrace(log.frames);
  const a = meas.ids.find((x) => x.id === 0x100);
  assert.ok(Math.abs(a.fitPeriod - 0.01) < 1e-6);
  assert.ok(Math.abs(a.jitterSpread - 0.0002) < 2e-6);
  const b = meas.ids.find((x) => x.extended);
  assert.equal(b.dlcMax, 2);
  assert.ok(Math.abs(b.fitPeriod - 0.02) < 1e-6);
  const csv = C.parseLog('timestamp,id,dlc,data\n0.1,0x123,2,ABCD\n0.2,123,2,AB CD');
  assert.equal(csv.frames.length, 2);
  assert.equal(csv.frames[1].data[1], 0xCD);
});

test('Bitrate inference from back-to-back frames', () => {
  // Build a saturated synthetic trace via the simulator at 500k
  const set = randomSet(3, 30, 500000).map((m) => Object.assign(m, { Tms: m.Tms / 20 }));
  const sim = C.simulate(set, { bitrate: 500000, duration: ms(200), jitterMode: 'zero', lengthMode: (m) => C.exactFrameBits(m.id, m.extended, []) });
  const frames = sim.frames.map((f) => ({ t: f.end / 1e9, id: f.id, extended: set.find((m) => m.key === f.key).extended, data: new Uint8Array(0) }));
  const inf = C.inferBitrate(frames);
  assert.ok(inf);
  assert.ok(inf.snapped === 500000 || inf.snapped === 800000, 'snapped ' + inf.snapped);
});
