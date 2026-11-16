#!/usr/bin/env bash
# Confidentiality gate: fail if a non-fixture email address or a personal home-folder path appears in the tree. The repo is public.
# 0.6.43: the static name-list check is dropped (names checked absent from every branch and commit of the repository history).
# Usage: tools/confidentiality-scan.sh [dir]   (default: the plugin root)
set -uo pipefail
# RESULT line (0.6.15): the last stdout line is "RESULT: OK" or "RESULT: FAILED (exit N)", so a "done" claim can be checked. Nested calls set DG_NO_RESULT.
if [ -z "${DG_NO_RESULT:-}" ]; then trap 'rc=$?; if [ "$rc" = 0 ]; then echo "RESULT: OK"; else echo "RESULT: FAILED (exit $rc)"; fi' EXIT; export DG_NO_RESULT=1; fi
root="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
fail=0
ex=(--exclude-dir=node_modules --exclude-dir=.git)
# email addresses other than fixtures
mails="$(grep -rnoE "${ex[@]}" -e '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$root" 2>/dev/null \
  | grep -viE '@(example\.(com|org|net)|anthropic\.com|localhost)\b|@[a-z-]+\.test\b' || true)"
if [ -n "$mails" ]; then echo "confidentiality-scan: EMAIL ADDRESS (not a fixture)" >&2; echo "$mails" >&2; fail=1; fi
# hardcoded personal home folders (bundle pre-commit rule): Windows/macOS user folders and /home/<user> other than the
# sandbox's generic /home/claude. Set DG_HOME_OK to an extra allowed regex if a fixture needs one.
homes="$(grep -rnoE "${ex[@]}" -e '[A-Za-z]:[\\/]+(Users|Documents and Settings)[\\/]+[A-Za-z0-9._ -]+|/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+' "$root" 2>/dev/null \
  | grep -vE ':/home/claude\.*$|:/Users/(Shared|example)\.*$' \
  | { if [ -n "${DG_HOME_OK:-}" ]; then grep -vE -e "$DG_HOME_OK"; else cat; fi; } || true)"
if [ -n "$homes" ]; then echo "confidentiality-scan: PERSONAL HOME PATH" >&2; echo "$homes" >&2; fail=1; fi
[ "$fail" = 0 ] && echo "confidentiality-scan: clean (email + home-folder checks)"
exit "$fail"
