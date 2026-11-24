"""Comparison against the Warwick suspension benchmark (Zenodo DOI
10.5281/zenodo.17242919, file suspension_dataset.mat, MD5 3ee016647067d39dd8c4feb61fef47f1).

STATUS IN THIS REPOSITORY: the file could NOT be downloaded from the build
environment (zenodo.org / doi.org blocked by the network policy), so this
comparison has NOT been executed and no Warwick results are reported.

What it does when the file is present (data/raw/warwick/suspension_dataset.mat):
the benchmark is a quarter-car-type rig with a road (track) displacement input
and measured body and tyre displacements. The ActiveRide car is a full car,
so the only comparable setup is a single corner. We therefore
  1. fit a linear 2-DOF quarter-car (ms, mu fixed ratio; ks, cs, kt free) to
     the measured body displacement for each road class, and
  2. compare the identified body natural frequency and damping ratio with
     the front-left corner of the ActiveRide model, and report the NRMSE of
     the fit. Disagreement is reported, not tuned away.

The variable names (hx<C>, bodyxsuppressed<C>, tirexsuppressed<C>, sampled at
250 Hz) are taken from third-party code that uses the dataset and are not
verified here; the loader lists all keys so a user can adapt them.
"""
from __future__ import annotations

import hashlib
import json

import numpy as np

from .config import ROOT

PATH = ROOT / "data" / "raw" / "warwick" / "suspension_dataset.mat"
MD5 = "3ee016647067d39dd8c4feb61fef47f1"
FS = 250.0


def available() -> bool:
    return PATH.exists() and hashlib.md5(PATH.read_bytes()).hexdigest() == MD5


def _quarter_car_response(params, road, fs):
    from scipy.signal import lsim
    ks_ms, cs_ms, kt_mu, ratio = params        # per-unit-mass parameters, ratio = ms/mu
    A = np.array([[0, 1, 0, 0],
                  [-ks_ms, -cs_ms, ks_ms, cs_ms],
                  [0, 0, 0, 1],
                  [ks_ms * ratio, cs_ms * ratio, -ks_ms * ratio - kt_mu, -cs_ms * ratio]])
    B = np.array([[0], [0], [0], [kt_mu]])
    C = np.array([[1, 0, 0, 0], [0, 0, 1, 0]])
    t = np.arange(len(road)) / fs
    _, y, _ = lsim((A, B, C, np.zeros((2, 1))), road, t)
    return y


def compare(cfg) -> dict:
    if not available():
        return {"status": "NOT RUN - suspension_dataset.mat not available (see data/README.md)"}
    from scipy.io import loadmat
    from scipy.optimize import least_squares
    d = loadmat(PATH)
    keys = sorted(k for k in d if not k.startswith("__"))
    out = {"status": "run", "keys": keys, "classes": {}}
    v = cfg.vehicle
    ms_c = v.static_sprung_loads()[0] / 9.81
    f_model = np.sqrt(v.ks[0] / ms_c * v.kt[0] / (v.ks[0] + v.kt[0])) / (2 * np.pi)
    out["activeride_FL_ride_freq_hz"] = float(f_model)
    out["activeride_FL_zeta"] = float(v.cs[0] / (2 * np.sqrt(v.ks[0] * ms_c)))
    for c in "ABCDE":
        kr, kb = f"hx{c}", f"bodyxsuppressed{c}"
        if kr not in d or kb not in d:
            continue
        road = d[kr].ravel().astype(float)
        body = d[kb].ravel().astype(float)
        n = min(len(road), len(body), int(60 * FS))
        road, body = road[:n] - road[:n].mean(), body[:n] - body[:n].mean()

        def resid(p):
            return _quarter_car_response(np.exp(p), road, FS)[:, 0] - body
        p0 = np.log([v.ks[0] / ms_c, v.cs[0] / ms_c, v.kt[0] / v.mu[0], ms_c / v.mu[0]])
        sol = least_squares(resid, p0, max_nfev=200)
        ks_ms, cs_ms, kt_mu, ratio = np.exp(sol.x)
        out["classes"][c] = {
            "nrmse_body": float(np.sqrt(np.mean(sol.fun ** 2)) / np.std(body)),
            "identified_body_freq_hz": float(np.sqrt(ks_ms) / (2 * np.pi)),
            "identified_zeta": float(cs_ms / (2 * np.sqrt(ks_ms))),
        }
    return out


if __name__ == "__main__":
    from .config import load_config
    print(json.dumps(compare(load_config()), indent=2))
