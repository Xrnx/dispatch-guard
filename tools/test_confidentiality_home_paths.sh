#!/usr/bin/env bash
# Tests for the home-path check added to tools/confidentiality-scan.sh (fixture trees in a temp dir; private denylist faked).
# Usage: tools/test_confidentiality_home_paths.sh [path/to/confidentiality-scan.sh]   -> "N passed, M failed" + RESULT line.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
scan="${1:-$here/confidentiality-scan.sh}"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
printf 'zzqqcodename\n' > "$t/deny.txt"
pass=0; fail=0
ok() { if eval "$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1"; fi; }
# fixture paths are assembled at run time so this file itself passes the scan it tests
H=/ho; U=Use
mk() { rm -rf "$t/tree"; mkdir -p "$t/tree"; printf '%s\n' "$1" > "$t/tree/f.txt"; }
run() { DG_DENYLIST="$t/deny.txt" DG_NO_RESULT=1 bash "$scan" "$t/tree" >"$t/out" 2>&1; echo $?; }
mk 'default list at /home/claude/.dg-denylist.txt and /root/.claude/skills'; ok "generic /home/claude allowed" "[ \$(run) = 0 ]"
mk "see C:\\${U}rs\\jsmith\\Documents\\deal"; ok "Windows user folder flagged" "[ \$(run) = 1 ] && grep -q 'PERSONAL HOME PATH' $t/out"
mk "see C:/${U}rs/jsmith/x"; ok "Windows forward-slash user folder flagged" "[ \$(run) = 1 ]"
mk "open /${U}rs/jsmith/Desktop/a.docx"; ok "macOS user folder flagged" "[ \$(run) = 1 ]"
mk "cd ${H}me/jsmith/work"; ok "/home/<other user> flagged" "[ \$(run) = 1 ]"
mk 'fixture under /Users/Shared and /Users/example'; ok "/Users/Shared and /Users/example allowed" "[ \$(run) = 0 ]"
mk "cd ${H}me/runner/work"; ok "DG_HOME_OK allows a named fixture path" "[ \$(DG_HOME_OK=\"${H}me/runner\" run) = 0 ]"
mk 'clean text only'; ok "clean tree passes" "[ \$(run) = 0 ] && grep -q 'clean (1 patterns)' $t/out"
mk 'zzqqcodename here'; ok "denylist still enforced" "[ \$(run) = 1 ] && grep -q 'DENYLIST HIT' $t/out"
echo "$pass passed, $fail failed"
[ "$fail" = 0 ] && echo "RESULT: OK" || echo "RESULT: FAILED ($fail)"
[ "$fail" = 0 ]
