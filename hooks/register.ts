import type { EngineInterface, Register } from 'claude-code'

const EXEMPT = new Set(['Agent', 'SendMessage', 'TaskCreate', 'TaskUpdate'])
const LIMIT = 3
const LONG = /(^|[\s;&|(])(node|python3?|npm\s+(run\s+)?test|npx\s+playwright|playwright|sleep)(\s|$)/
const TURN_MSG = '4th tool call this turn — hand the rest to a background agent and reply to the user.'
const START_MSG = "Load the orchestrator skill (Skill tool, skill 'orchestrator') before anything else in this chat, even for one-word or test messages."
const BASH_MSG = 'Foreground Bash looks long-running (node/python/npm test/playwright/sleep) — use run_in_background or a background agent.'
const RUNNING_MSG = '(running) claimed but nothing launched this turn — start it or say not started.'
const STYLE_MAX = 20
const styleMsg = (n: number) => `Style: ${n} points over ${STYLE_MAX} words last reply — fragments, ≤${STYLE_MAX} words per point.`
const GUARD_TAG = '[dispatch-guard]'
const IDLE_PROMPT = `${GUARD_TAG} Idle guard: read /areas/open-items.md and every /areas/*-backlog.md via memory_read now, dispatch what needs no J input, then reply in one line.`
const ARTIFACT_DATA = /(^|__)ArtifactData$/
const TS_TOLERANCE_MS = 5 * 60_000
const IDLE_MSG = 'Idle guard: read /areas/open-items.md and every /areas/*-backlog.md via memory_read, dispatch what needs no J input, then clear.'

// offer-guard: an answer that ends on an offer waiting on J ("want me to…?", "say so") instead of doing
// the step. "(needs you)" and D1/D2 decision questions are the legitimate forms, so they exempt it.
const OFFER = /\b(want me to|shall I|should I|would you like|if you'?d like|say so|say the word|let me know if)\b/i
const DECISION = /\(needs you\)|^\s*\**D\d+\b/im
const OFFER_MSG = 'offer-guard: offer waiting on J — do it now if reversible, else mark it (needs you).'
// verify-proof: "verified" needs a source on its own line (link, path or "source:"); quoted uses are not
// claims. Unverified/TBC markers in an answer mean a checkable fact went out unchecked.
const VERIFIED = /(?<![\w"'`“‘])(?<!un)verified\b(?!["'`”’])/i
const SOURCE = /https?:\/\/|\]\(|(^|[\s(`])\/[\w.-]+\/|\bsource:/i
const UNCHECKED = /(?<![\w"'`“‘])(unverified|to be confirmed|TBC|\[(confirm|check|verify)\b)(?!["'`”’])/i
const verifyMsg = (n: number, m: number) =>
  `verify-proof: ${[n ? `${n} "verified" with no source on its line` : '', m ? `${m} unverified/TBC markers` : ''].filter(Boolean).join(', ')} — add the source or check it now with own tools.`
// promise-proof: an Efficiency/Prevention line or "from now on" with no write or dispatch this turn.
const PROMISE = /^[\s>*_-]*(\*\*)?(Efficiency|Prevention):(\*\*)?\s*(?!(\*\*)?none\b)[^\s*]|\bfrom now on\b/im
const WRITE_TOOL = /^(Edit|Write|NotebookEdit|Bash|ArtifactData|Artifact|Agent|Task|SendMessage)$|memory_(?!read|list|search)\w+$|__(update|batch|create|create_trigger|send_later)$/
const PROMISE_MSG = 'promise-proof: Efficiency/Prevention/"from now on" with no write or dispatch this turn — make the change now or delete the line.'
// board-dispatch: an agent launched or the ledger edited with no status-board write this turn.
const LEDGER_PATH = /(^|\/)\.claude\/orchestrator\//
const LEDGER_WRITE = /(>>?|\btee\b|\bsed\s+-i\b)[^;&|\n]*?(\$\{?L\}?\b|\.claude\/orchestrator\/)/
const BOARD_MSG = 'Status board not updated for this dispatch — post it via ArtifactData before replying.'
export const editsLedger = (e: Record<string, unknown>): boolean =>
  ((e.tool === 'Edit' || e.tool === 'Write') && LEDGER_PATH.test(String(e.file_path ?? '')))
  || (e.tool === 'Bash' && LEDGER_WRITE.test(String(e.command ?? '')))
// orchestrator-proof: the chat was told to load the orchestrator skill and no Skill call loaded it.
const ORCH_SKILL = /(^|:)orchestrator$/
const ORCH_MSG = "orchestrator-proof: orchestrator skill not loaded this chat — Skill-load 'orchestrator' before the next step."

// running-proof: a reply's "(running" needs a launch id from a tool result this turn, or one from an
// earlier turn of the session that no notification has reported finished yet.
const RUNNING = /\(running/i
const AGENT_TOOLS = new Set(['Agent', 'Task'])
const TRIGGER_TOOL = /(^|__)(create_trigger|send_later)$/
const AGENT_ID = /\b(?:agentId|agent_id|agent|id)\b["']?\s*[:=]\s*["']?([\w-]{4,})/
const RESUMED_ID = /\bresumedAgentId\b["']?\s*[:=]\s*["']?([\w-]{4,})/
const BG_ID = /Command running in background with ID:?\s*([\w-]+)/
const TRIGGER_ID = /\btrigger_id\b["']?\s*[:=]\s*["']?([\w-]{4,})/
// A task notification that a launch ended: its id, when the status is a final one.
const DONE_NOTE = /<task-notification>[\s\S]*?<\/task-notification>/g
const NOTE_ID = /<(?:task-id|task_id|agent-id|agentId)>\s*([\w-]+)\s*</
const NOTE_FINAL = /<status>\s*(completed|failed|killed|stopped|cancelled|error)\s*</i
// idle-guard: removing the orchestrator ledger, or saying it is cleared / the queue is empty.
const LEDGER_RM = /(^|[\s;&|(])rm\b[^;&|\n]*?(\s["']?\$\{?L\}?["']?(?=$|[\s;&|)])|(~|\$HOME)?\/?\.claude\/orchestrator\/)/
// "(needs you)" is the legitimate footer for work waiting on J, so it is no idle miss.
const NEEDS_J = /\(needs you\)/i
const IDLE_TEXT = /ledger cleared|queue empty|nothing (is )?(running|queued|due)|all (items )?blocked|(blocked|waiting) on J\b|\b(going|staying|remain(ing)?|now|am|i'm) idle\b|\bidle until\b/i

// board-timestamp: the first `updated` in an ArtifactData write (data, or writes[].data) that is not
// within 5 min of the live clock; a missing `updated` is no miss, an unparseable one is.
export const staleStamp = (e: unknown, now: number = Date.now()): string | undefined => {
  const o = e as Record<string, unknown>
  if (!['set', 'update', 'batch'].includes(String(o.action))) return undefined
  const datas: unknown[] = [o.data, ...(Array.isArray(o.writes) ? o.writes.map(w => (w as Record<string, unknown> | null)?.data) : [])]
  for (const d of datas) {
    if (typeof d !== 'object' || d === null) continue
    const v = (d as Record<string, unknown>).updated
    if (v === undefined || v === null) continue
    const t = typeof v === 'string' ? Date.parse(v) : NaN
    if (Number.isNaN(t)) return `board-timestamp: \`updated\` ${JSON.stringify(v)} is unparseable — re-stamp from \`date\`.`
    const min = Math.round(Math.abs(now - t) / 60_000)
    if (Math.abs(now - t) > TS_TOLERANCE_MS) return `board-timestamp: \`updated\` ${v as string} is ${min} min off the live clock — re-stamp from \`date\`.`
  }
  return undefined
}

// Points over STYLE_MAX words: each bullet or paragraph outside code blocks; tables and code skipped.
export const longPoints = (answer: string): number => {
  let n = 0
  let para: string[] = []
  const flush = () => {
    if (para.join(' ').split(/\s+/).filter(Boolean).length > STYLE_MAX) n++
    para = []
  }
  let fenced = false
  for (const raw of answer.split('\n')) {
    const l = raw.trim()
    if (/^(```|~~~)/.test(l)) { flush(); fenced = !fenced; continue }
    // Tables, code and blockquotes (verbatim quotes, paste-ready text) are exempt from the word cap.
    if (fenced || l.startsWith('|') || l.startsWith('>')) { if (!fenced) flush(); continue }
    if (l === '') flush()
    else if (/^([-*+]|\d+[.)])\s/.test(l)) { flush(); para.push(l.replace(/^([-*+]|\d+[.)])\s+/, '')) }
    else para.push(l)
  }
  flush()
  return n
}

// Answer lines outside fenced code: what the text checks read.
const proseLines = (answer: string): string[] => {
  let fenced = false
  return answer.split('\n').filter(raw => {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; return false }
    return !fenced
  })
}
export const offers = (answer: string): boolean => {
  const lines = proseLines(answer).filter(l => !l.trim().startsWith('>'))
  return !DECISION.test(answer) && lines.some(l => OFFER.test(l))
}
// [unsourced "verified" lines, unverified/TBC markers]; blockquoted drafts count.
export const unverified = (answer: string): [number, number] => {
  const lines = proseLines(answer)
  return [lines.filter(l => VERIFIED.test(l) && !SOURCE.test(l)).length, lines.filter(l => UNCHECKED.test(l)).length]
}
export const promises = (answer: string): boolean => proseLines(answer).some(l => PROMISE.test(l))
export const writes = (tool: string): boolean => WRITE_TOOL.test(tool)

type Ran = { deny?: string; isError?: true; result?: unknown; text?: string }
const field = (r: unknown, k: string): string | undefined => {
  if (typeof r !== 'object' || r === null) return undefined
  const v = (r as Record<string, unknown>)[k]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
// The launch id a tool result proves (an agent, a background command, a scheduled task), else undefined.
export const launched = (tool: string, ran: Ran): string | undefined => {
  if (ran.deny !== undefined || ran.isError) return undefined
  const text = ran.text ?? (typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? ''))
  if (AGENT_TOOLS.has(tool)) {
    // A foreground agent that already finished launched nothing still running.
    if (field(ran.result, 'status') === 'completed') return undefined
    return field(ran.result, 'agentId') ?? field(ran.result, 'id') ?? AGENT_ID.exec(text)?.[1]
  }
  if (tool === 'SendMessage') return field(ran.result, 'resumedAgentId') ?? RESUMED_ID.exec(text)?.[1]
  if (tool === 'Bash') return field(ran.result, 'backgroundTaskId') ?? BG_ID.exec(text)?.[1]
  if (TRIGGER_TOOL.test(tool)) return field(ran.result, 'trigger_id') ?? TRIGGER_ID.exec(text)?.[1]
  return undefined
}
// The ids a turn's opening text reports as finished (task notifications with a final status).
export const finished = (text: string): string[] =>
  (text.match(DONE_NOTE) ?? []).filter(n => NOTE_FINAL.test(n)).flatMap(n => NOTE_ID.exec(n)?.[1] ?? [])
export const unproven = (reply: string, proof: boolean): boolean => !proof && RUNNING.test(reply)
export const removesLedger = (command: string): boolean => LEDGER_RM.test(command)

// Which chat was last reminded, keyed by session id: $.state survives a hot reload,
// $.store survives a reinstall or re-save, and a /clear starts a new session id.
const remindedSession = { plugin: 'dispatch-guard', key: 'remindedSession' } as const
// Launch ids proven in this session and not yet reported finished; survives a hot reload.
const openLaunches = { plugin: 'dispatch-guard', key: 'openLaunches' } as const
// The session that loaded the orchestrator skill, and the one already told it had not.
const orchLoaded = { plugin: 'dispatch-guard', key: 'orchestratorLoaded' } as const
const orchNagged = { plugin: 'dispatch-guard', key: 'orchestratorNagged' } as const
const KEEP_LAUNCHES = 100
const STORE_KEY = 'remindedSessions'
const KEEP = 200

// A finished launch leaves the open set: a task notification opening a main turn, or the end of
// a subagent's run (every hook hears an agent's end).
async function close($: EngineInterface, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const open = (await $.state.get(openLaunches)).value ?? []
  if (open.some(id => ids.includes(id))) await $.state.set(openLaunches, open.filter(id => !ids.includes(id)))
}
async function remember($: EngineInterface, id: string): Promise<void> {
  const open = (await $.state.get(openLaunches)).value ?? []
  if (!open.includes(id)) await $.state.set(openLaunches, [...open, id].slice(-KEEP_LAUNCHES))
}
async function openCount($: EngineInterface): Promise<number> {
  return ((await $.state.get(openLaunches)).value ?? []).length
}

export const register: Register = on => {
  let count = 0
  let handoffTurn = false // the handoff skill was loaded this main turn: no 4th-call reminder
  let pendingHandoff = false // a /handoff slash command was submitted; its turn is a handoff turn
  let proof = false // a launch id came back this main turn
  let stampFired = false // the board-timestamp lint went out this main turn
  let idleFired = false // the idle-guard reminder went out this main turn
  let wrote = false // a write or dispatch tool ran this main turn
  let dispatched = false // an agent was launched or the ledger edited this main turn
  let boarded = false // an ArtifactData write ran this main turn
  let fromGuard = false // this main turn began with the guard's own continuation prompt
  let submitted = false // the guard submitted a continuation not yet started
  let carry: string | undefined // the end-of-turn line, for the model with the next prompt only

  // Once per chat: attach the orchestrator instruction to the first prompt, before the model's first reply.
  // Re-arms on a new session id (startup, /clear), so it needs no SessionStart hook.
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined) {
      if (/(^|:)handoff$/.test(e.command.name)) pendingHandoff = true
      return next(e)
    }
    await close($, finished(e.text)) // a notification may arrive as a submitted prompt
    if (carry !== undefined) {
      e = { ...e, context: [...(e.context ?? []), carry] }
      carry = undefined
    }
    const id = await $.session.id()
    if ((await $.state.get(remindedSession)).value === id) return next(e)
    const stored = await $.store.get(STORE_KEY)
    const seen = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []
    await $.state.set(remindedSession, id)
    if (seen.includes(id)) return next(e)
    await $.store.set(STORE_KEY, [...seen, id].slice(-KEEP))
    return next({ ...e, context: [...(e.context ?? []), START_MSG] })
  }).catch(($, e, next) => next(e))

  // Main loop only: a new main turn (user message or agent notification) resets the count.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      count = 0
      handoffTurn = pendingHandoff
      pendingHandoff = false
      proof = false
      idleFired = false
      stampFired = false
      wrote = false
      dispatched = false
      boarded = false
      fromGuard = submitted || e.text.trimStart().startsWith(GUARD_TAG)
      submitted = false
      await close($, finished(e.text))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Warn only: always run the tool, then append a reminder to its result.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const notes: string[] = []
    // A handoff resume/write turn is a short fixed sequence; handing it to an agent only slows it.
    if (e.tool === 'Skill' && /(^|:)handoff$/.test(String((e as Record<string, unknown>).skill ?? ''))) handoffTurn = true
    if (!EXEMPT.has(e.tool)) {
      count += 1
      if (count === LIMIT + 1 && !handoffTurn) notes.push(TURN_MSG)
    }
    if (e.tool === 'Bash' && !e.run_in_background && LONG.test(e.command)) notes.push(BASH_MSG)
    if (e.tool === 'Bash' && !idleFired && removesLedger(e.command)) {
      idleFired = true
      notes.push(IDLE_MSG)
    }
    if (!stampFired && ARTIFACT_DATA.test(e.tool)) {
      const miss = staleStamp(e)
      if (miss !== undefined) {
        stampFired = true
        notes.push(miss)
      }
    }
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      if (writes(e.tool)) wrote = true
      if (ARTIFACT_DATA.test(e.tool) && ['set', 'update', 'batch'].includes(String((e as Record<string, unknown>).action))) boarded = true
      if (AGENT_TOOLS.has(e.tool) || editsLedger(e as unknown as Record<string, unknown>)) dispatched = true
      if (e.tool === 'Skill' && ORCH_SKILL.test(String((e as Record<string, unknown>).skill ?? ''))) {
        await $.state.set(orchLoaded, await $.session.id())
      }
    }
    const id = launched(e.tool, ran)
    if (id !== undefined) {
      proof = true
      await remember($, id)
    }
    if (notes.length === 0 || ran.deny !== undefined) return ran
    return { ...ran, context: [...(ran.context ?? []), ...notes] }
  }).catch(($, e, next) => next(e))

  // End of the main turn: never blocks or re-prompts. At most one line beneath the answer (an
  // unproven "(running" claim, or an idle claim with no ledger check), handed to the model once
  // with the next prompt so it acts on it then.
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined) {
      await close($, [e.agentId])
      return ran
    }
    if (e.reason !== 'answer') return ran
    let line: string | undefined
    if (RUNNING.test(e.answer) && unproven(e.answer, proof || (await openCount($)) > 0)) line = RUNNING_MSG
    else if (!idleFired && IDLE_TEXT.test(e.answer) && !NEEDS_J.test(e.answer)) line = IDLE_MSG
    let continued = false
    if (line === IDLE_MSG) {
      idleFired = true
      // Idle claim with nothing open: one continuation turn, never from the guard's own turn.
      if (!fromGuard && (await openCount($)) === 0) {
        submitted = true
        void $.prompt.submit({ text: IDLE_PROMPT })
        continued = true
      }
    }
    const extra: string[] = []
    if (line !== IDLE_MSG && offers(e.answer)) extra.push(OFFER_MSG)
    const [n, m] = unverified(e.answer)
    if (n + m > 0) extra.push(verifyMsg(n, m))
    if (!wrote && promises(e.answer)) extra.push(PROMISE_MSG)
    if (dispatched && !boarded) extra.push(BOARD_MSG)
    const sid = await $.session.id()
    if ((await $.state.get(remindedSession)).value === sid && (await $.state.get(orchLoaded)).value !== sid
      && (await $.state.get(orchNagged)).value !== sid) {
      await $.state.set(orchNagged, sid)
      extra.push(ORCH_MSG)
    }
    const long = longPoints(e.answer)
    if (long > 0) extra.push(styleMsg(long))
    const all = [...(line === undefined ? [] : [line]), ...extra].join(' ')
    if (all === '') return ran
    if (!continued || all !== IDLE_MSG) carry = all
    return { ...ran, text: all }
  }).catch(($, e, next) => next(e))
}
