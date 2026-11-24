"""Validation suite (run: python -m pytest -q tests). Tolerances are stated inline."""
import hashlib
from pathlib import Path

import numpy as np
import pytest

from activeride import validation as V
from activeride.config import ROOT, load_config


@pytest.fixture(scope="module")
def cfg():
    return load_config()


def test_static_equilibrium(cfg):
    r = V.static_equilibrium(cfg)
    assert r["drift_from_equilibrium_m"] < 1e-5
    assert r["tyre_load_error_N"] < 0.1
    assert r["settled_heave_after_offset_m"] < 1e-4
    assert abs(r["total_load_check_N"]) < 1e-6
    assert r["K_symmetric"]


def test_natural_frequencies(cfg):
    r = V.natural_frequencies(cfg)
    # implementation check: with the 7-DOF geometric assumptions MuJoCo must agree closely
    assert r["geometry_matched"]["undamped"]["max_rel_err"] < 1e-3
    assert r["geometry_matched"]["damped"]["max_rel_err"] < 1e-2
    # realistic geometry: documented discrepancy (unsprung masses below the roll/pitch axis)
    assert r["realistic"]["undamped"]["max_rel_err"] < 0.06
    f = r["realistic"]["undamped"]
    assert np.allclose(f["analytical_hz"][3:], f["mujoco_hz"][3:], rtol=1e-3)   # wheel hop modes


def test_frequency_response(cfg):
    r = V.frequency_response(cfg, freqs=(1.4, 5.0, 13.0))
    assert r["max_rel_mag_err"] < 0.10


def test_riccati(cfg):
    r = V.riccati(cfg)
    for k in ("lqr_kf", "preview_kf"):
        assert r[k]["lqr_rel"] < 1e-8 and r[k]["kf_rel"] < 1e-8
        assert r[k]["lqr_spectral_radius"] < 1 and r[k]["kf_spectral_radius"] < 1
        assert r[k]["P_min_eig"] > 0 and r[k]["Pkf_min_eig"] > 0


def test_preview_equals_batch_optimum(cfg):
    assert V.preview_vs_batch(cfg, H=120)["max_rel_diff"] < 1e-6


def test_energy(cfg):
    r = V.energy(cfg)
    u = r["undamped"]
    assert u["secular_rel_drift"] < 1e-3
    assert u["max_rel_fluctuation_h_over_10"] < 0.2 * u["max_rel_fluctuation"]   # O(h) integrator error
    assert r["damped"]["balance_rel_err"] < 0.01
    assert r["damped"]["monotone_decrease"]


def test_signs(cfg):
    r = V.signs(cfg)
    assert r["actuator_push_body_up"] and r["actuator_push_wheels_static"]
    assert r["front_lift_pitch_nose_up"] and r["left_lift_roll_positive"]
    a, b = r["actuator_static_heave_lin_vs_mj_m"]
    assert abs(a - b) / a < 1e-3
    assert r["accelerometer_zero_at_rest"] < 1e-3


def test_iso_weighting():
    assert V.iso_weighting()["max_rel_err"] < 0.005


def test_mujoco_vs_linear(cfg):
    r = V.mujoco_vs_linear(cfg, duration=5.0)["normalised_rms_difference"]
    for c in ("passive", "lqr"):
        assert r[c]["zs"] < 0.10 and r[c]["pitch"] < 0.10 and r[c]["stroke"] < 0.10


def test_data_checksums():
    sums = (ROOT / "data" / "samples" / "SHA256SUMS").read_text().split("\n")
    for line in filter(None, sums):
        h, name = line.split()
        assert hashlib.sha256((ROOT / "data" / "samples" / name).read_bytes()).hexdigest() == h


def test_synthetic_scenarios_labelled(cfg):
    for s in cfg.scenarios:
        if s["kind"] == "synthetic":
            assert "SYNTHETIC" in s["label"]
