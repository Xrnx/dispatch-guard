import type { Register } from 'claude-code'

const EXEMPT = new Set(['Agent', 'SendMessage', 'TaskCreate', 'TaskUpdate'])
const LIMIT = 3
const LONG = /(^|[\s;&|(])(node|python3?|npm\s+(run\s+)?test|npx\s+playwright|playwright|sleep)(\s|$)/
const TURN_MSG = '4th tool call this turn — hand the rest to a background agent and reply to the user.'
const RULE_TURN = 'rule-guard (J standing rule): before replying, (1) any rule, skill, memory or brief text you write states the general principle; a specific incident only as an "e.g."; (2) put it in the most general home that fits (Claude-wide: plugin or skill card, not a project file, unless it is project-only); (3) any fix or improvement you identify is applied this turn (edit, card, memory, dispatch), never only proposed or described; ask J only for irreversible or J-only decisions; (4) before saying a change is done, make it reach every layer it must (account preferences, project files, skills, plugins, running agents) and test each; report which layers were verified and which you could not reach.'
const RULE_WRITE = 'rule-guard check on this write: is every new line a general principle (facts only as e.g.)? Did you also apply the fix, not just record it? If not, redo it now.'
const WRITES = new Set(['propose_skills', 'mcp__memory__memory_write', 'mcp__memory__memory_str_replace', 'mcp__memory__memory_append'])
const BASH_MSG = 'Foreground Bash looks long-running (node/python/npm test/playwright/sleep) — use run_in_background or a background agent.'

export const register: Register = on => {
  let count = 0

  // Main loop only: a new main turn (user message or agent notification) resets the count.
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) count = 0
    return next(e)
  })

  // rule-guard: every user prompt carries the standing rule
  on('prompt.submit', ($, e, next) =>
    e.origin === undefined ? next({ ...e, context: [...(e.context ?? []), RULE_TURN] }) : next(e),
  )

  // Warn only: always run the tool, then append a reminder to its result.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const notes: string[] = []
    if (!EXEMPT.has(e.tool)) {
      count += 1
      if (count === LIMIT + 1) notes.push(TURN_MSG)
    }
    if (WRITES.has(e.tool)) notes.push(RULE_WRITE)
    if (e.tool === 'Bash' && !e.run_in_background && LONG.test(e.command)) notes.push(BASH_MSG)
    const ran = await next(e)
    if (notes.length === 0 || ran.deny !== undefined) return ran
    return { ...ran, context: [...(ran.context ?? []), ...notes] }
  }).catch(($, e, next) => next(e))
}
