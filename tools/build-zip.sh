#!/usr/bin/env bash
# Build the release zip: confidentiality scan first (fails the build on any hit), then a single top-level dispatch-guard/ folder.
# Usage: tools/build-zip.sh <out.zip>
set -euo pipefail
# RESULT line (0.6.15): the last stdout line is "RESULT: OK" or "RESULT: FAILED (exit N)", so a "done" claim can be checked. Nested calls set DG_NO_RESULT.
if [ -z "${DG_NO_RESULT:-}" ]; then trap 'rc=$?; if [ "$rc" = 0 ]; then echo "RESULT: OK"; else echo "RESULT: FAILED (exit $rc)"; fi' EXIT; export DG_NO_RESULT=1; fi
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$(realpath -m "${1:?usage: build-zip.sh out.zip}")"
"$here/tools/confidentiality-scan.sh" "$here"
# 0.6.19: the version the hook writes into deep-stats rows must equal plugin.json's
pj="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$here/.claude-plugin/plugin.json")"
rv="$(sed -n "s/^export const PLUGIN_VERSION = '\(.*\)'.*/\1/p" "$here/hooks/register.ts")"
[ "$pj" = "$rv" ] || { echo "version mismatch: plugin.json $pj vs PLUGIN_VERSION $rv" >&2; exit 1; }
tmp="$(mktemp -d)"; trap 'rc=$?; rm -rf "$tmp"; [ "$rc" = 0 ] && echo "RESULT: OK" || echo "RESULT: FAILED (exit $rc)"' EXIT
mkdir "$tmp/dispatch-guard"
tar -C "$here" --exclude=node_modules --exclude=.git --exclude=__pycache__ --exclude=bin -cf - . | tar -C "$tmp/dispatch-guard" -xf -
rm -f "$out"
(cd "$tmp" && zip -qr "$out" dispatch-guard)
# scan what actually ships
chk="$(mktemp -d)"; unzip -q "$out" -d "$chk"; "$here/tools/confidentiality-scan.sh" "$chk" || { rm -f "$out"; rm -rf "$chk"; exit 1; }
rm -rf "$chk"; echo "built $out"
