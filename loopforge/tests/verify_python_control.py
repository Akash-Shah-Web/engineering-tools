#!/usr/bin/env python3
"""Cross-check LoopForge's JavaScript maths against python-control / SciPy.

Independent re-implementations here (not ports of the JS code paths):
  * model fit: continuous-time simulation with control.forced_response on a fine
    grid, optimised with scipy.optimize.least_squares from a different start;
  * tuning: formulas re-typed from Skogestad (2003), Grimholt & Skogestad (2018),
    Rivera et al. (1986);
  * sampled plant: control.c2d (ZOH) for integer delays, and continuous
    simulation at sample instants for fractional delays;
  * margins / poles: control.stability_margins, control.feedback(...).poles()
    on a controller transfer function built here from Kc, Ti, Td, N, Ts;
  * continuous margins: python-control with a 12th-order Padé delay;
  * nonlinear closed loop (saturation + anti-windup): own simulation using
    scipy.linalg.expm for the sampled plant.

Usage: python3 tests/verify_python_control.py   (needs node, numpy, scipy, control)
Writes tests/python_control_report.json and exits non-zero on any failure.
"""
import json, math, pathlib, subprocess, sys
import numpy as np
import scipy.linalg, scipy.optimize
import control

HERE = pathlib.Path(__file__).resolve().parent
ref = json.loads(subprocess.check_output(["node", str(HERE / "dump_reference.js")]),
                 parse_constant=float)
fix = lambda v: float(v) if not isinstance(v, str) else {"inf": math.inf, "-inf": -math.inf, "nan": math.nan}[v]

results, failures = [], []


def check(name, ok, **info):
    results.append({"check": name, "ok": bool(ok), **info})
    if not ok:
        failures.append(name)
    print(("PASS " if ok else "FAIL ") + name + "  " + ", ".join(f"{k}={v}" for k, v in info.items()))


def tf_cont(m):
    t2 = m.get("tau2", 0) or 0
    den = np.polymul([m["tau1"], 1], [t2, 1]) if t2 > 0 else [m["tau1"], 1]
    return control.tf([m["K"]], den)


# ------------------------------------------------------------------ fits
def load_csv(name):
    a = np.genfromtxt(HERE.parent / "data" / "samples" / name, delimiter=",", names=True)
    return a["Time"], a["Q1"], a["T1"]


def sim_fine(m, t, u, upre, h=0.05):
    """Continuous model, delayed ZOH input, via control.forced_response on a fine grid."""
    tf = np.arange(t[0], t[-1] + h / 2, h)
    idx = np.searchsorted(t, tf - m["theta"], side="right") - 1
    ud = np.where(idx >= 0, u[np.clip(idx, 0, None)], upre) - upre
    resp = control.forced_response(tf_cont(m), T=tf, U=ud)
    return np.interp(t, tf, resp.outputs)


for fit in ref["fits"]:
    t, u, y = load_csv(fit["file"])
    m = fit["model"]
    yhat = m["y0"] + sim_fine(m, t, u, 0.0)
    sse_py = float(np.sum((y - yhat) ** 2))
    check(f"fit {fit['type']}: SSE at JS optimum reproduced by python-control", abs(sse_py - fit["sse"]) / fit["sse"] < 0.01,
          sse_js=round(fit["sse"], 4), sse_py=round(sse_py, 4))

    sopdt = fit["type"] == "SOPDT"
    def resid(p):
        mm = {"K": p[0], "tau1": p[1], "tau2": p[2] if sopdt else 0, "theta": p[-2]}
        return y - (p[-1] + sim_fine(mm, t, u, 0.0, h=0.1))
    lb = [-10, 1, 0.1, 0, 0] if sopdt else [-10, 1, 0, 0]
    ub = [10, 2000, 200, 200, 100] if sopdt else [10, 2000, 200, 100]
    sol = None
    for th0 in (0.5, 5.0, 15.0, 30.0):              # own multi-start, independent of the JS grid
        x0 = [1.0, 100.0, 5.0, th0, 22.0] if sopdt else [1.0, 100.0, th0, 22.0]
        r_ = scipy.optimize.least_squares(resid, x0, bounds=(lb, ub), x_scale="jac", diff_step=1e-2)
        if sol is None or r_.cost < sol.cost:
            sol = r_
    sse_opt = float(np.sum(resid(sol.x) ** 2))
    names = ["K", "tau1", "tau2", "theta", "y0"] if sopdt else ["K", "tau1", "theta", "y0"]
    py = dict(zip(names, sol.x))
    rel = {k: abs(py[k] - m[k]) / max(abs(m[k]), 1e-9) for k in ["K", "tau1"]}
    check(f"fit {fit['type']}: scipy least_squares optimum agrees with JS (K, tau1 within 1 %)",
          rel["K"] < 0.01 and rel["tau1"] < 0.01,
          js={k: round(m[k], 4) for k in names}, py={k: round(v, 4) for k, v in py.items()})
    check(f"fit {fit['type']}: JS SSE not worse than scipy optimum (+1 %)", fit["sse"] <= sse_opt * 1.01 + 1e-9,
          sse_js=round(fit["sse"], 4), sse_scipy=round(sse_opt, 4))


# ------------------------------------------------------------------ tuning
def tune_py(m, method, typ, tc):
    K, th, t1, t2 = m["K"], m["theta"], m["tau1"], m.get("tau2", 0) or 0
    sop = t2 > 0
    def ser2ideal(kc, ti, td):
        f = 1 + td / ti
        return kc * f, ti * f, td / f
    if method == "SIMC":
        if typ == "PI":
            tau, the = (t1 + t2 / 2, th + t2 / 2) if sop else (t1, th)
            return tau / (K * (tc + the)), min(tau, 4 * (tc + the)), 0.0
        if sop:
            return ser2ideal(t1 / (K * (tc + th)), min(t1, 4 * (tc + th)), t2)
        tau = t1 + th / 3
        return ser2ideal(tau / (K * (tc + th)), min(tau, 4 * (tc + th)), th / 3)
    if typ == "PI":
        tau, the = (t1 + t2 / 2, th + t2 / 2) if sop else (t1, th)
        return tau / (K * (tc + the)), tau, 0.0
    if sop:
        return (t1 + t2) / (K * (tc + th)), t1 + t2, t1 * t2 / (t1 + t2)
    return (t1 + th / 2) / (K * (tc + th / 2)), t1 + th / 2, t1 * th / (2 * t1 + th)


worst = 0.0
for c in ref["tuning"]:
    kc, ti, td = tune_py(c["model"], c["method"], c["type"], c["tauC"])
    r = c["result"]
    worst = max(worst, abs(kc - r["Kc"]) / abs(kc), abs(ti - r["Ti"]) / ti, abs(td - r["Td"]) / max(td, 1e-12) if td else abs(r["Td"]))
check(f"tuning: {len(ref['tuning'])} SIMC/lambda cases match re-typed formulas", worst < 1e-12, max_rel_err=worst)


# ------------------------------------------------------------------ sampled plant
def freq(sysd, w):
    return np.array([complex(sysd(np.exp(1j * wi * sysd.dt))) for wi in w])


for p in ref["plants"]:
    m, Ts, d = p["model"], p["Ts"], p["d"]
    Gjs = control.tf(p["num"], p["den"], Ts)
    if p["thetaFrac"] == 0:
        Gpy = control.c2d(tf_cont(m), Ts, "zoh") * control.tf([1], [1] + [0] * d, Ts)
        w = np.logspace(-4, math.log10(math.pi / Ts * 0.999), 200)
        err = np.max(np.abs(freq(Gjs, w) - freq(Gpy, w)) / np.maximum(np.abs(freq(Gpy, w)), 1e-12))
        check(f"plant c2d {m['type']} theta={m['theta']:.3g} Ts={Ts}: JS G(z) == control.c2d(zoh)*z^-d", err < 1e-9, rel_err=float(err))
    n = int(round(20 * max(m["tau1"], Ts) / Ts))
    k = np.arange(n)
    yjs = control.forced_response(Gjs, T=k * Ts, U=np.ones(n)).outputs
    # exact continuous step response with delay at sample instants (impulse-invariant check)
    tt = k * Ts - m["theta"]
    t2 = m.get("tau2", 0) or 0
    if t2 > 0:
        t1 = m["tau1"]
        yc = np.where(tt > 0, m["K"] * (1 - (t1 * np.exp(-tt / t1) - t2 * np.exp(-tt / t2)) / (t1 - t2)), 0)
    else:
        yc = np.where(tt > 0, m["K"] * (1 - np.exp(-tt / m["tau1"])), 0)
    err = float(np.max(np.abs(yjs - yc)) / abs(m["K"]))
    check(f"plant step {m['type']} theta={m['theta']:.3g} Ts={Ts} (frac {p['thetaFrac']:.3g}): sampled response exact", err < 1e-9, err=err)


def sampled_plant_expm(m, Ts):
    t2 = m.get("tau2", 0) or 0
    if t2 > 0:
        A = np.array([[-1 / m["tau1"], 0], [1 / t2, -1 / t2]]); B = np.array([[m["K"] / m["tau1"]], [0]]); Cm = np.array([0, 1])
    else:
        A = np.array([[-1 / m["tau1"]]]); B = np.array([[m["K"] / m["tau1"]]]); Cm = np.array([1])
    n = A.shape[0]
    def zoh(h):
        M = np.zeros((n + 1, n + 1)); M[:n, :n] = A; M[:n, n:] = B
        E = scipy.linalg.expm(M * h)
        return E[:n, :n], E[:n, n:]
    d = int(math.floor(m["theta"] / Ts + 1e-12)); thf = m["theta"] - d * Ts
    Phi, _ = zoh(Ts); Pr, G0 = zoh(Ts - thf); _, Gf = zoh(thf)
    return Phi, G0[:, 0], (Pr @ Gf)[:, 0], Cm, d


def plant_ss_py(m, Ts):
    """Sampled plant as a state-space system with an explicit input delay line."""
    Phi, G0, G1, Cm, d = sampled_plant_expm(m, Ts)
    nx = Phi.shape[0]
    na = nx + d + 1                 # extra states hold w[k-1] ... w[k-d-1]
    A = np.zeros((na, na)); B = np.zeros((na, 1)); Cc = np.zeros((1, na))
    A[:nx, :nx] = Phi
    if d == 0:
        B[:nx, 0] = G0; A[:nx, nx] = G1; B[nx, 0] = 1
    else:
        A[:nx, nx + d - 1] = G0; A[:nx, nx + d] = G1; B[nx, 0] = 1
        for i in range(1, d + 1):
            A[nx + i, nx + i - 1] = 1
    Cc[0, :nx] = Cm
    return control.ss(A, B, Cc, 0, Ts)


# ------------------------------------------------------------------ loops
def ctrl_tf_py(c, Ts):
    Kc, Ti, Td, N = c["Kc"], c["Ti"], c.get("Td", 0) or 0, c.get("N", 10)
    z = control.tf([1, 0], [1], Ts)
    Cy = Kc + Kc * Ts / Ti / (z - 1)              # forward-Euler integral
    if Td > 0:
        Tf = Td / N
        Cy = Cy + Kc * Td / (Tf + Ts) * (z - 1) / (z - Tf / (Tf + Ts))   # backward diff, filtered
    return Cy


def margin_close(a, b, tol):
    if math.isinf(a) and math.isinf(b):
        return True
    return abs(a - b) <= tol * max(1, abs(b))


for L in ref["loops"]:
    m, c, Ts = L["model"], L["ctrl"], L["Ts"]
    Lpy = ctrl_tf_py(c, Ts) * plant_ss_py(m, Ts)
    label = "(python C(z)*G(z), plant via expm)"
    gm, pm, sm, wpc, wgc, wms = control.stability_margins(Lpy)
    dj = {k: fix(v) for k, v in L["disc"].items()}
    tag = f"{m['type']} K={m['K']:.3g} {c['type']} Ts={Ts}"
    ok = margin_close(dj["gm"], gm, 1e-4) and margin_close(dj["pm"], pm, 1e-4) and margin_close(dj["wc"], wgc, 1e-4)
    check(f"margins {tag} {label}", ok, js=(round(dj["gm"], 5), round(dj["pm"], 4), round(dj["wc"], 6)),
          python_control=(round(float(gm), 5), round(float(pm), 4), round(float(wgc), 6)))
    # Ms by dense direct evaluation of python's own L(z) (stability_margins' sm can be coarse)
    wd = np.linspace(1e-6, math.pi / Ts, 200000)
    Lw = control.frequency_response(Lpy, wd).complex.ravel()
    Ms_py = float(np.max(np.abs(1 / (1 + Lw))))
    check(f"Ms {tag}", abs(dj["Ms"] - Ms_py) / Ms_py < 1e-4, js=round(dj["Ms"], 5), python_dense=round(Ms_py, 5),
          stability_margins_sm=round(1 / sm, 5) if sm > 0 else None)
    cl = control.feedback(Lpy, 1)
    pp = np.sort_complex(cl.poles())
    pj = np.sort_complex(np.array([complex(a, b) for a, b in L["poles"]]))
    # compare as multisets: greedy nearest matching
    used, err = set(), 0.0
    for q in pp:
        dists = [abs(q - r) if i not in used else np.inf for i, r in enumerate(pj)]
        i = int(np.argmin(dists)); used.add(i); err = max(err, dists[i])
    check(f"closed-loop poles {tag}", len(pp) == len(pj) and err < 1e-6, n=len(pp), max_dist=float(err),
          max_radius=round(float(np.max(np.abs(pp))), 6), stable_js=L["stable"])
    # continuous loop with Padé(12) delay vs JS exact delay
    num, den = control.pade(m["theta"], 12)
    N = c.get("N", 10); Td = c.get("Td", 0) or 0
    s = control.tf([1, 0], [1])
    Cc = c["Kc"] * (1 + 1 / (c["Ti"] * s) + (Td * s / (1 + Td / N * s) if Td > 0 else 0))
    Lc = Cc * tf_cont(m) * control.tf(num, den)
    gmc, pmc, smc, _, wgcc, _ = control.stability_margins(Lc)
    cj = {k: fix(v) for k, v in L["cont"].items()}
    check(f"continuous margins {tag} (Padé-12 reference)", margin_close(cj["pm"], pmc, 2e-3) and margin_close(cj["gm"], gmc, 2e-3),
          js=(round(cj["gm"], 4), round(cj["pm"], 3)), pade=(round(float(gmc), 4), round(float(pmc), 3)))


# ------------------------------------------------------------------ nonlinear closed loop
for s in ref["sims"]:
    o, cc = s["opts"], s["coeffs"]
    m, Ts = o["model"], o["Ts"]
    Phi, G0, G1, Cm, d = sampled_plant_expm(m, Ts)
    c = o["ctrl"]
    Kc, Ti, Td, N, b = c["Kc"], c["Ti"], c.get("Td", 0) or 0, c.get("N", 10), c.get("b", 1)
    Tf = Td / N
    Tt = math.sqrt(Ti * Td) if Td > 0 else Ti
    umin, umax = fix(o["umin"]), fix(o["umax"])
    x = np.zeros(Phi.shape[0]); I = o["uPre"] - (b * Kc - Kc) * o["y0"]; D = 0.0; yprev = o["y0"]
    n = len(s["t"]); w = np.zeros(n); ys, us = [], []
    for k in range(n):
        tk = k * Ts
        y = o["y0"] + Cm @ x
        r = o["r1"] if tk >= o["tStep"] else o["r0"]
        du = o["dist"]["du"] if tk >= o["dist"]["t"] else 0.0
        e = r - y
        P_ = Kc * (b * r - y)
        if Td > 0:
            D = Tf / (Tf + Ts) * D - Kc * Td / (Tf + Ts) * (y - yprev)
        v = P_ + I + D
        u = min(max(v, umin), umax)
        di = Kc * Ts / Ti * e
        aw = c["antiWindup"]
        if aw == "backcalc":
            I += di + Ts / Tt * (u - v)
        elif aw == "clamp":
            if not ((v > umax and di > 0) or (v < umin and di < 0)):
                I += di
        else:
            I += di
        yprev = y
        w[k] = u + du - o["uPre"]
        ys.append(y); us.append(u)
        wa = w[k - d] if k - d >= 0 else 0.0
        wb = w[k - d - 1] if k - d - 1 >= 0 else 0.0
        x = Phi @ x + G0 * wa + G1 * wb
    ey = float(np.max(np.abs(np.array(ys) - np.array(s["y"]))))
    eu = float(np.max(np.abs(np.array(us) - np.array(s["u"]))))
    satfrac = float(np.mean((np.array(us) >= umax - 1e-9) | (np.array(us) <= umin + 1e-9)))
    check(f"closed-loop sim {m['type']} aw={c['antiWindup']} sat={'on' if umax < 1e8 else 'off'}", ey < 1e-8 and eu < 1e-7,
          max_dy=ey, max_du=eu, saturated_fraction=round(satfrac, 3))

# linear closed loop vs python-control forced_response on T(z)
for s in [s for s in ref["sims"] if fix(s["opts"]["umax"]) > 1e8][:2]:
    o = s["opts"]; m, Ts, c = o["model"], o["Ts"], o["ctrl"]
    G = plant_ss_py(m, Ts)
    Kc, Ti, b = c["Kc"], c["Ti"], c.get("b", 1)
    z = control.tf([1, 0], [1], Ts)
    Cr = b * Kc + Kc * Ts / Ti / (z - 1)
    Cy = ctrl_tf_py(c, Ts)
    T = control.feedback(G, Cy) * Cr
    rr = np.where(np.array(s["t"]) >= o["tStep"], o["r1"] - o["r0"], 0.0)
    dd = np.where(np.array(s["t"]) >= o["dist"]["t"], o["dist"]["du"], 0.0)
    Sd = control.feedback(G, Cy)
    ypy = o["y0"] + control.forced_response(T, T=s["t"], U=rr).outputs + control.forced_response(Sd, T=s["t"], U=dd).outputs
    err = float(np.max(np.abs(ypy - np.array(s["y"]))))
    check(f"linear closed loop {m['type']} {c['type']}: JS sim == python-control forced_response", err < 1e-7, max_dy=err)

report = {"python_control": control.__version__, "numpy": np.__version__, "checks": results,
          "passed": len(results) - len(failures), "failed": len(failures)}
(HERE / "python_control_report.json").write_text(json.dumps(report, indent=1, default=str))
print(f"\n{len(results) - len(failures)}/{len(results)} checks passed (python-control {control.__version__})")
sys.exit(1 if failures else 0)
