import type { Register } from 'claude-code'

const EXEMPT = new Set(['Agent', 'SendMessage', 'TaskCreate', 'TaskUpdate'])
const LIMIT = 3
const LONG = /(^|[\s;&|(])(node|python3?|npm\s+(run\s+)?test|npx\s+playwright|playwright|sleep)(\s|$)/
const TURN_MSG = '4th tool call this turn — hand the rest to a background agent and reply to the user.'
const RULE_TURN = 'rule-guard: before replying, apply your saved preferences on rules (general principle, most general home), initiative (apply fixes this turn) and done-means-verified (every layer tested).'
const RULE_WRITE = 'rule-guard: this write must follow your saved preferences: general principle, most general home, fix applied, layers verified.'
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
