#!/usr/bin/env python3
"""Reproducibly fetch the measured TCLab datasets used by LoopForge.

Files are pinned to an exact git commit of the upstream repository and are
verified against SHA-256 checksums. Downloads go to data/raw/ (git-ignored).
Use --check-samples to verify the committed copies in data/samples/ instead.

Standard library only:  python3 data/fetch_data.py
"""
import hashlib, pathlib, sys, urllib.request

REPO = "dowlinglab/pyomo-doe"
COMMIT = "d250c5b0625afb35007c075df1e0f7125e74017d"
BASE = f"https://raw.githubusercontent.com/{REPO}/{COMMIT}/data/"

FILES = {
    "validation_experiment_env_2_step_50_run_1.csv": "0c5fc5917a3693ca73a9240f0f40aea711fe1458853b88dd9c9db54fded776ec",
    "validation_experiment_env_2_step_50_run_2.csv": "bd249f911ac8635bf2cf0d50dbf74405ebd10f879f9784feae90544d046cdbe4",
    "validation_experiment_env_2_step_50_run_3.csv": "08f2d71786510f0d232e22c1bb8e6225b5f4e7ecb572d4cde446f3305b184b6f",
    "validation_experiment_env_2_sin_5_50_run_1.csv": "12abe51379ee107ee593986e1923aa849939aa2254412c551886708c26aa7f6d",
    "validation_experiment_env_2_sin_50_50_run_1.csv": "958261e9db4cdd43c94d793e87ec97a3abef177913888bad4d25de27b8956389",
    "validation_experiment_env_2_sin_2_50_run_1.csv": "5381e073c848b52b1ea2d3acc69b6be790f7aaad1cee18511589a09668e3d7b5",
}

HERE = pathlib.Path(__file__).resolve().parent


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def main() -> int:
    check_samples = "--check-samples" in sys.argv
    out = HERE / ("samples" if check_samples else "raw")
    out.mkdir(exist_ok=True)
    bad = 0
    for name, digest in FILES.items():
        path = out / name
        if check_samples:
            data = path.read_bytes()
        else:
            with urllib.request.urlopen(BASE + name, timeout=60) as r:
                data = r.read()
            path.write_bytes(data)
        ok = sha256(data) == digest
        bad += not ok
        print(f"{'OK  ' if ok else 'FAIL'} {name} {len(data)} bytes")
    if bad:
        print(f"{bad} file(s) failed checksum verification", file=sys.stderr)
        return 1
    print("all checksums verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
