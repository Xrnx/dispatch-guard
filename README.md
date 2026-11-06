# dispatch-guard

Reminds the orchestrator dispatcher to hand off work after 3 tool calls in a turn.

On the main thread's 4th tool call in a turn it appends a reminder to the tool result telling the model to hand the remaining work to a background agent and reply to the user. Agent, SendMessage, TaskCreate and TaskUpdate calls do not count, and subagent calls are ignored. It also flags foreground Bash calls that look long-running (node, python, npm test, playwright, sleep). It only warns: it never blocks or changes a tool call.

At the start of every chat (and again after /clear) it attaches one note to the first message telling the model to load the orchestrator skill before anything else, even for one-word or test messages. It fires once per chat.

running-proof: if a main-turn answer says "(running" with no launch id (agent, background Bash, trigger) from this turn and none still open from an earlier turn of the session, one correction line shows beneath the answer and reaches the model once with the next prompt.
idle-guard: a Bash `rm` of the orchestrator ledger, or an answer saying "ledger cleared"/"queue empty", adds one reminder to read open-items and every backlog first; at most once per turn, never blocks.
board-timestamp: an ArtifactData set/update/batch whose `updated` is unparseable or more than 5 min from the live clock adds one line to that result ("re-stamp from `date`"); at most once per turn, main thread only, never blocks.
answer checks (each adds at most one line beneath the main-turn answer, carried to the model once with the next prompt, never blocks):
- style: points over 20 words; blockquotes (`> `), tables and fenced code are exempt (verbatim quotes, paste-ready text).
- offer-guard: an offer waiting on J ("want me to…", "say so") with no "(needs you)" or D1/D2 question.
- verify-proof: "verified" with no source (link, path, `source:`) on its line, or unverified/TBC/[confirm] markers left in the answer.
- promise-proof: an Efficiency/Prevention line (not "none") or "from now on" with no write or dispatch tool this turn.
- orchestrator-proof: the chat got the orchestrator reminder but never loaded the skill; once per chat.
- board-dispatch: an Agent launch or ledger edit with no ArtifactData write this turn ("Status board not updated for this dispatch").

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
