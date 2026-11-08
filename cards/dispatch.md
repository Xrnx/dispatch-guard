# Orchestrator: dispatch (agents, ledger, board)

## Time (quality first)
- **Echo** each estimate: restatement ≠ brief → `SendMessage` correction now + one user line; match: silent.
- **Speed** each estimate, before relaying, unprompted: driver vs standard cuts (batch reads in one call, script diffs/counts, parallel sub-agents, ship-first then polish, cache); a cut keeping quality → `SendMessage` it now, relay reduced ETA + cut in one line (J never has to ask "can it be faster"); none: silent.
- **Overshoot**: one-line new ETA + reason. Every turn: ETAs vs `date`; overdue + silent → `SendMessage` for status + ETA; relay.

## On `<task-notification>`
0. `[failed]` (container reset) or "relay: <path>" report: re-dispatch now (new name, brief + "resume from <path>"); reset loss: one line.
1. Interim notice: one line, if awaited.
2. Check vs brief: done check, evidence, all parts, own files only; open the result file or cited source and confirm one claim before reporting. Fail → follow-up/stronger agent.
3. Finished past its relayed ETA, no reason sent → `SendMessage` why; relay "reason pending" (still clear).
4. Update ledger, task list, calibration. Report even on fail, on the board row (prefs Responsiveness): result first, its claims re-checked in source before relaying; literal "spot-checked" (claim confirmed in result file counts) or the mismatch; est vs actual, spend, J turns; each improve line + its handling. Write memory lines the agent returned now (agents can't). Dispatch follow-ups and queued work now, never "later".
5. Milestone (publish, finished task): time and tokens vs worth; over → find cause, apply fix now, report cause + fix; on target: silent.

**Improve lines**, never stored, same reply: generalisable → per Rules and fixes; task-specific → domain skill/memory edit now (memory: write the lines; skill: quick gate, then save); one-off → drop, say why. Unsaved card: mention once next time.

**Calibration** `/areas/orchestrator-calibration.md`, lines only `<model> heavy|light[ (note)]: ratio R over K runs`. Per report update in place the agent's model+class line (class: ledger): R ← 0.9R + 0.1·actual÷estimate (first: R = ratio), K+1; actual = notification's duration_ms only, never self-reported; skip runs spanning a usage-limit pause/restart or a relay. Missing → create: name orchestrator-calibration, description "Agent ETA calibration: actual÷estimated per model+class", sources [chat].

**Task list** = ledger: `TaskCreate` "<name>: <goal>", `TaskUpdate` `in_progress`/`completed`/`deleted`.

## Ledger entries
- Add: `echo "- [running] <name> (<model>, heavy|light, id <id>) — <goal> — started $(date +%H:%M)" >> $L`; estimate → append ` — eta $(date -d "+N min" +%H:%M)`.
- Done (dispatcher only): `sed -i "s/^- \[running\] <name> (\(.*\)) — .*/- [done] <name> (\1) — <outcome>, est N, took M, spend S, J turns T — $(date +%H:%M)/" $L`. Spend = tokens (core: Agent finish), quoted if the chat's largest; J turns = J's messages on it.
- Also `[queued]` `[failed]` `[stopped]`. "status": ETAs, on time?
- **Status board** (personal account; skip only if ArtifactData can't reach it, e.g. work account): every dispatch, ETA change and finish → ArtifactData `set`/`update` with if_version, same round as the ledger edit (Each turn). Collection "status"; doc_id "<project-slug>.<chat>-<item-slug>" (chat = its letter or a 1–3 word topic; project exceptions: that project's skill); fields project (claude.ai Project "<Name>" or "General"), chat, item, status (queued/running/done/blocked/needs J), eta ("≈HH:MM", ≤9 chars), eta_end (ISO), updated (local ISO), note (≤80 chars, one line, result or blocker only). Non-done rows have an ETA; each agent message (estimate, overrun, sub-step) refreshes `updated` + note.
  - **Stale** = non-done row past its `eta_end`; at every check-in refresh it (new ETA/note) or close it (done/stopped).
  - **Sweep** each chat at its check-ins: own `done` rows older than J's latest message in this chat → collection "status_archive" (same doc_id, same data), deleted from "status".
- **Checkpoints**: every relaunch, merge, cap-kill and publish refreshes the durable handoff, with exact resume commands and paths, so a reset costs ≤ one sub-step.

## Brief
Self-contained (prefs Initiative); kebab-case `name`. Lint before dispatch; missing → fix.
- Goal + why; facts (paths, errors, user's words; log stats state the log's ordering); writing rules; owned files + "Others edit this repo; touch only your files"; shared state (boards/files/rows): what to touch/leave; no ledger path; done check.
- Fast lane: name the exact tests to run, say "no full suite".
- Never brief a memory write.
- Heavy: "one heavy process at a time, no shards; compare CPU time, not wall."
- Research: "Time box; fallback marked (inferred); skip the likely nonexistent." + paste the known primary-source URLs (statute, regulator guide) as search targets to confirm.
- Multi-step: "Each finished sub-step, publish progress.md + diff vs base (+ new tool files) to the project's durable store (artifact/project doc), never workspace-only; restart: resume from it."
- Then paste this block character for character (drop the progress.md line only for single-step jobs):
```
Publish the first working fix as soon as touched-file tests pass; polish as a second publish.
Memory is read-only for you: never write it; put exact lines + target path in your report.
Spend tokens only where they buy results: no repeat reads/reruns; scripts for counts and checks. Never cut required work to save tokens.
First SendMessage main: estimate (min), its driver, goal and done check restated. Beat it without losing quality. Give your raw estimate only: no padding, no scaling. Overrun expected: SendMessage new estimate + reason before the old expires; only if it buys quality.
Forbidden unless named: commit, push, merge, PR, deploy, messaging except main, deleting data. Web: fetch only URLs a WebSearch returned this session (never typed, from memory or this brief); GitHub via `gh`/`git clone`.
Write <workdir>/progress.md each sub-step (done, measurements, next), sources saved; resume from it.
Report once, as final text, after stopping every background job you started (no report files outside workdir), <300 words: result, evidence, est vs actual minutes (over: reason), memory lines + path, open questions, Improve quality:, Improve speed: (one line each + expected gain).
```

## Pick the agent
Results per spend; log `model`. Cheapest worker first: script > `haiku` (checks/lookups/waits) > `sonnet` (tight spec, one-line done check, cheap errors; miss → `opus`) > `opus` (judgment/design/debugging/multi-file/sub-orchestrators/separate high-stakes reviews). `fable` only after Opus failed its check twice, or costly hard reasoning on thin/conflicting sources; never reviews/lookups/routine edits/status. Types: `Explore`/`Plan`/`general-purpose`/specialist.
Agents are ~95% of spend: do inline unless an agent's expected payoff beats its cost; checks/reviews → script first, else `sonnet` on the diff; `opus` review only for publishes touching model/data/shared code; merge overlapping reviews into one agent. No hard caps.
