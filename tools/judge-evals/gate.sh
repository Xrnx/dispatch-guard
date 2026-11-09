#!/usr/bin/env bash
# usage: gate.sh <current-rules> <candidate-rules> [--reps N]. Exit 0 only if candidate FP <= current FP and catch >= current catch.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cur=${1:?usage: gate.sh <current> <candidate> [--reps N]}; cand=${2:?}; shift 2
reps=2; [ "${1:-}" = "--reps" ] && reps=${2:?}
python3 -I - "$here" "$cur" "$cand" "$reps" <<'PY'
import sys,importlib.util
here,cur,cand,reps=sys.argv[1:5]
spec=importlib.util.spec_from_file_location('jr',here+'/judge_run.py'); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a=m.run(cur,int(reps)); b=m.run(cand,int(reps))
print(f"{'metric':<22}{'current':>12}{'candidate':>12}")
for k,l in (('fp','FP rate (lower)'),('catch','catch (higher)'),('tag','tag accuracy')):
    print(f"{l:<22}{a[k]*100:>11.1f}%{b[k]*100:>11.1f}%")
f=lambda o:f"{o['ms']:.0f}ms" if o['ms'] else 'cached'
print(f"{'mean latency':<22}{f(a):>12}{f(b):>12}")
for n,o in (('current',a),('candidate',b)):
    print(f"-- {n} misses:"); [print('   '+x) for x in o['misses']] or None
err=a['counts']['err']+b['counts']['err']
eps=1e-9
ok=err==0 and b['fp']<=a['fp']+eps and b['catch']>=a['catch']-eps
print(f"unparseable verdicts: {err}")
print("RESULT: "+("OK (candidate may ship)" if ok else "FAILED (do not ship candidate)"))
sys.exit(0 if ok else 1)
PY
