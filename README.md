# dispatch-guard

Reminds the orchestrator dispatcher to hand off work after 3 tool calls in a turn.

On the main thread's 4th tool call in a turn it appends a reminder to the tool result telling the model to hand the remaining work to a background agent and reply to the user. Agent, SendMessage, TaskCreate and TaskUpdate calls do not count, nor do read-only calls (Read, Glob, Grep, ToolSearch, TaskGet, TaskList and any memory_read tool), and subagent calls are ignored. Finishing writes (Artifact publish, ArtifactData writes, memory_write/str_replace/append, propose_skills, SendUserMessage, SendUserFile) still count but never trigger the reminder (0.3.14); it fires once per turn, on the first non-finishing call at or past the 4th. It also flags foreground Bash calls that look long-running (node, python, npm test, playwright, sleep). It only warns: it never blocks or changes a tool call.

At the start of every chat (and again after /clear) it attaches one note to the first message telling the model to load the orchestrator skill before anything else, even for one-word or test messages. It fires once per chat.

Card injection (0.3.7): right after that note, the same first message also carries the orchestrator SKILL.md text itself (`hooks/orchestrator-card.ts`, tagged with the first 8 hex of its sha256), so a model that ignores the load instruction is still orchestrated: content needs no compliance. It is the one deliberate long context, once per chat; the model Skill-loads only if a newer orchestrator skill is listed. Run `scripts/sync-card.sh <SKILL.md>` after every orchestrator skill edit, then re-upload the zip.

Live card (0.3.9): at chat start the hook reads the synced orchestrator skill from disk (`/root/.claude/skills/synced/<sync-id>/orchestrator/SKILL.md`, newest mtime when several sync ids exist), strips its YAML frontmatter and injects that body tagged `(<sha256 first 8>, live)`, so skill edits reach new chats without a rebuild. If nothing readable is there, it falls back to the embedded card, tagged `embedded`. `scripts/sync-card.sh` now only refreshes that fallback: run it before a release so a host without the synced skill still gets a recent card. Any read error falls back; the hook never blocks.

Fail-safe card (0.3.10): the whole card build is wrapped, so any fs, store or runtime error falls back to the embedded card and the reminder plus card are still injected; the tag is FNV-1a 32-bit (8 hex, no crypto or TextEncoder needed), still marked `live` or `embedded`. The once-per-chat slot (state and store) is spent only after the injected prompt has gone through, so a throw can never use it up. The card ends with "If this card is absent in your context, Skill-load 'orchestrator'." Each chat-start injection writes `lastCard` to the plugin store: `{ at, source, tag, error?, root, files }`. To debug, read /root/.claude/plugins/store/dispatch-guard*.json → lastCard.

running-proof: if a main-turn answer says "(running" with no launch id (agent, background Bash, trigger) from this turn and none still open from an earlier turn of the session, one correction line shows beneath the answer and reaches the model once with the next prompt.
parked-fix: if a main-turn answer names a fix ("should be a cheap fix", "needs to be fixed") but no launch id came back and no Edit, Write, NotebookEdit or Artifact ran this turn, one correction line shows beneath the answer; "(needs you)" and past-tense reports are exempt, at most once per turn, never blocks.
miss-landing (0.3.11): if a main-turn answer has a line opening `Miss:`, `Correction:` or `Gap:` (after optional bold or bullet) and nothing landed this turn (no Edit, Write, NotebookEdit, Artifact, propose_skills or memory_write/append/str_replace tool, no launch id), one line shows beneath the answer: fix it this turn or say which existing rule covers it. "no fix", "no rule change", "already covers", "existing rule" and "(needs you)" are exempt. It shares the once-per-turn slot with parked-fix and wins when both match; never blocks.
idle-guard: a Bash `rm` of the orchestrator ledger, or an answer saying "ledger cleared"/"queue empty", adds one reminder to read open-items and every backlog first; at most once per turn, never blocks.
board-timestamp: an ArtifactData set/update/batch whose `updated` is unparseable or more than 5 min from the live clock adds one line to that result ("re-stamp from `date`"); at most once per turn, main thread only, never blocks.
answer checks (each adds at most one line beneath the main-turn answer, carried to the model once with the next prompt, never blocks):
- style: points over 20 words; blockquotes (`> `), tables and fenced code are exempt (verbatim quotes, paste-ready text).
- offer-guard: an offer waiting on J ("want me to…", "say so") with no "(needs you)" or D1/D2 question.
- verify-proof: "verified" with no source (link, path, `source:`) on its line, or unverified/TBC/[confirm] markers left in the answer.
- promise-proof: an Efficiency/Prevention line (not "none") or "from now on" with no write or dispatch tool this turn.
- orchestrator-proof: the chat was marked reminded but got no card and never loaded the skill; once per chat (dormant while card injection works).
- board-dispatch: an Agent launch or ledger edit with no ArtifactData write this turn ("Status board not updated for this dispatch").

- answer-first: J's message holds a yes/no question and the answer's first line has no yes/no or confidence label.
- lookup-first: "I don't know", "I can't see", or asking J for a screenshot/link/confirmation with no lookup tool (memory, chat search, files, web) this turn.
- eta-proof: a relayed "ETA/done N min" with no E×R scaling (the "(running, ETA …)" footer is exempt).
- checked-line: an option-seeking ask (best/which/recommend/options/vs) answered in 60+ words with no "checked: …" line.
- reask-guard: a correcting or re-asking prompt ("verified where", "are you sure", "why did you say", "I already told you"…) gets one context line before the answer; an answer with no "Correction:" line or confidence label then gets one line.
- verify-proof also accepts a "Sources:" line anywhere in the answer; idle-guard ignores idle words inside the "Next:" footer.
- corr-log (0.4.5): a J prompt that corrects or re-asks after an answer ("verified where", "are you sure", "just f i and j", "what is para 19"…; first 160 chars only; agent messages and notifications skipped) becomes a row queued in the plugin store (`corrLog`: date SGT, chat, words, category guess, covered false, count 1, auto true). Rows flush in one ArtifactData batch to the Claude Scoreboard's `corrections` collection only when `tool.check` already says allow (after the session's own ArtifactData write was approved), and again after each main-thread ArtifactData write; never prompts J, never blocks. Detector on 42 J corrections vs 68 other J turns: recall 81%, false alarms 3%.

## Install

At the prompt of a Claude Code session:

```
/plugin install dispatch-guard --marketplace Xrnx/dispatch-guard
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install dispatch-guard --marketplace Xrnx/dispatch-guard
```
