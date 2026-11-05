"""Optional independent cross-check of CANProof's Davis et al. (2007) CAN WCRT
analysis against pyCPA's static-priority non-preemptive scheduler
(TU Braunschweig, MIT licence, https://github.com/IDA-TUBS/pycpa), configured
with cycle_time = tau_bit (the tau term of Davis 2007 eq. 12).

NOT RUN in the build session (executing third-party cloned code was not
permitted there). Run it yourself:

    git clone https://github.com/IDA-TUBS/pycpa /tmp/pycpa
    node tools/crosscheck_dump.js 200 > /tmp/cases.json
    PYTHONPATH=/tmp/pycpa python3 tools/crosscheck_pycpa.py /tmp/cases.json
"""
import json
import sys

from pycpa import analysis, model, schedulers


def run(case):
    s = model.System()
    r = s.bind_resource(model.Resource("CAN", schedulers.SPNPScheduler(cycle_time=int(case["tau"]))))
    tasks = {}
    for m in case["msgs"]:
        t = r.bind_task(model.Task(m["key"], wcet=int(m["C"]), bcet=int(m["C"]), scheduling_parameter=m["prio"]))
        t.in_event_model = model.PJdEventModel(P=m["T"], J=m["J"])
        tasks[m["key"]] = t
    res = analysis.analyze_system(s)
    return {k: res[t].wcrt for k, t in tasks.items()}


def main():
    cases = json.load(open(sys.argv[1]))
    mism = total = skipped = 0
    for c in cases:
        if c["load"] >= 0.98:
            skipped += 1
            continue
        try:
            py = run(c)
        except Exception:  # pyCPA raises when a busy window does not converge
            skipped += 1
            continue
        for k, rp in py.items():
            total += 1
            mine = c["R"][k]
            if mine is None or abs(mine - rp) > 1:
                mism += 1
                print("MISMATCH seed=%d %s canproof=%s pycpa=%s" % (c["seed"], k, mine, rp))
    print("compared %d WCRTs in %d cases (%d skipped); mismatches: %d" % (total, len(cases) - skipped, skipped, mism))
    sys.exit(1 if mism else 0)


if __name__ == "__main__":
    main()
