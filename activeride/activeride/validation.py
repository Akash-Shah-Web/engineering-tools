"""Model validation checks. Each function returns a dict of numbers; the
pytest suite asserts tolerances and run_all.py writes them to results/."""
from __future__ import annotations

import numpy as np

from .config import G, Config
from .controllers import build_design
from .metrics import weighting_response
from .model7dof import build_full_car
from .plants import WHEELS, MujocoCar
from .road import WHEEL_SIDE, synthetic_road


def _flat(cfg, length=400.0):
    return synthetic_road("bump", 0.0, 1.0, "both", length, cfg.vehicle.envelope_m)


def _veh(cfg, **kw):
    c = cfg.copy()
    for k, v in kw.items():
        setattr(c.vehicle, k, v)
    return c


# ---------------------------------------------------------------------------
def static_equilibrium(cfg: Config) -> dict:
    """(a) qpos = 0 is an equilibrium; (b) a 20 mm heave offset decays back to it;
    tyre loads equal the analytical static axle-load split."""
    road = _flat(cfg)
    p = MujocoCar(cfg, road, 0.0, active=False)
    for _ in range(2000):
        p.step(np.zeros(4))
    tr = p.truth()
    drift = max(abs(tr["zs"]), abs(tr["pitch"]), abs(tr["roll"]), np.abs(tr["stroke"]).max())
    F_err = np.abs(tr["tyre_force"] - cfg.vehicle.static_tyre_loads()).max()
    p.reset()
    p.d.qpos[p.qz] = 0.02
    for _ in range(8000):
        p.step(np.zeros(4))
    tr2 = p.truth()
    # analytical static deflections from the stiffness matrix (sanity: gravity loads)
    car = build_full_car(cfg.vehicle)
    Wt = cfg.vehicle.static_tyre_loads()
    return {"drift_from_equilibrium_m": float(drift), "tyre_load_error_N": float(F_err),
            "settled_heave_after_offset_m": float(abs(tr2["zs"])),
            "static_tyre_loads_N": Wt.tolist(),
            "total_load_check_N": float(Wt.sum() - (cfg.vehicle.ms + cfg.vehicle.mu.sum()) * G),
            "K_symmetric": bool(np.allclose(car.K, car.K.T))}


# ---------------------------------------------------------------------------
def mujoco_fd_linearisation(cfg: Config, eps=1e-6, **plant_kw):
    """Finite-difference one-step map of the MuJoCo plant (incl. external tyre
    forces) about static equilibrium, state = [heave, pitch, roll, q_susp(4)] + rates."""
    p = MujocoCar(cfg, _flat(cfg), 0.0, active=False, **plant_kw)
    qi = np.array([p.qz, p.qth, p.qph, *p.qs])
    vi = np.array([p.vz, p.vth, p.vph, *p.vs])
    nq = len(qi)
    dt = p.dt_ctrl

    def stepper(x):
        p.reset()
        p.d.qpos[qi] += x[:nq]
        p.d.qvel[vi] += x[nq:]
        p.d.qvel[p.vspin] = 0.0
        p.step(np.zeros(4))
        return np.concatenate([p.d.qpos[qi], p.d.qvel[vi]])

    x0 = stepper(np.zeros(2 * nq))
    Ad = np.zeros((2 * nq, 2 * nq))
    for j in range(2 * nq):
        e = np.zeros(2 * nq); e[j] = eps
        Ad[:, j] = (stepper(e) - stepper(-e)) / (2 * eps)
    lam = np.log(np.linalg.eigvals(Ad).astype(complex)) / dt
    return Ad, lam, x0


GEOMETRY_MATCHED = {"h_cg": None, "wheel_inertia": (1e-4, 1e-4, 1e-4)}


def natural_frequencies(cfg: Config) -> dict:
    """Undamped (cs = ct = 0): analytical sqrt(eig(M^-1 K)) vs MuJoCo FD
    linearisation. Damped: analytical eig(A) vs MuJoCo.

    'realistic' uses the rendered geometry (wheel centres 0.25 m below the
    CG/roll axis). 'geometry_matched' puts the wheel centres at CG height with
    negligible wheel rotary inertia - the assumptions behind the 7-DOF model -
    so any remaining difference would be an implementation error."""
    out = {"realistic": _natfreq(cfg, {}),
           "geometry_matched": _natfreq(cfg, {"h_cg": float(cfg.vehicle.R0 - cfg.vehicle.static_tyre_loads()[0] / cfg.vehicle.kt[0]),
                                              "wheel_inertia": (1e-4, 1e-4, 1e-4)})}
    return out


def _natfreq(cfg, plant_kw) -> dict:
    out = {}
    for label, c in (("undamped", _veh(cfg, cs=np.zeros(4), ct=np.zeros(4))), ("damped", cfg)):
        car = build_full_car(c.vehicle)
        if label == "undamped":
            f_an, _ = car.natural_frequencies()
        else:
            f_an, zeta_an = car.damped_modes()
        _, lam, _ = mujoco_fd_linearisation(c, **plant_kw)
        lam = lam[lam.imag > 1e-6]
        f_mj = np.sort(np.abs(lam) / (2 * np.pi))
        f_an = np.sort(np.asarray(f_an))
        out[label] = {"analytical_hz": f_an.tolist(), "mujoco_hz": f_mj.tolist(),
                      "max_rel_err": float(np.max(np.abs(f_mj - f_an) / f_an))}
        if label == "damped":
            zeta_mj = -lam.real / np.abs(lam)
            out[label]["analytical_zeta"] = np.asarray(zeta_an)[np.argsort(f_an)].tolist()
            out[label]["mujoco_zeta"] = zeta_mj[np.argsort(np.abs(lam))].tolist()
    return out


# ---------------------------------------------------------------------------
def analytical_frf(cfg: Config, f: np.ndarray, wheel=0):
    """Transfer from road height at one wheel to [heave acc, pitch acc, roll acc]."""
    car = build_full_car(cfg.vehicle)
    A, B = car.A, car.B
    out = np.zeros((len(f), 3), complex)
    bz = B[:, 4 + wheel] + 2j * np.pi * 0  # placeholder for clarity
    for k, fk in enumerate(f):
        s = 2j * np.pi * fk
        u = np.zeros(12, complex); u[4 + wheel] = 1.0; u[8 + wheel] = s
        X = np.linalg.solve(s * np.eye(14) - A, B @ u)
        out[k] = s * X[7:10]          # accelerations = s * velocities
    del bz
    return out


def frequency_response(cfg: Config, freqs=(0.8, 1.4, 2.5, 5.0, 9.0, 13.0), amp=0.002, wheel=0) -> dict:
    """Sine excitation of one wheel in MuJoCo, steady-state amplitude/phase by
    least squares, vs the analytical 7-DOF FRF."""
    p = MujocoCar(cfg, _flat(cfg), 0.0, active=False)
    res = []
    for f in freqs:
        w = 2 * np.pi * f

        def zr_fn(t, w=w):
            zr = np.zeros(4); zd = np.zeros(4)
            ramp = min(1.0, t / 1.0)
            zr[wheel] = amp * ramp * np.sin(w * t)
            zd[wheel] = amp * ramp * w * np.cos(w * t)
            return zr, zd
        p.zr_fn = zr_fn
        p.reset()
        settle = max(4.0, 12.0 / f)
        n_meas = int(round(max(4.0, 10.0 / f) / p.dt_ctrl))
        for _ in range(int(settle / p.dt_ctrl)):
            p.step(np.zeros(4))
        ts, ys = [], []
        for _ in range(n_meas):
            p.step(np.zeros(4))
            ts.append(p.d.time)
            ys.append([p.d.qacc[p.vz], p.d.qacc[p.vth], p.d.qacc[p.vph]])
        ts, ys = np.array(ts), np.array(ys)
        X = np.column_stack([np.sin(w * ts), np.cos(w * ts), np.ones_like(ts)])
        coef, *_ = np.linalg.lstsq(X, ys, rcond=None)
        H_mj = (coef[0] + 1j * coef[1]) / amp     # sin -> 1, cos -> j
        H_an = analytical_frf(cfg, np.array([f]), wheel)[0]
        res.append({"f_hz": f, "mujoco_mag": np.abs(H_mj).tolist(), "analytical_mag": np.abs(H_an).tolist(),
                    "mujoco_phase_deg": np.degrees(np.angle(H_mj)).tolist(),
                    "analytical_phase_deg": np.degrees(np.angle(H_an)).tolist()})
    worst = max(np.max(np.abs(np.array(r["mujoco_mag"]) - np.array(r["analytical_mag"])) /
                       np.maximum(np.array(r["analytical_mag"]), 1e-9)) for r in res)
    return {"wheel": WHEELS[wheel], "amplitude_m": amp, "points": res, "max_rel_mag_err": float(worst)}


# ---------------------------------------------------------------------------
def mujoco_vs_linear(cfg: Config, sid="m13_A", duration=8.0, controllers=("passive", "lqr")) -> dict:
    from .sim import run_scenario
    out = {}
    rm = run_scenario(cfg, sid, controllers=controllers, plant_kind="mujoco", duration=duration)
    rl = run_scenario(cfg, sid, controllers=controllers, plant_kind="linear", duration=duration)
    for c in controllers:
        a, b = rm["logs"][c], rl["logs"][c]
        d = {}
        for key in ("zs", "pitch", "roll", "stroke", "tyre_force", "acc_seat"):
            xa, xb = np.asarray(a[key], float), np.asarray(b[key], float)
            if key == "tyre_force":
                xa = xa - cfg.vehicle.static_tyre_loads(); xb = xb - cfg.vehicle.static_tyre_loads()
            d[key] = float(np.sqrt(np.mean((xa - xb) ** 2)) / max(np.sqrt(np.mean(xb ** 2)), 1e-12))
        out[c] = d
    return {"scenario": sid, "duration_s": duration, "normalised_rms_difference": out,
            "logs": {"mujoco": rm["logs"], "linear": rl["logs"]}}


# ---------------------------------------------------------------------------
def riccati(cfg: Config) -> dict:
    d = build_design(cfg)
    dp = build_design(cfg, with_road_meas=True)
    return {"lqr_kf": d.residuals, "preview_kf": dp.residuals}


def preview_vs_batch(cfg: Config, H=200) -> dict:
    """Preview law (perfect state, full preview) equals the batch LQ optimum."""
    from .controllers import PreviewLQR
    c = cfg.copy(); c.control["dt"] = 0.005
    d = build_design(c)
    A, B, E, Q, R, K, P = d.Ad, d.Bd, d.Ed, d.Q, d.R, d.K, d.P
    n = A.shape[0]
    w = np.zeros((H, 4)); w[40:50, 0] = 0.5; w[40:50, 2] = -0.2
    Phi = [np.eye(n)]
    for _ in range(H):
        Phi.append(A @ Phi[-1])
    Su = np.zeros((H * n, H * 4)); Sw = np.zeros((H * n, H * 4))
    for k in range(1, H + 1):
        for j in range(k):
            Su[(k - 1) * n:k * n, j * 4:(j + 1) * 4] = Phi[k - 1 - j] @ B
            Sw[(k - 1) * n:k * n, j * 4:(j + 1) * 4] = Phi[k - 1 - j] @ E
    Qb = np.kron(np.eye(H), Q); Qb[-n:, -n:] = P
    Rb = np.kron(np.eye(H), R)
    U = -np.linalg.solve(Su.T @ Qb @ Su + Rb, Su.T @ Qb @ Sw @ w.ravel()).reshape(H, 4)
    pv = PreviewLQR(d, c, speed=c.sensors["preview_distance"] / (H * c.control["dt"]))
    Ac = A - B @ K
    Hm = np.linalg.solve(R + B.T @ P @ B, B.T)
    M = P @ E; g = []
    for _ in range(H):
        g.append(Hm @ M); M = Ac.T @ M
    x = np.zeros(n); Up = []
    for k in range(H):
        u = -K @ x - sum(g[j] @ w[k + j] for j in range(H - k))
        Up.append(u); x = A @ x + B @ u + E @ w[k]
    Up = np.array(Up)
    err = float(np.abs(U[: H // 2] - Up[: H // 2]).max() / np.abs(U).max())
    return {"max_rel_diff": err, "gain_shape_ok": bool(pv.Kff.shape[1:] == (4, 4))}


# ---------------------------------------------------------------------------
def _energy_run(c, n_ctrl=4000):
    p = MujocoCar(c, _flat(c), 0.0, active=False)
    p.d.qpos[p.qz] = 0.008; p.d.qpos[p.qth] = 0.003; p.d.qpos[p.qph] = -0.004   # small: tyres stay in contact
    p.d.qvel[p.vspin] = 0.0
    E0 = p.energy()
    E, diss = [E0], 0.0
    cs, ct = c.vehicle.cs, c.vehicle.ct
    for _ in range(n_ctrl):
        for _s in range(p.nsub):
            sd = -p.d.qvel[p.vs]
            p.d.qvel[p.vspin] = 0.0
            p.mj.mj_step1(p.m, p.d)
            F, zr, zrd, zw, vzw = p._tyre()
            p.d.xfrc_applied[p.bw, 2] = F
            diss += float(np.sum(cs * sd ** 2) + np.sum(ct * vzw ** 2)) * p.m.opt.timestep
            p.mj.mj_step2(p.m, p.d)
        E.append(p.energy())
    return np.array(E), diss, E0 - _equilibrium_energy(c)


def energy(cfg: Config) -> dict:
    """(a) cs = ct = 0: energy is conserved up to the bounded O(omega*h)
    oscillation of the semi-implicit integrator (checked by refining h);
    (b) with dampers: E(0) - E(t) = integral of damper power (energy balance)."""
    out = {}
    cu = _veh(cfg, cs=np.zeros(4), ct=np.zeros(4))
    E, _, exc = _energy_run(cu)
    n = len(E) // 8
    cf = cu.copy(); cf.sim["plant_dt"] = cfg.sim["plant_dt"] / 10
    Ef, _, _ = _energy_run(cf)
    out["undamped"] = {"excitation_J": float(exc),
                       "max_rel_fluctuation": float((E.max() - E.min()) / exc),
                       "max_rel_fluctuation_h_over_10": float((Ef.max() - Ef.min()) / exc),
                       "secular_rel_drift": float(abs(E[-n:].mean() - E[:n].mean()) / exc)}
    E, diss, exc = _energy_run(cfg)
    out["damped"] = {"excitation_J": float(exc), "energy_lost_J": float(E[0] - E[-1]),
                     "damper_dissipation_J": float(diss),
                     "balance_rel_err": float(abs((E[0] - E[-1]) - diss) / exc),
                     "monotone_decrease": bool(np.all(np.diff(E) <= 1e-6 * exc))}
    return out


def _equilibrium_energy(c):
    p = MujocoCar(c, _flat(c), 0.0, active=False)
    p.d.qvel[p.vspin] = 0.0
    return p.energy()


# ---------------------------------------------------------------------------
def signs(cfg: Config) -> dict:
    """Sign conventions shared by both models."""
    out = {}
    car = build_full_car(cfg.vehicle)
    # (1) static actuator push u>0 on all corners: body up, wheels down
    q_lin = np.linalg.solve(car.K, car.Bu @ np.full(4, 500.0))
    p = MujocoCar(cfg, _flat(cfg), 0.0, active=True)
    for _ in range(6000):
        p.step(np.full(4, 500.0))
    tr = p.truth()
    out["actuator_push_body_up"] = bool(q_lin[0] > 0 and tr["zs"] > 0)
    # an internal force cannot change the total tyre load: wheels stay put (|zu| ~ 0)
    out["actuator_push_wheels_static"] = bool(np.abs(q_lin[3:]).max() < 1e-9 and np.abs(tr["zu"]).max() < 2e-4)
    out["actuator_push_tyre_load_change_N"] = float(np.abs(tr["tyre_force"] - cfg.vehicle.static_tyre_loads()).max())
    out["actuator_static_heave_lin_vs_mj_m"] = [float(q_lin[0]), float(tr["zs"])]
    # (2) static front-axle road lift of 10 mm: body up, nose up (pitch < 0 with th>0 = front down)
    q2 = np.linalg.solve(car.K, car.Bz @ np.array([0.01, 0.01, 0, 0]))
    p = MujocoCar(cfg, _flat(cfg), 0.0, active=False)
    p.zr_fn = lambda t: (np.array([0.01, 0.01, 0, 0]) * min(1, t), np.zeros(4))
    for _ in range(8000):
        p.step(np.zeros(4))
    tr = p.truth()
    out["front_lift_pitch_nose_up"] = bool(q2[1] < 0 and tr["pitch"] < 0)
    out["front_lift_pitch_lin_vs_mj_rad"] = [float(q2[1]), float(tr["pitch"])]
    # (3) left-side lift: roll positive (left up)
    q3 = np.linalg.solve(car.K, car.Bz @ np.array([0.01, 0, 0.01, 0]))
    p.zr_fn = lambda t: (np.array([0.01, 0, 0.01, 0]) * min(1, t), np.zeros(4))
    p.reset()
    for _ in range(8000):
        p.step(np.zeros(4))
    tr = p.truth()
    out["left_lift_roll_positive"] = bool(q3[2] > 0 and tr["roll"] > 0)
    out["left_lift_roll_lin_vs_mj_rad"] = [float(q3[2]), float(tr["roll"])]
    # (4) accelerometer reads +g - g = 0 at rest, and sign of heave acceleration
    out["accelerometer_zero_at_rest"] = float(np.abs(MujocoCar(cfg, _flat(cfg), 0.0).measure()["acc"]).max())
    return out


def iso_weighting() -> dict:
    """Wk magnitudes vs ISO 2631-1:1997 Table 3 (values x1000)."""
    table = {0.5: 418, 1.0: 482, 2.0: 531, 4.0: 967, 6.3: 1054, 8.0: 1036, 12.5: 902, 20.0: 636, 31.5: 405, 63.0: 186}
    f = np.array(list(table))
    got = np.abs(weighting_response(f, "Wk")) * 1000
    ref = np.array(list(table.values()), float)
    return {"f_hz": f.tolist(), "table_x1000": ref.tolist(), "computed_x1000": got.tolist(),
            "max_rel_err": float(np.max(np.abs(got - ref) / ref))}


def estimator_accuracy(cfg: Config, duration=8.0) -> dict:
    """Kalman estimate vs MuJoCo truth on measured road (LQR running)."""
    from .controllers import LQR
    from .road import road_for_scenario
    from .sim import PreviewSensor, run
    sc = cfg.scenario("m13_A")
    V = sc["speed_kmh"] / 3.6
    road = road_for_scenario(sc, cfg.vehicle.envelope_m)
    d = build_design(cfg)
    ctrl = LQR(d, cfg)
    est, tru = [], []

    def cb(plant, tr):
        est.append(ctrl.xhat.copy())
        tru.append([tr["zs_d"], tr["pitch_d"], tr["roll_d"], *tr["stroke"]])
    plant = MujocoCar(cfg, road, V, active=True)
    run(plant, ctrl, duration, cfg, np.random.default_rng(1), preview=None, callback=cb)
    est, tru = np.array(est), np.array(tru)
    car = d.dm.car
    est_s = (car.S @ est[:, :7].T).T
    pairs = {"heave_rate": (est[:, 7], tru[:, 0]), "pitch_rate": (est[:, 8], tru[:, 1]),
             "roll_rate": (est[:, 9], tru[:, 2]), "stroke_FL": (est_s[:, 0], tru[:, 3])}
    k = len(est) // 8
    return {n: {"corr": float(np.corrcoef(a[k:], b[k:])[0, 1]),
                "nrmse": float(np.sqrt(np.mean((a[k:] - b[k:]) ** 2)) / np.std(b[k:]))} for n, (a, b) in pairs.items()}
