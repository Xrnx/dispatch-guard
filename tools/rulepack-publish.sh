#!/usr/bin/env bash
# Validate a dispatch-guard rule pack with the hook's own validator (hooks/rulepack.ts), then PRINT the git
# commands that publish it to branch `rulepack` (raw URL the hook fetches). Nothing is pushed by this script.
# Usage: tools/rulepack-publish.sh <pack.json>         validate + print publish commands
#        tools/rulepack-publish.sh --init [out.json]   write the bundled rules as a pack (version bundled+1) to edit
# Needs node >= 22.6 (type stripping).
set -euo pipefail
# RESULT line (0.6.15): the last stdout line is "RESULT: OK" or "RESULT: FAILED (exit N)", so a "done" claim can be checked. Nested calls set DG_NO_RESULT.
if [ -z "${DG_NO_RESULT:-}" ]; then trap 'rc=$?; if [ "$rc" = 0 ]; then echo "RESULT: OK"; else echo "RESULT: FAILED (exit $rc)"; fi' EXIT; export DG_NO_RESULT=1; fi
root="$(cd "$(dirname "$0")/.." && pwd)"
mod="$root/hooks/rulepack.ts"

if [ "${1:-}" = "--init" ]; then
  out="${2:-rulepack.json}"
  node --experimental-strip-types --no-warnings --input-type=module -e "
    const m = await import(process.argv[1]); const p = m.bundledPackJson(); p.version = m.BUNDLED_VERSION + 1
    ;(await import('node:fs')).writeFileSync(process.argv[2], JSON.stringify(p, null, 2) + '\n')
    console.log('wrote ' + process.argv[2] + ' (version ' + p.version + ')')" "$mod" "$out"
  exit 0
fi

pack="${1:?usage: tools/rulepack-publish.sh <pack.json> | --init [out.json]}"
[ -f "$pack" ] && { d="$(mktemp -d)"; cp "$pack" "$d/"; "$root/tools/confidentiality-scan.sh" "$d" || { rm -rf "$d"; echo "rulepack-publish: confidentiality scan failed" >&2; exit 1; }; rm -rf "$d"; }
[ -f "$pack" ] || { echo "rulepack-publish: no such file: $pack" >&2; exit 1; }
node --experimental-strip-types --no-warnings --input-type=module -e "
  const m = await import(process.argv[1]); const fs = await import('node:fs')
  let pack; try { pack = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) } catch (e) { console.error('INVALID: not JSON: ' + e.message); process.exit(1) }
  if (pack && pack.disabled === true) { console.log('OK: kill switch (disabled) — sessions use the bundled rules'); process.exit(0) }
  const errs = m.validatePack(pack)
  if (errs.length) { console.error('INVALID (' + errs.length + '):'); for (const e of errs) console.error('  - ' + e); process.exit(1) }
  const ids = Object.keys(pack.checks ?? {}); const add = (pack.add ?? []).map(a => a.id)
  console.log('OK: rulepack v' + pack.version + ' — overrides: ' + (ids.join(', ') || 'none') + '; added: ' + (add.join(', ') || 'none'))
" "$mod" "$pack"

abs="$(cd "$(dirname "$pack")" && pwd)/$(basename "$pack")"
cat <<EOF

# Publish (run in a clone of Xrnx/dispatch-guard; NOT run by this script):
git fetch origin rulepack 2>/dev/null || true
git worktree add /tmp/dg-rulepack origin/rulepack 2>/dev/null || git worktree add --orphan -b rulepack /tmp/dg-rulepack
cd /tmp/dg-rulepack
cp "$abs" rulepack.json
git add rulepack.json
git commit -m "rulepack v$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("version","?"))' "$abs")"
git push origin HEAD:refs/heads/rulepack
cd - && git worktree remove /tmp/dg-rulepack
# Live at: https://raw.githubusercontent.com/Xrnx/dispatch-guard/rulepack/rulepack.json (new sessions; CDN cache up to ~5 min)
# Kill switch: publish {"disabled": true} the same way.
EOF
