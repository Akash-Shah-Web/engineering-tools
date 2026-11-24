/* Data access for the logged simulation runs (window.ACTIVERIDE_DATA). */
(function () {
  "use strict";
  const AR = (window.AR = window.AR || {});

  function decodeF32(b64) {
    const bin = atob(b64);
    const buf = new ArrayBuffer(bin.length);
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Float32Array(buf);
  }

  class Run {
    constructor(channels, n, flat) {
      this.n = n;
      this.ch = {};
      channels.forEach((name, k) => (this.ch[name] = flat.subarray(k * n, (k + 1) * n)));
      this.t = this.ch.t;
      this.dt = this.t[1] - this.t[0];
    }
    /* fractional sample index for time t (clamped) */
    idx(t) {
      const f = (t - this.t[0]) / this.dt;
      return Math.max(0, Math.min(this.n - 1.0001, f));
    }
    at(name, t) {
      const a = this.ch[name];
      const f = this.idx(t), i = Math.floor(f), w = f - i;
      return a[i] * (1 - w) + a[i + 1] * w;
    }
    get duration() { return this.t[this.n - 1]; }
  }

  class Scenario {
    constructor(raw, channels) {
      Object.assign(this, raw);
      const r = raw.road;
      this.road = { dx: r.dx, n: r.n, left: decodeF32(r.left), right: decodeF32(r.right),
                    roughL: decodeF32(r.rough_left), roughR: decodeF32(r.rough_right) };
      this._raw = raw.runs;
      this._runs = {};
      this.channels = channels;
    }
    run(ctrl) {
      if (!this._runs[ctrl] && this._raw[ctrl]) {
        const rr = this._raw[ctrl];
        this._runs[ctrl] = new Run(this.channels, rr.n, decodeF32(rr.data));
      }
      return this._runs[ctrl];
    }
    roadHeight(side, x) {
      const r = this.road, f = x / r.dx;
      if (f <= 0) return 0;
      if (f >= r.n - 1) return 0;
      const i = Math.floor(f), w = f - i, a = side === 0 ? r.left : r.right;
      return a[i] * (1 - w) + a[i + 1] * w;
    }
    get length() { return (this.road.n - 1) * this.road.dx; }
  }

  AR.loadData = function () {
    const D = window.ACTIVERIDE_DATA;
    if (!D) throw new Error("data/activeride_data.js not loaded");
    const scenarios = D.scenarios.map((s) => new Scenario(s, D.channels));
    return { meta: D, vehicle: D.vehicle, controllers: D.controllers, scenarios };
  };

  /* metric definitions used by the KPI table and CSV export */
  AR.METRICS = [
    { k: "aw_seat", label: "Seat a<sub>w</sub> (Wk)", unit: "m/s²", d: 3, better: -1, tip: "RMS of ISO 2631-1 Wk-weighted vertical acceleration at the driver's seat point over the whole run." },
    { k: "vdv_seat", label: "Seat VDV", unit: "m/s^1.75", d: 3, better: -1, tip: "Vibration dose value (fourth-power) of the Wk-weighted seat acceleration; sensitive to shocks." },
    { k: "pitch_acc_w_rms", label: "Pitch acc. (We)", unit: "rad/s²", d: 4, better: -1, tip: "RMS of We-weighted body pitch acceleration." },
    { k: "roll_acc_w_rms", label: "Roll acc. (We)", unit: "rad/s²", d: 4, better: -1, tip: "RMS of We-weighted body roll acceleration." },
    { k: "travel_rms_mm", label: "Susp. travel RMS", unit: "mm", d: 2, better: -1, tip: "RMS suspension stroke over all four corners." },
    { k: "travel_max_mm", label: "Susp. travel max", unit: "mm", d: 1, better: -1, tip: "Largest absolute stroke at any corner (no bump stops are modelled)." },
    { k: "tyre_dlc", label: "Tyre DLC", unit: "–", d: 3, better: -1, tip: "Dynamic load coefficient: RMS dynamic tyre load / static load, worst corner. Lower = better road holding." },
    { k: "tyre_min_load_ratio", label: "Min tyre load", unit: "× static", d: 2, better: +1, tip: "Smallest tyre load divided by its static value. 0 = wheel lift-off." },
    { k: "power_mean_W", label: "Actuator power", unit: "W", d: 1, better: -1, tip: "Mean positive mechanical actuator power, summed over four corners (no regeneration credited)." },
    { k: "force_peak_N", label: "Peak force", unit: "N", d: 0, better: 0, tip: "Largest absolute actuator force at any corner (limit ±2500 N)." },
  ];
})();
