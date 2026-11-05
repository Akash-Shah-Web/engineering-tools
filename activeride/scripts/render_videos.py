#!/usr/bin/env python3
"""Render side-by-side MP4s (passive vs active) with MuJoCo offscreen rendering,
a chase camera and an overlaid live plot. Every frame is produced from the
simulated state (qpos) of the same closed-loop runs as the reported results.

Needs an OpenGL context. Headless Linux:   xvfb-run -a python scripts/render_videos.py
(or MUJOCO_GL=egl / osmesa where those libraries are installed).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from activeride.config import load_config  # noqa: E402
from activeride.controllers import CONTROLLER_LABELS, make_controllers  # noqa: E402
from activeride.metrics import weight_signal  # noqa: E402
from activeride.plants import MujocoCar  # noqa: E402
from activeride.road import road_for_scenario  # noqa: E402
from activeride.sim import PreviewSensor, run, scenario_duration  # noqa: E402

FPS = 30
W, H, PH = 640, 400, 224            # per-car view size, plot strip height
OUT = ROOT / "videos"
VIDEOS = [("m13_A", "passive", "preview", 16.0), ("speed_bump", "passive", "preview", None),
          ("one_sided_bump", "passive", "lqr", None)]
COLORS = {"passive": "0.20 0.45 0.85 1", "skyhook": "0.92 0.41 0.20 1", "lqr": "0.11 0.69 0.48 1",
          "preview": "0.93 0.63 0.0 1"}
RGB = {"passive": (42, 120, 214), "skyhook": (235, 104, 52), "lqr": (27, 175, 122), "preview": (237, 161, 0)}


def _font(sz):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, sz)
    return ImageFont.load_default()


def simulate(cfg, sid, ctrl, duration):
    sc = cfg.scenario(sid)
    V = sc["speed_kmh"] / 3.6
    road = road_for_scenario(sc, cfg.vehicle.envelope_m)
    dur = duration or scenario_duration(cfg, road, V)
    c = make_controllers(cfg, V)[ctrl]
    seed = cfg.sim["seed"]
    prev = PreviewSensor(road, cfg.sensors["preview_height_std"], cfg.sensors["preview_smoothing_m"],
                         np.random.default_rng(seed + 1))
    plant = MujocoCar(cfg, road, V, active=ctrl != "passive", visual=True, color=COLORS[ctrl])
    frames = []
    nxt = [0.0]

    def cb(p, tr):
        if p.t + 1e-9 >= nxt[0]:
            frames.append(p.d.qpos.copy())
            nxt[0] += 1.0 / FPS
    log = run(plant, c, dur, cfg, np.random.default_rng(seed), preview=prev, callback=cb)
    return plant, frames, log, sc


def draw_plot(img, logs, names, t_now, t_end, sc):
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = 60, H + 30, 2 * W - 20, H + PH - 30
    d.rectangle([0, H, 2 * W, H + PH], fill=(16, 19, 24))
    ymax = max(np.max(np.abs(l["acc_seat"])) for l in logs) * 1.05
    d.line([x0, (y0 + y1) / 2, x1, (y0 + y1) / 2], fill=(60, 66, 76))
    for k, (l, n) in enumerate(zip(logs, names)):
        m = l["t"] <= t_now
        t, a = l["t"][m], l["acc_seat"][m]
        if len(t) < 2:
            continue
        step = max(1, len(t) // 1500)
        px = x0 + (t[::step] / t_end) * (x1 - x0)
        py = (y0 + y1) / 2 - a[::step] / ymax * (y1 - y0) / 2
        d.line(list(zip(px, py)), fill=RGB[n], width=2)
        fs = 1 / (l["t"][1] - l["t"][0])
        aw = weight_signal(l["acc_seat"], fs, "Wk")
        win = int(fs)
        i = int(np.searchsorted(l["t"], t_now))
        aw_now = np.sqrt(np.mean(aw[max(0, i - win):i + 1] ** 2))
        d.text((x0 + 10 + k * 620, H + 6), f"{CONTROLLER_LABELS[n]}:  running a_w (Wk, 1 s) = {aw_now:.3f} m/s²",
               fill=RGB[n], font=_font(14))
    d.text((8, (y0 + y1) / 2 - 8), f"±{ymax:.1f}", fill=(150, 156, 166), font=_font(11))
    d.text((x0, y1 + 6), f"seat vertical acceleration [m/s²] vs time (0–{t_end:.0f} s)   ·   SIMULATED (MuJoCo)   ·   "
           f"road: {sc['kind'].upper()}", fill=(150, 156, 166), font=_font(12))
    xn = x0 + t_now / t_end * (x1 - x0)
    d.line([xn, y0, xn, y1], fill=(200, 200, 200), width=1)


def main():
    import imageio.v2 as imageio
    import mujoco
    cfg = load_config()
    OUT.mkdir(exist_ok=True)
    made = []
    for sid, ca, cb_, dur in VIDEOS:
        print(f"simulating {sid}: {ca} vs {cb_}", flush=True)
        pa, fa, la, sc = simulate(cfg, sid, ca, dur)
        pb, fb, lb, _ = simulate(cfg, sid, cb_, dur)
        n = min(len(fa), len(fb))
        # one model/renderer for both cars (identical geometry); only the paint colour is swapped
        m, d = pa.m, pa.d
        rend = mujoco.Renderer(m, H, W)
        cam = mujoco.MjvCamera()
        mujoco.mjv_defaultCamera(cam)
        cam.type = mujoco.mjtCamera.mjCAMERA_TRACKING
        cam.trackbodyid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, "chassis")
        cam.distance, cam.azimuth, cam.elevation = 8.0, 25.0, -13.0
        paint = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_MATERIAL, "paint")
        path = OUT / f"{sid}_{ca}_vs_{cb_}.mp4"
        wr = imageio.get_writer(path, fps=FPS, codec="libx264", quality=None, macro_block_size=8,
                                pixelformat="yuv420p", ffmpeg_params=["-crf", "23", "-preset", "slow"])
        t_end = n / FPS
        for k in range(n):
            img = Image.new("RGB", (2 * W, H + PH))
            for j, (fr, nm) in enumerate(((fa, ca), (fb, cb_))):
                d.qpos[:] = fr[k]
                mujoco.mj_forward(m, d)
                m.mat_rgba[paint] = [float(v) for v in COLORS[nm].split()]
                rend.update_scene(d, camera=cam)
                im = Image.fromarray(rend.render())
                dd = ImageDraw.Draw(im)
                dd.rectangle([0, 0, W, 30], fill=(16, 19, 24))
                dd.text((10, 6), CONTROLLER_LABELS[nm].upper(), fill=RGB[nm], font=_font(16))
                dd.text((W - 250, 8), "SIMULATION · not a real car", fill=(170, 175, 185), font=_font(12))
                img.paste(im, (j * W, 0))
            dr = ImageDraw.Draw(img)
            dr.line([W, 0, W, H], fill=(16, 19, 24), width=3)
            dr.text((10, H - 22), f"{sc['label']} · {sc['speed_kmh']:.0f} km/h · t = {k / FPS:5.2f} s · true vertical scale",
                    fill=(235, 235, 235), font=_font(13))
            draw_plot(img, [la, lb], [ca, cb_], k / FPS, t_end, sc)
            wr.append_data(np.asarray(img))
        wr.close()
        rend.close()   # a new Renderer per video otherwise corrupts the shared GL context
        made.append(path)
        print("  wrote", path, f"{path.stat().st_size / 1e6:.1f} MB", flush=True)
    return made


if __name__ == "__main__":
    main()
