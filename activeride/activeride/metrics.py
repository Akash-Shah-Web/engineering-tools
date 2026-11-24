"""Ride metrics. ISO 2631-1:1997 frequency weightings (Annex A) applied in the
frequency domain (exact magnitude and phase of the analogue filters).

This is an engineering implementation of the standard's weighting formulae; it
is not a certified ISO 2631 instrument (no instrument tolerance testing).
"""
from __future__ import annotations

import numpy as np

# Annex A parameters: f1, f2 band limiting; f3, f4, Q4 a-v transition; f5,Q5,f6,Q6 upward step
WEIGHTINGS = {
    "Wk": dict(f1=0.4, f2=100.0, f3=12.5, f4=12.5, Q4=0.63, f5=2.37, Q5=0.91, f6=3.35, Q6=0.91),
    "Wd": dict(f1=0.4, f2=100.0, f3=2.0, f4=2.0, Q4=0.63, f5=None, Q5=None, f6=None, Q6=None),
    "We": dict(f1=0.4, f2=100.0, f3=1.0, f4=1.0, Q4=0.63, f5=None, Q5=None, f6=None, Q6=None),
}


def weighting_response(f: np.ndarray, name: str = "Wk") -> np.ndarray:
    """Complex frequency response H(j 2 pi f) of an ISO 2631-1 weighting."""
    p = WEIGHTINGS[name]
    s = 2j * np.pi * np.asarray(f, float)
    s = np.where(s == 0, 1e-12j, s)
    w1, w2 = 2 * np.pi * p["f1"], 2 * np.pi * p["f2"]
    w3, w4 = 2 * np.pi * p["f3"], 2 * np.pi * p["f4"]
    Hh = 1.0 / (1 + np.sqrt(2) * w1 / s + (w1 / s) ** 2)
    Hl = 1.0 / (1 + np.sqrt(2) * s / w2 + (s / w2) ** 2)
    Ht = (1 + s / w3) / (1 + s / (p["Q4"] * w4) + (s / w4) ** 2)
    H = Hh * Hl * Ht
    if p["f5"] is not None:
        w5, w6 = 2 * np.pi * p["f5"], 2 * np.pi * p["f6"]
        Hs = (1 + s / (p["Q5"] * w5) + (s / w5) ** 2) / (1 + s / (p["Q6"] * w6) + (s / w6) ** 2) * (w5 / w6) ** 2
        H = H * Hs
    return H


def weight_signal(a: np.ndarray, fs: float, name: str = "Wk") -> np.ndarray:
    """Apply a weighting to a time history via FFT (zero-padded to limit wrap-around)."""
    a = np.asarray(a, float)
    n = len(a)
    nfft = int(2 ** np.ceil(np.log2(2 * n)))
    A = np.fft.rfft(a - a.mean(), nfft)
    f = np.fft.rfftfreq(nfft, 1 / fs)
    H = weighting_response(f, name)
    H[0] = 0.0
    return np.fft.irfft(A * H, nfft)[:n]


def rms(x) -> float:
    x = np.asarray(x, float)
    return float(np.sqrt(np.mean(x ** 2)))


def vdv(aw: np.ndarray, fs: float) -> float:
    """Vibration dose value (m/s^1.75)."""
    return float((np.sum(aw ** 4) / fs) ** 0.25)


def ride_metrics(log: dict, veh, t_skip: float = 1.0) -> dict:
    """Compute the reported metrics from a simulation log (see sim.run)."""
    t = log["t"]
    fs = 1.0 / (t[1] - t[0])
    m = t >= t_skip
    aw_seat = weight_signal(log["acc_seat"][m], fs, "Wk")
    aw_cg = weight_signal(log["acc_cg"][m], fs, "Wk")
    pitch_w = weight_signal(log["pitch_acc"][m], fs, "We")
    roll_w = weight_signal(log["roll_acc"][m], fs, "We")
    stroke = log["stroke"][m]           # (N,4) extension positive
    Ft = log["tyre_force"][m]           # (N,4) absolute tyre load
    F0 = veh.static_tyre_loads()
    dF = Ft - F0
    fa = log["f_act"][m]
    sdot = log["stroke_rate"][m]
    p = np.sum(fa * sdot, axis=1)       # power delivered by actuators to the vehicle
    return {
        "aw_seat": rms(aw_seat),
        "aw_cg": rms(aw_cg),
        "vdv_seat": vdv(aw_seat, fs),
        "acc_seat_rms_unweighted": rms(log["acc_seat"][m]),
        "acc_seat_peak": float(np.max(np.abs(log["acc_seat"][m]))),
        "pitch_rms_deg": float(np.degrees(rms(log["pitch"][m]))),
        "roll_rms_deg": float(np.degrees(rms(log["roll"][m]))),
        "pitch_acc_w_rms": rms(pitch_w),
        "roll_acc_w_rms": rms(roll_w),
        "travel_rms_mm": 1e3 * rms(stroke),
        "travel_max_mm": 1e3 * float(np.max(np.abs(stroke))),
        "tyre_dlc": float(np.max(np.sqrt(np.mean(dF ** 2, axis=0)) / F0)),   # worst corner RMS(dF)/F0
        "tyre_min_load_ratio": float(np.min(Ft / F0)),
        "liftoff_frac": float(np.mean(np.any(Ft <= 0.0, axis=1))),
        "power_mean_W": float(np.mean(np.clip(p, 0, None))),   # no regeneration credited
        "power_net_W": float(np.mean(p)),
        "force_rms_N": rms(fa),
        "force_peak_N": float(np.max(np.abs(fa))),
        "sat_frac": float(np.mean(log.get("saturated", np.zeros(1)))),
    }


METRIC_LABELS = {
    "aw_seat": ("Seat a_w (Wk)", "m/s²"),
    "aw_cg": ("CG a_w (Wk)", "m/s²"),
    "vdv_seat": ("Seat VDV", "m/s^1.75"),
    "pitch_rms_deg": ("Pitch RMS", "deg"),
    "roll_rms_deg": ("Roll RMS", "deg"),
    "pitch_acc_w_rms": ("Pitch acc. (We) RMS", "rad/s²"),
    "roll_acc_w_rms": ("Roll acc. (We) RMS", "rad/s²"),
    "travel_rms_mm": ("Susp. travel RMS", "mm"),
    "travel_max_mm": ("Susp. travel max", "mm"),
    "tyre_dlc": ("Tyre DLC (worst corner)", "-"),
    "tyre_min_load_ratio": ("Min tyre load / static", "-"),
    "power_mean_W": ("Actuator power (no regen)", "W"),
    "force_peak_N": ("Peak actuator force", "N"),
}
