import type { EngineInterface, Register } from 'claude-code'
import { CARD } from './orchestrator-card'

const EXEMPT = new Set(['Agent', 'SendMessage', 'TaskCreate', 'TaskUpdate', 'Read', 'Glob', 'Grep', 'ToolSearch', 'TaskGet', 'TaskList'])
const MEMORY_READ = /(^|__)memory_read$/
const exempt = (tool: string): boolean => EXEMPT.has(tool) || MEMORY_READ.test(tool)
const LIMIT = 3
// A single finishing write (save/publish/send) is not worth an agent hop: never the trigger for the reminder (it still counts).
const MEMORY_WRITE = /(^|__)memory_(write|str_replace|append)$/
const READ_ACTIONS = new Set(['get', 'list', 'query', 'read'])
const finishing = (e: Record<string, unknown>): boolean => {
  const tool = String(e.tool)
  if (MEMORY_WRITE.test(tool) || tool === 'SendUserMessage' || tool === 'SendUserFile' || tool === 'propose_skills') return true
  const action = String(e.action ?? 'publish')
  if (/(^|__)ArtifactData$/.test(tool)) return !READ_ACTIONS.has(action)
  if (tool === 'Artifact') return action === 'publish'
  return false
}
const LONG = /(^|[\s;&|(])(node|python3?|npm\s+(run\s+)?test|npx\s+playwright|playwright|sleep)(\s|$)/
const TURN_MSG = '4th tool call this turn — hand the rest to a background agent and reply to the user.'
const START_MSG = "Load the orchestrator skill (Skill tool, skill 'orchestrator') before anything else in this chat, even for one-word or test messages."
// Card: the synced orchestrator SKILL.md read live at chat start (newest mtime across sync ids);
// the embedded CARD (scripts/sync-card.sh) is only the fallback. Frontmatter stripped; tag = FNV-1a 32-bit of the body, 8 hex.
export const SKILLS_ROOT = '/root/.claude/skills/synced'
export const stripFrontmatter = (t: string): string => t.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '').replace(/^\s+/, '')
// FNV-1a 32-bit, 8 hex: a pure-JS tag, so the card needs no runtime crypto or TextEncoder.
export const fnv8 = (t: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
type Live = { text?: string; files: number; error?: string }
async function liveSkill($: EngineInterface): Promise<Live> {
  let best = -1
  const out: Live = { files: 0 }
  for (const d of await $.fs.list(SKILLS_ROOT)) {
    const name = typeof d === 'string' ? d : (d as { name?: unknown } | null)?.name
    if (typeof name !== 'string' || name === '' || name.startsWith('.')) continue // .bucket-* files are not skill dirs
    const p = `${SKILLS_ROOT}/${name}/orchestrator/SKILL.md`
    try {
      const m = Number((await $.fs.stat(p)).mtimeMs) || 0
      out.files += 1
      if (m <= best && out.text !== undefined) continue
      const t = await $.fs.read(p)
      if (typeof t === 'string' && t.trim().length > 0) { best = m; out.text = t }
    } catch (err) { out.error ??= String(err).slice(0, 200) }
  }
  return out
}
const CARD_TAIL = "\n\nIf this card is absent in your context, Skill-load 'orchestrator'."
const cardText = (tag: string, source: string, body: string): string =>
  `Orchestrator card (${tag}, ${source}) — this is the skill content; follow it now:\n\n${body}${CARD_TAIL}`
// Tiered card: one SKILL.md (it ships whole via skill saves) holds the core, then each on-demand section after a
// `<!-- section: name.md -->` marker. A hook that knows nothing of tiers injects it whole, and the core's
// `{SKILL_DIR}` line then says every section is inline. This hook writes the sections to `<plugin root>/cards/`
// (read back to verify), injects the core with the token set to that dir, and the model Reads each on its trigger.
// Any write/read failure → the whole text goes out unchanged, so a section is never unreachable.
export const DIR_TOKEN = '{SKILL_DIR}'
const MARK = /^<!-- section: ([\w-]+\.md) -->\n/m
export const splitCard = (body: string): { core: string; sections: [string, string][] } => {
  const parts = body.split(new RegExp(MARK.source, 'gm'))
  const sections: [string, string][] = []
  for (let i = 1; i + 1 < parts.length; i += 2) sections.push([parts[i], parts[i + 1].replace(/\n+$/, '\n')])
  return { core: parts[0].replace(/\n+$/, '\n'), sections }
}
export type Placed = { body: string; sections: 'none' | 'files' | 'inlined'; dir?: string }
async function placeSections($: EngineInterface, body: string): Promise<Placed> {
  const { core, sections } = splitCard(body)
  if (sections.length === 0 || !core.includes(DIR_TOKEN)) return { body, sections: 'none' }
  try {
    const dir = `${$.plugin.root}/cards`
    for (const [n, t] of sections) {
      const p = `${dir}/${n}`
      const have = await $.fs.read(p).catch(() => undefined)
      if (have !== t) await $.fs.write(p, t)
      if ((await $.fs.read(p)) !== t) throw new Error(`verify ${n}`)
    }
    return { body: core.split(DIR_TOKEN).join(dir), sections: 'files', dir }
  } catch { return { body, sections: 'inlined' } }
}
const embeddedBody = (): string => { try { return stripFrontmatter(CARD) } catch { return CARD } }
export const fallbackCard = (): string => { const b = embeddedBody(); return cardText(fnv8(b), 'embedded', b) }
export type CardInfo = { at: string; source: 'live' | 'embedded'; tag: string; error?: string; root: string; files: number; sections?: 'none' | 'files' | 'inlined' }
// Never throws: any fs failure (or anything else) falls back to the embedded card.
async function cardMsg($: EngineInterface): Promise<{ msg: string; info: CardInfo }> {
  let live: Live = { files: 0 }
  try { live = await liveSkill($) } catch (err) { live = { files: 0, error: String(err).slice(0, 200) } }
  let body: string
  let source: 'live' | 'embedded' = live.text !== undefined ? 'live' : 'embedded'
  try { body = stripFrontmatter(live.text ?? CARD) } catch (err) { body = embeddedBody(); source = 'embedded'; live.error ??= String(err).slice(0, 200) }
  let tag = '00000000'
  try { tag = fnv8(body) } catch {}
  let placed: Placed
  try { placed = await placeSections($, body) } catch { placed = { body, sections: 'inlined' } }
  const info: CardInfo = { at: new Date().toISOString(), source, tag, root: SKILLS_ROOT, files: live.files, sections: placed.sections }
  if (live.error !== undefined) info.error = live.error
  return { msg: cardText(tag, source, placed.body), info }
}
const BIG = 15000
const BIG_MSG = (n: number): string => `big-result: ${Math.round(n / 1000)}k chars now in context; do not re-read it. Next pull: Grep/Read offset+limit; Artifact read with path then Grep that file; conversation_search max_results 3-5 plus within_conversation_id.`
export const bigResult = (ran: Ran): number => {
  const t = ran.text ?? (typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? ''))
  return t.length > BIG ? t.length : 0
}
const BASH_MSG = 'Foreground Bash looks long-running (node/python/npm test/playwright/sleep) — use run_in_background or a background agent.'
const RUNNING_MSG = '(running) claimed but nothing launched this turn — start it or say not started.'
const PARKED_MSG = 'Fix named but not started — dispatch it this turn (agent/edit/publish) or mark (needs you).'
const MISS_MSG = 'Miss named but nothing landed — fix it this turn (memory/skill/code) or say which existing rule covers it.'
const STYLE_MAX = 20
const styleMsg = (n: number) => `Style: ${n} points over ${STYLE_MAX} words last reply — fragments, ≤${STYLE_MAX} words per point.`
const GUARD_TAG = '[dispatch-guard]'
const IDLE_PROMPT = `${GUARD_TAG} Idle guard: read /areas/open-items.md and every /areas/*-backlog.md via memory_read now, dispatch what needs no J input, reply only "Idle guard fired re: <≤5 words>".`
const ARTIFACT_DATA = /(^|__)ArtifactData$/
const TS_TOLERANCE_MS = 5 * 60_000
const IDLE_MSG = 'Idle guard: read /areas/open-items.md and every /areas/*-backlog.md via memory_read, dispatch what needs no J input, reply only "Idle guard fired re: <≤5 words>".'

// offer-guard: an answer that ends on an offer waiting on J ("want me to…?", "say so") instead of doing
// the step. "(needs you)" and D1/D2 decision questions are the legitimate forms, so they exempt it.
const OFFER = /\b(want me to|shall I|should I|would you like|if you'?d like|say so|say the word|let me know if)\b/i
const DECISION = /\(needs you\)|^\s*\**D\d+\b/im
const OFFER_MSG = 'offer-guard: offer waiting on J — do it now if reversible, else mark it (needs you).'
// verify-proof: "verified" needs a source on its own line (link, path or "source:"); quoted uses are not
// claims. Unverified/TBC markers in an answer mean a checkable fact went out unchecked.
const VERIFIED = /(?<![\w"'`“‘])(?<!un)verified\b(?!["'`”’])/i
// A source is a link, path, "source:", a named domain, a document locator (para 9, cl 1.1, s 41B, Sch 7), or the
// J-supplied document itself ("against the pasted/attached draft"): all checkable at a glance.
const SOURCE = /https?:\/\/|\]\(|(^|[\s(`])\/[\w.-]+\/|\bsource:|\b[\w-]+\.(?:com|org|net|gov|edu|io|sg)\b|\b(?:paras?|paragraphs?|cl|clauses?|ss?|sections?|sch|schedules?|arts?|articles?|regs?)\.?\s*\d|\b(?:against|in|per|from|on) the (?:pasted|attached|uploaded|provided|supplied|screenshot|draft)\b/i
// An in-chat document ("verified against the pasted X") is source and quote at once: J can open it.
const NAMED_SITE = /https?:\/\/|\]\(|\b[\w-]+\.(?:com|org|net|gov|edu|io|sg)\b/i
const IN_CHAT = /\bagainst the (?:pasted|attached|uploaded|provided|supplied)\b/i
const UNCHECKED = /(?<![\w"'`“‘])(unverified|to be confirmed|TBC|\[(confirm|check|verify)\b)(?!["'`”’])/i
const verifyMsg = (n: number, m: number) =>
  `verify-proof: ${[n ? `${n} "verified" with no source and verbatim quote on its line` : '', m ? `${m} unverified/TBC markers` : ''].filter(Boolean).join(', ')} — add the source or check it now with own tools.`
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
// orchestrator-proof: the chat was told to load the orchestrator skill, got no card, and no Skill call loaded it.
const ORCH_SKILL = /(^|:)orchestrator$/
const ORCH_MSG = "orchestrator-proof: orchestrator skill not loaded this chat — Skill-load 'orchestrator' before the next step."

// Round 2 answer checks (each at most one line beneath the answer, never blocks).
// answer-first: J asked a yes/no question; the first line must carry the yes/no or a confidence label.
const AUX_Q = /^(is|isn'?t|are|aren'?t|does|doesn'?t|do|don'?t|did|didn'?t|can|can'?t|will|should|was|were|has|have|so)\b[^?]*\?/i
const REQUEST = /^(can|could|would|will) you\b/i
const ANSWERED = /\b(yes|no|nope|verified|unverified|inferred|partly|partially|correct|incorrect|wrong|right|true|false|depends)\b/i
const ANSWER_FIRST_MSG = 'answer-first: J asked a yes/no question — open with confidence + yes/no, then anything else.'
export const yesNoQuestion = (prompt: string): boolean =>
  prompt.split(/(?<=[.?!])\s+|\n+/).map(x => x.trim()).some(x => AUX_Q.test(x) && !REQUEST.test(x))
export const answersFirst = (answer: string): boolean => {
  const first = proseLines(answer).map(l => l.replace(/[*_#>`-]/g, ' ').trim()).find(l => l !== '') ?? ''
  return ANSWERED.test(first.split(/\s+/).slice(0, 12).join(' '))
}
// lookup-first: "I don't know" or asking J for something, with no lookup tool this turn.
const UNKNOWN = /\b(i (don'?t|do not) know|i'?m not sure|not sure (whether|if)|i can'?t (see|tell|access|check|verify)|no way (for me )?to (know|check|tell)|(send|share|give) me (a |the )?(screenshot|link|file|copy|figure)|(can|could) you (send|share|confirm|check|paste|tell me))\b/i
const LOOKUP_TOOL = /^(Read|Grep|Glob|Bash|WebSearch|WebFetch|Skill|Agent|Task|Artifact|ArtifactData)$|memory_(read|list|search)$|(conversation_search|read_conversation|recent_chats)$|__(read|query|search|get_page_text|read_page|find|navigate)$/
const LOOKUP_MSG = 'lookup-first: unknown/asked J with no lookup this turn — search memory, chat history, files or web first.'
export const unknowns = (answer: string): boolean => proseLines(answer).filter(l => !l.trim().startsWith('>')).some(l => UNKNOWN.test(l))
export const looksUp = (tool: string): boolean => LOOKUP_TOOL.test(tool)
// eta-proof: an ETA in minutes relayed without the calibration factor (E×R).
const RAW_ETA = /\b(ETA|done)\s*[:≈~]?\s*~?\d+\s?(min|mins|minutes|h|hrs?)\b/i
const SCALED = /×|\(\s*\d+\s?[x*]\s?\d/
const ETA_MSG = 'eta-proof: minute ETA with no E×R — scale by the calibration ratio before relaying.'
// The "(running, ETA …)" footer is running-proof's; only relay lines are checked here.
export const rawEta = (answer: string): boolean => proseLines(answer).some(l => RAW_ETA.test(l) && !SCALED.test(l) && !RUNNING.test(l))
// checked-line: an option-seeking ask answered at length with no "checked: …" line of angles ruled out.
const OPTION_ASK = /\b(best|recommend|which|options?|alternatives?|should i|what about|anything else|compare|vs\.?)\b/i
const CHECKED = /\bchecked:/i
const CHECKED_MSG = 'checked-line: option ask answered with no "checked: …" line — map the angles, list what was ruled out.'
export const missingChecked = (prompt: string, answer: string): boolean => {
  if (!OPTION_ASK.test(prompt) || CHECKED.test(answer)) return false
  const words = proseLines(answer).filter(l => !l.trim().startsWith('>')).join(' ').split(/\s+/).filter(Boolean).length
  return words >= 60
}
// reask-guard: J is correcting or re-asking. Tell the model before it answers; then the answer needs a
// "Correction:" line or a confidence label.
const REASK = /\b(verified where|where is (this|that|it)\b|why (did|do) you (say|think|use|put)|are you sure|is it really|no,? it'?s a question|i (just|already) (told|said)|repeat(ing)? myself|you (forgot|missed|ignored)|not what i (asked|said|meant)|what is (para|paragraph|cl|clause|s|section|sch|schedule)\b|that'?s (wrong|not right))/i
const REASK_CTX = `${GUARD_TAG} reask-guard: J is correcting or re-asking. Re-open the source and quote the line; answer his literal question first; then Correction:/Prevention: if wrong.`
const REASK_MSG = 'reask-guard: J re-asked; answer has no Correction: line or confidence label — re-check the source and add one.'
const REASK_OK = /^[\s>*_-]*(\*\*)?Correction:|\b(verified|unverified|inferred)\b/im
export const reasks = (prompt: string): boolean => REASK.test(prompt)

// scope-quote: J stated a limit ("just f, i, j", "not just 40 keys", "finish the limit"). Quote his exact
// phrase back as context so the answer honours it. Narrow patterns on purpose: plain "just"/"only" don't fire.
const LIST_ITEM = String.raw`\(?[a-z0-9]{1,2}\)?`
const SCOPE_PATTERNS: RegExp[] = [
  /\bnot just\s+[^\s.?!,;]+(?:\s+[^\s.?!,;]+){0,3}/i,
  new RegExp(String.raw`\b(?:just|only)\s+(?:the\s+)?(?:${LIST_ITEM}(?:\s*,\s*|\s+and\s+|\s*&\s*))+${LIST_ITEM}\b`, 'i'),
  /\b(?:just|only)\s+(?:the\s+)?(?:top\s+|first\s+|last\s+)?\d+(?:\s+[a-z]+)?/i,
  /\b(?:just|only)\s+(?:the\s+)?(?:paras?|paragraphs?|clauses?|sections?|schedules?|heads?|items?|keys?|rows?|columns?|wireless|wired)\s+[\w-]+/i,
  /\bonly\s+(?:the|in|from|those|these|include|list|show)\s+[\w-]+(?:\s+[\w-]+){0,2}/i,
  /\b(?:except|excluding|apart from|other than)\s+(?:the\s+)?[\w-]+(?:\s+[\w-]+){0,2}/i,
  /\b(?:at least|at most|no more than|no fewer than|no less than|up to|a maximum of|a minimum of)\s+\d+(?:\s+[a-z]+)?/i,
  /\b\d+\s?(?:keys?|words?|characters?|chars|lines?|pages?|bullets?|points?)\b/i,
  /\bboth\s+[\w-]+(?:\s+[\w-]+){0,2}?\s+and\s+[\w-]+/i,
  /\ball of (?:the|these|those)\s+[\w-]+/i,
  /\band also\s+[\w-]+(?:\s+[\w-]+){0,2}/i,
  /\b(?:finish|use up|exhaust)\s+(?:the|my|all)\s+(?:limit|quota|allowance|budget|cap)\b/i,
  /\band\s+(?:wireless|wired|bluetooth)\b/i,
]
export const scopePhrases = (prompt: string): string[] => {
  const found: { at: number; text: string }[] = []
  for (const re of SCOPE_PATTERNS) {
    const m = re.exec(prompt)
    if (m !== null) found.push({ at: m.index, text: m[0].trim().split(/\s+/).slice(0, 5).join(' ') })
  }
  found.sort((a, b) => a.at - b.at)
  const out: string[] = []
  let words = 0
  for (const f of found) {
    const n = f.text.split(' ').length
    if (out.includes(f.text) || words + n > 8) continue
    out.push(f.text)
    words += n
  }
  return out
}
export const scopeCtx = (prompt: string): string | undefined => {
  if (prompt.trimStart().startsWith(GUARD_TAG) || prompt.includes('<task-notification>')) return undefined
  const p = scopePhrases(prompt)
  return p.length === 0 ? undefined : `Scope: J said ${p.map(x => `"${x}"`).join(' ')}. Honour it in every part of the answer.`
}

// running-proof: a reply's "(running" needs a launch id from a tool result this turn, or one from an
// earlier turn of the session that no notification has reported finished yet.
// "(running" or "running (Sonnet)" / "running (Opus ..." : both claim a launched agent.
const RUNNING = /\(running|\brunning \((?:haiku|sonnet|opus|fable)/i
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
// parked-fix: a fix named ("should be a cheap fix", "needs to be fixed") with no launch id and no write-type tool this turn.
const PARKED = /\b(should|could|would|will|can) be (a |an )?(cheap|quick|easy|small|simple|trivial|one-line|minor)\b[^.\n]{0,40}\b(fix|change|patch|tweak|edit)\b|\b(worth|needs|needs to be|should be|could be|to be) (fixed|fixing|patched|adding|added|changed)\b|\bcheap (page |ui )?fix\b|\b(propos(e|ing)|suggest(ing)?) (that|this|it)\b|\bcheaper next time\b|\bnext time[:,]? (keep|use|do|add|run)\b/i
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Artifact'])
export const parkedFix = (answer: string, acted: boolean): boolean => !acted && !NEEDS_J.test(answer) && PARKED.test(answer)
// miss-landing: a line opening "Miss:" / "Correction:" / "Gap:" (after markdown bold or bullets) names a miss;
// it must land a fix (write-type or memory-write tool, or a launch id) or say no fix is needed.
const MISS = /^[ \t]*(?:[-*+•][ \t]+)?(?:\*\*|__)?[ \t]*(?:miss|correction|gap)[ \t]*:/im
const MISS_OK = /no fix|no rule change|already covers|existing rule|\(needs you\)/i
const LANDING_TOOL = /(^|__)propose_skills$|memory_(write|append|str_replace)$/
export const missUnlanded = (answer: string, landed: boolean): boolean => !landed && MISS.test(answer) && !MISS_OK.test(answer)
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
// Not points: headings (own line), URLs of links, and verbatim quoted spans (exempt; each counts as one word).
// A bold footer label (**Next:** / **Efficiency:** / **Leap:**) starts its own point even on a shared line.
const QUOTED = /“[^”]*”|"[^"\n]*"/g
const FOOTER_LABEL = /\s+(?=\*\*(?:Next|Efficiency|Leap):\*\*)/
const pointWords = (t: string): number =>
  t.replace(/\]\([^)\s]*\)/g, ']').replace(QUOTED, 'Q').split(/\s+/).filter(Boolean).length
export const longPoints = (answer: string): number => {
  let n = 0
  let para: string[] = []
  const flush = () => {
    for (const p of para.join(' ').split(FOOTER_LABEL)) if (pointWords(p) > STYLE_MAX) n++
    para = []
  }
  let fenced = false
  for (const raw of answer.split('\n')) {
    const l = raw.trim()
    if (/^(```|~~~)/.test(l)) { flush(); fenced = !fenced; continue }
    // Tables, code and blockquotes (verbatim quotes, paste-ready text) are exempt from the word cap.
    if (fenced || l.startsWith('|') || l.startsWith('>')) { if (!fenced) flush(); continue }
    if (l === '' || /^#{1,6}\s/.test(l)) { flush(); if (l !== '') continue }
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
// A "Sources:" line anywhere in the answer sources every "verified" in it.
const SOURCES_LINE = /^[\s>*_-]*(\*\*)?Sources?:/im
// A "verified" line also needs a verbatim quoted span (“…”, "…" or a > blockquote) on that line or the next: a bare link can't be checked at a glance.
// "Checked and dropped/ruled out" is a verified claim in disguise (dropping an option on an unquoted reason).
const RULED_OUT = /\bchecked and (dropped|ruled out)\b/i
const QUOTE = /“[^”]{4,}”|"[^"\n]{4,}"|^\s*>\s*\S/m
export const unverified = (answer: string): [number, number] => {
  const lines = proseLines(answer)
  const sourced = SOURCES_LINE.test(lines.join('\n'))
  const bad = lines.filter((l, i) => (VERIFIED.test(l) || RULED_OUT.test(l)) && !IN_CHAT.test(l) && ((!sourced && !SOURCE.test(l)) || !QUOTE.test(`${l}\n${lines[i + 1] ?? ''}`))).length
  // An unverified marker that names where it looked (site or link) is an honest disclosure, not an unchecked fact.
  return [bad, lines.filter(l => UNCHECKED.test(l) && !NAMED_SITE.test(l)).length]
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
// An idle claim outside the "Next:" footer ("Next: nothing running" just states the footer's status).
const NEXT_LINE = /^[\s>*_-]*(\*\*)?Next:/i
export const idleClaim = (answer: string): boolean =>
  !NEEDS_J.test(answer) && answer.split('\n').some(l => !NEXT_LINE.test(l) && IDLE_TEXT.test(l))
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

// corr-log (0.4.5): a J prompt that corrects or re-asks after an answer is logged as a scoreboard row at
// zero model tokens. Rows queue in $.store (container-local) and flush to the Claude Scoreboard's
// "corrections" collection through ArtifactData only when the permission check already says allow
// (after this session approved a database write), so the hook never raises a prompt for J.
export const SCOREBOARD_URL = 'https://claude.ai/artifact/9eLvFVYqsp5CwzFY64V3pK'
const CORR_KEY = 'corrLog'
const CORR_KEEP = 200
const Q = "['’]"
const CORRECTING = new RegExp(
  "^(why|where( is\\b|\\s*\\??$)|just\\b|stop\\b|and\\s|but\\s|i mean\\b|what about\\b|can you not\\b|you (were|are|did|didn" + Q + "?t|forgot|missed|ignored|keep)\\b)"
  + "|\\b(verified where|are you sure|is it really|really mean|why (did|do) you|i (just |already )?(told|said)|repeat(ing)? myself|no,? it" + Q + "?s a question|not what i (asked|said|meant)"
  + "|what is (para|paragraph|cl|clause|s|section|sch|schedule)\\b|that" + Q + "?s (wrong|not right)|what the (hell|heck|f)|supposed to|in future|mix(ed)? up|except for|not just\\b|too (long|short|verbose|wordy)\\b|shorten\\b|\\bpaste\\b"
  + "|you can google|look (it )?up|\\bagain\\b|does(n" + Q + "?t| not)? have\\b|(i|we) (don" + Q + "?t|do not) (have|need|want|use)\\b|can" + Q + "?t get\\b)", 'i')
// Only the opening of a prompt is read: a long pasted brief is no correction.
export const correcting = (text: string): boolean => CORRECTING.test(text.trim().slice(0, 160))
const CATEGORIES: [RegExp, string][] = [
  [/verified where|are you sure|is it really|really mean|why (did|do) you|why do you say|what is (para|cl|s|sch)|^where\b/i, 'unverified claim'],
  [/too (long|short|verbose|wordy)|shorten|eta|slow/i, 'slow/over-long'],
  [/paste|format|icon|mix(ed)? up/i, 'format/style miss'],
  [/google|look (it )?up|supposed to|memori[sz]ed/i, "didn't check stored info"],
  [/^(just|and|but|what about|i mean)\b|except for|not just|only|question|i (just |already )?(told|said)|repeat/i, 'wrong scope'],
]
export const corrCategory = (text: string): string => CATEGORIES.find(([re]) => re.test(text))?.[1] ?? 'unclassified'
// Not J typing: agent messages, task notifications, hook continuations, slash commands.
const NOT_J = /^\s*(<|\[dispatch-guard\]|Another Claude session|Stop hook feedback|The files from earlier)/
export type CorrRow = { date: string; chat: string; words: string; wrong: string; category: string; covered: boolean; rule: string; count: number; auto: true; session: string }
export const corrRow = (text: string, session: string, chat: string, now: number): CorrRow => ({
  date: new Date(now + 8 * 3_600_000).toISOString().slice(0, 10), // SGT calendar day
  chat: chat.slice(0, 60), words: text.trim().slice(0, 300), wrong: '(auto-logged: triage)', category: corrCategory(text),
  covered: false, rule: 'auto-logged; triage', count: 1, auto: true, session,
})
const corrId = (r: CorrRow, now: number): string => `auto-${r.session.slice(0, 8)}-${now.toString(36)}`
async function corrQueue($: EngineInterface): Promise<{ id: string; data: CorrRow }[]> {
  const v = await $.store.get(CORR_KEY)
  return Array.isArray(v) ? v as { id: string; data: CorrRow }[] : []
}
// Flush queued rows in one batch, only where the check already allows a database write.
let corrBusy = false // the flush's own ArtifactData call passes through this plugin's tool.call hook
export async function corrFlush($: EngineInterface): Promise<number> {
  if (corrBusy) return 0
  corrBusy = true
  try { return await corrSend($) } finally { corrBusy = false }
}
async function corrSend($: EngineInterface): Promise<number> {
  const queue = await corrQueue($)
  if (queue.length === 0) return 0
  const writes = queue.slice(0, 50).map(q => ({ op: 'set', collection: 'corrections', doc_id: q.id, data: q.data }))
  const input = { action: 'batch', url: SCOREBOARD_URL, writes }
  const { decision } = await $.tool.check({ tool: 'ArtifactData', input } as never)
  if (decision !== 'allow') return 0
  const ran = await $.tool.call({ tool: 'ArtifactData', ...input } as never) as { deny?: string; isError?: boolean }
  if (ran.deny !== undefined || ran.isError) return 0
  const sent = new Set(writes.map(w => w.doc_id))
  await $.store.set(CORR_KEY, (await corrQueue($)).filter(q => !sent.has(q.id)))
  return writes.length
}
async function corrLog($: EngineInterface, text: string): Promise<void> {
  if (NOT_J.test(text) || !correcting(text)) return
  const msgs = await $.session.messages()
  if (!Array.isArray(msgs) || !msgs.some(m => m.role === 'assistant')) return // nothing to correct yet
  const chat = msgs.find(m => m.role === 'user' && !NOT_J.test(m.text))?.text.split('\n')[0] ?? ''
  const now = await $.clock.now()
  const row = corrRow(text, await $.session.id(), chat, now)
  await $.store.set(CORR_KEY, [...await corrQueue($), { id: corrId(row, now), data: row }].slice(-CORR_KEEP))
  await corrFlush($).catch(() => 0)
}

export const register: Register = on => {
  let count = 0
  let turnFired = false // the 4th-call reminder fires at most once per turn
  let handoffTurn = false // the handoff skill was loaded this main turn: no 4th-call reminder
  let pendingHandoff = false // a /handoff slash command was submitted; its turn is a handoff turn
  let proof = false // a launch id came back this main turn
  let acted = false // a write-type tool ran on the main thread this turn
  let landed = false // a write, memory-write or skill-proposal tool ran on the main thread this turn
  let stampFired = false // the board-timestamp lint went out this main turn
  let idleFired = false // the idle-guard reminder went out this main turn
  let wrote = false // a write or dispatch tool ran this main turn
  let dispatched = false // an agent was launched or the ledger edited this main turn
  let boarded = false // an ArtifactData write ran this main turn
  let fromGuard = false // this main turn began with the guard's own continuation prompt
  let submitted = false // the guard submitted a continuation not yet started
  let carry: string | undefined // the end-of-turn line, for the model with the next prompt only
  let injected: string | undefined // the session id this module last injected the card for
  let dueId: string | undefined // the session id the owed card is for
  let cardDue = false // a chat-start card is owed to the prompt in flight
  let asked = '' // the text that opened this main turn (J's prompt)
  let looked = false // a lookup tool ran this main turn

  // Once per chat: attach the orchestrator instruction to the first prompt, before the model's first reply.
  // Re-arms on a new session id (startup, /clear), so it needs no SessionStart hook.
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined) {
      if (/(^|:)handoff$/.test(e.command.name)) pendingHandoff = true
      return next(e)
    }
    if (!e.isMeta) await corrLog($, e.text).catch(() => undefined)
    await close($, finished(e.text)) // a notification may arrive as a submitted prompt
    if (carry !== undefined) {
      e = { ...e, context: [...(e.context ?? []), carry] }
      carry = undefined
    }
    if (reasks(e.text)) e = { ...e, context: [...(e.context ?? []), REASK_CTX] }
    const scope = scopeCtx(e.text)
    if (scope !== undefined) e = { ...e, context: [...(e.context ?? []), scope] }
    // Each read is tolerant: a failing session/state/store API can't skip the injection, and the
    // module-local `injected` keeps it once per chat when state and store both fail.
    const id = await Promise.resolve().then(() => $.session.id()).catch(() => '?')
    if (injected === id) return next(e)
    if ((await Promise.resolve().then(() => $.state.get(remindedSession)).catch(() => undefined))?.value === id) return next(e)
    const stored = await Promise.resolve().then(() => $.store.get(STORE_KEY)).catch(() => undefined)
    const seen = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []
    if (seen.includes(id)) {
      injected = id
      await $.state.set(remindedSession, id).catch(() => undefined)
      await $.state.set(orchLoaded, id).catch(() => undefined) // card went out earlier this chat
      return next(e)
    }
    // Card build never throws (embedded fallback), and the once-per-chat slot (state + store) is
    // spent only after the injected prompt went through, so no throw can skip the injection.
    dueId = id
    cardDue = true // from here a throw still injects (see .catch), until next() is called
    let card: { msg: string; info?: CardInfo }
    try { card = await cardMsg($) } catch { card = { msg: fallbackCard() } }
    cardDue = false
    const ran = await next({ ...e, context: [...(e.context ?? []), START_MSG, card.msg] })
    injected = id
    try {
      await $.state.set(remindedSession, id)
      await $.state.set(orchLoaded, id) // the card carries the skill text: counts as loaded
      await $.store.set(STORE_KEY, [...seen, id].slice(-KEEP))
      if (card.info !== undefined) await $.store.set('lastCard', card.info)
    } catch {}
    return ran
  }).catch(($, e, next) => {
    if (!cardDue) return next(e)
    cardDue = false
    injected = dueId
    return next({ ...e, context: [...(e.context ?? []), START_MSG, fallbackCard()] })
  })

  // Main loop only: a new main turn (user message or agent notification) resets the count.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      count = 0
      turnFired = false
      handoffTurn = pendingHandoff
      pendingHandoff = false
      proof = false
      acted = false
      landed = false
      idleFired = false
      stampFired = false
      wrote = false
      dispatched = false
      boarded = false
      looked = false
      asked = e.text
      fromGuard = submitted || e.text.trimStart().startsWith(GUARD_TAG)
      submitted = false
      await close($, finished(e.text))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Warn only: always run the tool, then append a reminder to its result.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) { // subagents: only the big-result warning, never counted or blocked
      const r = await next(e)
      const n = r.deny === undefined && !r.isError ? bigResult(r) : 0
      return n > 0 ? { ...r, context: [...(r.context ?? []), BIG_MSG(n)] } : r
    }
    const notes: string[] = []
    // A handoff resume/write turn is a short fixed sequence; handing it to an agent only slows it.
    if (e.tool === 'Skill' && /(^|:)handoff$/.test(String((e as Record<string, unknown>).skill ?? ''))) handoffTurn = true
    if (!exempt(e.tool)) {
      count += 1
      if (count >= LIMIT + 1 && !turnFired && !handoffTurn && !finishing(e as Record<string, unknown>)) {
        turnFired = true
        notes.push(TURN_MSG)
      }
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
    if (WRITE_TOOLS.has(e.tool)) acted = true
    if (WRITE_TOOLS.has(e.tool) || LANDING_TOOL.test(e.tool)) landed = true
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      if (writes(e.tool)) wrote = true
      if (looksUp(e.tool)) looked = true
      if (ARTIFACT_DATA.test(e.tool) && ['set', 'update', 'batch'].includes(String((e as Record<string, unknown>).action))) {
        boarded = true
        await corrFlush($).catch(() => 0) // the session's own write just passed the check: queued rows can follow
      }
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
    const big = ran.deny === undefined && !ran.isError ? bigResult(ran) : 0
    if (big > 0) notes.push(BIG_MSG(big))
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
    else if (!idleFired && idleClaim(e.answer)) line = IDLE_MSG
    // miss-landing wins over parked-fix: a turn gets at most one of the two lines.
    if (missUnlanded(e.answer, proof || landed)) line = MISS_MSG
    else if (line === undefined && parkedFix(e.answer, proof || acted)) line = PARKED_MSG
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
    if (yesNoQuestion(asked) && !answersFirst(e.answer)) extra.push(ANSWER_FIRST_MSG)
    if (!looked && unknowns(e.answer)) extra.push(LOOKUP_MSG)
    if (rawEta(e.answer)) extra.push(ETA_MSG)
    if (missingChecked(asked, e.answer)) extra.push(CHECKED_MSG)
    if (reasks(asked) && !REASK_OK.test(e.answer)) extra.push(REASK_MSG)
    const long = longPoints(e.answer)
    if (long > 0) extra.push(styleMsg(long))
    const all = [...(line === undefined ? [] : [line]), ...extra].join(' ')
    if (all === '') return ran
    if (!continued || all !== IDLE_MSG) carry = all
    return { ...ran, text: all }
  }).catch(($, e, next) => next(e))
}
