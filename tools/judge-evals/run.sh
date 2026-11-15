#!/usr/bin/env bash
# usage: run.sh <rules-file> [--reps N]   (default 2). Cases: cases/*.json and cases/*.jsonl (one case per line). JUDGE_MODEL=sonnet picks the judge model (default haiku). RESULT: OK = harness ran with every verdict parsed; it does not grade the rules (gate.sh does).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
rules=${1:?usage: run.sh <rules-file> [--reps N]}; shift
reps=2; [ "${1:-}" = "--reps" ] && reps=${2:?}
exec python3 -I "$here/judge_run.py" "$rules" --reps "$reps"
