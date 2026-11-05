"""Suspension controllers.

All active controllers act through the same actuator model and use only
NOISY sensor signals (no access to the plant's true state):
  4 body-corner vertical accelerometers, pitch & roll rate gyros,
  4 suspension stroke sensors, 4 actuator force sensors
  (+ preview LQR: a look-ahead road-height sensor with limited range).

* Passive     : actuators removed (u = 0), springs + dampers only.
* Skyhook     : u_i = -c_sky * v_corner_i, absolute body-corner velocity from the Kalman filter.
* LQR         : discrete LQR on the 22-state design model + steady-state Kalman filter.
* PreviewLQR  : LQR + optimal feed-forward of the previewed road ahead
                (discrete-time preview control, e.g. Tomizuka 1975; Hrovat 1997).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.linalg import expm, solve_discrete_are

from .config import Config
from .model7dof import DesignModel, build_design_model, build_full_car, c2d
from .road import WHEEL_SIDE


def van_loan(A, G, Qc, dt):
    """Discrete process-noise covariance for xdot = A x + G w, E[w w'] = Qc delta."""
    n = A.shape[0]
    M = np.block([[-A, G @ Qc @ G.T], [np.zeros((n, n)), A.T]]) * dt
    E = expm(M)
    Ad = E[n:, n:].T
    return Ad @ E[:n, n:]


@dataclass
class Design:
    """Everything the model-based controllers share (built once per config)."""
    dm: DesignModel
    Ad: np.ndarray
    Bd: np.ndarray
    Ed: np.ndarray
    Cy: np.ndarray
    Ry: np.ndarray
    Qd: np.ndarray
    Pkf: np.ndarray
    Lkf: np.ndarray
    Q: np.ndarray
    R: np.ndarray
    P: np.ndarray
    K: np.ndarray
    Cz: np.ndarray
    W: np.ndarray
    dt: float
    residuals: dict = field(default_factory=dict)


def measurement_model(dm: DesignModel, cfg: Config, with_road=False):
    s = cfg.sensors
    rows = [dm.corner_acc_rows()]
    e = np.zeros((2, dm.n)); e[0, 8] = 1.0; e[1, 9] = 1.0
    rows += [e, dm.stroke_rows()]
    fa = np.zeros((4, dm.n)); fa[:, 18:22] = np.eye(4)
    rows.append(fa)
    std = [s["body_accel_std"]] * 4 + [s["gyro_std"]] * 2 + [s["deflection_std"]] * 4 + [20.0] * 4
    if with_road:
        zr = np.zeros((4, dm.n)); zr[:, 14:18] = np.eye(4)
        rows.append(zr)
        n_avg = max(1.0, s["preview_smoothing_m"] / 0.05)            # points averaged by the smoothing
        std += [s["preview_height_std"] / np.sqrt(n_avg)] * 4
    return np.vstack(rows), np.diag(np.square(std))


def performance_output(dm: DesignModel, cfg: Config):
    c = cfg.control
    qdd = dm.qdd_rows()
    Cz = np.vstack([qdd[0:3], dm.stroke_rows(), dm.tyre_defl_rows()])
    w = [c["w_heave_acc"], c["w_pitch_acc"], c["w_roll_acc"]] + [c["w_travel"]] * 4 + [c["w_tyre"]] * 4
    return Cz, np.diag(w)


def build_design(cfg: Config, veh=None, with_road_meas=False, speed=None) -> Design:
    veh = veh or cfg.vehicle
    c = cfg.control
    dt = c["dt"]
    car = build_full_car(veh)
    alpha = 2 * np.pi * c["road_highpass_hz"]
    dm = build_design_model(car, alpha, cfg.actuator.tau)
    Ad, Bd = c2d(dm.A, dm.Bu, dt)
    _, Ed = c2d(dm.A, dm.Ew, dt)
    # ---- LQR -------------------------------------------------------------
    Cz, W = performance_output(dm, cfg)
    Q = Cz.T @ W @ Cz * dt
    R = np.eye(4) * c["w_force"] * dt
    P = solve_discrete_are(Ad, Bd, Q, R)
    K = np.linalg.solve(R + Bd.T @ P @ Bd, Bd.T @ P @ Ad)
    # ---- Kalman filter ---------------------------------------------------
    Cy, Ry = measurement_model(dm, cfg, with_road_meas)
    G = np.zeros((dm.n, 8)); G[:, :4] = dm.Ew; G[18:22, 4:] = np.eye(4)
    Qc = np.diag([c["road_velocity_psd"]] * 4 + [c["actuator_process_std"] ** 2 / dt] * 4)
    Qd = van_loan(dm.A, G, Qc, dt)
    Qd = 0.5 * (Qd + Qd.T) + 1e-14 * np.eye(dm.n)
    Pkf = solve_discrete_are(Ad.T, Cy.T, Qd, Ry)
    Lkf = Pkf @ Cy.T @ np.linalg.inv(Cy @ Pkf @ Cy.T + Ry)
    d = Design(dm, Ad, Bd, Ed, Cy, Ry, Qd, Pkf, Lkf, Q, R, P, K, Cz, W, dt)
    d.residuals = riccati_residuals(d)
    return d


def riccati_residuals(d: Design) -> dict:
    A, B, Q, R, P = d.Ad, d.Bd, d.Q, d.R, d.P
    res = A.T @ P @ A - P - A.T @ P @ B @ np.linalg.solve(R + B.T @ P @ B, B.T @ P @ A) + Q
    C, Rv, Pk, Qd = d.Cy, d.Ry, d.Pkf, d.Qd
    rk = A @ Pk @ A.T - Pk - A @ Pk @ C.T @ np.linalg.solve(C @ Pk @ C.T + Rv, C @ Pk @ A.T) + Qd
    rho_lqr = np.max(np.abs(np.linalg.eigvals(A - B @ d.K)))
    rho_kf = np.max(np.abs(np.linalg.eigvals(A - A @ d.Lkf @ C)))
    return {"lqr_rel": float(np.linalg.norm(res) / np.linalg.norm(P)),
            "kf_rel": float(np.linalg.norm(rk) / np.linalg.norm(Pk)),
            "lqr_spectral_radius": float(rho_lqr), "kf_spectral_radius": float(rho_kf),
            "P_min_eig": float(np.min(np.linalg.eigvalsh(0.5 * (P + P.T)))),
            "Pkf_min_eig": float(np.min(np.linalg.eigvalsh(0.5 * (Pk + Pk.T))))}


# ---------------------------------------------------------------------------
class Controller:
    name = "base"
    uses_preview = False

    def reset(self):
        pass

    def __call__(self, y: dict, info: dict) -> np.ndarray:
        raise NotImplementedError


class Passive(Controller):
    name = "passive"

    def __call__(self, y, info):
        return np.zeros(4)


class KFController(Controller):
    """Base class: steady-state Kalman filter in 'current estimator' form."""

    def __init__(self, design: Design, cfg: Config):
        self.d = design
        self.fmax = cfg.actuator.fmax
        self.reset()

    def reset(self):
        self.xpred = np.zeros(self.d.dm.n)
        self.xhat = np.zeros(self.d.dm.n)

    def _y_vec(self, y):
        return np.concatenate([y["acc"], [y["pitch_rate"], y["roll_rate"]], y["stroke"], y["f_act"]])

    def estimate(self, yv):
        d = self.d
        self.xhat = self.xpred + d.Lkf @ (yv - d.Cy @ self.xpred)
        return self.xhat

    def predict(self, u):
        self.xpred = self.d.Ad @ self.xhat + self.d.Bd @ np.clip(u, -self.fmax, self.fmax)

    def law(self, xhat, info):
        raise NotImplementedError

    def __call__(self, y, info):
        xh = self.estimate(self._y_vec(y))
        u = self.law(xh, info)
        self.predict(u)
        return u


class Skyhook(KFController):
    name = "skyhook"

    def __init__(self, design, cfg):
        super().__init__(design, cfg)
        self.c = cfg.control["skyhook_c"]
        self.T = design.dm.car.T

    def law(self, xh, info):
        v_corner = self.T @ xh[7:10]
        return -self.c * v_corner


class LQR(KFController):
    name = "lqr"

    def law(self, xh, info):
        return -self.d.K @ xh


class PreviewLQR(KFController):
    """LQR feedback + feed-forward of the previewed road innovation w."""
    name = "preview"
    uses_preview = True

    def __init__(self, design: Design, cfg: Config, speed: float):
        super().__init__(design, cfg)
        d = design
        self.V = speed
        self.Np = max(1, int(round(cfg.sensors["preview_distance"] / (speed * d.dt))))
        Ac = d.Ad - d.Bd @ d.K
        H = np.linalg.inv(d.R + d.Bd.T @ d.P @ d.Bd) @ d.Bd.T
        g = np.empty((self.Np, 4, 4))
        M = d.P @ d.Ed
        for j in range(self.Np):
            g[j] = H @ M
            M = Ac.T @ M
        self.Kff = g                     # u_ff = -sum_j Kff[j] @ w_{k+j}
        self.alpha = d.dm.alpha
        self.veh_x = cfg.vehicle.x

    def _y_vec(self, y):
        return np.concatenate([super()._y_vec(y), y["preview_zr0"]])

    def __call__(self, y, info):
        # preview heights for each wheel at j = 0..Np (from the noisy look-ahead sensor)
        zp = info["preview_profile"]            # callable(side, x) -> measured height
        xw = info["x_car"] + self.veh_x
        j = np.arange(self.Np + 1) * self.V * self.d.dt
        Z = np.stack([zp(WHEEL_SIDE[i], xw[i] + j) for i in range(4)], axis=1)  # (Np+1, 4)
        y = dict(y)
        y["preview_zr0"] = Z[0]
        xh = self.estimate(self._y_vec(y))
        dt = self.d.dt
        wseq = (Z[1:] - Z[:-1]) / dt + self.alpha * 0.5 * (Z[1:] + Z[:-1])   # (Np, 4)
        u = -self.d.K @ xh - np.einsum("jab,jb->a", self.Kff, wseq)
        self.predict(u)
        return u


def make_controllers(cfg: Config, speed: float, veh=None) -> dict:
    d = build_design(cfg, veh)
    dp = build_design(cfg, veh, with_road_meas=True)
    return {"passive": Passive(), "skyhook": Skyhook(d, cfg), "lqr": LQR(d, cfg),
            "preview": PreviewLQR(dp, cfg, speed)}


CONTROLLER_LABELS = {"passive": "Passive", "skyhook": "Skyhook", "lqr": "LQR + Kalman",
                     "preview": "Preview LQR"}
