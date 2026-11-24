"""Experiments: all scenarios x controllers on the MuJoCo plant, Monte Carlo
robustness study, results tables and the web-viewer data export."""
from __future__ import annotations

import base64
import csv
import json
import time
from multiprocessing import Pool
from pathlib import Path

import numpy as np

from .config import ROOT, load_config
from .controllers import CONTROLLER_LABELS, build_design, make_controllers
from .metrics import METRIC_LABELS, ride_metrics, weight_signal
from .road import iri, road_for_scenario
from .sim import PreviewSensor, run, scenario_duration
from .plants import MujocoCar

RESULTS = ROOT / "results"
RUNS = RESULTS / "runs"
CONTROLLERS = ["passive", "skyhook", "lqr", "preview"]


# ---------------------------------------------------------------------------
def _run_job(args):
    sid, ctrl_name = args
    cfg = load_config()
    sc = cfg.scenario(sid)
    V = sc["speed_kmh"] / 3.6
    road = road_for_scenario(sc, cfg.vehicle.envelope_m)
    dur = scenario_duration(cfg, road, V)
    ctrl = make_controllers(cfg, V)[ctrl_name]
    seed = cfg.sim["seed"]
    prev = PreviewSensor(road, cfg.sensors["preview_height_std"], cfg.sensors["preview_smoothing_m"],
                         np.random.default_rng(seed + 1))
    plant = MujocoCar(cfg, road, V, active=ctrl_name != "passive")
    t0 = time.time()
    log = run(plant, ctrl, dur, cfg, np.random.default_rng(seed), preview=prev)
    RUNS.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(RUNS / f"{sid}__{ctrl_name}.npz", **log)
    m = ride_metrics(log, cfg.vehicle)
    return sid, ctrl_name, m, time.time() - t0


def run_all_scenarios(processes=4) -> dict:
    cfg = load_config()
    jobs = [(s["id"], c) for s in cfg.scenarios for c in CONTROLLERS]
    res = {}
    with Pool(processes) as p:
        for sid, c, m, wall in p.imap_unordered(_run_job, jobs):
            res.setdefault(sid, {})[c] = m
            print(f"  {sid:16s} {c:8s} a_w={m['aw_seat']:.3f}  ({wall:.1f}s)", flush=True)
    write_tables(cfg, res)
    return res


def load_run(sid, ctrl):
    d = np.load(RUNS / f"{sid}__{ctrl}.npz")
    return {k: d[k] for k in d.files}


TABLE_METRICS = ["aw_seat", "vdv_seat", "pitch_acc_w_rms", "roll_acc_w_rms", "pitch_rms_deg", "roll_rms_deg",
                 "travel_rms_mm", "travel_max_mm", "tyre_dlc", "tyre_min_load_ratio", "power_mean_W", "force_peak_N"]


def write_tables(cfg, res) -> None:
    RESULTS.mkdir(exist_ok=True)
    keys = sorted(next(iter(next(iter(res.values())).values())).keys())
    with open(RESULTS / "metrics.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["scenario", "data_kind", "controller"] + keys)
        for s in cfg.scenarios:
            for c in CONTROLLERS:
                if c in res.get(s["id"], {}):
                    w.writerow([s["id"], s["kind"], c] + [f"{res[s['id']][c][k]:.6g}" for k in keys])
    lines = ["# ActiveRide results (SIMULATION ONLY — MuJoCo plant, no real-vehicle tests)", "",
             "Road inputs: MEASURED = LiRA-CD P79 profilometer wheel paths (DOI 10.11583/DTU.23097002);",
             "SYNTHETIC = analytic obstacle shapes. Percentages are changes relative to passive.", ""]
    for s in cfg.scenarios:
        r = res.get(s["id"])
        if not r:
            continue
        lines += [f"## {s['label']} — {s['kind'].upper()}, {s['speed_kmh']:.0f} km/h", ""]
        hdr = "| Metric | " + " | ".join(CONTROLLER_LABELS[c] for c in CONTROLLERS) + " |"
        lines += [hdr, "|" + "---|" * (len(CONTROLLERS) + 1)]
        for k in TABLE_METRICS:
            lab, unit = METRIC_LABELS.get(k, (k, ""))
            if k == "vdv_seat":
                lab, unit = "Seat VDV (Wk)", "m/s^1.75"
            cells = []
            for c in CONTROLLERS:
                v = r[c][k]
                base = r["passive"][k]
                rel = "" if c == "passive" or abs(base) < 1e-9 or k in ("power_mean_W", "force_peak_N") \
                    else f" ({100 * (v - base) / abs(base):+.0f}%)"
                cells.append(f"{v:.3g}{rel}")
            lines.append(f"| {lab} [{unit}] | " + " | ".join(cells) + " |")
        lines.append("")
    (RESULTS / "results_table.md").write_text("\n".join(lines) + "\n")


# ---------------------------------------------------------------------------
# Monte Carlo robustness
# ---------------------------------------------------------------------------
def _perturbed_vehicle(cfg, rng):
    mc = cfg.montecarlo
    v = cfg.copy().vehicle
    fm = max(0.6, 1 + mc["mass_sd"] * rng.standard_normal())
    v.ms *= fm; v.Ixx *= fm; v.Iyy *= fm
    v.ks = v.ks * np.clip(1 + mc["spring_sd"] * rng.standard_normal(4), 0.5, 1.5)
    v.cs = v.cs * np.clip(1 + mc["damper_sd"] * rng.standard_normal(4), 0.4, 1.6)
    v.kt = v.kt * np.clip(1 + mc["tyre_sd"] * rng.standard_normal(4), 0.5, 1.5)
    noise = rng.uniform(1.0, mc["sensor_noise_scale_max"])
    return v, noise, {"mass_factor": fm, "ks_mean_factor": float(np.mean(v.ks / cfg.vehicle.ks)),
                      "cs_mean_factor": float(np.mean(v.cs / cfg.vehicle.cs)),
                      "kt_mean_factor": float(np.mean(v.kt / cfg.vehicle.kt)), "noise_scale": noise}


def _mc_job(i):
    cfg = load_config()
    mc = cfg.montecarlo
    rng = np.random.default_rng(cfg.sim["seed"] + 1000 + i)
    veh_p, noise, params = _perturbed_vehicle(cfg, rng)
    sc = cfg.scenario(mc["scenario"])
    V = sc["speed_kmh"] / 3.6
    road = road_for_scenario(sc, cfg.vehicle.envelope_m)
    ctrls = make_controllers(cfg, V)                     # designed on the NOMINAL vehicle
    out = {"i": i, "params": params, "metrics": {}}
    for c in CONTROLLERS:
        prev = PreviewSensor(road, cfg.sensors["preview_height_std"] * noise, cfg.sensors["preview_smoothing_m"],
                             np.random.default_rng(cfg.sim["seed"] + 7 + i))
        plant = MujocoCar(cfg, road, V, active=c != "passive", veh=veh_p)
        log = run(plant, ctrls[c], mc["duration_s"], cfg, np.random.default_rng(cfg.sim["seed"] + 3 + i),
                  noise_scale=noise, preview=prev)
        m = ride_metrics(log, veh_p)
        m["finite"] = bool(np.all(np.isfinite(log["zs"])) and np.max(np.abs(log["zs"])) < 0.5)
        out["metrics"][c] = m
    # robust stability of the nominal state-feedback LQR on the perturbed linear model
    dn = build_design(cfg)
    dpert = build_design(cfg, veh_p)
    rho = np.max(np.abs(np.linalg.eigvals(dpert.Ad - dpert.Bd @ dn.K)))
    out["lqr_state_feedback_spectral_radius"] = float(rho)
    return out


def monte_carlo(processes=4, samples=None) -> list:
    cfg = load_config()
    n = samples or cfg.montecarlo["samples"]
    res = []
    with Pool(processes) as p:
        for k, r in enumerate(p.imap_unordered(_mc_job, range(n))):
            res.append(r)
            if (k + 1) % 10 == 0:
                print(f"  Monte Carlo {k + 1}/{n}", flush=True)
    res.sort(key=lambda r: r["i"])
    (RESULTS / "montecarlo.json").write_text(json.dumps(res, indent=1, default=float))
    summarise_mc(res)
    return res


def summarise_mc(res) -> dict:
    keys = ["aw_seat", "pitch_acc_w_rms", "roll_acc_w_rms", "travel_rms_mm", "tyre_dlc", "power_mean_W"]
    summ = {}
    for c in CONTROLLERS:
        summ[c] = {}
        for k in keys:
            v = np.array([r["metrics"][c][k] for r in res])
            summ[c][k] = {"median": float(np.median(v)), "p5": float(np.percentile(v, 5)),
                          "p95": float(np.percentile(v, 95))}
        summ[c]["all_finite"] = all(r["metrics"][c]["finite"] for r in res)
        if c != "passive":
            ratio = np.array([r["metrics"][c]["aw_seat"] / r["metrics"]["passive"]["aw_seat"] for r in res])
            summ[c]["aw_ratio_vs_passive"] = {"median": float(np.median(ratio)), "worst": float(ratio.max()),
                                              "frac_better": float(np.mean(ratio < 1))}
    summ["n"] = len(res)
    summ["lqr_state_feedback_max_spectral_radius"] = max(r["lqr_state_feedback_spectral_radius"] for r in res)
    (RESULTS / "montecarlo_summary.json").write_text(json.dumps(summ, indent=2))
    return summ


# ---------------------------------------------------------------------------
# Web-viewer export (decimated logged data, base64 float32)
# ---------------------------------------------------------------------------
def _b64(a) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype="<f4").tobytes()).decode()


def _roughness_proxy(x, z, win_m=5.0):
    """Rolling RMS of profile slope (rad) — an illustrative roughness proxy."""
    dx = x[1] - x[0]
    s = np.gradient(z, dx)
    n = max(1, int(win_m / dx))
    k = np.ones(n) / n
    return np.sqrt(np.convolve(s ** 2, k, mode="same"))


def export_viewer(res: dict | None = None, out=ROOT / "viewer" / "data" / "activeride_data.js") -> Path:
    cfg = load_config()
    v = cfg.vehicle
    rate = cfg.sim["viewer_rate_hz"]
    data = {"generated": time.strftime("%Y-%m-%d"), "rate_hz": rate,
            "note": "All motion is SIMULATED (MuJoCo plant). Road heights are MEASURED (LiRA-CD) or SYNTHETIC as labelled.",
            "vehicle": {"a": v.a, "b": v.b, "tf": v.tf, "tr": v.tr, "R0": v.R0, "h_cg": 0.55,
                        "seat_x": v.seat_x, "seat_y": v.seat_y,
                        "static_tyre_N": v.static_tyre_loads().tolist(),
                        "wheel_centre_static_m": (v.R0 - v.static_tyre_loads() / v.kt).tolist(),
                        "x_corner": v.x.tolist(), "y_corner": v.y.tolist(),
                        "fmax": cfg.actuator.fmax, "preview_m": cfg.sensors["preview_distance"]},
            "controllers": {c: CONTROLLER_LABELS[c] for c in CONTROLLERS},
            "channels": ["t", "x", "zs", "pitch", "roll", "zu0", "zu1", "zu2", "zu3", "s0", "s1", "s2", "s3",
                         "F0", "F1", "F2", "F3", "fa0", "fa1", "fa2", "fa3", "acc_seat", "aw_seat", "aw_run",
                         "zr0", "zr1", "zr2", "zr3", "pitch_acc", "roll_acc", "power"],
            "scenarios": []}
    metrics_csv = {}
    with open(RESULTS / "metrics.csv") as f:
        for row in csv.DictReader(f):
            metrics_csv.setdefault(row["scenario"], {})[row["controller"]] = {
                k: float(val) for k, val in row.items() if k not in ("scenario", "data_kind", "controller")}
    for sc in cfg.scenarios:
        road = road_for_scenario(sc, v.envelope_m)
        step = max(1, int(round(0.1 / (road.x[1] - road.x[0]))))
        xr = road.x[::step]
        zl, zrr = road.z_raw[0, ::step], road.z_raw[1, ::step]
        rough = np.vstack([_roughness_proxy(road.x, road.z_raw[i])[::step] for i in (0, 1)])
        entry = {"id": sc["id"], "label": sc["label"], "kind": sc["kind"], "speed_kmh": sc["speed_kmh"],
                 "source": road.source, "meta": road.meta,
                 "road": {"dx": float(xr[1] - xr[0]), "n": len(xr), "left": _b64(zl), "right": _b64(zrr),
                          "rough_left": _b64(rough[0]), "rough_right": _b64(rough[1])},
                 "runs": {}, "metrics": metrics_csv.get(sc["id"], {})}
        if sc["kind"] == "measured":
            entry["iri_m_per_km"] = [float(iri(road.x, road.z_raw[i])) for i in (0, 1)]
        for c in CONTROLLERS:
            try:
                L = load_run(sc["id"], c)
            except FileNotFoundError:
                continue
            fs = 1 / (L["t"][1] - L["t"][0])
            aw = weight_signal(L["acc_seat"], fs, "Wk")
            nwin = int(fs * 1.0)
            aw_run = np.sqrt(np.convolve(aw ** 2, np.ones(nwin) / nwin, mode="full")[:len(aw)])
            power = np.sum(L["f_act"] * L["stroke_rate"], axis=1)
            dec = max(1, int(round(fs / rate)))
            cols = [L["t"], L["x"], L["zs"], L["pitch"], L["roll"], *L["zu"].T, *L["stroke"].T,
                    *L["tyre_force"].T, *L["f_act"].T, L["acc_seat"], aw, aw_run, *L["zr"].T,
                    L["pitch_acc"], L["roll_acc"], power]
            M = np.vstack([np.asarray(cc, float)[::dec] for cc in cols])
            entry["runs"][c] = {"n": M.shape[1], "data": _b64(M.ravel())}
        data["scenarios"].append(entry)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("/* Generated by activeride/experiments.py — logged simulation data, do not edit. */\n"
                   "window.ACTIVERIDE_DATA = " + json.dumps(data, separators=(",", ":")) + ";\n")
    return out


# ---------------------------------------------------------------------------
PREVIEW_CASES = {"perfect\n(no noise)": (1e-9, 0.25), "2 mm,\n0.25 m smooth": (0.002, 0.25),
                 "2 mm,\n0.5 m smooth": (0.002, 0.5), "2 mm, 1 m\n(default)": (0.002, 1.0),
                 "6 mm,\n1 m smooth": (0.006, 1.0)}


def _sens_job(a):
    label, sid = a
    cfg = load_config()
    from .sim import run_scenario
    if label == "LQR":
        r = run_scenario(cfg, sid, controllers=("lqr",), duration=15.0)
        return a, ride_metrics(r["logs"]["lqr"], cfg.vehicle)
    std, sm = PREVIEW_CASES[label]
    cfg.sensors["preview_height_std"], cfg.sensors["preview_smoothing_m"] = std, sm
    r = run_scenario(cfg, sid, controllers=("preview",), duration=15.0)
    return a, ride_metrics(r["logs"]["preview"], cfg.vehicle)


def preview_sensitivity(processes=4, scenarios=("m13_A", "m13_B_slow")) -> dict:
    jobs = [(lab, s) for lab in list(PREVIEW_CASES) + ["LQR"] for s in scenarios]
    out = {"scenarios": list(scenarios), "duration_s": 15.0, "cases": {}, "lqr": {}}
    with Pool(processes) as p:
        for (lab, s), m in p.imap_unordered(_sens_job, jobs):
            if lab == "LQR":
                out["lqr"][s] = m["aw_seat"]
            else:
                out["cases"].setdefault(lab, {})[s] = {k: m[k] for k in ("aw_seat", "tyre_dlc", "power_mean_W")}
    out["cases"] = {k: out["cases"][k] for k in PREVIEW_CASES}
    (RESULTS / "preview_sensitivity.json").write_text(json.dumps(out, indent=2))
    return out
