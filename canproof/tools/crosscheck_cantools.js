// Compare CANProof decoding with cantools output (see crosscheck_cantools.py).
'use strict';
const fs = require('fs');
const C = require('../src/core.js');
const dbc = C.parseDBC(fs.readFileSync(process.argv[2], 'utf8'));
const ref = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
let compared = 0; let mism = 0; let skipped = 0;
for (const [name, rows] of Object.entries(ref)) {
  const msg = dbc.messages.find((m) => m.name === name);
  for (const row of rows) {
    if (row.error) { skipped++; continue; }
    const data = Buffer.from(row.data, 'hex');
    const mine = Object.fromEntries(C.decodeMessage(msg, data).map((s) => [s.name, s.phys]));
    for (const [sig, v] of Object.entries(row.signals)) {
      compared++;
      if (mine[sig] == null || Math.abs(mine[sig] - v) > 1e-6 * Math.max(1, Math.abs(v))) {
        mism++;
        if (mism < 20) console.log(`MISMATCH ${name}.${sig} data=${row.data} canproof=${mine[sig]} cantools=${v}`);
      }
    }
  }
}
console.log(`compared ${compared} decoded signal values; mismatches ${mism}; rows skipped (cantools error) ${skipped}`);
process.exit(mism ? 1 : 0);
