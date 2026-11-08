#!/usr/bin/env bash
# Tests for tools/maintenance-lint and the RESULT-line convention (fixtures built in a temp dir, nothing real is read).
# Usage: tools/maintenance-lint.test.sh   -> prints "N passed, M failed" and ends with a RESULT line.
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
pass=0; fail=0
ok() { if eval "$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1"; fi; }
M="$t/mem"; mkdir -p "$M/areas" "$M/topics"
cat > "$M/preferences.md" <<'P'
---
name: preferences
---
- [stated] Rule A: see /areas/alpha.md and [[alpha]] and [[beta-alias]] and /topics/gone.md
- [stated] Rule B: never an offer waiting on J; keep tone short
- [stated] Rule C: from now on is banned; Leap: one idea
- [stated] Rule D: see [[nowhere]]; register.ts l.319; orchestrator card "No Such Heading"
- [stated] Rule E: dispatch-guard tools/missing-file.sh and tools/build-zip.sh; artifact https://claude.ai/artifact/AAA111 and https://claude.ai/artifact/BBB222
P
printf -- '---\nname: alpha\naliases: [beta alias, beta-alias]\n---\n# Heading One\n- see /areas/alpha.md#heading-one and /areas/alpha.md#nope\n' > "$M/areas/alpha.md"
printf '/areas/extra.md\n/topics/leap-criteria.md\n/areas/open-items.md\n/areas/orchestrator-calibration.md\n' > "$t/index.txt"
printf 'https://claude.ai/artifact/AAA111\tok\nhttps://claude.ai/artifact/BBB222\tmissing\n' > "$t/art.tsv"
out="$("$here/tools/maintenance-lint" --memory-dir "$M" --memory-index "$t/index.txt" --artifacts "$t/art.tsv")"; rc=$?
ok "exit 1 on issues" "[ $rc = 1 ]"
ok "last line RESULT FAILED" "[ \"\$(echo \"\$out\" | tail -1)\" = 'RESULT: FAILED (7 issues)' ]"
ok "missing memory path flagged" "echo \"\$out\" | grep -q 'memory path /topics/gone.md not found'"
ok "existing path not flagged" "! echo \"\$out\" | grep -q 'memory path /areas/alpha.md not found'"
ok "bad anchor flagged, good anchor not" "echo \"\$out\" | grep -q 'anchor #nope' && ! echo \"\$out\" | grep -q 'anchor #heading-one'"
ok "alias resolves, unknown wikilink flagged" "! echo \"\$out\" | grep -q 'beta-alias\]\] resolves' && echo \"\$out\" | grep -q 'nowhere\]\] resolves'"
ok "line-number pointer flagged" "echo \"\$out\" | grep -q 'line-number pointer \"register.ts l.319\"'"
ok "missing card heading flagged" "echo \"\$out\" | grep -q 'section \"No Such Heading\" not found'"
ok "missing plugin path flagged, real one not" "echo \"\$out\" | grep -q 'plugin path tools/missing-file.sh' && ! echo \"\$out\" | grep -q 'plugin path tools/build-zip.sh'"
ok "missing artifact flagged, ok one not" "echo \"\$out\" | grep -q 'artifact https://claude.ai/artifact/BBB222 -> missing' && ! echo \"\$out\" | grep -q 'AAA111 ->'"
ok "live check duplicate suggested" "echo \"\$out\" | grep -q 'DELETE? /preferences.md:5 \[offer-guard'"
ok "off check kept, not deleted" "echo \"\$out\" | grep -q 'keep .*\[leap-line is OFF'"
ok "report only: memory untouched" "grep -q 'Rule B' \"$M/preferences.md\""
urls="$("$here/tools/maintenance-lint" --memory-dir "$M" --list-urls)"
ok "--list-urls" "echo \"\$urls\" | grep -q AAA111 && echo \"\$urls\" | grep -q BBB222"
# clean tree -> OK
C="$t/clean"; mkdir -p "$C"; printf -- '---\nname: preferences\n---\n- plain rule with no pointers\n' > "$C/preferences.md"
out2="$("$here/tools/maintenance-lint" --memory-dir "$C" --memory-index "$t/index.txt")"; rc2=$?
ok "clean exit 0 + RESULT: OK" "[ $rc2 = 0 ] && [ \"\$(echo \"\$out2\" | tail -1)\" = 'RESULT: OK' ]"
# RESULT line on the shell tools
d="$t/denylist.txt"; echo 'zz'"qqxx" > "$d"; mkdir "$t/tree"; echo hello > "$t/tree/a.txt"
o3="$(DG_DENYLIST="$d" "$here/tools/confidentiality-scan.sh" "$t/tree" 2>/dev/null)"
ok "scan clean ends RESULT: OK" "[ \"\$(echo \"\$o3\" | tail -1)\" = 'RESULT: OK' ]"
echo 'zz'"qqxx" > "$t/tree/b.txt"
o4="$(DG_DENYLIST="$d" "$here/tools/confidentiality-scan.sh" "$t/tree" 2>/dev/null)"
ok "scan hit ends RESULT: FAILED" "[ \"\$(echo \"\$o4\" | tail -1)\" = 'RESULT: FAILED (exit 1)' ]"
o5="$("$here/tools/rulepack-publish.sh" /nonexistent.json 2>/dev/null)"
ok "rulepack-publish failure ends RESULT: FAILED" "[ \"\$(echo \"\$o5\" | tail -1)\" = 'RESULT: FAILED (exit 1)' ]"
o6="$(DG_DENYLIST="$d" "$here/tools/build-zip.sh" "$t/x.zip" 2>/dev/null)"
ok "build-zip (clean) ends RESULT: OK once" "[ \"\$(echo \"\$o6\" | tail -1)\" = 'RESULT: OK' ] && [ \"\$(echo \"\$o6\" | grep -c '^RESULT:')\" = 1 ]"
echo "$pass passed, $fail failed"
[ "$fail" = 0 ] && echo "RESULT: OK" || { echo "RESULT: FAILED ($fail issues)"; exit 1; }
