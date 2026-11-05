// Dump random message sets + CANProof (Davis 2007) results for an independent
// cross-check with pyCPA (see tools/crosscheck_pycpa.py).
'use strict';
const C = require('../src/core.js');
function randomSet(seed, n) {
  let x = seed >>> 0;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  const periods = [2, 5, 10, 10, 20, 20, 50, 100, 100, 200, 1000];
  const ids = new Set(); const out = [];
  while (out.length < n) {
    const id = 1 + Math.floor(rnd() * 0x7fe);
    if (ids.has(id)) continue; ids.add(id);
    const T = periods[Math.floor(rnd() * periods.length)];
    out.push({ key: 's' + id, name: 'M' + id, id, extended: false, dlc: Math.floor(rnd() * 9), Tms: T, Dms: T, Jms: rnd() < 0.5 ? 0 : Math.round(T * 0.2 * rnd() * 1000) / 1000 });
  }
  return out;
}
const cases = [];
for (let seed = 1; seed <= Number(process.argv[2] || 200); seed++) {
  const bitrate = [125000, 250000, 500000, 1000000][seed % 4];
  const set = randomSet(seed, 5 + (seed % 25));
  const a = C.analyse(set, { bitrate, method: 'davis' });
  cases.push({
    seed, bitrate, tau: 1e9 / bitrate,
    msgs: C.sortByPriority(set).map((m, i) => ({ key: m.key, prio: i, C: C.worstCaseFrameBits(m.dlc, false) * 1e9 / bitrate, T: Math.round(m.Tms * 1e6), J: Math.round(m.Jms * 1e6) })),
    R: Object.fromEntries(a.results.map((r) => [r.key, Number.isFinite(r.R) ? r.R : null])),
    load: a.load.worst,
  });
}
process.stdout.write(JSON.stringify(cases));
