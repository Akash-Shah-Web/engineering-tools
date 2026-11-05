"""Closed-loop simulation: plant + noisy sensors + controller + logging."""
from __future__ import annotations

import numpy as np

from .config import Config
from .controllers import make_controllers
from .plants import LinearCar, MujocoCar
from .road import GRID_DX, Road, _moving_average, road_for_scenario

LOG_KEYS = ["x", "zs", "pitch", "roll", "zs_d", "pitch_d", "roll_d", "pitch_acc", "roll_acc", "zu", "stroke",
            "stroke_rate", "tyre_force", "zr", "zrd", "f_act", "saturated", "acc_seat", "acc_cg"]


class PreviewSensor:
    """Noisy look-ahead road sensor. Each road point is observed once with
    white noise (std preview_height_std) and smoothed over the tyre envelope.
    Beyond the range the controller receives nothing (handled by the
    controller's finite preview horizon)."""

    def __init__(self, road: Road, std: float, envelope_m: float, rng):
        noisy = road.z_raw + rng.normal(0.0, std, road.z_raw.shape)
        n = max(1, int(round(envelope_m / GRID_DX)))
        self.x = road.x
        self.z = np.vstack([_moving_average(z, n) for z in noisy])

    def __call__(self, side: int, xq: np.ndarray) -> np.ndarray:
        return np.interp(xq, self.x, self.z[side])


def add_noise(y: dict, cfg: Config, rng, scale=1.0) -> dict:
    s = cfg.sensors
    return {"acc": y["acc"] + rng.normal(0, s["body_accel_std"] * scale, 4),
            "pitch_rate": y["pitch_rate"] + rng.normal(0, s["gyro_std"] * scale),
            "roll_rate": y["roll_rate"] + rng.normal(0, s["gyro_std"] * scale),
            "stroke": y["stroke"] + rng.normal(0, s["deflection_std"] * scale, 4),
            "f_act": y["f_act"] + rng.normal(0, 20.0 * scale, 4)}


def run(plant, controller, duration: float, cfg: Config, rng, noise_scale=1.0, preview=None,
        log_rate=None, callback=None) -> dict:
    dt = cfg.control["dt"]
    n = int(round(duration / dt))
    log_rate = log_rate or cfg.sim["log_rate_hz"]
    every = max(1, int(round(1.0 / (log_rate * dt))))
    controller.reset()
    plant.reset()
    logs = {k: [] for k in LOG_KEYS}
    logs["t"], logs["u_cmd"] = [], []
    u = np.zeros(4)
    for k in range(n):
        y = add_noise(plant.measure(), cfg, rng, noise_scale)
        info = {"t": plant.t, "x_car": plant.x_start + plant.V * plant.t, "preview_profile": preview}
        u = controller(y, info)
        plant.step(u)
        if (k + 1) % every == 0:
            tr = plant.truth()
            for key in LOG_KEYS:
                logs[key].append(tr[key])
            logs["t"].append(plant.t)
            logs["u_cmd"].append(np.array(u, float))
            if callback is not None:
                callback(plant, tr)
    return {k: np.asarray(v) for k, v in logs.items()}


def scenario_duration(cfg: Config, road: Road, speed: float) -> float:
    v = cfg.vehicle
    x0 = v.b + 1.0
    x_end = road.length - v.a - cfg.sensors["preview_distance"] - 1.0
    return float((x_end - x0) / speed)


def run_scenario(cfg: Config, sid: str, controllers=("passive", "skyhook", "lqr", "preview"),
                 plant_kind="mujoco", seed=None, duration=None, veh_plant=None, noise_scale=1.0,
                 ctrl_set=None) -> dict:
    """Run one scenario for several controllers. veh_plant lets the plant
    differ from the nominal vehicle used for controller design (robustness)."""
    sc = cfg.scenario(sid)
    V = sc["speed_kmh"] / 3.6
    road = road_for_scenario(sc, cfg.vehicle.envelope_m)
    dur = duration or scenario_duration(cfg, road, V)
    ctrls = ctrl_set or make_controllers(cfg, V)
    seed = cfg.sim["seed"] if seed is None else seed
    out = {}
    for name in controllers:
        rng = np.random.default_rng(seed)          # identical noise realisation for every controller
        prev = PreviewSensor(road, cfg.sensors["preview_height_std"], cfg.vehicle.envelope_m,
                             np.random.default_rng(seed + 1))
        active = name != "passive"
        P = MujocoCar if plant_kind == "mujoco" else LinearCar
        plant = P(cfg, road, V, active=active, veh=veh_plant)
        out[name] = run(plant, ctrls[name], dur, cfg, rng, noise_scale, prev)
    return {"scenario": sc, "road": road, "speed": V, "duration": dur, "logs": out}
