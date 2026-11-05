"""Simulation plants.

* MujocoCar  - 3D MuJoCo plant (the "truth" in all reported results).
  Rigid body with heave/pitch/roll joints and a forward slide joint held at
  constant speed; four wheel bodies on body-fixed vertical slide joints
  (suspension springs/dampers = joint stiffness/damping, actuators = motors);
  tyres are vertical spring-dampers to the road profile applied as external
  forces each sub-step (optionally unilateral = lift-off). Geometry is exact
  (finite rotations, suspension axes tilt with the body).
* LinearCar  - the analytical 7-DOF model integrated with ZOH (for
  validation and cross-checks).

Both plants share: actuator model (saturation -> first-order lag ->
slew-rate limit), the same measurement set, and the same log channels.
"""
from __future__ import annotations

import numpy as np

from .config import G, Config
from .model7dof import build_full_car, c2d
from .road import WHEEL_SIDE, Road

WHEELS = ["FL", "FR", "RL", "RR"]
H_CG = 0.55  # m, CG height above flat road at static equilibrium (visual/geometry)


class Actuator4:
    """Saturation -> first-order force tracking (bandwidth) -> slew-rate limit."""

    def __init__(self, act, enabled=True):
        self.fmax, self.rate, self.tau = act.fmax, act.rate, act.tau
        self.enabled = enabled
        self.f = np.zeros(4)
        self.saturated = np.zeros(4, bool)

    def reset(self):
        self.f[:] = 0.0

    def step(self, u_cmd, dt):
        if not self.enabled:
            self.f[:] = 0.0
            return self.f
        uc = np.clip(u_cmd, -self.fmax, self.fmax)
        self.saturated = np.abs(u_cmd) > self.fmax
        dfdt = (uc - self.f) / self.tau
        dfdt = np.clip(dfdt, -self.rate, self.rate)
        self.f = self.f + dfdt * dt
        return self.f


# ---------------------------------------------------------------------------
# MJCF generation (original low-poly vehicle)
# ---------------------------------------------------------------------------
def _prism_wheel_mesh(name, r, w, n=14):
    """Low-poly wheel: n-gon prism with its axis along y."""
    verts = []
    for side in (-w / 2, w / 2):
        for k in range(n):
            a = 2 * np.pi * (k + 0.5) / n
            verts += [r * np.cos(a), side, r * np.sin(a)]
    return f'<mesh name="{name}" vertex="{" ".join(f"{v:.4f}" for v in verts)}"/>'


def _box_mesh(name, xs, ys_bot, ys_top, z0, z1, xs_top=None):
    """Convex 'frustum' between a bottom rectangle and a top rectangle."""
    x0, x1 = xs
    tx0, tx1 = xs_top if xs_top else xs
    v = [x0, -ys_bot, z0, x1, -ys_bot, z0, x1, ys_bot, z0, x0, ys_bot, z0,
         tx0, -ys_top, z1, tx1, -ys_top, z1, tx1, ys_top, z1, tx0, ys_top, z1]
    return f'<mesh name="{name}" vertex="{" ".join(f"{a:.4f}" for a in v)}"/>'


def road_mesh_xml(road: Road, x0=-30.0, half_width=3.6, step=0.2, max_len=None):
    """Visual road surface following both measured wheel paths (true scale)."""
    x_end = road.length if max_len is None else min(road.length, max_len)
    xs = np.arange(x0, x_end + 30, step)
    ys = np.array([half_width, 1.2, 0.78, 0.0, -0.78, -1.2, -half_width])
    zl = np.interp(xs, road.x, road.z[0], left=0, right=0)
    zr = np.interp(xs, road.x, road.z[1], left=0, right=0)
    verts, faces = [], []
    ny = len(ys)
    for i, x in enumerate(xs):
        for j, y in enumerate(ys):
            # lateral interpolation between the two wheel paths, flat beyond them
            w = np.clip((y + 0.78) / 1.56, 0, 1)
            z = w * zl[i] + (1 - w) * zr[i]
            verts += [x, y, z - 0.002]
    for i in range(len(xs) - 1):
        for j in range(ny - 1):
            a, b = i * ny + j, i * ny + j + 1
            c, d = (i + 1) * ny + j, (i + 1) * ny + j + 1
            faces += [a, c, b, b, c, d]
    vs = " ".join(f"{v:.4f}" for v in verts)
    fs = " ".join(str(f) for f in faces)
    return f'<mesh name="road" vertex="{vs}" face="{fs}"/>', xs[0], xs[-1]


def build_mjcf(cfg: Config, road: Road | None = None, color="0.86 0.30 0.16 1", visual=True,
               veh=None) -> str:
    v = veh or cfg.vehicle
    dt = cfg.sim["plant_dt"]
    Ws = v.static_sprung_loads()
    Wt = v.static_tyre_loads()
    delta0 = Wt / v.kt
    zwc = v.R0 - delta0                       # wheel-centre height at static equilibrium
    qref = -Ws / v.ks                         # joint springref (q = wheel up rel. body)
    x, y = v.x, v.y
    assets = [
        _prism_wheel_mesh("tyre", v.R0, 0.215),
        _prism_wheel_mesh("rim", v.R0 * 0.62, 0.225, n=10),
        _box_mesh("hull", (-v.b - 0.95, v.a + 0.95), 0.90, 0.86, -0.27, 0.12),
        _box_mesh("shoulder", (-v.b - 0.92, v.a + 0.80), 0.86, 0.82, 0.12, 0.30, (-v.b - 0.85, v.a + 0.55)),
        _box_mesh("cabin", (-v.b - 0.45, v.a - 0.05), 0.76, 0.62, 0.30, 0.78, (-v.b + 0.05, v.a - 0.80)),
    ]
    road_geom = ""
    if road is not None and visual:
        rm, rx0, rx1 = road_mesh_xml(road)
        assets.append(rm)
        road_geom = ('<geom name="road" type="mesh" mesh="road" material="asphalt" contype="0" conaffinity="0"/>')
    wheels = []
    for i, nm in enumerate(WHEELS):
        side = 1 if y[i] > 0 else -1
        wheels.append(f"""
      <body name="wheel_{nm}" pos="{x[i]:.4f} {y[i]:.4f} {zwc[i] - H_CG:.5f}">
        <joint name="susp_{nm}" type="slide" axis="0 0 1" stiffness="{v.ks[i]:.3f}" damping="{v.cs[i]:.3f}"
               springref="{qref[i]:.6f}" armature="0"/>
        <joint name="spin_{nm}" type="hinge" axis="0 1 0" damping="0"/>
        <inertial pos="0 0 0" mass="{v.mu[i]:.3f}" diaginertia="0.6 0.02 0.6"/>
        <geom type="mesh" mesh="tyre" material="rubber" contype="0" conaffinity="0"/>
        <geom type="mesh" mesh="rim" pos="0 {side * 0.004:.3f} 0" material="rim" contype="0" conaffinity="0"/>
        <geom type="box" size="{v.R0 * 0.58:.3f} 0.118 0.030" material="spoke" contype="0" conaffinity="0"/>
        <geom type="box" size="0.030 0.118 {v.R0 * 0.58:.3f}" material="spoke" contype="0" conaffinity="0"/>
        <site name="hub_{nm}" pos="0 {-side * 0.05:.3f} 0" size="0.02"/>
      </body>""")
    tendons = "".join(
        f'<spatial name="strut_{nm}" width="0.035" rgba="0.95 0.78 0.2 1"><site site="top_{nm}"/><site site="hub_{nm}"/></spatial>'
        for nm in WHEELS)
    tops = "".join(f'<site name="top_{nm}" pos="{x[i]:.3f} {y[i] - np.sign(y[i]) * 0.05:.3f} 0.22" size="0.02"/>'
                   for i, nm in enumerate(WHEELS))
    accs = "".join(f'<site name="acc_{nm}" pos="{x[i]:.3f} {y[i]:.3f} 0" size="0.01"/>' for i, nm in enumerate(WHEELS))
    sens = "".join(f'<accelerometer name="acc_{nm}" site="acc_{nm}"/>' for nm in WHEELS)
    sens += '<gyro name="gyro" site="imu"/>'
    sens += "".join(f'<jointpos name="stroke_{nm}" joint="susp_{nm}"/>' for nm in WHEELS)
    motors = "".join(f'<motor name="act_{nm}" joint="susp_{nm}" gear="-1" ctrllimited="false"/>' for nm in WHEELS)
    Izz = v.Iyy + 0.9 * v.Ixx   # ASSUMPTION (yaw not excited: no yaw DOF)
    return f"""
<mujoco model="activeride">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="{dt}" integrator="implicitfast" gravity="0 0 {-G}">
    <flag contact="disable"/>
  </option>
  <visual>
    <global offwidth="1920" offheight="1080" fovy="40"/>
    <quality shadowsize="4096" offsamples="8"/>
    <headlight ambient="0.35 0.35 0.38" diffuse="0.55 0.55 0.55" specular="0.1 0.1 0.1"/>
    <map znear="0.02" zfar="400"/>
  </visual>
  <asset>
    <texture name="sky" type="skybox" builtin="gradient" rgb1="0.42 0.55 0.70" rgb2="0.09 0.11 0.15" width="256" height="256"/>
    <texture name="grass" type="2d" builtin="checker" rgb1="0.20 0.27 0.17" rgb2="0.18 0.25 0.15" width="512" height="512"/>
    <texture name="asph" type="2d" builtin="flat" rgb1="0.23 0.24 0.26" rgb2="0.22 0.23 0.25" mark="random" markrgb="0.3 0.3 0.32" random="0.08" width="512" height="512"/>
    <material name="ground" texture="grass" texrepeat="200 200" reflectance="0"/>
    <material name="asphalt" texture="asph" texrepeat="1 1" rgba="0.36 0.37 0.40 1" specular="0.1" reflectance="0"/>
    <material name="paint" rgba="{color}" specular="0.5" shininess="0.6" reflectance="0.05"/>
    <material name="glass" rgba="0.10 0.14 0.20 1" specular="0.9" shininess="0.9"/>
    <material name="trim" rgba="0.10 0.10 0.11 1"/>
    <material name="rubber" rgba="0.08 0.08 0.09 1" specular="0.1"/>
    <material name="rim" rgba="0.70 0.72 0.75 1" specular="0.7" shininess="0.8"/>
    <material name="spoke" rgba="0.45 0.47 0.50 1"/>
    <material name="lamp" rgba="1.0 0.95 0.75 1" emission="0.8"/>
    <material name="tail" rgba="0.9 0.08 0.06 1" emission="0.6"/>
    {''.join(assets)}
  </asset>
  <worldbody>
    <light name="sun" pos="0 0 40" dir="-0.3 0.25 -1" directional="true" castshadow="true" diffuse="0.8 0.78 0.72"/>
    <geom name="ground" type="plane" size="0 0 1" pos="0 0 -0.05" material="ground" contype="0" conaffinity="0"/>
    {road_geom}
    <body name="chassis" pos="0 0 {H_CG}">
      <joint name="x" type="slide" axis="1 0 0"/>
      <joint name="heave" type="slide" axis="0 0 1"/>
      <joint name="pitch" type="hinge" axis="0 1 0"/>
      <joint name="roll" type="hinge" axis="1 0 0"/>
      <inertial pos="0 0 0" mass="{v.ms:.3f}" diaginertia="{v.Ixx:.3f} {v.Iyy:.3f} {Izz:.3f}"/>
      <geom type="mesh" mesh="hull" material="paint" contype="0" conaffinity="0"/>
      <geom type="mesh" mesh="shoulder" material="paint" contype="0" conaffinity="0"/>
      <geom type="mesh" mesh="cabin" material="glass" contype="0" conaffinity="0"/>
      <geom type="box" size="0.04 0.78 0.04" pos="{v.a + 0.95:.3f} 0 -0.20" material="trim" contype="0" conaffinity="0"/>
      <geom type="box" size="0.02 0.18 0.035" pos="{v.a + 0.94:.3f} 0.62 0.05" material="lamp" contype="0" conaffinity="0"/>
      <geom type="box" size="0.02 0.18 0.035" pos="{v.a + 0.94:.3f} -0.62 0.05" material="lamp" contype="0" conaffinity="0"/>
      <geom type="box" size="0.02 0.20 0.035" pos="{-v.b - 0.95:.3f} 0.6 0.08" material="tail" contype="0" conaffinity="0"/>
      <geom type="box" size="0.02 0.20 0.035" pos="{-v.b - 0.95:.3f} -0.6 0.08" material="tail" contype="0" conaffinity="0"/>
      <site name="imu" pos="0 0 0" size="0.01"/>
      <site name="seat" pos="{v.seat_x:.3f} {v.seat_y:.3f} 0" size="0.01"/>
      <camera name="chase" mode="track" pos="-9.5 -3.2 2.9" xyaxes="0.32 -0.95 0 0.16 0.05 0.99"/>
      {tops}{accs}
      {''.join(wheels)}
    </body>
  </worldbody>
  <tendon>{tendons}</tendon>
  <actuator>{motors}</actuator>
  <sensor>{sens}</sensor>
</mujoco>"""


class MujocoCar:
    """MuJoCo plant. One call to step() advances one control period."""

    def __init__(self, cfg: Config, road: Road, speed: float, active=True, veh=None,
                 visual=False, color="0.86 0.30 0.16 1"):
        import mujoco
        self.mj = mujoco
        self.cfg = cfg
        self.veh = veh or cfg.vehicle
        self.road, self.V = road, speed
        self.xml = build_mjcf(cfg, road if visual else None, color=color, visual=visual, veh=self.veh)
        self.m = mujoco.MjModel.from_xml_string(self.xml)
        self.d = mujoco.MjData(self.m)
        self.dt_ctrl = cfg.control["dt"]
        self.nsub = int(round(self.dt_ctrl / self.m.opt.timestep))
        self.act = Actuator4(cfg.actuator, enabled=active)
        jid = lambda n: self.m.jnt_qposadr[mujoco.mj_name2id(self.m, mujoco.mjtObj.mjOBJ_JOINT, n)]
        did = lambda n: self.m.jnt_dofadr[mujoco.mj_name2id(self.m, mujoco.mjtObj.mjOBJ_JOINT, n)]
        self.qx, self.qz, self.qth, self.qph = (jid(n) for n in ("x", "heave", "pitch", "roll"))
        self.vx, self.vz, self.vth, self.vph = (did(n) for n in ("x", "heave", "pitch", "roll"))
        self.qs = np.array([jid(f"susp_{n}") for n in WHEELS])
        self.vs = np.array([did(f"susp_{n}") for n in WHEELS])
        self.qspin = np.array([jid(f"spin_{n}") for n in WHEELS])
        self.vspin = np.array([did(f"spin_{n}") for n in WHEELS])
        self.bw = np.array([mujoco.mj_name2id(self.m, mujoco.mjtObj.mjOBJ_BODY, f"wheel_{n}") for n in WHEELS])
        self.seat = mujoco.mj_name2id(self.m, mujoco.mjtObj.mjOBJ_SITE, "seat")
        self.imu = mujoco.mj_name2id(self.m, mujoco.mjtObj.mjOBJ_SITE, "imu")
        self.sadr = {self.m.sensor(i).name: (self.m.sensor_adr[i], self.m.sensor_dim[i]) for i in range(self.m.nsensor)}
        Wt = self.veh.static_tyre_loads()
        self.zwc0 = self.veh.R0 - Wt / self.veh.kt          # static wheel-centre heights
        self.x_start = 0.0
        self._vel6 = np.zeros(6)
        self.tyre_force = Wt.copy()
        self.reset()

    # ---- state -------------------------------------------------------------
    def reset(self, x0=None):
        self.mj.mj_resetData(self.m, self.d)
        self.x_start = self.veh.b + 1.0 if x0 is None else x0
        self.d.qpos[self.qx] = self.x_start
        self.d.qvel[self.vx] = self.V
        self.d.qvel[self.vspin] = self.V / self.veh.R0
        self.act.reset()
        self.t = 0.0
        self.mj.mj_forward(self.m, self.d)

    def wheel_world(self):
        """World x, z and vertical velocity of the wheel centres (after mj_step1)."""
        xs = self.d.xpos[self.bw]
        vz = np.empty(4)
        for k, b in enumerate(self.bw):
            self.mj.mj_objectVelocity(self.m, self.d, self.mj.mjtObj.mjOBJ_BODY, b, self._vel6, 0)
            vz[k] = self._vel6[5]
        return xs[:, 0], xs[:, 2], vz

    def _tyre(self):
        xw, zw, vzw = self.wheel_world()
        zr = self.road.height(WHEEL_SIDE, xw)
        zrd = self.road.slope(WHEEL_SIDE, xw) * self.V
        defl = self.veh.R0 - (zw - zr)          # tyre compression (m)
        F = self.veh.kt * defl + self.veh.ct * (zrd - vzw)
        if self.veh.liftoff:
            F = np.maximum(F, 0.0)
        return F, zr, zrd, zw, vzw

    def step(self, u_cmd):
        mj, m, d = self.mj, self.m, self.d
        h = m.opt.timestep
        for _ in range(self.nsub):
            d.qvel[self.vx] = self.V                      # constant forward speed
            d.qvel[self.vspin] = self.V / self.veh.R0     # cosmetic wheel spin
            mj.mj_step1(m, d)
            F, zr, zrd, zw, vzw = self._tyre()
            self.tyre_force, self.zr, self.zrd = F, zr, zrd
            d.xfrc_applied[self.bw, 2] = F
            d.ctrl[:] = self.act.step(u_cmd, h)
            mj.mj_step2(m, d)
        self.t += self.dt_ctrl

    # ---- measurements (noise-free; noise is added by the simulator) --------
    def measure(self):
        sd = self.d.sensordata
        acc = np.array([sd[self.sadr[f"acc_{n}"][0] + 2] for n in WHEELS]) - G
        gyro = sd[self.sadr["gyro"][0]:self.sadr["gyro"][0] + 3]
        stroke = -np.array([sd[self.sadr[f"stroke_{n}"][0]] for n in WHEELS])
        return {"acc": acc, "pitch_rate": gyro[1], "roll_rate": gyro[0], "stroke": stroke,
                "f_act": self.act.f.copy()}

    def truth(self):
        mj, m, d = self.mj, self.m, self.d
        acc6 = np.zeros(6)
        mj.mj_objectAcceleration(m, d, mj.mjtObj.mjOBJ_SITE, self.seat, acc6, 0)
        a_seat = acc6[5] - G
        mj.mj_objectAcceleration(m, d, mj.mjtObj.mjOBJ_SITE, self.imu, acc6, 0)
        a_cg = acc6[5] - G
        zw = d.xpos[self.bw, 2] - self.zwc0
        return {
            "x": d.qpos[self.qx], "zs": d.qpos[self.qz], "pitch": d.qpos[self.qth], "roll": d.qpos[self.qph],
            "zs_d": d.qvel[self.vz], "pitch_d": d.qvel[self.vth], "roll_d": d.qvel[self.vph],
            "pitch_acc": d.qacc[self.vth], "roll_acc": d.qacc[self.vph],
            "zu": zw, "stroke": -d.qpos[self.qs].copy(), "stroke_rate": -d.qvel[self.vs].copy(),
            "tyre_force": self.tyre_force.copy(), "zr": self.zr.copy(), "zrd": self.zrd.copy(),
            "f_act": self.act.f.copy(), "saturated": bool(self.act.saturated.any()),
            "acc_seat": a_seat, "acc_cg": a_cg,
        }

    def energy(self):
        """Mechanical energy relative to static equilibrium (J), for energy checks."""
        d, v = self.d, self.veh
        mj = self.mj
        mj.mj_forward(self.m, self.d)
        # kinetic energy of heave/pitch/roll/suspension motion (exclude forward speed and spin)
        qv = d.qvel.copy()
        qv[self.vx] = 0.0
        qv[self.vspin] = 0.0
        Mfull = np.zeros((self.m.nv, self.m.nv))
        mj.mj_fullM(self.m, Mfull, d.qM)
        T = 0.5 * qv @ Mfull @ qv
        # potential: gravity + suspension springs + tyre springs
        zcom = d.xipos[:, 2] * self.m.body_mass
        Ug = G * zcom.sum()
        q = d.qpos[self.qs]
        qref = self.m.qpos_spring[self.qs]
        Us = 0.5 * np.sum(v.ks * (q - qref) ** 2)
        xw, zw, _ = self.wheel_world()
        zr = self.road.height(WHEEL_SIDE, xw)
        defl = v.R0 - (zw - zr)
        Ut = 0.5 * np.sum(v.kt * defl ** 2)
        return T + Ug + Us + Ut


class LinearCar:
    """Analytical 7-DOF model as a plant (ZOH at the control rate)."""

    def __init__(self, cfg: Config, road: Road, speed: float, active=True, veh=None):
        self.cfg, self.veh = cfg, (veh or cfg.vehicle)
        self.road, self.V = road, speed
        self.car = build_full_car(self.veh)
        self.dt_ctrl = cfg.control["dt"]
        self.Ad, self.Bd = c2d(self.car.A, self.car.B, self.dt_ctrl)
        self.act = Actuator4(cfg.actuator, enabled=active)
        self.nsub = 4
        self.Mi = np.linalg.inv(self.car.M)
        self.reset()

    def reset(self, x0=None):
        self.x = np.zeros(14)
        self.x_start = self.veh.b + 1.0 if x0 is None else x0
        self.t = 0.0
        self.act.reset()
        self._inputs(np.zeros(4))

    def wheel_x(self, t):
        return self.x_start + self.V * t + self.veh.x

    def _inputs(self, fa, t=None):
        t = self.t if t is None else t
        xw = self.wheel_x(t)
        zr = self.road.height(WHEEL_SIDE, xw)
        zrd = self.road.slope(WHEEL_SIDE, xw) * self.V
        self.fa, self.zr, self.zrd = fa, zr, zrd
        return np.concatenate([fa, zr, zrd])

    def step(self, u_cmd):
        h = self.dt_ctrl / self.nsub
        fs = []
        for _ in range(self.nsub):
            fs.append(self.act.step(u_cmd, h).copy())
        fa = np.mean(fs, axis=0)
        w = self._inputs(fa, self.t + 0.5 * self.dt_ctrl)
        self.x = self.Ad @ self.x + self.Bd @ w
        self.t += self.dt_ctrl
        self._inputs(self.act.f.copy())

    def _qdd(self):
        c = self.car
        q, qd = self.x[:7], self.x[7:]
        rhs = -c.K @ q - c.C @ qd + c.Bu @ self.fa + c.Bz @ self.zr + c.Bzd @ self.zrd
        return self.Mi @ rhs

    def measure(self):
        qdd = self._qdd()
        S = self.car.S
        return {"acc": self.car.T @ qdd[:3], "pitch_rate": self.x[8], "roll_rate": self.x[9],
                "stroke": S @ self.x[:7], "f_act": self.act.f.copy()}

    def truth(self):
        qdd = self._qdd()
        c, v = self.car, self.veh
        q, qd = self.x[:7], self.x[7:]
        Ft = v.static_tyre_loads() + v.kt * (self.zr - q[3:]) + v.ct * (self.zrd - qd[3:])
        return {"x": self.x_start + self.V * self.t, "zs": q[0], "pitch": q[1], "roll": q[2],
                "zs_d": qd[0], "pitch_d": qd[1], "roll_d": qd[2], "pitch_acc": qdd[1], "roll_acc": qdd[2],
                "zu": q[3:].copy(), "stroke": c.S @ q, "stroke_rate": c.S @ qd, "tyre_force": Ft,
                "zr": self.zr.copy(), "zrd": self.zrd.copy(), "f_act": self.act.f.copy(),
                "saturated": bool(self.act.saturated.any()),
                "acc_seat": c.seat_row() @ qdd[:3], "acc_cg": qdd[0]}
