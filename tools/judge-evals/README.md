# judge-evals

Replay harness for dispatch-guard's deep-mode judge rules (`JUDGE_RULES` in hooks/rulepack.ts, overridable by rule pack key `deep-judge.messages.rules`).

**Rule: a judge-rules change ships only if `gate.sh <current> <candidate>` prints `RESULT: OK`.** No gate pass, no ship.

## Run
```
./extract-rules.sh /path/to/hooks/register.ts      # or an unzipped plugin dir -> rules/current.txt
./run.sh rules/current.txt [--reps 2]              # metrics for one rules file
./gate.sh rules/current.txt rules/candidate.txt    # exit 0 only if candidate FP <= current FP and catch >= current catch
```
Each case x rep is one `claude -p --model haiku --tools "" --settings '{"disableAllHooks":true}'` call, system = rules, prompt = same layout as `judgeReply` in register.ts. Results are cached in `cache/` by sha256(rules + prompt + model + rep); only parsed verdicts are cached. Cost = cases x reps fresh calls per rules file (25 x 2 = 50); a re-run of unchanged rules costs 0. `RESULT: OK` from run.sh only means every verdict parsed; the gate does the grading.

## Add a case
Create `cases/<id>.json`:
`{id, kind: "benign"|"bad", ask, evidence, hook_evidence, draft, expect: "ok"|"problem", expect_tag?: "a"|"b"|"c"|"d", acted?: bool, note}`
- `hook_evidence` "(none)" renders as "tools run: no"; `acted: true` renders "writes/actions: yes".
- Tags: a contradicted claim, b unsupported done/verified claim, c undone work, d question unanswered.
- No real names, clients, matters or emails: use placeholders ("the buyer", "Project X").
- A benign case must be one the live judge should pass; add every real false positive and every real miss as a case.

## Caveats
- Haiku is non-deterministic; reps of 2 is a smoke level. Use `--reps 4` for close calls; ties pass.
- The harness omits the optional standing-rules system block (user preferences), so it tests JUDGE_RULES alone.
- Small suite (14 benign, 11 bad): one flip moves rates by ~3.6 / ~4.5 points per rep.
