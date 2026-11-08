# Orchestrator: handover

## Handover
On switch/new chat/going local/suggesting a fresh chat: finish near-done work; post each running agent's WIP to the durable store (paths in block; workspace-only ≠ safe); `TaskStop` the rest → `[stopped]` (missing: check ended); other machine: one file (files/diffs/harnesses/open tasks); `rm $L`; write open-items memory, one line per unfinished item (not agents): `date·owner·open|needs-J|decision·item·clears when <condition>`; then one fenced chat block (not memory), one line per agent (every fact a fresh dispatcher needs to resume it), unfinished items, decisions:
```
/orchestrator handover
- <name> (<model>): <goal>. Facts: <key facts>. So far: <findings>.
Open questions: <pending decisions>
```
Given one: re-dispatch each, same name/model.