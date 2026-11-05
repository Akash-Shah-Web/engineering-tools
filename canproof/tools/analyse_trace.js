#!/usr/bin/env node
/*
 * Measure a CAN capture and compare it with CANProof's predictions.
 *
 *   node tools/analyse_trace.js <capture.log> [--bitrate 500000] [--dbc file.dbc]
 *        [--label measured|synthetic] [--source "ROAD ambient_dyno_drive_basic_long"]
 *        [--out data/samples/name.json] [--excerpt 10]
 *
 * Output JSON (embedded into the web page by tools/build.js when placed in
 * data/samples/):
 *   provenance  — label + source; deadlines flagged as ASSUMED (D = measured T)
 *   ids         — per-ID period (median, LSQ fit), jitter spread, DLC, count
 *   model       — Davis 2007 WCRT for the trace-derived message set (J=0 and J=measured)
 *   comparison  — observed vs predicted bus load; per-ID observed spread vs bound
 *   excerpt     — first N seconds of frames (for replay), if --excerpt given
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../src/core.js');

function args() {
  const a = process.argv.slice(2);
  const o = { file: a[0], label: 'measured', excerpt: 0 };
  for (let i = 1; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    o[k] = a[++i];
  }
  return o;
}

function run(o) {
  const text = fs.readFileSync(o.file, 'utf8');
  const log = C.parseLog(text);
  if (!log.frames.length) throw new Error('no frames parsed');
  const inferred = C.inferBitrate(log.frames);
  const bitrate = o.bitrate ? Number(o.bitrate) : inferred && inferred.snapped;
  if (!bitrate) throw new Error('bitrate unknown: pass --bitrate');
  const meas = C.measureTrace(log.frames);
  let set = C.messageSetFromTrace(meas);
  let dbcInfo = null;
  if (o.dbc) {
    const dbc = C.parseDBC(fs.readFileSync(o.dbc, 'utf8'));
    dbcInfo = { file: path.basename(o.dbc), messages: dbc.messages.length };
    // use DBC names where IDs match (timing still from the trace)
    for (const m of set) {
      const d = dbc.messages.find((x) => x.id === m.id && x.extended === m.extended);
      if (d) m.name = d.name;
    }
  }
  const a0 = C.analyse(set, { bitrate, method: 'davis' });
  const setJ = C.messageSetFromTrace(meas, { jitterFromTrace: true });
  const aJ = C.analyse(setJ, { bitrate, method: 'davis' });
  const cmp0 = C.compareTraceToModel(meas, a0, bitrate);
  const cmpJ = C.compareTraceToModel(meas, aJ, bitrate);
  const loadTl = C.loadTimeline(log.frames, bitrate, 0.1);
  const peak = loadTl.reduce((m, x) => Math.max(m, x.load), 0);
  const out = {
    provenance: {
      label: o.label, source: o.source || path.basename(o.file), file: path.basename(o.file),
      generated: new Date().toISOString().slice(0, 10),
      notes: [
        'Periods, jitter spread and payload lengths are MEASURED from the capture timestamps.',
        'Deadlines are NOT in the data: ASSUMED equal to the measured period (implicit deadlines).',
        'Release jitter is not observable from a single bus tap: model run twice — J = 0 (assumed) and J = measured spread (conservative).',
        inferred ? `Bitrate inferred from back-to-back frames: ${Math.round(inferred.estimate)} bit/s -> ${inferred.snapped}` : 'Bitrate could not be inferred.',
      ],
    },
    bitrate, bitrateInferred: inferred, dbc: dbcInfo,
    frames: log.frames.length, skippedLines: log.skipped, duration: meas.duration,
    ids: meas.ids.map((x) => ({
      key: x.key, id: x.id, extended: x.extended, count: x.count, periodic: x.periodic,
      medianPeriodMs: r6(x.medianPeriod * 1e3), fitPeriodMs: x.fitPeriod && r6(x.fitPeriod * 1e3),
      minDeltaMs: x.minDelta && r6(x.minDelta * 1e3), maxDeltaMs: x.maxDelta && r6(x.maxDelta * 1e3),
      cv: x.cv && r6(x.cv), jitterSpreadMs: x.jitterSpread != null ? r6(x.jitterSpread * 1e3) : null,
      missing: x.missing, dlcMin: x.dlcMin, dlcMax: x.dlcMax,
    })),
    model: {
      J0: a0.results.map(slim), Jmeasured: aJ.results.map(slim),
      loadWorst: a0.load.worst, loadBest: a0.load.best,
    },
    comparison: {
      load: { observed: cmp0.load.observed, predictedWorst: cmp0.load.predictedWorst, predictedBest: cmp0.load.predictedBest, peak100ms: peak },
      J0: cmp0.rows, Jmeasured: cmpJ.rows,
      disagreementsJ0: cmp0.rows.filter((r) => r.status === 'DISAGREES').length,
      disagreementsJmeasured: cmpJ.rows.filter((r) => r.status === 'DISAGREES').length,
      aperiodic: meas.ids.filter((x) => !x.periodic).length,
    },
    loadTimeline: loadTl.map((x) => r6(x.load)),
  };
  if (Number(o.excerpt) > 0) {
    const t0 = log.frames[0].t;
    out.excerpt = log.frames.filter((f) => f.t - t0 <= Number(o.excerpt)).map((f) => [r6(f.t - t0), f.id, f.extended ? 1 : 0, Buffer.from(f.data).toString('hex')]);
  }
  return out;
}
function slim(r) { return { key: r.key, name: r.name, Rms: Number.isFinite(r.R) ? r6(r.R / 1e6) : null, Dms: r6(r.D / 1e6), Cms: r6(r.C / 1e6), schedulable: r.schedulable }; }
function r6(x) { return x == null ? null : Math.round(x * 1e6) / 1e6; }

if (require.main === module) {
  const o = args();
  const out = run(o);
  const js = JSON.stringify(out);
  if (o.out) { fs.writeFileSync(o.out, js); console.error('wrote ' + o.out); } else process.stdout.write(js);
  const c = out.comparison;
  console.error(`${out.frames} frames, ${out.ids.length} IDs, ${out.duration.toFixed(1)} s @ ${out.bitrate} bit/s`);
  console.error(`load observed ${(100 * c.load.observed).toFixed(2)}% | predicted best ${(100 * c.load.predictedBest).toFixed(2)}% worst ${(100 * c.load.predictedWorst).toFixed(2)}% | peak(100ms) ${(100 * c.load.peak100ms).toFixed(1)}%`);
  console.error(`disagreements (observed spread > R - Cmin): J=0 ${c.disagreementsJ0}, J=measured ${c.disagreementsJmeasured}; aperiodic IDs ${c.aperiodic}`);
}
module.exports = { run };
