# dispatch-guard

Reminds the orchestrator dispatcher to hand off work after 3 tool calls in a turn.

On the main thread's 4th tool call in a turn it appends a reminder to the tool result telling the model to hand the remaining work to a background agent and reply to the user. Agent, SendMessage, TaskCreate and TaskUpdate calls do not count, and subagent calls are ignored. It also flags foreground Bash calls that look long-running (node, python, npm test, playwright, sleep). It only warns: it never blocks or changes a tool call.

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
