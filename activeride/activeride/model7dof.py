"""Analytical linear 7-DOF full-car model (heave, pitch, roll, 4 unsprung masses).

q = [zs, th, ph, zu_FL, zu_FR, zu_RL, zu_RR]  (deviations from static equilibrium)
Body corner height z_ci = zs - x_i th + y_i ph.  Stroke (extension) s_i = z_ci - zu_i.
Suspension force on body at corner i:  f_i = -k_i s_i - c_i sdot_i + u_i
Tyre force on wheel i (dynamic part): kt_i (zr_i - zu_i) + ct_i (zrdot_i - zudot_i)

    M qdd + C qd + K q = S' u + Bz zr + Bzd zrdot
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.linalg import expm

from .config import Vehicle


@dataclass
class FullCar:
    M: np.ndarray
    C: np.ndarray
    K: np.ndarray
    S: np.ndarray       # (4,7) stroke map
    T: np.ndarray       # (4,3) body corner map
    Bu: np.ndarray      # (7,4)
    Bz: np.ndarray      # (7,4)
    Bzd: np.ndarray     # (7,4)
    veh: Vehicle

    # ---------------- first-order form, x = [q, qd] -----------------
    @property
    def A(self) -> np.ndarray:
        Mi = np.linalg.inv(self.M)
        return np.block([[np.zeros((7, 7)), np.eye(7)], [-Mi @ self.K, -Mi @ self.C]])

    @property
    def B(self) -> np.ndarray:
        """Inputs [u(4), zr(4), zrdot(4)]."""
        Mi = np.linalg.inv(self.M)
        return np.vstack([np.zeros((7, 12)), Mi @ np.hstack([self.Bu, self.Bz, self.Bzd])])

    def natural_frequencies(self):
        """Undamped natural frequencies (Hz) and mode shapes of M qdd + K q = 0."""
        w2, V = np.linalg.eig(np.linalg.solve(self.M, self.K))
        idx = np.argsort(w2.real)
        return np.sqrt(w2.real[idx]) / (2 * np.pi), V[:, idx].real

    def damped_modes(self):
        lam = np.linalg.eigvals(self.A)
        lam = lam[lam.imag > 0]
        lam = lam[np.argsort(np.abs(lam))]
        return np.abs(lam) / (2 * np.pi), -lam.real / np.abs(lam)

    def seat_row(self):
        """Row vector c so that seat vertical displacement = c @ q[:3]."""
        v = self.veh
        return np.array([1.0, -v.seat_x, v.seat_y])


def build_full_car(veh: Vehicle) -> FullCar:
    x, y = veh.x, veh.y
    T = np.column_stack([np.ones(4), -x, y])
    S = np.hstack([T, -np.eye(4)])
    M = np.diag([veh.ms, veh.Iyy, veh.Ixx, *veh.mu])
    Kt = np.zeros((7, 7)); Kt[3:, 3:] = np.diag(veh.kt)
    Ct = np.zeros((7, 7)); Ct[3:, 3:] = np.diag(veh.ct)
    K = S.T @ np.diag(veh.ks) @ S + Kt
    C = S.T @ np.diag(veh.cs) @ S + Ct
    Bz = np.vstack([np.zeros((3, 4)), np.diag(veh.kt)])
    Bzd = np.vstack([np.zeros((3, 4)), np.diag(veh.ct)])
    return FullCar(M=M, C=C, K=K, S=S, T=T, Bu=S.T.copy(), Bz=Bz, Bzd=Bzd, veh=veh)


def c2d(A, B, dt):
    """Zero-order-hold discretisation."""
    n, m = B.shape
    Mx = expm(np.block([[A, B], [np.zeros((m, n + m))]]) * dt)
    return Mx[:n, :n], Mx[:n, n:]


# ---------------------------------------------------------------------------
# Controller-design model: 22 states
#   xd = [q(7), qd(7), zr(4), fa(4)]
#   zr_dot = -alpha zr + w          (shaping filter road model, w = white noise)
#   fa_dot = (u_cmd - fa)/tau       (actuator bandwidth)
# ---------------------------------------------------------------------------
@dataclass
class DesignModel:
    A: np.ndarray
    Bu: np.ndarray       # u_cmd
    Ew: np.ndarray       # road innovation w
    alpha: float
    tau: float
    car: FullCar
    # index helpers
    iq = slice(0, 7)
    iqd = slice(7, 14)
    izr = slice(14, 18)
    ifa = slice(18, 22)
    n = 22

    def qdd_rows(self):
        """Rows of A giving the 7 generalised accelerations (no feedthrough: u enters via fa)."""
        return self.A[7:14, :]

    def corner_acc_rows(self):
        T = self.car.T
        return T @ self.qdd_rows()[:3, :]

    def seat_acc_row(self):
        return self.car.seat_row() @ self.qdd_rows()[:3, :]

    def stroke_rows(self):
        C = np.zeros((4, self.n)); C[:, :7] = self.car.S
        return C

    def stroke_rate_rows(self):
        C = np.zeros((4, self.n)); C[:, 7:14] = self.car.S
        return C

    def tyre_defl_rows(self):
        """zu - zr (compression positive)."""
        C = np.zeros((4, self.n)); C[:, 3:7] = np.eye(4); C[:, 14:18] = -np.eye(4)
        return C


def build_design_model(car: FullCar, alpha: float, tau: float) -> DesignModel:
    n = 22
    Mi = np.linalg.inv(car.M)
    A = np.zeros((n, n))
    A[0:7, 7:14] = np.eye(7)
    A[7:14, 0:7] = -Mi @ car.K
    A[7:14, 7:14] = -Mi @ car.C
    # road position and velocity (zrdot = -alpha zr + w) enter wheel equations
    A[7:14, 14:18] = Mi @ (car.Bz - alpha * car.Bzd)
    A[7:14, 18:22] = Mi @ car.Bu
    A[14:18, 14:18] = -alpha * np.eye(4)
    A[18:22, 18:22] = -np.eye(4) / tau
    Bu = np.zeros((n, 4)); Bu[18:22] = np.eye(4) / tau
    Ew = np.zeros((n, 4)); Ew[14:18] = np.eye(4); Ew[7:14] = Mi @ car.Bzd
    return DesignModel(A=A, Bu=Bu, Ew=Ew, alpha=alpha, tau=tau, car=car)
