# Rebase onto reconcile/0.3.14

main (a54f988, 0.4.0) forked from 0.3.5 and lacks live 0.3.6–0.3.14. The correct base is
`reconcile/0.3.14` in /home/claude/improve/dg-reconcile:

- 11a24c9 Sync to live 0.3.14 (exact copy of the installed synced plugin)
- f71ca88 Add answer checks for recurring misses (0.4.0) (a54f988 ported; 51/51 tests)

a54f988's content is already in f71ca88, so replay only your commits *after* a54f988.

## Commands (run in your own working dir, /home/claude/improve/dispatch-guard)

```bash
cd /home/claude/improve/dispatch-guard
git fetch /home/claude/improve/dg-reconcile reconcile/0.3.14:reconcile/0.3.14

# 1. Commit (or stash) uncommitted work first. improve/round2 currently has an uncommitted
#    hooks/register.ts change (+79 lines): commit it on your branch before rebasing.
git status --short

# 2. Replay your commits onto the reconciled base (replace <branch>):
#    improve-round2 → improve/round2 ; orch-tiering → improve/orch-tiering
git rebase --onto reconcile/0.3.14 a54f988 <branch>

# 3. Conflicts: expect them in hooks/register.ts (turn.complete builds `line` + `extra[]`;
#    0.3.14 adds parked-fix / miss-landing / finishing-write logic) and in
#    hooks/dispatch-guard.test.ts (append new tests after the board-dispatch test).
#    Keep both sides; then:
git add -A && git rebase --continue

# 4. Gate before handing back:
claude plugin test .        # all pass (base is 51)
claude plugin validate .    # "Validation passed" (ICON_MISSING warning is pre-existing)
```

Notes
- Version: base is 0.4.0; bump to 0.4.1+ in .claude-plugin/plugin.json for your change.
- orchestrator-proof on this base counts an injected chat-start card as a load
  (`orchestratorLoaded` state set at injection), so it stays silent while card injection works.
- `improve/orch-tiering` does not exist yet in that repo (checked 2026-11-06); create it from
  `reconcile/0.3.14`, not from main: `git switch -c improve/orch-tiering reconcile/0.3.14`.
- Do not branch from origin/main until it has been force-reset to reconcile/0.3.14.
