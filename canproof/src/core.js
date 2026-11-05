/*
 * CANProof core — DBC parsing, frame timing, bus load and worst-case response
 * time (WCRT) analysis for Classical CAN.
 *
 * Analysis follows R.I. Davis, A. Burns, R.J. Bril, J.J. Lukkien,
 * "Controller Area Network (CAN) schedulability analysis: Refuted, revisited
 * and revised", Real-Time Systems 35(3):239-272, 2007.
 * DOI 10.1007/s11241-007-9012-7.
 *
 * All internal times are integer NANOSECONDS so that the ceiling functions in
 * the recurrence relations are exact (no floating point rounding surprises).
 *
 * UMD module: works in the browser (window.CANProof) and in Node (require).
 * Licence: MIT (see canproof/LICENSE).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CANProof = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NS_PER_MS = 1e6;
  const msToNs = (ms) => Math.round(Number(ms) * NS_PER_MS);
  const nsToMs = (ns) => ns / NS_PER_MS;
  const bitTimeNs = (bitrate) => {
    const t = 1e9 / bitrate;
    if (!Number.isFinite(t) || t <= 0) throw new Error('Invalid bitrate ' + bitrate);
    return t; // may be non-integer for odd bitrates (e.g. 83.333k = 12000ns exact)
  };

  /* ------------------------------------------------------------------ *
   * Frame timing
   * ------------------------------------------------------------------ */

  /**
   * Worst-case number of bits on the wire for a Classical CAN data frame,
   * Davis et al. 2007, eq. (1):
   *   C = (g + 8s + 13 + floor((g + 8s - 1) / 4)) * tau_bit
   * g = 34 (11-bit identifier) or 54 (29-bit identifier); 13 bits are the
   * unstuffed tail (CRC delimiter, ACK slot+delimiter, 7 EOF, 3 IFS).
   */
  function worstCaseFrameBits(dlcBytes, extended) {
    const s = clampPayload(dlcBytes);
    const g = extended ? 54 : 34;
    return g + 8 * s + 13 + Math.floor((g + 8 * s - 1) / 4);
  }
  /** Worst-case bits of a message entry; `Cbits` overrides (for published examples given as C). */
  function frameBitsOf(m) { return m.Cbits != null ? m.Cbits : worstCaseFrameBits(m.dlc, m.extended); }
  /** Frame length with zero stuff bits (best case). */
  function minFrameBits(dlcBytes, extended) {
    const s = clampPayload(dlcBytes);
    return (extended ? 54 : 34) + 8 * s + 13;
  }
  function clampPayload(s) {
    s = Math.floor(Number(s));
    if (!(s >= 0)) return 0;
    return Math.min(s, 8);
  }

  /** CRC-15/CAN, polynomial 0x4599, over an array of bits. */
  function crc15(bits) {
    let crc = 0;
    for (let i = 0; i < bits.length; i++) {
      const nxt = bits[i] ^ ((crc >> 14) & 1);
      crc = (crc << 1) & 0x7fff;
      if (nxt) crc ^= 0x4599;
    }
    return crc;
  }
  function pushBits(arr, value, n) {
    for (let i = n - 1; i >= 0; i--) arr.push(Math.floor(value / Math.pow(2, i)) % 2);
  }

  /**
   * Build the exact bit sequence of a Classical CAN data frame as transmitted,
   * including stuff bits. Returns { bits:[{v, field, stuff}], stuffCount, total }.
   * ACK slot is shown recessive (as sent by the transmitter).
   */
  function buildFrame(id, extended, data) {
    const bytes = Array.from(data || []).slice(0, 8);
    const dlc = bytes.length;
    const raw = []; // {v, field}
    const add = (value, n, field) => {
      const tmp = [];
      pushBits(tmp, value, n);
      tmp.forEach((v) => raw.push({ v, field }));
    };
    add(0, 1, 'SOF');
    if (!extended) {
      add(id & 0x7ff, 11, 'ID');
      add(0, 1, 'RTR');
      add(0, 1, 'IDE');
      add(0, 1, 'r0');
    } else {
      add((id >>> 18) & 0x7ff, 11, 'ID-A');
      add(1, 1, 'SRR');
      add(1, 1, 'IDE');
      add(id & 0x3ffff, 18, 'ID-B');
      add(0, 1, 'RTR');
      add(0, 1, 'r1');
      add(0, 1, 'r0');
    }
    add(dlc, 4, 'DLC');
    bytes.forEach((b, i) => add(b & 0xff, 8, 'D' + i));
    const crc = crc15(raw.map((b) => b.v));
    add(crc, 15, 'CRC');
    // Stuffing over SOF..CRC
    const out = [];
    let run = 0;
    let last = -1;
    let stuffCount = 0;
    for (const b of raw) {
      out.push({ v: b.v, field: b.field, stuff: false });
      if (b.v === last) run++;
      else { run = 1; last = b.v; }
      if (run === 5) {
        const sv = 1 - b.v;
        out.push({ v: sv, field: b.field, stuff: true });
        stuffCount++;
        last = sv;
        run = 1;
      }
    }
    const tail = [['CRC-del', 1, 1], ['ACK', 1, 1], ['ACK-del', 1, 1], ['EOF', 7, 0x7f], ['IFS', 3, 7]];
    tail.forEach(([f, n, v]) => { const t = []; pushBits(t, v, n); t.forEach((x) => out.push({ v: x, field: f, stuff: false })); });
    return { bits: out, stuffCount, total: out.length, crc, dlc };
  }

  /** Exact on-wire bit count (incl. 3-bit IFS) of a specific frame. */
  function exactFrameBits(id, extended, data) {
    return buildFrame(id, extended, data).total;
  }

  /* ------------------------------------------------------------------ *
   * DBC parsing
   * ------------------------------------------------------------------ */

  function tokenizeLine(line) {
    return line;
  }

  /**
   * Parse a DBC file. Returns { nodes, messages, attributes, errors, warnings }.
   * Supports BU_, BO_, SG_ (incl. multiplexing), CM_, BA_DEF_, BA_DEF_DEF_, BA_,
   * VAL_. Identifier bit 31 marks extended (29-bit) frames.
   */
  function parseDBC(text) {
    const res = {
      version: '', nodes: [], messages: [], attrDefs: {}, attrDefaults: {},
      errors: [], warnings: [], valueTables: {},
    };
    const byId = new Map();
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    let cur = null;
    // Join CM_/BA_ statements that span lines (terminated by ';')
    const stmts = [];
    for (let i = 0; i < lines.length; i++) {
      let l = lines[i];
      const t = l.trim();
      if (/^(CM_|BA_DEF_|BA_DEF_DEF_|BA_|VAL_)\b/.test(t) && !/;\s*$/.test(t)) {
        let j = i;
        let acc = l;
        while (j + 1 < lines.length && !/;\s*$/.test(acc.trim())) { j++; acc += '\n' + lines[j]; }
        stmts.push({ text: acc, line: i + 1 });
        i = j;
      } else stmts.push({ text: l, line: i + 1 });
    }
    const reBO = /^BO_\s+(\d+)\s+([A-Za-z_][\w]*)\s*:\s*(\d+)\s+([\w]+)/;
    const reSG = /^SG_\s+([A-Za-z_][\w]*)\s*(M|m\d+M?)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)\s*\[\s*([^|]*?)\s*\|\s*([^\]]*?)\s*\]\s*"((?:[^"\\]|\\.)*)"\s*(.*)$/;
    for (const st of stmts) {
      const t = st.text.trim();
      if (!t) continue;
      let m;
      if (t.startsWith('VERSION')) {
        const q = t.match(/"([^"]*)"/); res.version = q ? q[1] : '';
      } else if (/^BU_\s*:/.test(t)) {
        res.nodes = t.replace(/^BU_\s*:/, '').trim().split(/\s+/).filter(Boolean);
      } else if ((m = t.match(reBO))) {
        const rawId = Number(m[1]);
        const extended = rawId >= 0x80000000;
        const id = extended ? rawId - 0x80000000 : rawId;
        cur = {
          rawId, id, extended, name: m[2], dlc: Number(m[3]), sender: m[4],
          signals: [], attrs: {}, comment: '', line: st.line,
        };
        if (!extended && id > 0x7ff) {
          res.errors.push({ line: st.line, msg: m[2], code: 'ID_RANGE', text: `Standard ID 0x${id.toString(16)} exceeds 11 bits (set bit 31 for extended IDs)` });
        }
        if (extended && id > 0x1fffffff) res.errors.push({ line: st.line, msg: m[2], code: 'ID_RANGE', text: 'Extended ID exceeds 29 bits' });
        const key = (extended ? 'x' : 's') + id;
        if (byId.has(key)) res.errors.push({ line: st.line, msg: m[2], code: 'DUP_ID', text: `Duplicate identifier 0x${id.toString(16).toUpperCase()} (also used by ${byId.get(key).name})` });
        else byId.set(key, cur);
        res.messages.push(cur);
      } else if (/^SG_\s/.test(t)) {
        m = t.match(reSG);
        if (!m) { res.errors.push({ line: st.line, code: 'SYNTAX', text: 'Unparseable signal definition: ' + t.slice(0, 80) }); continue; }
        if (!cur) { res.errors.push({ line: st.line, code: 'SYNTAX', text: 'Signal outside message' }); continue; }
        let mux = null;
        if (m[2] === 'M') mux = { role: 'mux' };
        else if (m[2]) {
          const mm = m[2].match(/^m(\d+)(M?)$/);
          mux = { role: 'muxed', value: Number(mm[1]), alsoMux: !!mm[2] };
        }
        cur.signals.push({
          name: m[1], mux, start: Number(m[3]), length: Number(m[4]),
          byteOrder: m[5] === '1' ? 'intel' : 'motorola', signed: m[6] === '-',
          factor: Number(m[7]), offset: Number(m[8]), min: Number(m[9]), max: Number(m[10]),
          unit: m[11], receivers: m[12].trim().split(/[\s,]+/).filter(Boolean), line: st.line,
          values: null, comment: '',
        });
      } else if (t.startsWith('BA_DEF_DEF_')) {
        m = t.match(/^BA_DEF_DEF_\s+"([^"]+)"\s+(.+?)\s*;/s);
        if (m) res.attrDefaults[m[1]] = parseAttrValue(m[2]);
      } else if (t.startsWith('BA_DEF_')) {
        m = t.match(/^BA_DEF_\s+(BU_|BO_|SG_|EV_)?\s*"([^"]+)"\s+(\w+)\s*(.*?);/s);
        if (m) res.attrDefs[m[2]] = { scope: m[1] || 'NET', type: m[3], spec: m[4].trim() };
      } else if (t.startsWith('BA_ ')) {
        m = t.match(/^BA_\s+"([^"]+)"\s+BO_\s+(\d+)\s+(.+?)\s*;/s);
        if (m) {
          const msg = findRaw(res.messages, Number(m[2]));
          if (msg) msg.attrs[m[1]] = parseAttrValue(m[3]);
          else res.warnings.push({ line: st.line, code: 'ATTR_ORPHAN', text: `Attribute ${m[1]} for unknown message ${m[2]}` });
        }
      } else if (t.startsWith('CM_')) {
        m = t.match(/^CM_\s+BO_\s+(\d+)\s+"((?:[^"\\]|\\.)*)"\s*;/s);
        if (m) { const msg = findRaw(res.messages, Number(m[1])); if (msg) msg.comment = m[2]; }
        m = t.match(/^CM_\s+SG_\s+(\d+)\s+(\w+)\s+"((?:[^"\\]|\\.)*)"\s*;/s);
        if (m) {
          const msg = findRaw(res.messages, Number(m[1]));
          const sg = msg && msg.signals.find((s) => s.name === m[2]);
          if (sg) sg.comment = m[3];
        }
      } else if (t.startsWith('VAL_ ')) {
        m = t.match(/^VAL_\s+(\d+)\s+(\w+)\s+(.*);/s);
        if (m) {
          const msg = findRaw(res.messages, Number(m[1]));
          const sg = msg && msg.signals.find((s) => s.name === m[2]);
          if (sg) {
            sg.values = {};
            const re = /(-?\d+)\s+"((?:[^"\\]|\\.)*)"/g;
            let v;
            while ((v = re.exec(m[3]))) sg.values[v[1]] = v[2];
          }
        }
      }
    }
    // Resolve cycle times
    for (const msg of res.messages) {
      const ct = pickAttr(msg, res, ['GenMsgCycleTime', 'CycleTime', 'GenMsgCycleTimeFast']);
      msg.cycleTimeMs = ct != null && Number(ct) > 0 ? Number(ct) : null;
      msg.cycleSource = msg.cycleTimeMs != null ? (msg.attrs.GenMsgCycleTime != null || msg.attrs.CycleTime != null ? 'dbc' : 'dbc-default') : null;
      const dl = pickAttr(msg, res, ['GenMsgDeadline', 'Deadline', 'GenMsgDeadlineTime']);
      msg.deadlineMs = dl != null && Number(dl) > 0 ? Number(dl) : null;
      const jt = pickAttr(msg, res, ['GenMsgJitter', 'Jitter']);
      msg.jitterMs = jt != null && Number(jt) >= 0 ? Number(jt) : null;
      const st = pickAttr(msg, res, ['GenMsgSendType']);
      msg.sendType = st;
      const ftype = pickAttr(msg, res, ['VFrameFormat', 'CANFD_BRS']);
      if (typeof ftype === 'number' && res.attrDefs.VFrameFormat) {
        // enum lookup
        const enumVals = parseEnum(res.attrDefs.VFrameFormat.spec);
        msg.frameFormat = enumVals[ftype] || String(ftype);
      } else msg.frameFormat = null;
    }
    return res;
  }
  function parseEnum(spec) {
    const out = [];
    const re = /"([^"]*)"/g; let m;
    while ((m = re.exec(spec))) out.push(m[1]);
    return out;
  }
  function parseAttrValue(s) {
    s = String(s).trim();
    if (/^"/.test(s)) return s.replace(/^"|"$/g, '');
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  function pickAttr(msg, res, names) {
    for (const n of names) if (msg.attrs[n] != null) return msg.attrs[n];
    for (const n of names) if (res.attrDefaults[n] != null && res.attrDefs[n] && res.attrDefs[n].scope === 'BO_') return res.attrDefaults[n];
    return null;
  }
  function findRaw(msgs, rawId) { return msgs.find((m) => m.rawId === rawId); }

  /* ------------------------------------------------------------------ *
   * Signal bit layout & decoding
   * ------------------------------------------------------------------ */

  /**
   * Bit positions occupied by a signal, as DBC "sawtooth" indices
   * (byte*8 + bit-in-byte, bit 0 = LSB of byte 0), ordered LSB -> MSB of value.
   */
  function signalBits(sig) {
    const pos = [];
    if (sig.length <= 0) return pos;
    if (sig.byteOrder === 'intel') {
      for (let i = 0; i < sig.length; i++) pos.push(sig.start + i);
    } else {
      // Motorola: start bit is the MSB; walk towards LSB.
      let p = sig.start;
      const msbFirst = [];
      for (let i = 0; i < sig.length; i++) {
        msbFirst.push(p);
        if (p % 8 === 0) p += 15; else p -= 1;
      }
      for (let i = msbFirst.length - 1; i >= 0; i--) pos.push(msbFirst[i]);
    }
    return pos;
  }

  /** Extract raw unsigned value (as Number; exact up to 53 bits). */
  function extractRaw(sig, data) {
    const pos = signalBits(sig);
    let v = 0;
    for (let i = pos.length - 1; i >= 0; i--) {
      const p = pos[i];
      const byte = data[p >> 3] || 0;
      v = v * 2 + ((byte >> (p & 7)) & 1);
    }
    return v;
  }
  /** Encode a physical value into data bytes (in place). Clamps to raw range. */
  function encodeSignal(sig, data, phys) {
    let raw = Math.round((phys - sig.offset) / (sig.factor || 1));
    const max = sig.signed ? Math.pow(2, sig.length - 1) - 1 : Math.pow(2, sig.length) - 1;
    const min = sig.signed ? -Math.pow(2, sig.length - 1) : 0;
    raw = Math.max(min, Math.min(max, raw));
    if (raw < 0) raw += Math.pow(2, sig.length);
    const pos = signalBits(sig);
    for (let i = 0; i < pos.length; i++) {
      const p = pos[i];
      if (p < 0 || (p >> 3) >= data.length) continue;
      const bit = Math.floor(raw / Math.pow(2, i)) % 2;
      if (bit) data[p >> 3] |= (1 << (p & 7)); else data[p >> 3] &= ~(1 << (p & 7));
    }
    return data;
  }
  function decodeSignal(sig, data) {
    let raw = extractRaw(sig, data);
    if (sig.signed && sig.length > 0 && raw >= Math.pow(2, sig.length - 1)) raw -= Math.pow(2, sig.length);
    const phys = raw * sig.factor + sig.offset;
    const label = sig.values && sig.values[String(raw)] != null ? sig.values[String(raw)] : null;
    return { raw, phys, label };
  }
  /** Decode all signals in a message, honouring multiplexing. */
  function decodeMessage(msg, data) {
    const out = [];
    const muxSig = msg.signals.find((s) => s.mux && s.mux.role === 'mux');
    const muxVal = muxSig ? extractRaw(muxSig, data) : null;
    for (const s of msg.signals) {
      if (s.mux && s.mux.role === 'muxed' && s.mux.value !== muxVal) continue;
      out.push(Object.assign({ name: s.name, unit: s.unit, sig: s }, decodeSignal(s, data)));
    }
    return out;
  }

  /**
   * Check DBC signal layout. Returns list of findings
   * {severity:'error'|'warning', code, msg, signal, text}.
   */
  function checkLayout(dbc) {
    const out = [];
    const push = (severity, code, msg, signal, text) => out.push({ severity, code, msg: msg && msg.name, id: msg && msg.id, signal, text });
    for (const msg of dbc.messages) {
      if (msg.dlc > 8) {
        push('error', 'DLC_FD', msg, null, `DLC ${msg.dlc} > 8: CAN FD frames are not supported by this Classical CAN analysis`);
      }
      const nbits = Math.min(msg.dlc, 64) * 8;
      const names = new Set();
      const occ = new Map(); // bit -> [{sig, muxKey}]
      for (const s of msg.signals) {
        if (names.has(s.name)) push('error', 'DUP_SIGNAL', msg, s.name, `Duplicate signal name ${s.name}`);
        names.add(s.name);
        if (s.length <= 0) { push('error', 'ZERO_LEN', msg, s.name, 'Signal length is zero'); continue; }
        if (s.length > 64) push('error', 'TOO_LONG', msg, s.name, `Signal length ${s.length} > 64 bits`);
        if (s.factor === 0) push('warning', 'ZERO_FACTOR', msg, s.name, 'Factor is 0 — every raw value decodes to the offset');
        const bits = signalBits(s);
        const outside = bits.filter((b) => b < 0 || b >= nbits);
        if (outside.length) push('error', 'OUT_OF_FRAME', msg, s.name, `${outside.length} bit(s) fall outside the ${msg.dlc}-byte payload (bits ${outside.slice(0, 4).join(',')}${outside.length > 4 ? '…' : ''})`);
        if (s.byteOrder === 'motorola' && s.length > 1) {
          // A common error: Motorola start bit given as LSB (Intel style) -> detect wrap past byte 0 upwards
          const negative = bits.some((b) => b < 0);
          if (negative) push('error', 'MOTOROLA_START', msg, s.name, 'Motorola signal runs before byte 0 — start bit is probably the LSB, not the MSB');
        }
        // range check
        const rawMax = s.signed ? Math.pow(2, s.length - 1) - 1 : Math.pow(2, s.length) - 1;
        const rawMin = s.signed ? -Math.pow(2, s.length - 1) : 0;
        const p1 = rawMin * s.factor + s.offset; const p2 = rawMax * s.factor + s.offset;
        const lo = Math.min(p1, p2); const hi = Math.max(p1, p2);
        if (!(s.min === 0 && s.max === 0) && (s.min < lo - 1e-9 * Math.abs(lo) - 1e-9 || s.max > hi + 1e-9 * Math.abs(hi) + 1e-9)) {
          push('warning', 'RANGE', msg, s.name, `Declared range [${s.min}, ${s.max}] exceeds what ${s.length} bits can encode [${round6(lo)}, ${round6(hi)}]`);
        }
        if (s.min > s.max) push('warning', 'RANGE_ORDER', msg, s.name, `Minimum ${s.min} > maximum ${s.max}`);
        const muxKey = s.mux && s.mux.role === 'muxed' ? s.mux.value : 'always';
        for (const b of bits) {
          if (!occ.has(b)) occ.set(b, []);
          occ.get(b).push({ name: s.name, muxKey });
        }
      }
      const reported = new Set();
      for (const [b, list] of occ) {
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
          const a = list[i]; const c = list[j];
          const conflict = a.muxKey === 'always' || c.muxKey === 'always' || a.muxKey === c.muxKey;
          if (!conflict) continue;
          const key = [a.name, c.name].sort().join('|');
          if (reported.has(key)) continue;
          reported.add(key);
          push('error', 'OVERLAP', msg, a.name, `Signals ${a.name} and ${c.name} overlap (first shared bit ${b})`);
        }
      }
      const muxers = msg.signals.filter((s) => s.mux && s.mux.role === 'mux');
      if (muxers.length > 1) push('error', 'MULTI_MUX', msg, muxers[1].name, 'More than one multiplexor signal (simple multiplexing allows one)');
      if (msg.signals.some((s) => s.mux && s.mux.role === 'muxed') && muxers.length === 0) push('error', 'NO_MUX', msg, null, 'Multiplexed signals without a multiplexor');
      if (msg.sender && dbc.nodes.length && msg.sender !== 'Vector__XXX' && !dbc.nodes.includes(msg.sender)) push('warning', 'SENDER', msg, null, `Sender ${msg.sender} is not declared in BU_`);
    }
    for (const e of dbc.errors) out.push({ severity: 'error', code: e.code, msg: e.msg || null, signal: null, text: `line ${e.line}: ${e.text}` });
    return out;
  }
  function round6(x) { return Math.round(x * 1e6) / 1e6; }

  /* ------------------------------------------------------------------ *
   * Message set construction
   * ------------------------------------------------------------------ */

  /**
   * Turn a parsed DBC into an analysis message set.
   * Each entry: { key, id, extended, name, sender, dlc, T, D, J (ns), source:{...} }
   * Priority = identifier (lower wins); for mixed 11/29-bit, arbitration compares
   * the 11-bit base ID first and a standard frame beats an extended one with the
   * same base ID (because RTR(0) < SRR(1)).
   */
  function messageSetFromDBC(dbc, opts) {
    opts = opts || {};
    const set = [];
    for (const m of dbc.messages) {
      if (/VECTOR__INDEPENDENT_SIG_MSG/.test(m.name)) continue;
      const T = m.cycleTimeMs;
      set.push({
        key: (m.extended ? 'x' : 's') + m.id, id: m.id, extended: m.extended, name: m.name,
        sender: m.sender, dlc: Math.min(m.dlc, 8),
        Tms: T, Dms: m.deadlineMs != null ? m.deadlineMs : T, Jms: m.jitterMs != null ? m.jitterMs : 0,
        source: {
          T: T != null ? 'dbc' : 'missing',
          D: m.deadlineMs != null ? 'dbc' : (T != null ? 'assumed (D = T)' : 'missing'),
          J: m.jitterMs != null ? 'dbc' : 'assumed (J = 0)',
        },
      });
    }
    return set;
  }

  /** Arbitration key: smaller wins. */
  function arbKey(m) {
    if (!m.extended) return m.id * 2 * Math.pow(2, 18); // base ID, then SRR/RTR bit 0
    const base = Math.floor(m.id / Math.pow(2, 18));
    const ext = m.id % Math.pow(2, 18);
    return (base * 2 + 1) * Math.pow(2, 18) + ext;
  }
  function sortByPriority(set) {
    return set.slice().sort((a, b) => (a.prio != null && b.prio != null ? a.prio - b.prio : arbKey(a) - arbKey(b)));
  }

  /* ------------------------------------------------------------------ *
   * Bus load
   * ------------------------------------------------------------------ */
  function busLoad(set, bitrate) {
    const tb = bitTimeNs(bitrate);
    let worst = 0; let best = 0;
    const per = [];
    for (const m of set) {
      if (!(m.Tms > 0)) continue;
      const Tn = msToNs(m.Tms);
      const cw = frameBitsOf(m) * tb;
      const cb = (m.Cbits != null ? m.Cbits : minFrameBits(m.dlc, m.extended)) * tb;
      worst += cw / Tn; best += cb / Tn;
      per.push({ key: m.key, worst: cw / Tn, best: cb / Tn });
    }
    return { worst, best, per };
  }

  /* ------------------------------------------------------------------ *
   * Response-time analysis
   * ------------------------------------------------------------------ */

  /**
   * Revised CAN schedulability analysis (Davis et al. 2007, Section 4).
   *
   *   C_m  = worst-case transmission time (eq. 1)
   *   B_m  = max_{k in lp(m)} C_k                           (eq. 4)
   *   t_m  = B_m + sum_{k in hep(m)} ceil((t_m + J_k)/T_k) C_k  (eq. 10)
   *   Q_m  = ceil((t_m + J_m)/T_m)                          (eq. 11)
   *   w_m(q) = B_m + q C_m
   *          + sum_{k in hp(m)} ceil((w_m(q) + J_k + tau_bit)/T_k) C_k   (eq. 12)
   *   R_m(q) = J_m + w_m(q) - q T_m + C_m                    (eq. 13)
   *   R_m  = max_{q=0..Q_m-1} R_m(q)                         (eq. 14)
   *
   * Options: { bitrate, method: 'davis'|'sufficient'|'tindell', errorBits }
   * 'sufficient' is Davis et al. eq. (16): w = max(B_m, C_m) + sum hp ...,
   * R = J + w + C — a simpler upper bound.
   * 'tindell' is the ORIGINAL (flawed, optimistic) analysis, provided ONLY so
   * users can see the difference. It must never be used to claim schedulability.
   */
  function analyse(set, opts) {
    const bitrate = opts.bitrate;
    const method = opts.method || 'davis';
    const tau = bitTimeNs(bitrate);
    const ordered = sortByPriority(set.filter((m) => m.Tms > 0));
    const n = ordered.length;
    const C = ordered.map((m) => frameBitsOf(m) * tau);
    const T = ordered.map((m) => msToNs(m.Tms));
    const D = ordered.map((m) => msToNs(m.Dms != null ? m.Dms : m.Tms));
    const J = ordered.map((m) => msToNs(m.Jms || 0));
    const results = [];
    const horizon = opts.horizonNs || Math.max(1e10, 1000 * Math.max(...T, 1)); // divergence guard
    for (let i = 0; i < n; i++) {
      let B = 0; let Bfrom = null;
      for (let k = i + 1; k < n; k++) if (C[k] > B) { B = C[k]; Bfrom = ordered[k].key; }
      const hpU = sumRange(0, i, (k) => C[k] / T[k]);
      const hepU = hpU + C[i] / T[i];
      const r = {
        key: ordered[i].key, name: ordered[i].name, id: ordered[i].id, extended: ordered[i].extended,
        priorityRank: i, C: C[i], T: T[i], D: D[i], J: J[i], B, blockedBy: Bfrom, hepU,
        method, tau,
      };
      if (method === 'tindell') {
        const w = fixpoint(B, (w) => B + sumRange(0, i, (k) => Math.ceil(snap((w + J[k] + tau) / T[k])) * C[k]), horizon);
        r.w = w; r.R = w == null ? Infinity : J[i] + w + C[i]; r.Q = 1; r.worstQ = 0; r.instances = null;
      } else if (method === 'sufficient') {
        const base = Math.max(B, C[i]);
        const w = hpU >= 1 ? null : fixpoint(base, (w) => base + sumRange(0, i, (k) => Math.ceil(snap((w + J[k] + tau) / T[k])) * C[k]), horizon);
        r.w = w; r.R = w == null ? Infinity : J[i] + w + C[i]; r.Q = 1; r.worstQ = 0; r.instances = null;
      } else {
        // busy period (eq. 10)
        const t = hepU > 1 ? null : fixpoint(B + C[i], (t) => B + sumRange(0, i + 1, (k) => Math.ceil(snap((t + J[k]) / T[k])) * C[k]), horizon);
        if (t == null) { r.R = Infinity; r.busy = Infinity; r.Q = Infinity; r.instances = []; }
        else {
          r.busy = t;
          const Q = Math.ceil(snap((t + J[i]) / T[i]));
          r.Q = Q;
          r.instances = [];
          let Rmax = -Infinity; let worstQ = 0; let w = B;
          for (let q = 0; q < Q; q++) {
            const start = Math.max(w, B + q * C[i]);
            const wq = fixpoint(start, (w) => B + q * C[i] + sumRange(0, i, (k) => Math.ceil(snap((w + J[k] + tau) / T[k])) * C[k]), horizon);
            if (wq == null) { Rmax = Infinity; break; }
            w = wq;
            const Rq = J[i] + wq - q * T[i] + C[i];
            const interf = [];
            for (let k = 0; k < i; k++) {
              const cnt = Math.ceil(snap((wq + J[k] + tau) / T[k]));
              interf.push({ key: ordered[k].key, name: ordered[k].name, count: cnt, C: C[k], total: cnt * C[k] });
            }
            r.instances.push({ q, w: wq, R: Rq, interference: interf });
            if (Rq > Rmax) { Rmax = Rq; worstQ = q; }
            if (r.instances.length > 10000) break;
          }
          r.R = Rmax; r.worstQ = worstQ; r.w = r.instances[worstQ] ? r.instances[worstQ].w : null;
        }
      }
      r.schedulable = r.R <= r.D;
      r.slack = r.D - r.R;
      results.push(r);
    }
    return {
      bitrate, tau, method, results,
      schedulable: results.every((r) => r.schedulable),
      load: busLoad(ordered, bitrate),
    };
  }
  // Snap ratios that are integers within floating error (non-integer tau, e.g. 83.333kbit/s)
  function snap(x) { const r = Math.round(x); return Math.abs(x - r) < 1e-9 ? r : x; }
  function sumRange(a, b, f) { let s = 0; for (let k = a; k < b; k++) s += f(k); return s; }
  function fixpoint(start, f, horizon) {
    let x = start;
    for (let it = 0; it < 100000; it++) {
      const nx = f(x);
      if (Math.abs(nx - x) < 1e-6) return nx;
      if (nx > horizon) return null;
      x = nx;
    }
    return null;
  }

  /**
   * Audsley's Optimal Priority Assignment applied with the Davis analysis.
   * Davis et al. 2007 (Sect. 7) note that OPA is applicable to CAN since R_m
   * depends only on the SETS of higher/lower priority messages, not their order.
   * Returns { feasible, order:[keys high->low] , failedAt }.
   */
  function optimalPriorityAssignment(set, opts) {
    const remaining = set.filter((m) => m.Tms > 0).slice();
    const order = [];
    while (remaining.length) {
      // Try candidates for lowest priority; prefer largest deadline then current priority (stable)
      const cands = remaining.slice().sort((a, b) => (msToNs(b.Dms) - msToNs(a.Dms)) || (arbKey(b) - arbKey(a)));
      let placed = null;
      for (const c of cands) {
        const others = remaining.filter((m) => m !== c);
        const trial = others.map((m, idx) => Object.assign({}, m, { prio: idx })).concat([Object.assign({}, c, { prio: others.length })]);
        // lower priority already placed contribute blocking: add them with lower prio
        const lower = order.slice().reverse().map((m, idx) => Object.assign({}, m, { prio: others.length + 1 + idx }));
        const res = analyse(trial.concat(lower), Object.assign({}, opts, { method: opts.method || 'davis' }));
        const rc = res.results.find((r) => r.key === c.key);
        if (rc.schedulable) { placed = c; break; }
      }
      if (!placed) return { feasible: false, order: null, failedAt: remaining.map((m) => m.key) };
      order.unshift(placed);
      remaining.splice(remaining.indexOf(placed), 1);
    }
    return { feasible: true, order: order.map((m) => m.key) };
  }

  /**
   * Priority findings: deadline-monotonic inversions, unschedulable messages
   * that could be fixed by reassignment, low-slack messages.
   */
  function checkPriorities(set, analysis, opts) {
    const out = [];
    const ordered = sortByPriority(set.filter((m) => m.Tms > 0));
    const byKey = new Map(analysis.results.map((r) => [r.key, r]));
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const hi = ordered[i]; const lo = ordered[j];
        const dHi = hi.Dms; const dLo = lo.Dms;
        if (dLo < dHi) {
          const rl = byKey.get(lo.key);
          const sev = rl && !rl.schedulable ? 'error' : (rl && rl.slack < 0.25 * rl.D ? 'warning' : 'info');
          {
            out.push({ severity: sev, code: 'DM_INVERSION', key: lo.key, text: `${lo.name} (D=${fmtMs(dLo)}) has lower priority than ${hi.name} (D=${fmtMs(dHi)})` });
          }
        }
      }
    }
    for (const r of analysis.results) {
      if (!r.schedulable) out.push({ severity: 'error', code: 'DEADLINE_MISS', key: r.key, text: `${r.name}: worst-case response ${Number.isFinite(r.R) ? fmtMs(nsToMs(r.R)) : '∞ (busy period does not converge)'} exceeds deadline ${fmtMs(nsToMs(r.D))}` });
      else if (r.slack < 0.1 * r.D) out.push({ severity: 'warning', code: 'LOW_SLACK', key: r.key, text: `${r.name}: only ${(100 * r.slack / r.D).toFixed(1)}% of its deadline remains as slack` });
    }
    // dedupe: keep at most 1 DM inversion entry per lower-priority message (worst)
    const seen = new Set();
    const filtered = out.filter((f) => { if (f.code !== 'DM_INVERSION') return true; if (seen.has(f.key)) return false; seen.add(f.key); return true; });
    if (!analysis.schedulable) {
      const opa = optimalPriorityAssignment(set, { bitrate: analysis.bitrate });
      if (opa.feasible) filtered.unshift({ severity: 'error', code: 'UNSAFE_PRIORITIES', key: null, text: 'Deadlines are missed with the current identifiers, but a feasible priority order exists (Audsley OPA). The identifier assignment is unsafe.', order: opa.order });
      else filtered.unshift({ severity: 'error', code: 'INFEASIBLE', key: null, text: 'No priority order can meet all deadlines at this bitrate (Audsley OPA found none). Reduce load or raise bitrate.' });
    }
    return filtered;
  }
  function fmtMs(ms) { return (Math.round(ms * 1000) / 1000) + ' ms'; }

  /* ------------------------------------------------------------------ *
   * Bus simulation (discrete event, non-preemptive fixed priority)
   * ------------------------------------------------------------------ */

  /**
   * Simulate the bus. Each message m releases at offset_m + k T_m, and is
   * queued after a release jitter in [0, J_m] (chosen by `jitterMode`).
   * Frame lengths: 'worst' (worst-case stuffing) or a function(msg,k)->bits.
   * Returns a list of frame records with timestamps (ns).
   * Options: { bitrate, duration (ns), offsets: {key: ns}, jitterMode:'max'|'zero'|'random', seed, lengthMode }
   */
  function simulate(set, opts) {
    const tau = bitTimeNs(opts.bitrate);
    const dur = opts.duration;
    const rnd = mulberry32(opts.seed || 1);
    const msgs = sortByPriority(set.filter((m) => m.Tms > 0)).map((m, i) => ({
      m, rank: i, T: msToNs(m.Tms), D: msToNs(m.Dms != null ? m.Dms : m.Tms), J: msToNs(m.Jms || 0),
      off: opts.offsets && opts.offsets[m.key] != null ? opts.offsets[m.key] : 0, k: 0, queue: [],
    }));
    const lenBits = (x, k) => {
      if (typeof opts.lengthMode === 'function') return opts.lengthMode(x.m, k);
      if (opts.lengthMode === 'min') return minFrameBits(x.m.dlc, x.m.extended);
      return frameBitsOf(x.m);
    };
    const jit = (x) => {
      if (opts.jitterMode === 'zero' || !x.J) return 0;
      if (opts.jitterMode === 'random') return Math.floor(rnd() * x.J);
      if (opts.jitterMode === 'critical') return x.k === 0 ? x.J : 0; // first instance late, then early
      return x.J;
    };
    // queue-time events
    const frames = [];
    let t = 0;
    const nextQueueTime = (x) => x.off + x.k * x.T + (x.pendJ != null ? x.pendJ : (x.pendJ = jit(x)));
    let guard = 0;
    while (t < dur && guard++ < 5e6) {
      // enqueue everything queued by time t
      let earliest = Infinity;
      for (const x of msgs) {
        while (true) {
          const qt = nextQueueTime(x);
          if (qt <= t) {
            x.queue.push({ k: x.k, release: x.off + x.k * x.T, queued: qt });
            x.k++; x.pendJ = null;
          } else { if (qt < earliest) earliest = qt; break; }
        }
      }
      // arbitration: highest priority non-empty queue
      let win = null;
      for (const x of msgs) if (x.queue.length) { win = x; break; }
      if (!win) { t = earliest; continue; }
      const inst = win.queue.shift();
      const bits = lenBits(win, inst.k);
      const start = t; const end = start + bits * tau;
      // who was waiting during this transmission (for blocking classification)
      frames.push({
        key: win.m.key, name: win.m.name, id: win.m.id, rank: win.rank, k: inst.k,
        release: inst.release, queued: inst.queued, start, end, bits,
        R: end - inst.release, D: win.D, miss: end - inst.release > win.D,
      });
      t = end;
    }
    // classify waiting: blocked (lower priority on bus) vs interference (higher priority)
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      f.waits = [];
      for (let j = i - 1; j >= 0; j--) {
        const g = frames[j];
        if (g.end <= f.queued) break;
        const s = Math.max(g.start, f.queued); const e = g.end;
        if (e > s) f.waits.unshift({ key: g.key, start: s, end: e, kind: g.rank > f.rank ? 'blocking' : (g.key === f.key ? 'self' : 'interference') });
      }
    }
    return { frames, tau };
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------------ *
   * Trace (log) parsing & measurement
   * ------------------------------------------------------------------ */

  /**
   * Parse a CAN log. Supported:
   *  - candump -l:   (1600000000.123456) can0 123#DEADBEEF
   *  - candump -ta:  (1600000000.123456)  can0  123   [4]  DE AD BE EF
   *  - CSV: timestamp,id,dlc,data   (header optional; id hex; data hex string or bytes)
   * Returns { frames: [{t (seconds, float), id, extended, dlc, data:Uint8Array}], skipped, format }
   */
  function parseLog(text, opts) {
    opts = opts || {};
    const lines = String(text).split(/\r?\n/);
    const frames = [];
    let skipped = 0; let format = null;
    const reCan = /^\s*\((\d+(?:\.\d+)?)\)\s+\S+\s+([0-9A-Fa-f]{1,8})#(R?)([0-9A-Fa-f]*)/;
    const reTa = /^\s*\((\d+(?:\.\d+)?)\)\s+\S+\s+([0-9A-Fa-f]{1,8})\s+\[(\d+)\]\s+((?:[0-9A-Fa-f]{2}\s*)*)/;
    for (const l of lines) {
      if (!l.trim()) continue;
      let m = l.match(reCan);
      if (m) {
        format = format || 'candump';
        if (m[3] === 'R') { skipped++; continue; }
        const idStr = m[2];
        const id = parseInt(idStr, 16);
        const extended = idStr.length > 3;
        const hex = m[4];
        if (hex.length % 2 || hex.length > 16) { skipped++; continue; }
        frames.push({ t: Number(m[1]), id, extended, dlc: hex.length / 2, data: hexBytes(hex) });
        continue;
      }
      m = l.match(reTa);
      if (m) {
        format = format || 'candump-ascii';
        const idStr = m[2];
        const hex = m[4].replace(/\s+/g, '');
        frames.push({ t: Number(m[1]), id: parseInt(idStr, 16), extended: idStr.length > 3, dlc: Number(m[3]), data: hexBytes(hex) });
        continue;
      }
      const c = l.split(/[,;\t]/).map((s) => s.trim());
      if (c.length >= 3 && /^\d+(\.\d+)?$/.test(c[0]) && /^(0x)?[0-9A-Fa-f]+$/.test(c[1])) {
        format = format || 'csv';
        const idStr = c[1].replace(/^0x/i, '');
        const dlc = Number(c[2]);
        let hex = c.slice(3).join('').replace(/\s+/g, '');
        if (hex.length > 16) hex = hex.slice(0, 16);
        frames.push({ t: Number(c[0]) * (opts.csvTimeScale || 1), id: parseInt(idStr, 16), extended: idStr.length > 3 || parseInt(idStr, 16) > 0x7ff, dlc, data: hexBytes(hex) });
        continue;
      }
      skipped++;
    }
    frames.sort((a, b) => a.t - b.t);
    return { frames, skipped, format };
  }
  function hexBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  /**
   * Infer bitrate from back-to-back frames: when the bus is busy, consecutive
   * frame timestamps differ by exactly the frame's own wire time. The minimum
   * of delta/bits over many pairs approximates the bit time; snap to standard.
   * Returns { estimate, snapped, samples } or null if timestamps too coarse.
   */
  function inferBitrate(frames) {
    const ratios = [];
    for (let i = 1; i < frames.length; i++) {
      const dt = frames[i].t - frames[i - 1].t;
      if (dt <= 0) continue;
      const bits = exactFrameBits(frames[i].id, frames[i].extended, frames[i].data);
      ratios.push(dt / bits);
    }
    if (ratios.length < 50) return null;
    ratios.sort((a, b) => a - b);
    const p = ratios[Math.floor(ratios.length * 0.002)];
    const est = 1 / p;
    const std = [1000000, 800000, 500000, 250000, 125000, 100000, 83333, 50000, 33333, 20000, 10000];
    // The bus can never be faster than observed, so snap to the smallest standard rate >= ~0.9*est
    let snapped = null;
    for (const r of std.slice().reverse()) if (r >= est * 0.9) { snapped = r; break; }
    return { estimate: est, snapped, samples: ratios.length };
  }

  /**
   * Measure per-ID statistics from a frame list.
   * period: median inter-arrival; fitted period by least squares on k-index;
   * jitter: spread (max-min) of residuals of arrival times to the fitted
   * periodic grid (includes queuing delay variation + release jitter + drift).
   */
  function measureTrace(frames, opts) {
    opts = opts || {};
    const groups = new Map();
    for (const f of frames) {
      const key = (f.extended ? 'x' : 's') + f.id;
      if (!groups.has(key)) groups.set(key, { key, id: f.id, extended: f.extended, ts: [], dlcs: new Map(), bits: 0, sample: f.data });
      const g = groups.get(key);
      g.ts.push(f.t);
      g.dlcs.set(f.dlc, (g.dlcs.get(f.dlc) || 0) + 1);
      g.bits += exactFrameBits(f.id, f.extended, f.data);
    }
    const t0 = frames.length ? frames[0].t : 0;
    const t1 = frames.length ? frames[frames.length - 1].t : 0;
    const duration = t1 - t0;
    const out = [];
    for (const g of groups.values()) {
      const n = g.ts.length;
      const deltas = [];
      for (let i = 1; i < n; i++) deltas.push(g.ts[i] - g.ts[i - 1]);
      const sd = deltas.slice().sort((a, b) => a - b);
      const med = sd.length ? sd[Math.floor(sd.length / 2)] : null;
      const mean = sd.length ? sd.reduce((a, b) => a + b, 0) / sd.length : null;
      const cv = sd.length > 1 ? Math.sqrt(sd.reduce((a, b) => a + (b - mean) ** 2, 0) / (sd.length - 1)) / mean : null;
      let fitT = null; let spread = null; let missing = 0; let residMin = null; let residMax = null;
      if (med && n >= 3) {
        // index each arrival on the periodic grid incrementally (robust to drift & drops)
        const ks = [0];
        for (let i = 1; i < n; i++) ks.push(ks[i - 1] + Math.max(1, Math.round((g.ts[i] - g.ts[i - 1]) / med)));
        missing = ks[ks.length - 1] + 1 - n;
        // least squares t = a + b k
        const N = n; let sk = 0, st = 0, skk = 0, skt = 0;
        for (let i = 0; i < N; i++) { const k = ks[i]; const t = g.ts[i] - g.ts[0]; sk += k; st += t; skk += k * k; skt += k * t; }
        const den = N * skk - sk * sk;
        const b = den ? (N * skt - sk * st) / den : med;
        const a = (st - b * sk) / N;
        fitT = b;
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < N; i++) { const r = g.ts[i] - g.ts[0] - (a + b * ks[i]); if (r < lo) lo = r; if (r > hi) hi = r; }
        spread = hi - lo; residMin = lo; residMax = hi;
      }
      const dlcList = [...g.dlcs.entries()].sort((a, b) => b[1] - a[1]);
      const maxDlc = Math.max(...g.dlcs.keys());
      const periodic = cv != null && cv < 0.5 && missing <= Math.max(2, 0.05 * n);
      out.push({
        key: g.key, id: g.id, extended: g.extended, count: n,
        medianPeriod: med, meanPeriod: mean, fitPeriod: fitT, minDelta: sd[0] ?? null, maxDelta: sd[sd.length - 1] ?? null,
        cv, jitterSpread: spread, missing, periodic,
        dlcMin: Math.min(...g.dlcs.keys()), dlcMax: maxDlc, dlcMode: dlcList[0][0],
        observedLoadBits: g.bits, sample: g.sample,
      });
    }
    out.sort((a, b) => arbKey(a) - arbKey(b));
    const totalBits = out.reduce((a, b) => a + b.observedLoadBits, 0);
    return { ids: out, duration, t0, t1, totalBits, frameCount: frames.length };
  }

  /** Observed bus load over time windows (exact stuffing per frame). */
  function loadTimeline(frames, bitrate, windowS) {
    if (!frames.length) return [];
    const t0 = frames[0].t; const t1 = frames[frames.length - 1].t;
    const nw = Math.max(1, Math.ceil((t1 - t0) / windowS));
    const bits = new Float64Array(nw);
    for (const f of frames) {
      const i = Math.min(nw - 1, Math.floor((f.t - t0) / windowS));
      bits[i] += exactFrameBits(f.id, f.extended, f.data);
    }
    return Array.from(bits, (b, i) => ({ t: t0 + i * windowS, load: b / (bitrate * windowS) }));
  }

  /**
   * Build an analysis message set from trace measurements. Deadlines are NOT
   * in the data: they are ASSUMED equal to the measured period (implicit
   * deadlines) and flagged as such. Jitter is assumed 0 unless jitterFromTrace.
   */
  function messageSetFromTrace(meas, opts) {
    opts = opts || {};
    return meas.ids.filter((x) => x.periodic && x.fitPeriod > 0).map((x) => ({
      key: x.key, id: x.id, extended: x.extended, name: 'ID 0x' + x.id.toString(16).toUpperCase(),
      sender: null, dlc: x.dlcMax,
      Tms: round6(x.fitPeriod * 1000), Dms: round6(x.fitPeriod * 1000),
      Jms: opts.jitterFromTrace ? round6(x.jitterSpread * 1000) : 0,
      source: { T: 'measured', D: 'assumed (D = T, not in data)', J: opts.jitterFromTrace ? 'measured spread (conservative)' : 'assumed (J = 0)' },
    }));
  }

  /**
   * Compare trace observations with model predictions.
   * Per ID: the completion-time spread on a single tap is bounded by
   *   R_m - C_m^min  (best case: no queuing and minimum stuffing; worst: R_m).
   * A spread above that bound is a model/data DISAGREEMENT (jitter, offsets
   * drift, event-driven transmissions, or the period estimate is wrong).
   */
  function compareTraceToModel(meas, analysis, bitrate) {
    const tau = bitTimeNs(bitrate);
    const byKey = new Map(analysis.results.map((r) => [r.key, r]));
    const rows = [];
    for (const x of meas.ids) {
      const r = byKey.get(x.key);
      if (!r) { rows.push({ key: x.key, id: x.id, status: 'not-modelled', note: x.periodic ? 'Not in model' : 'Aperiodic / event-driven — excluded from periodic model' }); continue; }
      const cmin = minFrameBits(x.dlcMin, x.extended) * tau;
      const bound = (r.R - cmin) / 1e9; // seconds
      const obs = x.jitterSpread;
      const agree = obs != null && Number.isFinite(bound) ? obs <= bound + 2e-6 : null; // 2us timestamp tolerance
      rows.push({ key: x.key, id: x.id, observedSpread: obs, predictedBound: bound, R: r.R / 1e9, status: agree == null ? 'n/a' : agree ? 'consistent' : 'DISAGREES' });
    }
    const predicted = analysis.load.worst; const predictedBest = analysis.load.best;
    const observed = meas.totalBits / (bitrate * meas.duration);
    return { rows, load: { predictedWorst: predicted, predictedBest, observed } };
  }

  return {
    version: '1.0.0',
    msToNs, nsToMs, bitTimeNs,
    worstCaseFrameBits, minFrameBits, frameBitsOf, buildFrame, exactFrameBits, crc15,
    parseDBC, signalBits, extractRaw, encodeSignal, decodeSignal, decodeMessage, checkLayout,
    messageSetFromDBC, sortByPriority, arbKey, busLoad, analyse,
    optimalPriorityAssignment, checkPriorities, simulate,
    parseLog, inferBitrate, measureTrace, loadTimeline, messageSetFromTrace, compareTraceToModel,
  };
});
