#!/usr/bin/env bash
# Promote the checked-out commit to the release ref only if the full suite and validator pass.
# Usage: tools/promote.sh [remote] [branch]   (defaults: origin stable)
# Org sync reads the DEFAULT branch of a PRIVATE repo: point remote/branch at that.
set -euo pipefail
# RESULT line (0.6.15): the last stdout line is "RESULT: OK" or "RESULT: FAILED (exit N)", so a "done" claim can be checked. Nested calls set DG_NO_RESULT.
if [ -z "${DG_NO_RESULT:-}" ]; then trap 'rc=$?; if [ "$rc" = 0 ]; then echo "RESULT: OK"; else echo "RESULT: FAILED (exit $rc)"; fi' EXIT; export DG_NO_RESULT=1; fi
cd "$(dirname "$0")/.."
remote="${1:-origin}"; branch="${2:-stable}"
[ -z "$(git status --porcelain)" ] || { echo "promote: working tree not clean" >&2; exit 1; }
tools/confidentiality-scan.sh >/dev/null || { echo "promote: confidentiality scan failed" >&2; exit 1; }
claude plugin validate . >/dev/null
out="$(claude plugin test . 2>&1)" || { echo "$out" | tail -20 >&2; echo "promote: tests failed" >&2; exit 1; }
echo "$out" | grep -E '^ *[0-9]+ fail' | grep -q '^ *0 fail' || { echo "promote: failures reported" >&2; exit 1; }
ver="$(python3 -c 'import json;print(json.load(open(".claude-plugin/plugin.json"))["version"])')"
git tag -f "v$ver-stable" >/dev/null
git push "$remote" "HEAD:refs/heads/$branch" "refs/tags/v$ver-stable"
echo "promoted $ver ($(git rev-parse --short HEAD)) to $remote/$branch"
