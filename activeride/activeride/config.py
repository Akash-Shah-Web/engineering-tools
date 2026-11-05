"""Load the single TOML parameter file into plain dataclasses."""
from __future__ import annotations

import copy
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "config" / "activeride.toml"
G = 9.81


@dataclass
class Vehicle:
    ms: float
    Ixx: float
    Iyy: float
    a: float
    b: float
    tf: float
    tr: float
    mu: np.ndarray
    ks: np.ndarray
    cs: np.ndarray
    kt: np.ndarray
    ct: np.ndarray
    R0: float
    seat_x: float
    seat_y: float
    liftoff: bool
    envelope_m: float

    @property
    def x(self) -> np.ndarray:
        """Longitudinal corner positions relative to CG (FL, FR, RL, RR)."""
        return np.array([self.a, self.a, -self.b, -self.b])

    @property
    def y(self) -> np.ndarray:
        """Lateral corner positions relative to CG (left positive)."""
        return np.array([self.tf / 2, -self.tf / 2, self.tr / 2, -self.tr / 2])

    @property
    def L(self) -> float:
        return self.a + self.b

    def static_sprung_loads(self) -> np.ndarray:
        """Static sprung load per corner (N), CG on the centreline."""
        W = self.ms * G
        f = W * self.b / self.L / 2
        r = W * self.a / self.L / 2
        return np.array([f, f, r, r])

    def static_tyre_loads(self) -> np.ndarray:
        return self.static_sprung_loads() + self.mu * G


@dataclass
class Actuator:
    fmax: float
    rate: float
    bw_hz: float

    @property
    def tau(self) -> float:
        return 1.0 / (2 * np.pi * self.bw_hz)


@dataclass
class Config:
    vehicle: Vehicle
    actuator: Actuator
    sensors: dict
    control: dict
    sim: dict
    scenarios: list
    montecarlo: dict
    raw: dict = field(repr=False, default_factory=dict)

    def scenario(self, sid: str) -> dict:
        for s in self.scenarios:
            if s["id"] == sid:
                return s
        raise KeyError(sid)

    def copy(self) -> "Config":
        return copy.deepcopy(self)


def load_config(path: str | Path | None = None) -> Config:
    path = Path(path) if path else DEFAULT_CONFIG
    raw = tomllib.loads(path.read_text())
    v = raw["vehicle"]
    veh = Vehicle(
        ms=v["sprung_mass"], Ixx=v["Ixx_roll"], Iyy=v["Iyy_pitch"], a=v["a_front"], b=v["b_rear"],
        tf=v["track_front"], tr=v["track_rear"], mu=np.array(v["unsprung_mass"], float),
        ks=np.array(v["spring_rate"], float), cs=np.array(v["damper_rate"], float),
        kt=np.array(v["tyre_stiffness"], float), ct=np.array(v["tyre_damping"], float),
        R0=v["tyre_radius"], seat_x=v["driver_seat_x"], seat_y=v["driver_seat_y"],
        liftoff=bool(v["tyre_liftoff"]), envelope_m=v["tyre_envelope_m"])
    a = raw["actuator"]
    act = Actuator(fmax=a["max_force"], rate=a["max_rate"], bw_hz=a["bandwidth_hz"])
    return Config(vehicle=veh, actuator=act, sensors=dict(raw["sensors"]), control=dict(raw["control"]),
                  sim=dict(raw["simulation"]), scenarios=list(raw["scenario"]),
                  montecarlo=dict(raw["montecarlo"]), raw=raw)
