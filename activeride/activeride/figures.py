"""Publication-quality figures (PNG 200 dpi + PDF). Every figure is drawn from
logged simulation results, validation outputs or the measured data samples."""
from __future__ import annotations

import json

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from scipy.signal import welch  # noqa: E402

from .config import ROOT, load_config  # noqa: E402
from .controllers import CONTROLLER_LABELS  # noqa: E402
from .metrics import weighting_response  # noqa: E402
from .road import displacement_psd, iri, load_lira_sample, preprocess_measured, road_for_scenario  # noqa: E402

FIG = ROOT / "figures"
RES = ROOT / "results"
# validated categorical slots 1-4 (dataviz reference palette, light mode)
COL = {"passive": "#2a78d6", "skyhook": "#eb6834", "lqr": "#1baf7a", "preview": "#eda100"}
LS = {"passive": "-", "skyhook": "--", "lqr": "-.", "preview": "-"}
CTRL = ["passive", "skyhook", "lqr", "preview"]
INK, INK2, GRID = "#0b0b0b", "#52514e", "#e4e3df"

plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 9, "axes.titlesize": 10, "axes.labelsize": 9,
    "axes.edgecolor": INK2, "axes.labelcolor": INK, "xtick.color": INK2, "ytick.color": INK2,
    "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.6, "axes.spines.top": False,
    "axes.spines.right": False, "legend.frameon": False, "lines.linewidth": 1.4,
    "savefig.dpi": 200, "savefig.bbox": "tight", "figure.dpi": 100})


def _save(fig, name):
    FIG.mkdir(exist_ok=True)
    fig.savefig(FIG / f"{name}.png")
    fig.savefig(FIG / f"{name}.pdf")
    plt.close(fig)


def _tag(ax, text):
    ax.text(0.99, 0.97, text, transform=ax.transAxes, ha="right", va="top", fontsize=7.5, color=INK2,
            bbox=dict(boxstyle="round,pad=0.25", fc="white", ec=GRID))


# ---------------------------------------------------------------------------
def fig_roads():
    fig, axs = plt.subplots(2, 2, figsize=(10, 6.2))
    for k, s in enumerate("ABC"):
        d = load_lira_sample(s)
        x, z = preprocess_measured(d["chainage_m"], d["left_mm"], d["right_mm"])
        ax = axs[0, 0] if k == 0 else None
        if k == 0:
            ax.plot(d["chainage_m"][0] + x, z[0] * 1e3, color=COL["passive"], lw=0.8, label="left wheel path")
            ax.plot(d["chainage_m"][0] + x, z[1] * 1e3 - 25, color=COL["skyhook"], lw=0.8,
                    label="right wheel path (offset −25 mm)")
            ax.set_xlabel("chainage [m]"); ax.set_ylabel("elevation (line removed) [mm]")
            ax.set_title("Measured profile, M13 section A")
            ax.legend(loc="lower left", fontsize=7.5)
            _tag(ax, "MEASURED · LiRA-CD P79")
        for side, ls in ((0, "-"), (1, "--")):
            n, G = displacement_psd(x, z[side])
            axs[0, 1].loglog(n, G, ls=ls, lw=1.0, color=list(COL.values())[k],
                             label=f"section {s} {'left' if side == 0 else 'right'} (IRI {iri(x, z[side]):.2f} m/km)")
    nn = np.logspace(-2, 1, 50)
    for cls, g0 in (("A/B", 32e-6), ("B/C", 128e-6), ("C/D", 512e-6)):
        axs[0, 1].loglog(nn, g0 * (nn / 0.1) ** -2, color=INK2, lw=0.6, ls=":")
        axs[0, 1].text(0.012, g0 * (0.012 / 0.1) ** -2 * 1.3, f"ISO 8608 {cls}", fontsize=6.5, color=INK2)
    axs[0, 1].set_xlim(0.01, 5); axs[0, 1].set_ylim(1e-11, 1e-1)
    axs[0, 1].set_xlabel("spatial frequency n [cycles/m]"); axs[0, 1].set_ylabel("G_d(n) [m³]")
    axs[0, 1].set_title("Displacement PSD of measured wheel paths")
    axs[0, 1].legend(fontsize=6.5, loc="lower left", ncol=1)
    _tag(axs[0, 1], "MEASURED")
    cfg = load_config()
    for sid, ax in (("m13_A", axs[1, 0]), ("speed_bump", axs[1, 1])):
        sc = cfg.scenario(sid)
        r = road_for_scenario(sc, cfg.vehicle.envelope_m)
        m = slice(None) if sc["kind"] == "synthetic" else (r.x < 60)
        ax.plot(r.x[m], r.z_raw[0][m] * 1e3, color=INK2, lw=0.8, label="before enveloping")
        ax.plot(r.x[m], r.z[0][m] * 1e3, color=COL["passive"], lw=1.3, label="tyre-enveloped input (0.25 m)")
        ax.set_xlabel("distance along simulated run [m]"); ax.set_ylabel("left path height [mm]")
        if sc["kind"] == "synthetic":
            for o in ("pothole", "one_sided_bump"):
                rr = road_for_scenario(cfg.scenario(o), cfg.vehicle.envelope_m)
                side = 0 if cfg.scenario(o)["side"] == "left" else 1
                ax.plot(rr.x, rr.z[side] * 1e3, lw=1.1, ls="--",
                        color=COL["skyhook" if o == "pothole" else "lqr"], label=cfg.scenario(o)["label"].replace("SYNTHETIC ", ""))
            ax.set_title("Synthetic obstacles (not measured)")
            ax.set_xlim(24, 32)
            _tag(ax, "SYNTHETIC")
        else:
            ax.set_title("Simulation input: flat lead-in, taper, measured profile")
            _tag(ax, "MEASURED input")
        ax.legend(fontsize=7, loc="lower right" if sc["kind"] == "synthetic" else "lower left")
    fig.tight_layout()
    _save(fig, "fig1_road_inputs")


def fig_validation(val):
    fig, axs = plt.subplots(1, 3, figsize=(12, 3.6))
    nf = val["natural_frequencies"]
    labels = ["heave", "pitch", "roll", "hop 1", "hop 2", "hop 3", "hop 4"]
    an = np.array(nf["realistic"]["undamped"]["analytical_hz"])
    mr = np.array(nf["realistic"]["undamped"]["mujoco_hz"])
    mm = np.array(nf["geometry_matched"]["undamped"]["mujoco_hz"])
    ax = axs[0]
    ax.axhline(0, color=INK2, lw=0.6)
    xx = np.arange(7)
    ax.bar(xx - 0.2, 100 * (mm - an) / an, 0.38, color=COL["passive"], label="MuJoCo, geometry matched")
    ax.bar(xx + 0.2, 100 * (mr - an) / an, 0.38, color=COL["skyhook"], label="MuJoCo, realistic geometry")
    ax.set_xticks(xx, labels, fontsize=7.5)
    ax.set_ylabel("natural frequency error vs 7-DOF [%]")
    ax.set_title("Undamped natural frequencies")
    ax.legend(fontsize=7, loc="lower left")
    for i, f in enumerate(an):
        ax.text(i, 0.4, f"{f:.2f} Hz", ha="center", fontsize=6.5, color=INK2, rotation=90)
    ax.set_ylim(-5, 2.5)
    ax.text(0.02, 0.62, f"geometry matched: max |error| {100 * np.max(np.abs(mm - an) / an):.3f} %\n"
            "(bars too small to see)", transform=ax.transAxes, fontsize=7, color=INK2)
    # FRF
    from .validation import analytical_frf
    cfg = load_config()
    f = np.logspace(np.log10(0.3), np.log10(30), 300)
    H = analytical_frf(cfg, f, 0)
    ax = axs[1]
    names = ["heave acc. [m/s² per m]", "pitch acc. [rad/s² per m]", "roll acc. [rad/s² per m]"]
    for j, c in enumerate(["passive", "skyhook", "lqr"]):
        ax.loglog(f, np.abs(H[:, j]), color=COL[c], lw=1.2, label=f"7-DOF: {names[j]}")
        pts = val["frequency_response"]["points"]
        ax.loglog([p["f_hz"] for p in pts], [p["mujoco_mag"][j] for p in pts], "o", ms=5, mfc="white",
                  mec=COL[c], mew=1.4)
    ax.plot([], [], "o", mfc="white", mec=INK2, label="MuJoCo sine-dwell")
    ax.set_xlabel("frequency [Hz]"); ax.set_title("FL road input → body accelerations (passive)")
    ax.legend(fontsize=6.5, loc="lower right")
    # time domain MuJoCo vs linear
    ax = axs[2]
    L = val["_mvl_logs"]
    t = L["mujoco"]["passive"]["t"]
    m = (t > 2) & (t < 6)
    ax.plot(t[m], 1e3 * L["linear"]["passive"]["zs"][m], color=COL["passive"], lw=2.2, alpha=0.55, label="7-DOF heave")
    ax.plot(t[m], 1e3 * L["mujoco"]["passive"]["zs"][m], color=INK, lw=0.8, label="MuJoCo heave")
    ax.plot(t[m], 1e3 * L["linear"]["passive"]["stroke"][m, 0], color=COL["skyhook"], lw=2.2, alpha=0.55, label="7-DOF FL stroke")
    ax.plot(t[m], 1e3 * L["mujoco"]["passive"]["stroke"][m, 0], color=INK, lw=0.8, ls="--", label="MuJoCo FL stroke")
    ax.set_xlabel("time [s]"); ax.set_ylabel("[mm]")
    nr = val["mujoco_vs_linear"]["passive"]
    ax.set_title(f"Measured road A, passive: NRMS diff heave {100 * nr['zs']:.1f}%, stroke {100 * nr['stroke']:.1f}%",
                 fontsize=8.5)
    ax.legend(fontsize=6.5, ncol=2, loc="lower left")
    fig.tight_layout()
    _save(fig, "fig2_validation")


def fig_wk():
    f = np.logspace(-1, 2.1, 400)
    fig, ax = plt.subplots(figsize=(5, 3.2))
    for n, c in (("Wk", "passive"), ("We", "skyhook")):
        ax.semilogx(f, 20 * np.log10(np.abs(weighting_response(f, n))), color=COL[c], label=n)
    tab = {0.5: 418, 1.0: 482, 2.0: 531, 4.0: 967, 6.3: 1054, 8.0: 1036, 12.5: 902, 20.0: 636, 31.5: 405, 63.0: 186}
    ax.semilogx(list(tab), [20 * np.log10(v / 1000) for v in tab.values()], "o", ms=5, mfc="white",
                mec=INK, label="ISO 2631-1 Table 3 (Wk)")
    ax.set_xlabel("frequency [Hz]"); ax.set_ylabel("gain [dB]"); ax.set_ylim(-40, 3)
    ax.set_title("Frequency weightings used for comfort metrics"); ax.legend(fontsize=7.5)
    _save(fig, "fig8_iso_weighting")


def _runs(sid):
    from .experiments import load_run
    return {c: load_run(sid, c) for c in CTRL}


def fig_time(sid="m13_A", t0=6.0, t1=11.0, name="fig3_time_histories_measured"):
    cfg = load_config()
    R = _runs(sid)
    rows = [("acc_seat", None, "seat vertical acc. [m/s²]", 1), ("pitch", None, "pitch [mrad]", 1e3),
            ("roll", None, "roll [mrad]", 1e3), ("stroke", 0, "FL stroke [mm]", 1e3),
            ("tyre_force", 0, "FL tyre load [kN]", 1e-3), ("f_act", 0, "FL actuator force [kN]", 1e-3)]
    fig, axs = plt.subplots(len(rows), 1, figsize=(8.5, 9), sharex=True)
    for ax, (k, i, lab, sc) in zip(axs, rows):
        for c in CTRL:
            L = R[c]
            m = (L["t"] >= t0) & (L["t"] <= t1)
            y = L[k][m] if i is None else L[k][m, i]
            if c == "passive" and k == "f_act":
                continue
            ax.plot(L["t"][m], y * sc, color=COL[c], ls=LS[c], lw=1.0 if c != "passive" else 1.4,
                    label=CONTROLLER_LABELS[c])
        ax.set_ylabel(lab, fontsize=8)
    axs[0].legend(ncol=4, fontsize=7.5, loc="upper left", bbox_to_anchor=(0, 1.35))
    axs[-1].set_xlabel("time [s]")
    sc = cfg.scenario(sid)
    fig.suptitle(f"{sc['label']} at {sc['speed_kmh']:.0f} km/h — SIMULATED response to {sc['kind'].upper()} road",
                 y=1.0, fontsize=10)
    fig.tight_layout()
    _save(fig, name)


def fig_psd(sid="m13_A"):
    R = _runs(sid)
    fig, ax = plt.subplots(figsize=(6, 3.6))
    for c in CTRL:
        L = R[c]
        fs = 1 / (L["t"][1] - L["t"][0])
        m = L["t"] > 1
        f, P = welch(L["acc_seat"][m], fs=fs, nperseg=int(fs * 4))
        ax.loglog(f[1:], P[1:], color=COL[c], ls=LS[c], label=CONTROLLER_LABELS[c])
    ax.set_xlim(0.3, 80); ax.set_xlabel("frequency [Hz]"); ax.set_ylabel("seat acc. PSD [(m/s²)²/Hz]")
    ax2 = ax.twinx(); ax2.grid(False)
    ff = np.logspace(np.log10(0.3), np.log10(80), 200)
    ax2.semilogx(ff, np.abs(weighting_response(ff, "Wk")), color=INK2, lw=0.8, ls=":")
    ax2.set_ylim(0, 3); ax2.set_yticks([]); ax2.spines["right"].set_visible(False)
    ax2.text(5.5, 1.12, "Wk weighting (shape)", fontsize=7, color=INK2)
    ax.set_title("Seat acceleration spectrum, measured road A, 90 km/h (simulated)")
    ax.legend(fontsize=7.5, loc="lower left")
    _save(fig, "fig4_seat_psd")


def fig_metrics(res):
    cfg = load_config()
    keys = [("aw_seat", "seat a_w"), ("pitch_acc_w_rms", "pitch acc."), ("roll_acc_w_rms", "roll acc."),
            ("travel_rms_mm", "travel RMS"), ("tyre_dlc", "tyre DLC")]
    sids = [s["id"] for s in cfg.scenarios]
    fig, axs = plt.subplots(2, 3, figsize=(12, 6.2), sharey=True)
    for ax, sid in zip(axs.ravel(), sids):
        r = res[sid]
        xx = np.arange(len(keys))
        for j, c in enumerate(CTRL[1:]):
            vals = []
            for k, _ in keys:
                b = r["passive"][k]
                vals.append(100 * (r[c][k] / b - 1) if b > 1e-9 else np.nan)
            ax.bar(xx + (j - 1) * 0.27, vals, 0.25, color=COL[c], label=CONTROLLER_LABELS[c])
        ax.axhline(0, color=INK, lw=0.8)
        ax.set_xticks(xx, [k[1] for k in keys], fontsize=7.5, rotation=20)
        sc = cfg.scenario(sid)
        ax.set_title(f"{sc['label']}".replace("Motorway ", "").replace("SYNTHETIC ", "")[:46], fontsize=8.5)
        _tag(ax, sc["kind"].upper())
        ax.set_ylim(-80, 150)
    axs[0, 0].set_ylabel("change vs passive [%]"); axs[1, 0].set_ylabel("change vs passive [%]")
    axs[0, 0].legend(fontsize=7.5, loc="upper left")
    fig.suptitle("Simulated performance relative to the passive car (negative = better; values clipped to [−80, 150] %)",
                 fontsize=10)
    fig.tight_layout()
    _save(fig, "fig5_metrics_vs_passive")


def fig_montecarlo():
    mc = json.loads((RES / "montecarlo.json").read_text())
    fig, axs = plt.subplots(1, 4, figsize=(15, 3.6))
    rng = np.random.default_rng(0)
    for ax, (k, lab) in zip(axs[:2], (("aw_seat", "seat a_w [m/s²]"), ("tyre_dlc", "tyre DLC [-]"))):
        for j, c in enumerate(CTRL):
            v = np.array([r["metrics"][c][k] for r in mc])
            ax.scatter(j + rng.uniform(-0.18, 0.18, len(v)), v, s=10, color=COL[c], alpha=0.75, lw=0)
            q = np.percentile(v, [5, 50, 95])
            ax.plot([j - 0.3, j + 0.3], [q[1]] * 2, color=INK, lw=1.6)
            ax.plot([j, j], [q[0], q[2]], color=INK, lw=0.8)
        ax.set_xticks(range(4), [CONTROLLER_LABELS[c] for c in CTRL], fontsize=8)
        ax.set_ylabel(lab)
    axs[0].set_title(f"Monte Carlo, N = {len(mc)} plants (bar: median, line: 5–95 %)", fontsize=9)
    axs[1].set_title("Tyre load variation", fontsize=9)
    ax = axs[2]
    for c in CTRL[1:]:
        x = np.array([r["params"]["mass_factor"] for r in mc])
        y = np.array([r["metrics"][c]["aw_seat"] / r["metrics"]["passive"]["aw_seat"] for r in mc])
        ax.scatter(x, y, s=12, color=COL[c], label=CONTROLLER_LABELS[c], lw=0)
    ax.axhline(1, color=INK, lw=0.8)
    ax.set_xlabel("sprung-mass factor (plant / design)"); ax.set_ylabel("a_w ratio vs passive (same plant)")
    ax.set_title("Robustness to mass error", fontsize=9); ax.legend(fontsize=7.5)
    ax = axs[3]
    for c in CTRL[1:]:
        x = np.array([r["params"]["noise_scale"] for r in mc])
        y = np.array([r["metrics"][c]["aw_seat"] / r["metrics"]["passive"]["aw_seat"] for r in mc])
        ax.scatter(x, y, s=12, color=COL[c], label=CONTROLLER_LABELS[c], lw=0)
    ax.axhline(1, color=INK, lw=0.8)
    ax.set_xlabel("sensor-noise multiplier (all sensors incl. preview)")
    ax.set_title("Robustness to sensor noise", fontsize=9)
    fig.tight_layout()
    _save(fig, "fig6_montecarlo")


def fig_preview_sensitivity(sens):
    fig, ax = plt.subplots(figsize=(6.5, 3.4))
    labels = list(sens["cases"])
    scen = sens["scenarios"]
    xx = np.arange(len(labels))
    for j, sid in enumerate(scen):
        vals = [sens["cases"][lab][sid]["aw_seat"] for lab in labels]
        ax.bar(xx + (j - 0.5) * 0.38, vals, 0.36, color=list(COL.values())[j], label=sid)
        ax.axhline(sens["lqr"][sid], color=list(COL.values())[j], lw=0.9, ls="--")
    ax.set_xticks(xx, labels, fontsize=7.5)
    ax.set_ylabel("seat a_w [m/s²]")
    ax.set_title("Preview LQR vs look-ahead sensor quality (dashed: LQR without preview)", fontsize=9)
    ax.legend(fontsize=7.5)
    _save(fig, "fig7_preview_sensitivity")
