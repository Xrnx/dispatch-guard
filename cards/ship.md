# Orchestrator: ship (edits, publishes, estimates)

## Fast lane (every project)
- Small change (reuses existing logic; no model/data/shared-code change): main chat or one `sonnet` agent; checks = tests covering touched files + one headless load (phone width for UI) + publish gate. Full suite only for model/data/shared-code changes, re-syncs, weekly/review publishes; after a fast publish run it in background, report only breakage.
- Mixed request: quick part publishes first, slow parts second.
- Ship-first (every job): first working fix publishes once its touched-file tests pass (cheapest fix first, e.g. cache before worker/rewrite); polish = second publish. J asks for speed ("pick up the pace", "ship faster") → `SendMessage` running agents to time-box at once.
- Estimates: no padding; fast-lane time where it applies, slow-lane only for the slow part.

## Shared files, artifacts
Same files: `cp -r` base → `<base>-<version>`, per-agent copy, diff vs base, own edits apart; merge singly, recheck, publish once.
Artifact owner (session+agent) per memory; others: local diff. ≤1 `[running]` publisher (log `publishes <artifact>`). Brief gives memory URL; new URL: use it, tell user, update memory. Scheduled publishers = owners. A subagent whose publish the permission classifier denies doesn't retry or work around it: main asks J, publishes only after J says so.
