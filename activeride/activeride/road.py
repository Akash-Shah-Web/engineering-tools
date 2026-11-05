"""Road inputs: MEASURED LiRA-CD wheel-path profiles and SYNTHETIC obstacles.

A Road object holds two wheel-path profiles (left, right) on a uniform
distance grid. Wheels on the left side follow the left path, wheels on the
right side follow the right path; rear wheels see the same path as the front
wheels, delayed by the wheelbase.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .config import ROOT

SAMPLES = ROOT / "data" / "samples"
GRID_DX = 0.05          # m, resampling grid
LEAD_IN_M = 12.0        # m of flat road before the profile (static start)
TAPER_M = 8.0           # m cosine taper from flat road into the profile


@dataclass
class Road:
    x: np.ndarray            # m, distance grid
    z: np.ndarray            # (2, N) m, [left, right] heights AFTER tyre enveloping
    z_raw: np.ndarray        # (2, N) m, heights before enveloping (still detrended)
    kind: str                # "measured" | "synthetic"
    label: str
    source: str
    meta: dict

    def height(self, side: np.ndarray, xq: np.ndarray) -> np.ndarray:
        """Road height for each wheel. side: 0=left,1=right per query."""
        out = np.empty(len(xq))
        for s in (0, 1):
            m = side == s
            out[m] = np.interp(xq[m], self.x, self.z[s])
        return out

    def slope(self, side: np.ndarray, xq: np.ndarray) -> np.ndarray:
        out = np.empty(len(xq))
        for s in (0, 1):
            m = side == s
            out[m] = np.interp(xq[m], self.x, self._dz[s])
        return out

    def __post_init__(self):
        self._dz = np.gradient(self.z, self.x, axis=1)

    @property
    def length(self) -> float:
        return float(self.x[-1])


WHEEL_SIDE = np.array([0, 1, 0, 1])   # FL, FR, RL, RR -> left/right path


def _moving_average(z: np.ndarray, n: int) -> np.ndarray:
    if n <= 1:
        return z.copy()
    k = np.ones(n) / n
    zp = np.pad(z, (n // 2, n - 1 - n // 2), mode="edge")
    return np.convolve(zp, k, mode="valid")


def load_lira_sample(section: str) -> dict:
    """Read a committed LiRA-CD sample (values unchanged from the source)."""
    p = SAMPLES / f"lira_m13_{section}.csv"
    if not p.exists():
        raise FileNotFoundError(f"{p} missing - run scripts/fetch_data.py")
    d = np.loadtxt(p, delimiter=",", comments="#", skiprows=3)
    return {"chainage_m": d[:, 0], "left_mm": d[:, 1], "right_mm": d[:, 2], "path": p}


def preprocess_measured(chainage, left_mm, right_mm):
    """mm -> m, per-track least-squares line removed, resampled to GRID_DX.

    Returns distance (from 0) and (2,N) heights. No amplitude scaling, no
    filtering other than the line removal; tyre enveloping is applied later.
    """
    s = chainage - chainage[0]
    out = []
    for z in (left_mm, right_mm):
        zm = np.asarray(z) / 1000.0
        p = np.polyfit(s, zm, 1)
        out.append(zm - np.polyval(p, s))
    xg = np.arange(0.0, s[-1], GRID_DX)
    zg = np.vstack([np.interp(xg, s, z) for z in out])
    return xg, zg


def _assemble(xp, zp, envelope_m, length_m=None):
    """Prepend a flat lead-in and a cosine taper so the car starts in static equilibrium."""
    if length_m is not None:
        keep = xp <= length_m
        xp, zp = xp[keep], zp[:, keep]
    taper = np.ones_like(xp)
    t = xp < TAPER_M
    taper[t] = 0.5 - 0.5 * np.cos(np.pi * xp[t] / TAPER_M)
    zp = zp * taper
    n_lead = int(round(LEAD_IN_M / GRID_DX))
    x = np.arange(len(xp) + n_lead) * GRID_DX
    z_raw = np.hstack([np.zeros((2, n_lead)), zp])
    n_env = max(1, int(round(envelope_m / GRID_DX)))
    z = np.vstack([_moving_average(zz, n_env) for zz in z_raw])
    return x, z, z_raw


def measured_road(section: str, envelope_m: float, length_m=None, label="") -> Road:
    d = load_lira_sample(section)
    xp, zp = preprocess_measured(d["chainage_m"], d["left_mm"], d["right_mm"])
    x, z, z_raw = _assemble(xp, zp, envelope_m, length_m)
    meta = {"section": section, "chainage_start_m": float(d["chainage_m"][0]),
            "chainage_end_m": float(d["chainage_m"][-1]), "lead_in_m": LEAD_IN_M, "taper_m": TAPER_M,
            "file": str(d["path"].relative_to(ROOT))}
    return Road(x, z, z_raw, "measured", label or f"M13 section {section}",
                "LiRA-CD P79 profilometer (DTU, DOI 10.11583/DTU.23097002, CC BY 4.0)", meta)


def synthetic_road(shape: str, height: float, length: float, side: str, total_m: float,
                   envelope_m: float, at_m: float = 15.0, label="") -> Road:
    """SYNTHETIC obstacle on otherwise flat road (no measured content)."""
    xp = np.arange(0.0, total_m, GRID_DX)
    prof = np.zeros_like(xp)
    m = (xp >= at_m) & (xp <= at_m + length)
    u = (xp[m] - at_m) / length
    if shape == "bump":
        prof[m] = height * np.sin(np.pi * u)
    elif shape == "pothole":
        prof[m] = height * 0.5 * (1 - np.cos(2 * np.pi * u))
    else:
        raise ValueError(shape)
    zp = np.zeros((2, len(xp)))
    if side in ("both", "left"):
        zp[0] = prof
    if side in ("both", "right"):
        zp[1] = prof
    n_lead = int(round(LEAD_IN_M / GRID_DX))
    x = np.arange(len(xp) + n_lead) * GRID_DX
    z_raw = np.hstack([np.zeros((2, n_lead)), zp])
    n_env = max(1, int(round(envelope_m / GRID_DX)))
    z = np.vstack([_moving_average(zz, n_env) for zz in z_raw])
    return Road(x, z, z_raw, "synthetic", label or f"synthetic {shape}", "SYNTHETIC analytic shape",
                {"shape": shape, "height": height, "length": length, "side": side,
                 "obstacle_at_m": at_m + LEAD_IN_M})


def road_for_scenario(sc: dict, envelope_m: float) -> Road:
    if sc["kind"] == "measured":
        return measured_road(sc["section"], envelope_m, sc.get("length_m"), sc["label"])
    return synthetic_road(sc["shape"], sc["height"], sc["length"], sc["side"], sc["length_m"],
                          envelope_m, label=sc["label"])


# ---------------------------------------------------------------------------
# Road characterisation: IRI (ASTM E1926 quarter-car "golden car") and PSD
# ---------------------------------------------------------------------------
def iri(x: np.ndarray, z: np.ndarray) -> float:
    """International Roughness Index (m/km), ASTM E1926 / Sayers (1995)."""
    dx = 0.25
    xs = np.arange(x[0], x[-1], dx)
    zs = np.interp(xs, x, z)
    zs = _moving_average(zs, 1)  # 250 mm base length already equals dx
    c, k1, k2, mu = 6.0, 653.0, 63.3, 0.15
    A = np.array([[0, 1, 0, 0], [-k2, -c, k2, c], [0, 0, 0, 1], [k2 / mu, c / mu, -(k1 + k2) / mu, -c / mu]])
    B = np.array([0, 0, 0, k1 / mu])
    V = 80 / 3.6
    dt = dx / V
    from scipy.linalg import expm
    M = expm(np.block([[A, B[:, None]], [np.zeros((1, 5))]]) * dt)
    Ad, Bd = M[:4, :4], M[:4, 4]
    # initialise with the 11 m average slope (ASTM E1926)
    n11 = int(round(11 / dx))
    s0 = (zs[n11] - zs[0]) / 11.0
    st = np.array([zs[0], s0 * V, zs[0], s0 * V])
    acc = 0.0
    for zi in zs[1:]:
        st = Ad @ st + Bd * zi
        acc += abs(st[1] - st[3]) * dt
    L = xs[-1] - xs[0]
    return acc / (L / V) / V * 1000.0  # average rectified slope (m/m) -> m/km


def displacement_psd(x: np.ndarray, z: np.ndarray, nseg_m: float = 100.0):
    """One-sided spatial PSD Gd(n) [m^3] vs n [cycles/m] (Welch, Hann)."""
    from scipy.signal import welch
    dx = x[1] - x[0]
    nper = int(nseg_m / dx)
    n, G = welch(z - z.mean(), fs=1 / dx, nperseg=nper, detrend="linear")
    return n[1:], G[1:]


ISO8608_CLASSES = {"A": 16e-6, "B": 64e-6, "C": 256e-6, "D": 1024e-6, "E": 4096e-6}


def iso8608_class(n, G):
    """Fit Gd(n0)*(n/n0)^-2 over 0.011..2.83 cyc/m (ISO 8608) and classify."""
    m = (n >= 0.011) & (n <= 2.83)
    n0 = 0.1
    gd0 = float(np.exp(np.mean(np.log(G[m] * (n[m] / n0) ** 2))))
    bounds = [("A", 32e-6), ("B", 128e-6), ("C", 512e-6), ("D", 2048e-6), ("E", 8192e-6)]
    cls = next((c for c, b in bounds if gd0 < b), "F+")
    return gd0, cls
