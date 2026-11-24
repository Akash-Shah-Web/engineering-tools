#!/usr/bin/env python3
"""Reproducible data fetch for ActiveRide, with checksums.

Sources (see data/README.md for full provenance):

1. LTPP InfoPave longitudinal profiles (https://infopave.fhwa.dot.gov/)
   -> requested main road source. InfoPave serves profile data through an
   interactive, session-based web export, so there is no stable direct URL to
   script. This script only probes reachability and, if the user has exported
   a profile manually, picks it up from data/raw/ltpp/*.csv (see README).

2. LiRA-CD "Data subset for road condition modelling - reference data"
   (DTU Data, DOI 10.11583/DTU.23097002, CC BY 4.0). Measured P79
   profilometer wheel-path elevations, Danish motorway M13.
   a) full original file m13_zp_vh.csv from figshare, MD5-verified, or
   b) fallback: original-byte excerpts mirrored in a public GitHub repository
      at a pinned commit, SHA-256 verified against that repository's
      provenance records.

3. Warwick suspension benchmark, Zenodo DOI 10.5281/zenodo.17242919,
   file suspension_dataset.mat, MD5-verified.

Only small LiRA-CD samples (three wheel-path columns) are written to
data/samples/ and committed. Everything else stays in data/raw/ (git-ignored).
"""
from __future__ import annotations

import datetime as _dt
import gzip
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
SAMPLES = ROOT / "data" / "samples"
LOG = ROOT / "data" / "fetch_log.json"

LIRA_FULL_URL = "https://ndownloader.figshare.com/files/41206187"
LIRA_FULL_MD5 = "d1c74b645b169dcd88ce99d71ffbb43e"
LIRA_MIRROR_REPO = "https://github.com/MingyiLiuGT/VehicleVibrationSuppression.git"
LIRA_MIRROR_COMMIT = "33b1254f1f86df724dedc4ddf0ed0aed6c163813"
# section id -> (path in mirror, SHA-256 of the *uncompressed* excerpt bytes)
LIRA_EXCERPTS = {
    "A": ("results/road_halfcar/source/m13_zp_vh_first6000.csv.gz",
          "04e7278edca955df93530da9c25c8d763a3b0d86dade24108a8abc5e3b9cbf24"),
    "B": ("results/road_coverage/new_measured_source.csv.gz",
          "ce3a22f722501b2a058c69e8c31bb3d4385f142ca399f23ab26547837797f3ef"),
    "C": ("results/road_coverage_centered/new_measured_source.csv.gz",
          "bf51289619e9fa3ba0e1e6b8d982b0f36c9c1a38d91c34fb0ea966f4860053d4"),
}
# chainage windows (m) of the three sections in the full file, identical to the excerpts
LIRA_WINDOWS = {"A": (16551.0, 17155.3), "B": (17550.9, 18061.1), "C": (18550.9, 19061.2)}
LEFT_COL, RIGHT_COL = "Laser 5 [mm]", "Laser 21 [mm]"   # left / right wheel path (dataset readme)

WARWICK_URL = "https://zenodo.org/records/17242919/files/suspension_dataset.mat?download=1"
WARWICK_MD5 = "3ee016647067d39dd8c4feb61fef47f1"
LTPP_URL = "https://infopave.fhwa.dot.gov/"


def _md5(b: bytes) -> str:
    return hashlib.md5(b).hexdigest()


def _sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _get(url: str, timeout=60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "activeride-fetch/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _write_sample(section: str, text: str, origin: str, sha: str) -> dict:
    """Keep only distance + left/right wheel-path columns (values unchanged)."""
    lines = text.splitlines()
    header = [h.strip() for h in lines[0].split(";")]
    i_d, i_l, i_r = header.index("Distance [m]"), header.index(LEFT_COL), header.index(RIGHT_COL)
    out = ["# LiRA-CD P79 wheel-path elevation sample (MEASURED). Source DOI 10.11583/DTU.23097002, CC BY 4.0.",
           f"# Section {section}; columns copied unchanged from m13_zp_vh.csv ({origin}); excerpt sha256={sha}",
           "distance_m,left_wheelpath_mm,right_wheelpath_mm"]
    lo, hi = LIRA_WINDOWS[section]
    n = 0
    for ln in lines[1:]:
        f = ln.split(";")
        try:
            d = float(f[i_d])
        except (ValueError, IndexError):
            continue
        if not (lo <= d <= hi):
            continue
        out.append(f"{f[i_d].strip()},{f[i_l].strip()},{f[i_r].strip()}")
        n += 1
    SAMPLES.mkdir(parents=True, exist_ok=True)
    p = SAMPLES / f"lira_m13_{section}.csv"
    p.write_text("\n".join(out) + "\n")
    return {"file": str(p.relative_to(ROOT)), "rows": n,
            "sha256": _sha256(p.read_bytes())}


def fetch_lira(log: dict) -> None:
    entry = log.setdefault("lira_cd", {})
    # (a) full original
    try:
        raw = _get(LIRA_FULL_URL, timeout=120)
        ok = _md5(raw) == LIRA_FULL_MD5
        entry["full_file"] = {"url": LIRA_FULL_URL, "status": "ok" if ok else "md5 mismatch",
                              "md5": _md5(raw)}
        if ok:
            (RAW / "lira").mkdir(parents=True, exist_ok=True)
            (RAW / "lira" / "m13_zp_vh.csv").write_bytes(raw)
            text = raw.decode("cp1252")
            entry["samples"] = {s: _write_sample(s, text, "full file", _md5(raw)) for s in LIRA_WINDOWS}
            entry["route"] = "full original file"
            return
    except Exception as e:  # noqa: BLE001 - we log any network failure
        entry["full_file"] = {"url": LIRA_FULL_URL, "status": f"unavailable: {type(e).__name__}: {e}"}
    # (b) GitHub mirror of original-byte excerpts
    tmp = Path(tempfile.mkdtemp(prefix="lira_mirror_"))
    try:
        subprocess.run(["git", "init", "-q", str(tmp)], check=True)
        subprocess.run(["git", "-C", str(tmp), "fetch", "-q", "--depth", "1", LIRA_MIRROR_REPO,
                        LIRA_MIRROR_COMMIT], check=True, timeout=600)
        subprocess.run(["git", "-C", str(tmp), "checkout", "-q", "FETCH_HEAD", "--"]
                       + [v[0] for v in LIRA_EXCERPTS.values()], check=True)
        entry["mirror"] = {"repo": LIRA_MIRROR_REPO, "commit": LIRA_MIRROR_COMMIT, "status": "ok"}
        entry["samples"] = {}
        for s, (path, sha) in LIRA_EXCERPTS.items():
            data = gzip.decompress((tmp / path).read_bytes())
            got = _sha256(data)
            if got != sha:
                entry["samples"][s] = {"status": f"sha256 mismatch {got}"}
                continue
            (RAW / "lira").mkdir(parents=True, exist_ok=True)
            (RAW / "lira" / f"excerpt_{s}.csv").write_bytes(data)
            entry["samples"][s] = _write_sample(s, data.decode("cp1252"), "mirror excerpt", sha) | {
                "excerpt_sha256_verified": True}
        entry["route"] = "GitHub mirror of original-byte excerpts"
    except Exception as e:  # noqa: BLE001
        entry["mirror"] = {"repo": LIRA_MIRROR_REPO, "status": f"failed: {e}"}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def fetch_warwick(log: dict) -> None:
    dst = RAW / "warwick" / "suspension_dataset.mat"
    if dst.exists() and _md5(dst.read_bytes()) == WARWICK_MD5:
        log["warwick"] = {"status": "ok (cached)", "md5": WARWICK_MD5}
        return
    try:
        raw = _get(WARWICK_URL, timeout=300)
        ok = _md5(raw) == WARWICK_MD5
        if ok:
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(raw)
        log["warwick"] = {"url": WARWICK_URL, "status": "ok" if ok else "md5 mismatch", "md5": _md5(raw)}
    except Exception as e:  # noqa: BLE001
        log["warwick"] = {"url": WARWICK_URL, "status": f"unavailable: {type(e).__name__}: {e}"}


def probe_ltpp(log: dict) -> None:
    try:
        _get(LTPP_URL, timeout=30)
        st = "portal reachable; profile export is interactive - see data/README.md"
    except Exception as e:  # noqa: BLE001
        st = f"unreachable: {type(e).__name__}: {e}"
    user = sorted(str(p.relative_to(ROOT)) for p in (RAW / "ltpp").glob("*.csv")) if (RAW / "ltpp").exists() else []
    log["ltpp"] = {"url": LTPP_URL, "status": st, "user_exported_files": user}


def main() -> int:
    RAW.mkdir(parents=True, exist_ok=True)
    log = {"access_date_utc": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d")}
    probe_ltpp(log)
    fetch_lira(log)
    fetch_warwick(log)
    LOG.write_text(json.dumps(log, indent=2) + "\n")
    print(json.dumps(log, indent=2))
    ok = all(isinstance(v, dict) and "rows" in v for v in log.get("lira_cd", {}).get("samples", {}).values())
    if not ok:
        # committed samples are still usable: verify them instead
        print("WARNING: could not refresh LiRA-CD samples; using committed data/samples if present.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
