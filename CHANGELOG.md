# Changelog

One line per version, newest first. Every version bump adds its line here in the same commit. Sources: version comments in hooks/*.ts, README 0.6.x sections, git log. "no record" = no comment, README text or commit names that version.

- 0.6.24: speed meter on the deep-stats row (turn_ms_total, turn_count, turn_ms_max, judge_ms_total, checker_rounds_ms_total); auto-evidence digest is a rolling last 30 non-read-only calls across turns, SGT-timed.
- 0.6.23: dark_hits and dark_samples (last 3 snippets per id, 3000-char cap) in the deep-stats row.
- 0.6.22: rule checks run before the judge; DEEP_LINE lists rule checks; deep-stats fail_checks; generic auto-evidence digest (this turn); efficiency-fix goes live.
- 0.6.21: save-gate (dark by default), judge auto-evidence (Agent launches, sent messages), Efficiency-fix guard (ships dark), eta-proof on sent messages.
- 0.6.20: burst-safe mid-turn (queued J messages block other tools until answered; fold-in deny; valve).
- 0.6.19: deep-mode judge, session evidence, source gate (log-only), first-draft stats row, judge-evals harness.
- 0.6.18: per-session rolling evidence store; agent hand-backs and notifications count as evidence; "Session facts" line for the writer.
- 0.6.17: deep-mode failure cap (deep-cap), short replies skip the judge, token usage per judge call, privacy: Scoreboard rows carry generic labels only.
- 0.6.16: deep mode: pre-send check_reply tool and AI judge; final reply must be the passed draft; checks run on the draft.
- 0.6.15: reply modes (deep/light); prevention-line "why" check; unsaved-promise check.
- 0.6.14: dark checks (logged, never shown); ported answer checks (stop-dates, stop-figures, stop-sources, stop-writes, page-cite, stripDrafts).
- 0.6.13: no record.
- 0.6.12: no record.
- 0.6.11: unbacked-absolute and open-question checks; any-main-turn-tool-call flag.
- 0.6.10: hook-fire rows with self-catch metric; ask-first counts only knowable asks; "Gap:" line check.
- 0.6.9: no record.
- 0.6.8: per-session label and scope-phrase tracking; undefined-label, chat-long scope, question-edit, reuse-first checks; rule pack v12 keys.
- 0.6.7: live pack version shown on the upload line when not newer than bundled.
- 0.6.6: slim (some checks switched off in code); replay clock flag (dg-clock-offset); orchestrator card second sentence from the A/B.
- 0.6.5: no record.
- 0.6.4: per-prompt J rows and J-correction rows; subagent loop guard (3 repeated failing Bash or Edit calls).
- 0.6.3: done-claim read-back rule; style escalation owes a Correction line.
- 0.6.2: sleep log.
- 0.6.1: hook-fire rows (check id, session, SGT time); `requires` pack checks.
- 0.6.0: leap-line, source-addendum, arith-proof, repeat-miss; first-reply and mid-turn replace the silence and 4th-call guards; thresholds from THRESHOLDS.md.
- 0.5.9: judges J's own text, not the raw prompt with its prepended system-reminder.
- 0.5.8: rule pack: check regexes, thresholds and texts overridable without an upload.
- 0.5.7: dangling-ref: a "D1", "see below" or "next message" reference with nothing matching in the reply is flagged.
- 0.5.6: reply first, ledger and board in the same round or later; clock stamp rides every prompt.
- 0.5.0 to 0.5.5: no record.
- 0.4.0: answer checks for recurring misses.
- 0.3.5: /handoff slash-command turns exempt from the 4th-call reminder.
- 0.3.4: skip the 4th-call reminder in handoff turns.
- 0.3.3: synced to live.
- 0.3.2 and earlier: rule-guard and the initial dispatch-guard mod (git history only, no version numbers).
