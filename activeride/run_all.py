#!/usr/bin/env python3
"""Reproduce everything: data -> validation -> experiments -> Monte Carlo ->
figures -> web-viewer data -> (optional) MP4 videos.

    python run_all.py               # everything except videos
    python run_all.py --videos      # also render MP4s (needs an OpenGL context, e.g. xvfb-run)
    python run_all.py --quick       # fewer Monte Carlo samples
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))


def step(msg):
    print(f"\n=== {msg} ===", flush=True)


def make_figures(val, res, sens, export_viewer):
    from activeride import figures
    figures.fig_roads(); figures.fig_validation(val); figures.fig_wk(); figures.fig_time()
    figures.fig_time("speed_bump", 0.3, 4.5, "fig3b_time_histories_speed_bump")
    figures.fig_psd(); figures.fig_metrics(res); figures.fig_montecarlo(); figures.fig_preview_sensitivity(sens)
    print("viewer data:", export_viewer(res))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", action="store_true")
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--skip-fetch", action="store_true")
    ap.add_argument("--figures-only", action="store_true", help="regenerate figures/viewer data from saved results")
    a = ap.parse_args()
    t0 = time.time()
    if not a.skip_fetch:
        step("1/7 fetch data (checksummed)")
        subprocess.run([sys.executable, str(ROOT / "scripts" / "fetch_data.py")], check=False)

    from activeride import validation as V, warwick
    from activeride.config import load_config
    from activeride.experiments import export_viewer, monte_carlo, preview_sensitivity, run_all_scenarios
    cfg = load_config()

    if a.figures_only:
        from activeride.experiments import CONTROLLERS, load_run
        from activeride.metrics import ride_metrics
        val = json.loads((ROOT / "results" / "validation.json").read_text())
        val["_mvl_logs"] = V.mujoco_vs_linear(cfg)["logs"]
        res = {s["id"]: {c: ride_metrics(load_run(s["id"], c), cfg.vehicle) for c in CONTROLLERS} for s in cfg.scenarios}
        sens = json.loads((ROOT / "results" / "preview_sensitivity.json").read_text())
        make_figures(val, res, sens, export_viewer)
        return

    step("2/7 validation")
    val = {"static_equilibrium": V.static_equilibrium(cfg), "natural_frequencies": V.natural_frequencies(cfg),
           "frequency_response": V.frequency_response(cfg), "riccati": V.riccati(cfg),
           "preview_vs_batch": V.preview_vs_batch(cfg), "energy": V.energy(cfg), "signs": V.signs(cfg),
           "iso_weighting": V.iso_weighting(), "estimator_accuracy": V.estimator_accuracy(cfg),
           "warwick_benchmark": warwick.compare(cfg)}
    mvl = V.mujoco_vs_linear(cfg)
    val["mujoco_vs_linear"] = mvl["normalised_rms_difference"]
    (ROOT / "results").mkdir(exist_ok=True)
    (ROOT / "results" / "validation.json").write_text(json.dumps(val, indent=2, default=float))
    val["_mvl_logs"] = mvl["logs"]

    step("3/7 scenarios x controllers (MuJoCo plant)")
    res = run_all_scenarios()

    step("4/7 Monte Carlo robustness")
    monte_carlo(samples=12 if a.quick else None)

    step("5/7 preview sensor sensitivity")
    sens = preview_sensitivity()

    step("6/7 figures + viewer data")
    make_figures(val, res, sens, export_viewer)

    if a.videos:
        step("7/7 MP4 videos (MuJoCo offscreen)")
        subprocess.run([sys.executable, str(ROOT / "scripts" / "render_videos.py")], check=False)
    print(f"\nDone in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
