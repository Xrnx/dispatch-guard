#!/usr/bin/env bash
# usage: extract-rules.sh <register.ts | rulepack.ts | unzipped plugin dir> [out=rules/current.txt]
# Pulls the JUDGE_RULES template literal (it lives in hooks/rulepack.ts; register.ts imports it).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
src=${1:?usage: extract-rules.sh <register.ts|plugin dir> [out]}
out=${2:-$here/rules/current.txt}
python3 -I - "$src" "$out" <<'PY'
import sys,os,re
src,out=sys.argv[1:3]
files=[]
if os.path.isdir(src):
    for r,_,fs in os.walk(src):
        if 'node_modules' in r: continue
        files+= [os.path.join(r,f) for f in fs if f.endswith(('.ts','.js','.mjs','.cjs'))]
else:
    files=[src]; d=os.path.dirname(os.path.abspath(src))
    files.append(os.path.join(d,'rulepack.ts'))
for f in files:
    try: t=open(f,encoding='utf8').read()
    except OSError: continue
    m=re.search(r'JUDGE_RULES\s*(?::\s*string\s*)?=\s*`((?:\\.|[^`\\])*)`',t)
    if m:
        s=re.sub(r'\\(.)',lambda k:{'n':'\n','t':'\t'}.get(k.group(1),k.group(1)),m.group(1))
        if '${' in s: sys.exit('template interpolation in JUDGE_RULES: unsupported')
        open(out,'w').write(s+'\n'); print(f'extracted {len(s)} chars from {f} -> {out}'); sys.exit(0)
sys.exit('JUDGE_RULES not found in '+src)
PY
