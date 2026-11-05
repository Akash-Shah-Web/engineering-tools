"""Cross-check CANProof's DBC signal decoder against cantools (PyPI, MIT).

Decodes N random payloads for every message of a DBC with cantools and prints
JSON {msgName: [{data: hex, signals: {name: physical}}]} for
tools/crosscheck_cantools.js to compare.

    pip install cantools
    python3 tools/crosscheck_cantools.py data/synthetic/demo_vehicle.dbc 200 > /tmp/ct.json
    node tools/crosscheck_cantools.js data/synthetic/demo_vehicle.dbc /tmp/ct.json
"""
import json
import random
import sys

import cantools

db = cantools.database.load_file(sys.argv[1], strict=False)
n = int(sys.argv[2]) if len(sys.argv) > 2 else 100
rng = random.Random(42)
out = {}
for m in db.messages:
    rows = []
    for _ in range(n):
        data = bytes(rng.randrange(256) for _ in range(m.length))
        try:
            dec = m.decode(data, decode_choices=False, scaling=True)
        except Exception as e:  # e.g. planted layout errors
            rows.append({"data": data.hex(), "error": str(e)})
            continue
        rows.append({"data": data.hex(), "signals": {k: float(v) for k, v in dec.items()}})
    out[m.name] = rows
json.dump(out, sys.stdout)
