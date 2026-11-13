import type { EngineInterface, Register } from 'claude-code'
import { CARD } from './orchestrator-card'
import { registerGuards, takeCompactNote } from './guards'
import { PACK_URL, JUDGE_RULES, PACK_TIMEOUT_MS, BUNDLED_VERSION, bundledRules, fill, mergePack, validatePack, type Compiled, type Pack } from './rulepack'

// Active rule pack (0.5.8): the bundled rules until a valid newer pack loads for the session.
let RULES: Compiled = bundledRules()
export const setRules = (r: Compiled): void => { RULES = r }
export const activeRules = (): Compiled => RULES
const rx = (id: string, k: string): RegExp => RULES.checks[id].patterns[k] as RegExp
const rxg = (id: string, k: string): RegExp => { const r = rx(id, k); return new RegExp(r.source, `${r.flags}g`) }
const rxs = (id: string, k: string): RegExp[] => RULES.checks[id].patterns[k] as RegExp[]
const num = (id: string, k: string): number => RULES.checks[id].numbers[k]
const msg = (id: string, k = 'line', vars?: Record<string, string | number>): string => fill(RULES.checks[id].messages[k], vars)
// 0.6.6 slim: checks switched off in code, so no rule pack can turn them back on (pack `add` entries with these ids are
// ignored too). Replay A/B 0.6.2 vs baseline: they fired on passing answers as often as on failing ones, or their
// continuation (source-addendum) cut the pass rate. The definitions stay in the pack schema so older packs still validate.
export const OFF: ReadonlySet<string> = new Set(['style', 'verify-proof', 'leap-line', 'arith-proof', 'lookup-first', 'parked-fix', 'board-dispatch', 'done-claim', 'source-addendum'])
export const live = (id: string): boolean => !OFF.has(id)
// 0.6.14 dark checks: computed and logged to the Scoreboard (hookLog) but never shown to the model or J. Promote by removing the id here.
export const DARK: ReadonlySet<string> = new Set(['stop-figures', 'stop-sources', 'stop-writes', 'promise-proof', 'source-gate']) // 0.6.19: source-gate is log-only until deep-evidence.sourceGate is 2

const EXEMPT = new Set(['Agent', 'SendMessage', 'TaskCreate', 'TaskUpdate', 'Read', 'Glob', 'Grep', 'ToolSearch', 'TaskGet', 'TaskList'])
const SAVE_TOOL = /(^|__)memory_(write|str_replace|append)$|(^|__)propose_skills$/ // 0.6.21 save-gate: the rule-saving tools
export const handoffPath = (p: unknown): boolean => /^\/?areas\/handoffs\//.test(String(p ?? ''))
const MEMORY_READ = /(^|__)memory_read$/
const exempt = (tool: string): boolean => EXEMPT.has(tool) || MEMORY_READ.test(tool)
// 0.6.0: the 4th-call count is only the fallback for a runtime where a mid-turn J message never reaches prompt.submit.
// The plugin reference documents it does ("Typed while a turn ran, it fires at Enter, with that turn's id"); the first
// mid-turn J prompt this hook sees (store key MID_SEEN) switches the fallback off for good, leaving the event trigger.
const LIMIT = 3
const MID_SEEN = 'midTurnSeen'
// W23 early reply (J, 13 Nov 20:59 "you were unresponsive for super long"): in a turn opened by J's own message, once EARLY_REPLY_SECS have passed since
// the prompt or EARLY_REPLY_CALLS non-reply main-thread tool calls have run with nothing J-visible yet, every further tool but the reply path is denied
// until a SendUserMessage goes out. Only where the session's tool list affirmatively carries SendUserMessage (else the final text is the only reply).
// EARLY_REPLY_VALVE denials per turn, then it steps aside (no deadlock if the reply cannot go out).
export const EARLY_REPLY_SECS = 45
export const EARLY_REPLY_CALLS = 4
export const EARLY_REPLY_VALVE = 6
export const EARLY_REPLY_MSG = "Reply to J first: the answer, or one 'on it, ETA <time>' line via SendUserMessage; then continue."
// The reply path: the reply itself, its pre-send check, set_rules (required before the first check) and ToolSearch (loads SendUserMessage's schema when deferred).
export const EARLY_OPEN: ReadonlySet<string> = new Set(['SendUserMessage', 'ToolSearch', 'mcp__dispatch-guard__check_reply', 'mcp__dispatch-guard__set_rules'])
// 0.6.20 burst-safe mid-turn: the tools a pending J message leaves open (the reply, delegation, loading their schemas, the pre-send check).
export const MID_OPEN: ReadonlySet<string> = new Set(['SendUserMessage', 'Agent', 'Task', 'SendMessage', 'ToolSearch', 'mcp__dispatch-guard__check_reply', 'mcp__dispatch-guard__set_rules'])
export type MidMsg = { text: string; at: number; seq: number; gap: number }
export const midList = (q: MidMsg[]): string => q.map((m, i) => `(${i + 1}) "${m.text.replace(/\s+/g, ' ').trim().slice(0, 140)}${m.text.length > 140 ? '…' : ''}"`).join(' ')
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
const TURN_MSG = '4th tool call this turn — hand the rest to a background agent and reply to the user.' // fallback only
// The prompt origins J types through (terminal, Remote Control, SDK host such as the app); others are not J.
const J_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'unclassified'])
const jOrigin = (e: { origin?: { kind?: string } }): boolean => e.origin?.kind === undefined || J_ORIGINS.has(e.origin.kind)
// first-reply: work J's reply doesn't need — a write or dispatch that is not a finishing write, an ArtifactData/Artifact
// read or a read-only shell command (date, ls, cat, grep …, no redirect). Lookups stay free.
const READ_ONLY_BASH = /^\s*(?:TZ=\S+\s+)?(?:date|ls|cat|head|tail|wc|grep|rg|find|pwd|echo|stat|file|sha256sum|du|df|which|git\s+(?:status|log|diff|show))\b[^>]*$/
export const startsWork = (e: Record<string, unknown>): boolean => {
  const tool = String(e.tool)
  if (!WRITE_TOOL.test(tool) || finishing(e)) return false
  if (/(^|__)ArtifactData$/.test(tool) || tool === 'Artifact') return !READ_ACTIONS.has(String(e.action ?? 'publish'))
  if (tool === 'Bash') return !READ_ONLY_BASH.test(String(e.command ?? ''))
  return true
}
// 0.6.6: the second sentence — the A/B found the injected card halved legal-answer skill loads (38/46 → 18/46 legal runs).
const START_MSG = "Load the orchestrator skill (Skill tool, skill 'orchestrator') before anything else in this chat, even for one-word or test messages. Then load any other skill matching the request as usual: the card below does not replace domain skills."
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
// Relay (W2-7): a subagent's context grows ~2k tokens per tool call and every call re-reads it. Backtest
// (improve/plan/wave2/relay/backtest.py, 31 agents): handing over to a fresh agent after RELAY_AT calls, relay cost
// included, saves ~9% of cost-weighted agent spend, flat from 35 to 50 calls; 50 needs the fewest relays.
export const RELAY_AT = 50
// 0.6.4 loop guard: a subagent that fails the same (normalised) Bash command 3 times in a row, or Edit-fails the same file 3 times, gets one stop line.
export const LOOP_AT = 3
export const LOOP_MSG = 'Loop detected: stop retrying, report what\u2019s blocked and hand back.'
export const normCmd = (c: string): string => c.replace(/\s+/g, ' ').trim()
const RELAY_MSG = `${RELAY_AT} tool calls: context is now costly to re-read. Finish the current step, update <workdir>/progress.md (done, next, files, exact commands), then end with report "relay: <path to progress.md>" so main resumes you fresh.`
const GUARD_TAG = '[dispatch-guard]'
// V5 (0.6.0): the continuation carries the rule pack's idle-guard text (account and project backlogs), one source.
const idlePrompt = (): string => `${GUARD_TAG} ${msg('idle-guard')}`
const ARTIFACT_DATA = /(^|__)ArtifactData$/
const TS_TOLERANCE_MS = 5 * 60_000

// offer-guard: an answer that ends on an offer waiting on J ("want me to…?", "say so") instead of doing
// the step. "(needs you)" and D1/D2 decision questions are the legitimate forms, so they exempt it.
// verify-proof: "verified" needs a source on its own line (link, path or "source:"); quoted uses are not
// claims. Unverified/TBC markers in an answer mean a checkable fact went out unchecked.
// A source is a link, path, "source:", a named domain, a document locator (para 9, cl 1.1, s 41B, Sch 7), or the
// J-supplied document itself ("against the pasted/attached draft"): all checkable at a glance.
// An in-chat document ("verified against the pasted X") is source and quote at once: J can open it.
// A named file (plugin.json, notes.md, run.py ...) or "the X file" is a checkable source when a quoted span is on the line.
const verifyMsg = (n: number, m: number) =>
  msg('verify-proof', 'line', { detail: [n ? msg('verify-proof', 'verified', { n }) : '', m ? msg('verify-proof', 'unchecked', { n: m }) : ''].filter(Boolean).join(', ') })
const styleMsg = (n: number) => msg('style', 'line', { n, max: num('style', 'maxWords') })
const styleEscMsg = () => msg('style', 'escalate', { max: num('style', 'maxWords') })
export const CORRECTION_LINE = /^\W*Correction\b\W*:/m // a Correction: line (bold or bullet allowed)
// promise-proof: an Efficiency/Prevention line or "from now on" with no write or dispatch this turn.
const WRITE_TOOL = /^(Edit|Write|NotebookEdit|Bash|ArtifactData|Artifact|Agent|Task|SendMessage)$|memory_(?!read|list|search)\w+$|__(update|batch|create|create_trigger|send_later)$/
// board-dispatch: an agent launched or the ledger edited with no status-board write this turn.
const LEDGER_PATH = /(^|\/)\.claude\/orchestrator\//
const LEDGER_WRITE = /(>>?|\btee\b|\bsed\s+-i\b)[^;&|\n]*?(\$\{?L\}?\b|\.claude\/orchestrator\/)/
// Order-free: the reply (with ETAs) may come first; ledger + board writes count anywhere in the same turn.
// clock-stamp: one short context line per prompt with the live Singapore time (UTC+8, no DST), so ETAs use the real clock.
export const clockStamp = (ms: number): string => {
  const d = new Date(ms + 8 * 3_600_000)
  return `now ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} SGT (Asia/Singapore)`
}
// upload-check: J says "uploaded": show the synced dispatch-guard versions (plugin.json + mtime) so the reply needs no tool call.
const SYNCED_ROOT = '/root/.claude/plugins/synced'
const entryName = (d: unknown): string => (typeof d === 'string' ? d : String((d as { name?: unknown } | null)?.name ?? ''))
export const hhmm = (ms: number): string => clockStamp(ms).slice(4, 9)
// 0.6.6 replay clock flag: an integer in <session cwd>/.claude/dg-clock-offset (ms) shifts every clock read, so a replay
// stamps the case's time, not the real one. Read once per process; absent (live use) → 0.
let clockOffset: number | undefined
export const resetClockOffset = (): void => { clockOffset = undefined }
async function offsetMs($: EngineInterface): Promise<number> {
  if (clockOffset !== undefined) return clockOffset
  clockOffset = 0
  try {
    const cwd = String(await $.session.cwd())
    const n = Number(String(await $.fs.read(`${cwd}/.claude/dg-clock-offset`)).trim())
    if (Number.isFinite(n)) clockOffset = Math.trunc(n)
  } catch {}
  return clockOffset
}
async function nowMs($: EngineInterface): Promise<number> {
  const off = await offsetMs($).catch(() => 0)
  try { const c = Number(await $.clock.now()); if (Number.isFinite(c) && c > 0) return c + off } catch {}
  return Date.now() + off
}
// H-14: every synced plugin and skill changed in the last recentHours (dispatch-guard always listed).
export async function syncedVersions($: EngineInterface): Promise<string> {
  const now = await nowMs($)
  const recent = num('upload-check', 'recentHours') * 3_600_000
  const out: string[] = []
  const skills: string[] = []
  let dg = 0
  for (const id of await $.fs.list(SYNCED_ROOT).catch(() => [] as unknown[])) {
    const idn = entryName(id)
    if (idn === '' || idn.startsWith('.') || idn.includes('.')) continue
    for (const d of await $.fs.list(`${SYNCED_ROOT}/${idn}`).catch(() => [] as unknown[])) {
      const n = entryName(d)
      if (n === '' || n.startsWith('.') || n.includes('.meta')) continue
      const p = `${SYNCED_ROOT}/${idn}/${n}/.claude-plugin/plugin.json`
      try {
        const v = (JSON.parse(await $.fs.read(p)) as { version?: unknown }).version
        const m = Number((await $.fs.stat(p)).mtimeMs) || 0
        const isDg = n.startsWith('dispatch-guard')
        if (isDg) dg++
        if (isDg || now - m <= recent) out.push(`${n} ${String(v)} (${hhmm(m)})`)
      } catch {}
    }
  }
  for (const id of await $.fs.list(SKILLS_ROOT).catch(() => [] as unknown[])) {
    const idn = entryName(id)
    if (idn === '' || idn.startsWith('.') || idn.includes('.')) continue
    for (const d of await $.fs.list(`${SKILLS_ROOT}/${idn}`).catch(() => [] as unknown[])) {
      const n = entryName(d)
      if (n === '' || n.startsWith('.') || n.includes('.')) continue
      try {
        const m = Number((await $.fs.stat(`${SKILLS_ROOT}/${idn}/${n}/SKILL.md`)).mtimeMs) || 0
        if (m > 0 && now - m <= recent) skills.push(`${n} (${hhmm(m)})`)
      } catch {}
    }
  }
  const head = dg === 0 ? ['no dispatch-guard found', ...out] : out
  return `synced: ${head.join('; ')}${skills.length > 0 ? `; skills: ${skills.join(', ')}` : ''}`
}
// resend-guard: SendUserFile of a file whose sha256 equals one already sent this session.
const SENT_KEEP = 50
const pathsOf = (e: Record<string, unknown>): string[] => {
  const out: string[] = []
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v !== '') out.push(v)
    else if (Array.isArray(v)) v.forEach(add)
    else if (typeof v === 'object' && v !== null) { const o = v as Record<string, unknown>; add(o.path ?? o.file_path) }
  }
  for (const k of ['file_path', 'path', 'paths', 'file_paths', 'files', 'attachments']) add(e[k])
  return [...new Set(out)]
}
export const sha256 = async (t: string): Promise<string> => {
  try {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
  } catch { return `fnv:${fnv8(t)}:${t.length}` }
}
async function resendNotes($: EngineInterface, e: Record<string, unknown>): Promise<{ notes: string[]; commit: () => Promise<void> }> {
  const key = `sentFiles:${await $.session.id()}`
  const stored = await Promise.resolve().then(() => $.store.get(key)).catch(() => undefined)
  const sent: Record<string, string> = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored as Record<string, string> : {}
  const have = new Set(Object.values(sent))
  const notes: string[] = []
  const fresh: Record<string, string> = {}
  for (const p of pathsOf(e)) {
    try {
      const h = await sha256(await $.fs.read(p))
      if (have.has(h)) notes.push(`already sent unchanged: ${p.split('/').pop()}`)
      fresh[p] = h
    } catch {}
  }
  return { notes, commit: async () => { await $.store.set(key, Object.fromEntries(Object.entries({ ...sent, ...fresh }).slice(-SENT_KEEP))).catch(() => undefined) } }
}
const stampPrompt = async ($: EngineInterface, e: { context?: string[] }): Promise<string> => clockStamp(await nowMs($))
export const editsLedger = (e: Record<string, unknown>): boolean =>
  ((e.tool === 'Edit' || e.tool === 'Write') && LEDGER_PATH.test(String(e.file_path ?? '')))
  || (e.tool === 'Bash' && LEDGER_WRITE.test(String(e.command ?? '')))
// orchestrator-proof: the chat was told to load the orchestrator skill, got no card, and no Skill call loaded it.
const ORCH_SKILL = /(^|:)orchestrator$/

// Round 2 answer checks (each at most one line beneath the answer, never blocks).
// answer-first: J asked a yes/no question; the first line must carry the yes/no or a confidence label.
export const yesNoQuestion = (prompt: string): boolean =>
  prompt.split(/(?<=[.?!])\s+|\n+/).map(x => x.trim()).some(x => rx('answer-first','question').test(x) && !rx('answer-first','request').test(x))
export const answersFirst = (answer: string): boolean => {
  const first = proseLines(answer).map(l => l.replace(/[*_#>`-]/g, ' ').trim()).find(l => l !== '') ?? ''
  // 0.6.0 (#39): the first sentence (to the first . ? ! or line end), not a word count; firstWords stays a valid pack key, unused.
  return rx('answer-first','answered').test(first.split(/(?<=[.?!])\s+/)[0] ?? '')
}
// lookup-first: "I don't know" or asking J for something, with no lookup tool this turn.
const LOOKUP_TOOL = /^(Read|Grep|Glob|Bash|WebSearch|WebFetch|Skill|Agent|Task|Artifact|ArtifactData)$|memory_(read|list|search)$|(conversation_search|read_conversation|recent_chats)$|__(read|query|search|get_page_text|read_page|find|navigate)$/
export const unknowns = (answer: string): boolean => proseLines(answer).filter(l => !l.trim().startsWith('>')).some(l => rx('lookup-first','unknown').test(l))
export const looksUp = (tool: string): boolean => LOOKUP_TOOL.test(tool)
// eta-proof: an ETA in minutes relayed without the calibration factor (E×R).
// The "(running, ETA …)" footer is running-proof's; only relay lines are checked here.
export const rawEta = (answer: string): boolean => proseLines(answer).some(l => rx('eta-proof','eta').test(l) && !rx('eta-proof','scaled').test(l) && !rx('running-proof','claim').test(l))
// checked-line: an option-seeking ask answered at length with no "checked: …" line of angles ruled out.
export const missingChecked = (prompt: string, answer: string): boolean => {
  if (!rx('checked-line','ask').test(prompt) || rx('checked-line','checked').test(answer)) return false
  const words = proseLines(answer).filter(l => !l.trim().startsWith('>')).join(' ').split(/\s+/).filter(Boolean).length
  return words >= num('checked-line', 'minWords')
}
// 0.6.11 unbacked-absolute: exclusive/universal or coverage claims in prose the reply itself asserts. Blockquotes, fenced and
// inline code, quoted spans ("…", “…”) and lines carrying a link or "source:" are not scanned. Returns the matching claims.
export const absoluteClaims = (answer: string, prompt = ''): string[] => {
  const out: string[] = []
  for (const raw of proseLines(stripDrafts(answer, prompt))) {
    if (raw.trim().startsWith('>') || rx('unbacked-absolute', 'link').test(raw)) continue
    const l = raw.replace(/`[^`\n]*`/g, ' ').replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, ' ')
    const m = rx('unbacked-absolute', 'claim').exec(l)
    if (m) out.push(m[0].trim())
  }
  return out
}
// 0.6.11 open-question: same scan rules as absoluteClaims (no quotes, code, blockquotes, linked lines, drafts).
export const openQuestions = (answer: string, prompt = ''): string[] => {
  const out: string[] = []
  for (const raw of proseLines(stripDrafts(answer, prompt))) {
    if (raw.trim().startsWith('>') || rx('unbacked-absolute', 'link').test(raw)) continue
    const l = raw.replace(/`[^`\n]*`/g, ' ').replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, ' ')
    const m = rx('open-question', 'claim').exec(l)
    if (m) out.push(m[0].trim())
  }
  return out
}
// 0.6.14 stripDrafts (port of the bundle's strip_drafts): drop paste-ready draft text, keep the explanation around it — fenced blocks,
// blockquote lines, and the block after a "Draft:"/"Subject:" line when the next non-empty line is a greeting or J asked for a draft.
// The block ends at a '---' rule, or at the first blank line after a sign-off line (Regards/Thanks…) and its name line.
const DRAFT_REQ = /\b(?:draft\w*|e-?mails?|repl(?:y|ies)|respond\w*|wording)\b/i
const GREET = /^\s*(?:dear|hi|hello)\b/i
const DRAFT_HDR = /^(?:[*_#]+\s*)?(?:draft|subject)\s*[*_]*\s*:/i
const SIGNOFF = /^\s*(?:(?:kind |best |warm )?regards|best|thanks|thank you|many thanks|cheers|yours (?:sincerely|faithfully))\b[^\n]{0,20}$/i
export const stripDrafts = (text: string, prompt = ''): string => {
  const lines = text.replace(/```[\s\S]*?```/g, ' ').split('\n')
  const asked = DRAFT_REQ.test(prompt)
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const ln = lines[i]
    if (ln.trimStart().startsWith('>')) { i++; continue }
    if (DRAFT_HDR.test(ln)) {
      const nxt = lines.slice(i + 1).find(l => l.trim() !== '') ?? ''
      const rest = ln.replace(DRAFT_HDR, '').replace(/^[ *_]+|[ *_]+$/g, '')
      if (asked || GREET.test(nxt) || GREET.test(rest)) {
        let j = i + 1
        let signed = false
        while (j < lines.length) {
          const l = lines[j]
          if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { j++; break }
          if (SIGNOFF.test(l)) signed = true
          else if (signed && l.trim() === '') break
          j++
        }
        i = j
        continue
      }
    }
    out.push(ln)
    i++
  }
  return out.join('\n')
}
const stripCode = (t: string): string => t.replace(/`[^`\n]*`/g, ' ')
// 0.6.14 stop-dates: a weekday stated with a date must match the calendar. Returns '"<match>" is a <Weekday>' strings (max 5).
const WD_RE = String.raw`\b(mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\.?,?\s+(?:the\s+)?`
const DATE_FORMS: { re: RegExp; pick: (m: RegExpExecArray) => [string, string, string] }[] = [
  { re: new RegExp(`${WD_RE}(\\d{1,2})(?:st|nd|rd|th)?\\s+([a-z]{3,9})\\.?,?\\s+(\\d{4})\\b`, 'gi'), pick: m => [m[4], m[3], m[2]] },
  { re: new RegExp(`${WD_RE}([a-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), pick: m => [m[4], m[2], m[3]] },
  { re: new RegExp(`${WD_RE}(\\d{4})-(\\d{2})-(\\d{2})\\b`, 'gi'), pick: m => [m[2], m[3], m[4]] },
]
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const weekdayMismatches = (answer: string, prompt = ''): string[] => {
  const text = stripCode(stripDrafts(answer, prompt)).replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, ' ')
  const out: string[] = []
  for (const f of DATE_FORMS) {
    for (const m of text.matchAll(f.re)) {
      const [y, mo, d] = f.pick(m as RegExpExecArray)
      const mi = /^\d+$/.test(mo) ? Number(mo) - 1 : MONTHS.indexOf(mo.slice(0, 3).toLowerCase())
      if (mi < 0 || mi > 11) continue
      const dt = new Date(Date.UTC(Number(y), mi, Number(d)))
      if (dt.getUTCMonth() !== mi || dt.getUTCDate() !== Number(d)) continue
      const actual = DAYS[dt.getUTCDay()]
      if (actual.slice(0, 3).toLowerCase() !== m[1].slice(0, 3).toLowerCase()) out.push(`"${m[0].trim()}" is a ${actual}`)
    }
  }
  return out.slice(0, 5)
}
// 0.6.14 stop-figures (a): an amount/percentage/"D Mon YYYY" year in a reply that names a document must occur in the corpus
// (J's message, tool inputs and results, earlier turns' sources, hand-backs). Skips sentences labelled unverified/inferred/own arithmetic.
const DOC_NAME = /[\w][\w.()&-]{1,80}?\.(?:pdf|docx?|xlsx?|msg|pptx?)\b/i
const FIG_AMT = /(?:US\$|S\$|HK\$|RMB|USD|SGD|HKD|\$)\s?(\d[\d,]*(?:\.\d+)?)|\b(\d+(?:\.\d+)?)\s?%(?![0-9A-Fa-f]{2})/g
const FIG_YEAR = /\b\d{1,2}(?:st|nd|rd|th)? (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w* (\d{4})\b/gi
const normFig = (s: string): string => s.replace(/[,\s]/g, '').toLowerCase()
export const unsourcedFigures = (answer: string, corpus: string, prompt = ''): string[] => {
  const text = stripCode(stripDrafts(answer, prompt))
  if (!DOC_NAME.test(text)) return []
  const hay = normFig(corpus)
  const out: string[] = []
  for (const sent of text.split(/(?<=[.!?])\s+|[;|\n]/)) {
    if (/\b(?:unverified|inferred|my arithmetic|my calculation)\b/i.test(sent)) continue
    for (const m of sent.matchAll(FIG_AMT)) {
      const v = normFig(m[1] ?? m[2])
      const trimmed = v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v
      if (!hay.includes(v) && !hay.includes(trimmed) && !out.includes(m[0].trim())) out.push(m[0].trim())
    }
    for (const m of sent.matchAll(FIG_YEAR)) if (!hay.includes(m[1]) && !out.includes(m[0])) out.push(m[0])
  }
  return out
}
// 0.6.15 prevention-line: a line starting "Correction:" with no line starting "Prevention:" in the same reply (drafts, code, blockquotes
// and quoted spans excluded). Bold or bullet marks allowed before the label.
const LABEL_LINE = (w: string): RegExp => new RegExp(String.raw`^[ \t]*(?:[-*+•][ \t]+)?(?:\*\*|__)?[ \t]*${w}\b[^:\n]{0,30}:`, 'im')
// 0.6.32 W6 light clarification: a one-line Correction:/Clarification: of the reply's own wording (<= LIGHT_WORDS words) needs no Prevention/Why block.
// It is NOT light when it admits a process miss (J caught it, I missed/forgot/without checking, wrong/mistake/should have), or swaps one figure/time/count
// for another ("is 09:30, not 10:00"): those are real misses and keep the full block. Version strings (0.6.29) are not figures.
export const LIGHT_WORDS = 25
const MISS_WORDS = /\b(?:wrong|incorrect|mistake[n]?|error|misread|mis-?stated|miscounted|false|should have|shouldn'?t have|forgot|missed|failed|overlooked|(?:you|J)\s+(?:caught|spotted|noticed|asked|flagged)|(?:I|we)\s+(?:never|didn'?t|did not|passed on|assumed|guessed)|without\s+(?:\w+ing|a check)|not\s+(?:true|correct|right))\b/i
const SWAP_WORDS = /\b(?:not|instead|rather than|actually|was|were|now)\b/i
const LIGHT_STATUS = /\b(?:not|n'?t|never)\b[^.\n]{0,40}\b(?:yet|built|tested|confirmed|verified|seen|run|ran)\b|\b(?:haven'?t|hasn'?t|isn'?t)\b/i
export const lightCorrection = (line: string): boolean => {
  const m = /^[ \t>]*(?:[-*+\u2022][ \t]+)?(?:\*\*|__)?[ \t]*(?:Correction|Clarification)\b[^:\n]{0,30}:(?:\*\*|__)?(.*)$/i.exec(line)
  if (m === null) return false
  const body = (m[1] ?? '').trim()
  if (body === '' || body.split(/\s+/).length > LIGHT_WORDS || MISS_WORDS.test(body)) return false
  const figs = body.replace(/\b\d+(?:\.\d+){1,3}\b(?!:)/g, ' ').replace(/\b(?:v|0\.)\d+\b/gi, ' ') // drop version strings
  return !(/\d/.test(figs) && SWAP_WORDS.test(figs))
}
// Correction/Clarification lines that still owe the full block (not light); a Clarification that is not light counts as a Correction.
const owesBlock = (t: string): number => t.split('\n').filter(l => /^[ \t>]*(?:[-*+\u2022][ \t]+)?(?:\*\*|__)?[ \t]*(?:Correction|Clarification)\b[^:\n]{0,30}:/i.test(l) && !lightCorrection(l)).length
export const correctionWithoutPrevention = (answer: string, prompt = ''): boolean => {
  const t = stripCode(stripDrafts(answer, prompt)).replace(/"[^"\n]*"|\u201c[^\u201d]*\u201d|\u2018[^\u2019\n]*\u2019/g, ' ')
  return owesBlock(t) > 0 && !LABEL_LINE('Prevention').test(t)
}
// 0.6.15 prevention-line (why): a Prevention:/Correction: line with no line starting "Why you caught it:" / "Why J caught it:". Same exemptions.
// 0.6.16: the "why J, not Claude, caught it" line is matched by meaning: "Why you caught it", "Why J caught it", "why you, not Claude, ...", "You caught it because".
const WHY_LINE = /^[ \t]*(?:[-*+•][ \t]+)?(?:\*\*|__)?[ \t]*(?:Why (?:you|J)\b[^\n]{0,30}\bcaught\b|Why (?:you|J),? not Claude|(?:You|J) caught (?:it|this|that) because)/im
export const preventionWithoutWhy = (answer: string, prompt = ''): boolean => {
  const t = stripCode(stripDrafts(answer, prompt)).replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, ' ')
  return (LABEL_LINE('Prevention').test(t) || owesBlock(t) > 0) && !WHY_LINE.test(t)
}
// 0.6.14 page-cite: "p. 4" / "page 4" on a line that names a file whose name appears in no tool input or message of this turn.
export const unopenedPageCites = (answer: string, inputs: string, prompt = ''): string[] => {
  const hay = inputs.toLowerCase().replace(/[^a-z0-9]/g, '')
  const out: string[] = []
  for (const l of stripCode(stripDrafts(answer, prompt)).split('\n')) {
    if (!/\bpp?\.\s?\d+|\bpages?\s+\d+/i.test(l)) continue
    for (const m of l.matchAll(new RegExp(DOC_NAME.source, 'gi'))) {
      const stem = m[0].replace(/\.[a-z]+$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '')
      if (stem.length >= 2 && !hay.includes(stem) && !out.includes(m[0])) out.push(m[0])
    }
  }
  return out
}
// 0.6.14 stop-sources: 3+ list/table lines carrying a date, amount or % with no source marker. A list header ending ":" that carries a
// source covers its items; a table whose header starts source/evidence/ref passes. Reports about usage/limits naming no document are skipped.
const SRC_FACT = /\b\d{1,2} [A-Za-z]{3,9} \d{4}\b|\b\d{4}-\d{2}-\d{2}\b|(?:US\$|S\$|HK\$|RMB|USD|SGD|HKD|\$)\s?\d|\b\d+(?:\.\d+)?%|\bdated\b/
const SRC_MARK = /\.(?:pdf|docx?|xlsx?|msg|pptx?|md|py)\b|\bp\. ?\d|\bpage\b|\bcl\.? ?\d|\bsch\.? ?\d|\brow \d|\bemail\b|\bvdr\b|\bintralinks\b|\bregister\b|\bbriefing\b|\bminutes\b|\bdeed\b|\bagreement\b|\bcertificate\b|https?:\/\/|\]\(|\bunverified\b|\binferred\b|\bsuggest|\bestimate|\bproposed\b|\byour figure\b|(?<!['’])\b(?:paras?|paragraphs?|ss?|sections?|art(?:icle)?|slides?)\.?\s?\d|¶\s?\d/i
const BULLET = /^\s*(?:[-*•]\s|\d+\.\s|\|)/
export const unsourcedBullets = (answer: string, prompt = ''): number => {
  const text = stripCode(stripDrafts(answer, prompt))
  if (/\b(?:usage|limits?|tokens?)\b/i.test(text) && !DOC_NAME.test(text)) return 0
  const lines = text.split('\n')
  if (lines.some(l => /^\s*\|\s*(?:source|evidence|ref)/i.test(l))) return 0
  let bad = 0
  let header = ''
  for (const l of lines) {
    if (!BULLET.test(l)) { if (l.trim() !== '') header = l; continue }
    if (/^\s*\|[\s:|-]+\|?\s*$/.test(l)) continue
    if (SRC_FACT.test(l) && !SRC_MARK.test(l) && !(header.trimEnd().endsWith(':') && SRC_MARK.test(header))) bad++
  }
  return bad
}
// 0.6.14 stop-writes: a first-person "saved/updated/written…" (or "file/draft was saved") claim, outside quotes, code and blockquotes.
const WRITE_CLAIM = /\bi(?:['’]ve| have)?(?: now)? (?:saved|updated|added|written|wrote|filed|renamed|created|tightened|edited)\b|\b(?:rule|briefing|file|hook|script|settings?|draft|copy) (?:is |was |has been )?(?:saved|updated|added|created)\b/i
export const writeClaims = (answer: string, prompt = ''): string[] => {
  const out: string[] = []
  for (const raw of proseLines(stripDrafts(answer, prompt))) {
    const l = raw.replace(/`[^`\n]*`/g, ' ').replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, ' ')
    const m = WRITE_CLAIM.exec(l)
    if (m) out.push(m[0].trim())
  }
  return out
}
// jText: only J's typed text counts. Agent messages, hand-backs, task/trigger notifications, notification reads
// and system reminders are not J: strip them (an unclosed block runs to the end); a prompt that opens on one is not J's.
const NOT_J_BLOCK = /<(agent-message|task-notification|system-reminder|cross-session-message|scheduled-task|trigger-notification|notification)\b[^>]*>[\s\S]*?(<\/\1>|$)/gi
const NOT_J_FRAME = /^[ \t]*(\[Subagent hand-?back\]|\[Scheduled[^\]\n]*\]|\[Trigger[^\]\n]*\]|\[Notification[^\]\n]*\]|Another Claude session sent a message:?|Scheduled (?:task|trigger)[^\n]*(?:fired|notification)[^\n]*:)[\s\S]*$/im
export const jText = (prompt: string): string => prompt.replace(NOT_J_BLOCK, ' ').replace(NOT_J_FRAME, '').trim()
// reask-guard: J is correcting or re-asking. Tell the model before it answers; then the answer needs a
// "Correction:" line or a confidence label.
export const reasks = (prompt: string): boolean => rx('reask-guard','reask').test(jText(prompt))

// scope-quote: J stated a limit ("just f, i, j", "not just 40 keys", "finish the limit"). Quote his exact
// phrase back as context so the answer honours it. Narrow patterns on purpose: plain "just"/"only" don't fire.
export const scopePhrases = (prompt: string): string[] => {
  const found: { at: number; text: string }[] = []
  for (const re of rxs('scope-quote','list')) {
    const m = re.exec(prompt)
    if (m !== null) found.push({ at: m.index, text: m[0].trim().split(/\s+/).slice(0, num('scope-quote', 'maxWords')).join(' ') }) // 0.6.0: no 5-word cut
  }
  found.sort((a, b) => a.at - b.at)
  const out: string[] = []
  let words = 0
  for (const f of found) {
    const n = f.text.split(' ').length
    if (out.includes(f.text) || words + n > num('scope-quote', 'maxWords')) continue
    out.push(f.text)
    words += n
  }
  return out
}
export const scopeCtx = (prompt: string): string | undefined => {
  if (prompt.trimStart().startsWith(GUARD_TAG) || prompt.includes('<task-notification>')) return undefined
  const p = scopePhrases(jText(prompt))
  return p.length === 0 ? undefined : msg('scope-quote', 'context', { phrases: p.map(x => `"${x}"`).join(' ') })
}

// 0.6.8 per session id: J's own words this chat (labels he used) and his scope phrases.
const saidBy = new Map<string, string>()
const scopeBy = new Map<string, string[]>()
export const saidIn = (sid: string): string => saidBy.get(sid) ?? ''
// scope-quote (0.6.8): J's limit phrases kept for the whole chat; each later prompt carries them (word budget, newest kept).
async function scopeCarry($: EngineInterface, text: string): Promise<string | undefined> {
  if (text.trimStart().startsWith(GUARD_TAG) || text.includes('<task-notification>')) return undefined
  const sid = await $.session.id()
  const said = jText(text)
  for (const m of [saidBy, scopeBy]) if (!m.has(sid) && m.size >= 20) m.delete(m.keys().next().value!)
  if (said !== '' && isJ(text)) saidBy.set(sid, `${saidIn(sid)}\n${said}`.slice(-50_000))
  const now = scopePhrases(said)
  const kept: string[] = []
  let words = 0
  const prev = (scopeBy.get(sid) ?? []).filter(x => !now.includes(x))
  for (const p of [...prev, ...now].reverse()) {
    const n = p.split(' ').length
    if (words + n > num('scope-quote', 'maxWords')) break
    kept.unshift(p)
    words += n
  }
  // Only J's own short messages carry on: a long one is mostly pasted text, quoted for its own turn only.
  scopeBy.set(sid, said.split(/\s+/).length <= 60 ? kept : prev.filter(x => kept.includes(x)))
  return kept.length === 0 ? undefined : msg('scope-quote', 'context', { phrases: kept.map(x => `"${x}"`).join(' ') })
}

// running-proof: a reply's "(running" needs a launch id from a tool result this turn, or one from an
// earlier turn of the session that no notification has reported finished yet.
// "(running" or "running (Sonnet)" / "running (Opus ..." : both claim a launched agent.
const AGENT_TOOLS = new Set(['Agent', 'Task'])
const TRIGGER_TOOL = /(^|__)(create_trigger|send_later)$/
const AGENT_ID = /\b(?:agentId|agent_id|agent|id)\b["']?\s*[:=]\s*["']?([\w-]{4,})/
const RESUMED_ID = /\bresumedAgentId\b["']?\s*[:=]\s*["']?([\w-]{4,})/
const BG_ID = /Command running in background with ID:?\s*([\w-]+)/
const TRIGGER_ID = /\btrigger_id\b["']?\s*[:=]\s*["']?([\w-]{4,})/
// A task notification that a launch ended: its id, when the status is a final one.
const DONE_NOTE = /<task-notification>[\s\S]*?<\/task-notification>/g
const NOTE_ID = /<(?:task-id|task_id|agent-id|agentId)>\s*([\w-]+)\s*</
// finish-row: a turn opened by a task-notification with status completed needs a status-board write that turn.
const BOARD_URL = '1pV8oEewdbsBMqi6EYDAA8'
const NOTE_COMPLETED = /<status>\s*completed\s*</i
// Only an agent's completion owes a board row: summary 'Agent "…"' or an agent <result> block; a background command never.
const NOTE_SUMMARY = /<summary>\s*([\s\S]*?)\s*<\/summary>/i
const agentNote = (n: string): boolean => {
  const sum = NOTE_SUMMARY.exec(n)?.[1] ?? ''
  if (/^Background command\b/i.test(sum)) return false
  return /^Agent "/.test(sum) || /<result>/i.test(n)
}
export const completedNote = (text: string): boolean => (text.match(DONE_NOTE) ?? []).some(n => NOTE_COMPLETED.test(n) && agentNote(n))
export const boardWrite = (e: Record<string, unknown>): boolean => {
  if (!ARTIFACT_DATA.test(String(e.tool)) || !['set', 'update', 'batch'].includes(String(e.action))) return false
  return String(e.url ?? '').includes(BOARD_URL)
}
// 0.6.28 claim-ahead: what a job-record call says about live jobs. A task-list read or a status-board read (get/list/query) sets it from its result;
// a board write that marks a row live sets it; any other call leaves it (undefined). Live = a job or row whose status is running / in progress / active / building / queued.
const BOARD_LIVE = /["']?status["']?\s*:\s*["']?(?:running|in[ _-]?progress|active|building|queued)\b/i
const TASKS_LIVE = /(?:^|[\s·|:"'(])(?:running|in[ _-]?progress)\b/im
export const liveJobsOf = (e: Record<string, unknown>, result: string): boolean | undefined => {
  if (/(?:^|__)(?:TaskList|TaskGet)$/.test(String(e.tool))) return TASKS_LIVE.test(result)
  if (!ARTIFACT_DATA.test(String(e.tool)) || !String(e.url ?? '').includes(BOARD_URL)) return undefined
  const act = String(e.action ?? '')
  if (['get', 'list', 'query'].includes(act)) return BOARD_LIVE.test(result)
  if (['set', 'update', 'batch'].includes(act) && BOARD_LIVE.test(JSON.stringify([e.data, e.writes, e.batch]))) return true
  return undefined
}
const NOTE_FINAL = /<status>\s*(completed|failed|killed|stopped|cancelled|error)\s*</i
// idle-guard: removing the orchestrator ledger, or saying it is cleared / the queue is empty.
const LEDGER_RM = /(^|[\s;&|(])rm\b[^;&|\n]*?(\s["']?\$\{?L\}?["']?(?=$|[\s;&|)])|(~|\$HOME)?\/?\.claude\/orchestrator\/)/
// "(needs you)" is the legitimate footer for work waiting on J, so it is no idle miss.
const NEEDS_J = /\(needs you\)/i
// parked-fix: a fix named ("should be a cheap fix", "needs to be fixed") with no launch id and no write-type tool this turn.
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Artifact'])
export const parkedFix = (answer: string, acted: boolean): boolean => !acted && !NEEDS_J.test(answer) && rx('parked-fix','fix').test(answer)
// 0.6.21 efficiency-fix: an "Efficiency:" line that describes a fix ("I could have", "would have", "should") with no write, memory write, launch id or SendMessage this turn.
// "Efficiency: none" and "(needs you)" are exempt. Same one line as parked-fix; live regardless of the parked-fix switch (that check is OFF at turn end).
const EFF_FIX = /\b(?:I|we)(?:'d| could| would| should| ought)\b|\b(?:could|would|should|ought to)(?: have| be| now)?\b/i
export const efficiencyFix = (answer: string, acted: boolean): boolean => {
  if (acted) return false
  return answer.split('\n').some(l => { const m = /^\W*Efficiency\b\W*:\W*(.*)$/i.exec(l); return m !== null && !/^none\b/i.test(m[1].trim()) && !NEEDS_J.test(m[1]) && EFF_FIX.test(m[1]) })
}
// miss-landing: a line opening "Miss:" / "Correction:" / "Gap:" (after markdown bold or bullets) names a miss;
// it must land a fix (write-type or memory-write tool, or a launch id) or say no fix is needed.
const LANDING_TOOL = /(^|__)propose_skills$|memory_(write|append|str_replace)$/
// 0.6.10: a "Gap:" line about J's draft (names a para/clause/heading/schedule/definition/formula or a 3.9 / 3(f) number, and has
// no I/me/my/we/our) is a finding about his document, not Claude's own miss: it needs no landing. Miss:/Correction: lines unchanged.
const GAP_LABEL = /^[ \t]*(?:[-*+•][ \t]+)?(?:\*\*|__)?[ \t]*gap[ \t]*(?:\*\*|__)?[ \t]*:/i
const FIRST_PERSON = /(?<!\()\bI\b(?!\))|\b(?:[Mm]e|[Mm]y|[Mm]ine|[Ww]e|[Oo]urs?|[Uu]s)\b/ // case-sensitive "I": "(i)" / "3(i)" are list labels
const DRAFT_PART = /\b(?:paras?|paragraphs?|clauses?|cl|sub-?clauses?|headings?|headers?|title(?: line)?|schedules?|sections?|definitions?|defined|extract|formula|recitals?|limbs?|the (?:draft|agreement|SPA|SSA|contract|memo|document|deed))\b|\b\d+\.\d+\b|\b\d+\([a-z]{1,4}\)/i
export const draftGap = (line: string): boolean => GAP_LABEL.test(line) && !FIRST_PERSON.test(line.replace(GAP_LABEL, '')) && DRAFT_PART.test(line)
// 0.6.15 unsaved-promise: a reply promising a future way of working ("from now on", "going forward", "I'll always") when no memory write,
// propose_skills or Edit/Write to a skill/card file ran this turn. Drafts, blockquotes, quoted spans and "(needs you)" are exempt.
const SAVE_FILE = /skill|card|preferences|CLAUDE\.md/i
export const savesClaudeWide = (e: Record<string, unknown>): boolean => {
  const tool = String(e.tool)
  if (MEMORY_WRITE.test(tool) || /(^|__)propose_skills$/.test(tool)) return true
  return /^(Edit|Write|NotebookEdit)$/.test(tool) && SAVE_FILE.test(String(e.file_path ?? e.path ?? e.notebook_path ?? ''))
}
export const unsavedPromise = (answer: string, saved: boolean, prompt = ''): boolean => {
  if (saved || NEEDS_J.test(answer)) return false
  const t = stripCode(stripDrafts(answer, prompt)).replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, ' ')
  return proseLines(t).some(l => rx('unsaved-promise', 'promise').test(l))
}
export const missUnlanded = (answer: string, landed: boolean): boolean => {
  if (landed || rx('miss-landing', 'ok').test(answer)) return false
  const miss = rx('miss-landing', 'miss')
  const one = new RegExp(miss.source, miss.flags.replace(/[gm]/g, ''))
  return answer.split('\n').some(l => one.test(l) && !draftGap(l))
}

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

// Points over the style maxWords (rule pack) words: each bullet or paragraph outside code blocks; tables and code skipped.
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
    for (const p of para.join(' ').split(FOOTER_LABEL)) if (pointWords(p) > num('style','maxWords')) n++
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
// dangling-ref (0.5.7): a pointer to a decision list or item that the same reply does not hold —
// "D2" with no D2 line, "questions below" with nothing after it, "options in my next message".
const labelKey = (t: string): string => t.toLowerCase().replace(/[\s()]/g, '')
export const danglingRefs = (answer: string, said = '', web = ''): string[] => {
  const lines = proseLines(answer).filter(l => !l.trim().startsWith('>'))
  const defined = new Set<string>()
  for (const l of lines) {
    const m = rx('dangling-ref', 'dDef').exec(l)
    if (m) defined.add(labelKey(m[1]))
    const n = rx('dangling-ref', 'listDef').exec(l)
    if (n) defined.add(`#${n[1].toLowerCase()}`)
  }
  // D/Q/Decision need their own line; step/option/item/question/(c) are also met by a "3." / "c)" list line.
  const met = (label: string): boolean => {
    const k = labelKey(label)
    if (defined.has(k)) return true
    const g = /^(?:step|option|item|question)(\w{1,2})$/.exec(k) ?? (/^\(\w{1,2}\)$/.test(label.trim()) ? [k, k] : null)
    return g !== null && defined.has(`#${g[1]}`)
  }
  const refs: string[] = []
  const add = (r: string): void => { if (!refs.includes(r)) refs.push(r) }
  const isAsk = (x: string): boolean => rx('dangling-ref', 'dDef').test(x) || /\?[*_ \t]*$/.test(x) || /^\s*([-*•]|\d+[.)])\s+\S/.test(x)
  lines.forEach((l, i) => {
    for (const m of l.matchAll(rxg('dangling-ref', 'dRef'))) if (!met(m[1]) && !usedIn(m[1], said)) add(m[1].replace(/\s+/g, ' '))
    const after = (): string[] => lines.slice(i + 1).filter(x => x.trim() !== '')
    if (rx('dangling-ref', 'below').test(l)) {
      const a = after()
      if (a.length === 0 || (rx('dangling-ref', 'belowDecision').test(l) && !a.some(isAsk))) add('"below"')
    }
    const d = rx('dangling-ref', 'nextMsg').exec(l)
    if (d !== null && rx('dangling-ref', 'listish').test(l) && !after().some(isAsk)) add(`"${d[0]}"`)
    // An ask whose only carrier is a link on that line: the decision itself is not in the reply.
    if (rx('dangling-ref', 'askNoun').test(l) && rx('dangling-ref', 'link').test(l) && !/\?/.test(l) && !rx('verify-proof', 'sourcesLine').test(l)) add('"link"')
  })
  for (const t of undefinedLabels(lines, said, web)) add(t)
  return refs
}
// 0.6.8: a label J never used and the reply doesn't gloss where it first appears; a name a web lookup returned is public.
const usedIn = (t: string, hay: string): boolean =>
  hay !== '' && new RegExp(`(?<!\\w)${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s?').replace('#', '#?')}(?!\\w)`, 'i').test(hay)
export const undefinedLabels = (lines: string[], said: string, web = ''): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const l of lines) {
    for (const id of ['code', 'workLabel']) {
      for (const m of l.matchAll(rxg('dangling-ref', id))) {
        const t = m[1]
        const k = t.toLowerCase().replace(/[\s#]/g, '')
        if (seen.has(k)) continue
        seen.add(k)
        const before = l.slice(0, m.index)
        const rest = l.slice((m.index ?? 0) + m[0].length)
        if (usedIn(t, said) || usedIn(t, web) || rx('dangling-ref', 'gloss').test(rest)) continue
        if (id === 'code' && ((rx('dangling-ref', 'brand').test(before) && !/^\W*\w+[ -]$/.test(before)) || rx('dangling-ref', 'product').test(rest))) continue
        if (/^[QH][1-4]$/.test(t) && /^\s*(?:19|20)\d\d/.test(rest)) continue // a quarter or half-year
        out.push(t)
      }
    }
  }
  return out
}
// question-edit (0.6.8): J's message holds only questions — no request or instruction verb in any sentence.
export const questionOnly = (prompt: string): boolean => {
  const s = prompt.split(/(?<=[.?!])\s+|\n+/).map(x => x.trim().replace(/^[^\w"“]+/, '')).filter(Boolean)
  return s.length > 0 && /\?[*_)"'”’\s]*$/.test(s[s.length - 1]) && !s.some(x => rx('question-edit', 'request').test(x))
}
export const redrafts = (asked: string, answer: string, edited = false): boolean => questionOnly(asked) && (edited || rx('question-edit', 'redraft').test(answer))
export const danglingMsg = (refs: string[]): string => msg('dangling-ref', 'line', { refs: refs.join(', ') })
// H-5: an AskUserQuestion call or an own-line question to J (that is not itself the offer) is a real ask: no offer line.
const ownAsk = (l: string): boolean => /^[^.!?]*\b(you|your)\b[^.!?]*\?[*_ \t]*$/i.test(l.trim())
export const offers = (answer: string, askTool = false): boolean => {
  const lines = proseLines(answer).filter(l => !l.trim().startsWith('>'))
  if (askTool || rx('offer-guard', 'decision').test(answer)) return false
  if (!lines.some(l => rx('offer-guard', 'offer').test(l))) return false
  return !lines.some(l => ownAsk(l) && !rx('offer-guard', 'offer').test(l))
}
// H-3: the reply holds an ask to J.
export const asksJ = (text: string): boolean => rx('ask-first', 'ask').test(proseLines(text).join('\n'))
// 0.6.10 ask-first: an ask counts as held only when it was knowable before the work calls. ~95% of 0.6.9 firings were a
// closing "**Next:** … (needs you)" whose ask came out of that turn's own findings. A line is knowable when it asks J for
// input (a question, a D/Q line, or a lead verb such as send/tell/paste/choose) and names nothing the work produced:
// no "[●]" placeholder or "the block", no blocked-site note, no "A or B" options, no section/clause/D-number,
// model-number or link that is absent from the early text (J's prompt plus J-facing text sent before the first work call).
// A to-do handed to J ("check/fill/file/open/get … (needs you)") is a next step, not a held ask. A prompt that itself asks
// "what do you need from me" makes the asks the reply, so nothing was held.
const ASK_LEAD = /^[\s>*_#•+-]*(?:(?:\*\*|__)?\s*(?:next|D\d{1,2}|Q\d{1,2})\b[^:\n]{0,20}[:.]\s*(?:\*\*|__)?)?\s*(?:\(needs you\)[:\s]*)?(?:\*\*|__)?\s*(?:please\s+)?(?:if [^,\n]{0,60},\s*)?(?:then\s+)?([a-z]+)/i
const INPUT_VERB = new Set(['tell', 'send', 'share', 'give', 'paste', 'attach', 'choose', 'pick', 'decide', 'approve', 'reply', 'answer', 'confirm', 'let', 'say', 'forward', 'provide'])
const ASK_Q = /\?(?=[*_)"'”’]*(?:\s|$))/
const ASK_DQ = /^[\s*_#-]*(?:\*\*|__)?[DQ]\d{1,2}\b/i
const ASKS_FOR_ASKS = /\b(?:what|anything)\b[^.?\n]{0,20}\byou need from me\b|\bneed (?:anything|something) from me\b|\bwhat do you need\b/i
const WORK_MADE = /\[\s*(?:●|x|\.\.\.|…)?\s*\]|\b(?:this|the) block\b|\bblocked (?:for me|my|me|automated|access|the)\b|\b(?:it|site|page) blocked\b|\bcan[’']?t (?:open|reach|get|access)\b|\bmy tools\b/i
const WORK_OPTIONS = /\b(?:option\s+)?[A-D]\s+or\s+[A-D]\b|\(a\)[^\n]*\(b\)/i
// A section/clause/item number, a model-style name (letters with digits) or a link: the number part must be in the early text.
const WORK_REF = /\b(?:ss?|cl|clauses?|para(?:graph)?s?|sections?|rule|items?|limb|steps?)\.?\s*\(?(\d[\w.()–-]*)|\b((?=[a-z]*\d)(?=\d*[a-z])[a-z\d]{3,})\b|(https?:\/\/\S+)|\b(\d+\.\d+(?:\.\d+)*)\b/gi
export const inputAsk = (line: string): boolean => {
  if (ASK_DQ.test(line) || ASK_Q.test(line)) return true
  const m = ASK_LEAD.exec(line)
  const v = (m?.[1] ?? '').toLowerCase()
  if (v === 'the') return /\(needs you\)[*_:\s]*the\b/i.test(line) // "Next (needs you): the lender's address …" names the data wanted
  if (v === 'i') return /^\s*need\b/i.test(line.slice((m?.index ?? 0) + (m?.[0].length ?? 0))) // "I need the parties …"
  return INPUT_VERB.has(v) && !(v === 'paste' && /\binto\b/i.test(line))
}
// The ask itself: the line without its Next/D-label, (needs you) tags and parentheticals, up to the first sentence end or follow-on clause.
export const askClause = (line: string): string =>
  line.replace(/\(needs you\)/gi, ' ').replace(/^[\s>*_#•+-]*(?:\*\*|__)?\s*(?:next\b[^:\n]{0,20}:|[DQ]\d{1,2}\b\s*[:.—–-]?)\s*(?:\*\*|__)?/i, '')
    .replace(/^\s*[DQ]\d{1,2}\s*[—–:-]\s*/, '').replace(/\([^()\n]*\)/g, ' ')
    .split(/\?|[.;](?=\s|$)|,\s*(?:and|or|then)\s|\s(?:and|so) (?:I|we)(?:['’]ll| will| can)?\s|\sthen\s|\s(?:or I can|that decides)\b/i)[0]
export const workMade = (line: string, early: string): boolean => {
  const ask = askClause(line)
  if (WORK_MADE.test(ask) || WORK_OPTIONS.test(line)) return true
  const e = early.toLowerCase()
  return [...ask.matchAll(WORK_REF)].some(m => !e.includes((m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').toLowerCase().replace(/[.)]+$/, '')))
}
// The ask lines of `text` that were knowable before the work (see above); [] when J's prompt asked for the asks.
export const knowableAsks = (text: string, early: string): string[] => {
  if (ASKS_FOR_ASKS.test(early)) return []
  return proseLines(text).filter(l => rx('ask-first', 'ask').test(l) && inputAsk(l) && !workMade(l, early))
}
// H-4: you-questions buried in a multi-sentence line or a table row (blockquotes are paste-ready text: exempt).
export const buriedAsks = (answer: string): number => {
  let n = 0
  for (const raw of proseLines(answer)) {
    const l = raw.trim()
    if (l === '' || l.startsWith('>')) continue
    if (l.startsWith('|')) { if (rx('ask-standout', 'ask').test(l.replace(QUOTED, 'Q'))) n++; continue }
    if (rx('dangling-ref', 'dDef').test(l) || rx('dangling-ref', 'listDef').test(l)) continue
    const parts = l.replace(QUOTED, 'Q').split(/(?<=[.!?])\s+(?=\S)/)
    if (parts.length > 1 && parts.some(p => /\?[*_)"'”’]*$/.test(p) && rx('ask-standout', 'ask').test(p))) n++
  }
  return n
}
// [unsourced "verified" lines, unverified/TBC markers]; blockquoted drafts count.
// A "Sources:" line anywhere in the answer sources every "verified" in it.
// A "verified" line also needs a verbatim quoted span (“…”, "…" or a > blockquote) on that line or the next: a bare link can't be checked at a glance.
// "Checked and dropped/ruled out" is a verified claim in disguise (dropping an option on an unquoted reason).
export const unverified = (answer: string): [number, number] => {
  const lines = proseLines(answer)
  const sourced = rx('verify-proof','sourcesLine').test(lines.join('\n'))
  const bad = lines.filter((l, i) => (rx('verify-proof','verified').test(l) || rx('verify-proof','ruledOut').test(l)) && !rx('verify-proof','inChat').test(l) && ((!sourced && !rx('verify-proof','source').test(l) && !(rx('verify-proof','fileSrc').test(l) && rx('verify-proof','quote').test(l))) || !rx('verify-proof','quote').test(`${l}\n${lines[i + 1] ?? ''}`))).length
  // An unverified marker that names where it looked (site or link) is an honest disclosure, not an unchecked fact.
  return [bad, lines.filter(l => rx('verify-proof','unchecked').test(l) && !rx('verify-proof','namedSite').test(l)).length]
}
export const promises = (answer: string): boolean => proseLines(answer).some(l => rx('promise-proof','promise').test(l))
export const writes = (tool: string): boolean => WRITE_TOOL.test(tool)
// 0.6.3 done-claim: a read-back is a call that shows the written thing again (read, search, fetch, get/query, test run, validate).
const READBACK_TOOL = /^(Read|Grep|Glob|WebFetch)$/
const READBACK_BASH = /\b(curl|gh\s+(?:api|pr view|run view|release view)|grep|rg|cat|head|tail|diff|test|pytest|vitest|validate|sha256sum|ls|wc|unzip\s+-l|stat)\b/
const WRITEISH_BASH = /(?:^|[^>=])>{1,2}\s*[\w./~$"'-]|\bsed\s+-i|\btee\b|\b(?:cp|mv|rm|zip|git\s+(?:push|commit))\b/
export const readsBack = (e: Record<string, unknown>): boolean => {
  const tool = String(e.tool)
  if (READBACK_TOOL.test(tool)) return true
  if (/(^|__)ArtifactData$/.test(tool) || tool === 'Artifact') return READ_ACTIONS.has(String(e.action ?? 'publish'))
  if (tool === 'Bash') return READBACK_BASH.test(String(e.command ?? '')) && !WRITEISH_BASH.test(String(e.command ?? ''))
  return false
}

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
export const unproven = (reply: string, proof: boolean): boolean => !proof && rx('running-proof','claim').test(reply)
// An idle claim outside the "Next:" footer ("Next: nothing running" just states the footer's status).
const NEXT_LINE = /^[\s>*_-]*(\*\*)?Next:/i
export const idleClaim = (answer: string): boolean =>
  !NEEDS_J.test(answer) && answer.split('\n').some(l => !NEXT_LINE.test(l) && rx('idle-guard','claim').test(l))
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
  + "|\\b(what|which|where)(" + Q + "?s|\\s+is|\\s+are)?\\s+(the\\s+)?[a-z]{1,10}\\.?\\s?\\d[\\w.]*|that" + Q + "?s (wrong|not right)|what the (hell|heck|f)|supposed to|in future|mix(ed)? up|except for|not just\\b|too (long|short|verbose|wordy)\\b|shorten\\b|\\bpaste\\b"
  + "|you can google|look (it )?up|\\bagain\\b|does(n" + Q + "?t| not)? have\\b|(i|we) (don" + Q + "?t|do not) (have|need|want|use)\\b|can" + Q + "?t get\\b)", 'i')
// Only the opening of a prompt is read: a long pasted brief is no correction.
export const correcting = (text: string): boolean => CORRECTING.test(jText(text).slice(0, 160))
const CATEGORIES: [RegExp, string][] = [
  [/verified where|are you sure|is it really|really mean|why (did|do) you|why do you say|\b(what|which|where)('?s| is| are)?\s+(the\s+)?[a-z]{1,10}\.?\s?\d|^where\b/i, 'unverified claim'],
  [/too (long|short|verbose|wordy)|shorten|eta|slow/i, 'slow/over-long'],
  [/paste|format|icon|mix(ed)? up/i, 'format/style miss'],
  [/google|look (it )?up|supposed to|memori[sz]ed/i, "didn't check stored info"],
  [/^(just|and|but|what about|i mean)\b|except for|not just|only|question|i (just |already )?(told|said)|repeat/i, 'wrong scope'],
]
export const corrCategory = (text: string): string => CATEGORIES.find(([re]) => re.test(text))?.[1] ?? 'unclassified'
// Not J typing: agent messages, task notifications, hook continuations, slash commands.
const NOT_J = /^\s*(<|\[dispatch-guard\]|Another Claude session|Stop hook feedback|The files from earlier|\[?\s*Your previous response had no visible output\b)/ // 0.6.29: the app's no-output nudge is not J
// 0.5.9: judge J's own text, not the raw prompt — the app prepends a <system-reminder> (current date) to J's messages,
// so a raw-text NOT_J test (leading '<') wrongly read every J message as not-J (night nudge and corr-log never fired).
export const isJ = (text: string): boolean => { const j = jText(String(text ?? '')); return j !== '' && !NOT_J.test(j) }
export type CorrRow = { source?: 'J'; date: string; chat: string; words: string; wrong: string; category: string; covered: boolean; rule: string; count: number; auto: true; session: string; triage_conf?: 'low' }
// 0.6.25 write-time category: a regex category is kept as low-confidence triage; only an unclassified row stays in the triage queue.
export const corrRow = (text: string, session: string, chat: string, now: number): CorrRow => {
  const category = corrCategory(text)
  return {
    date: new Date(now + 8 * 3_600_000).toISOString().slice(0, 10), // SGT calendar day
    chat: chat.slice(0, 60), words: text.trim().slice(0, 300), wrong: '(auto-logged: triage)', category,
    covered: false, rule: category === 'unclassified' ? 'auto-logged; triage' : 'auto-logged; regex category (low confidence)', count: 1, auto: true, session,
    ...(category === 'unclassified' ? {} : { triage_conf: 'low' as const }),
  }
}
const corrId = (r: CorrRow, now: number): string => `auto-${r.session.slice(0, 8)}-${now.toString(36)}`
async function corrQueue($: EngineInterface): Promise<{ id: string; data: CorrRow | HookRow; collection?: string }[]> {
  const v = await $.store.get(CORR_KEY)
  return Array.isArray(v) ? v as { id: string; data: CorrRow | HookRow; collection?: string }[] : []
}
// 0.6.1 hook-fire rows: each time a check fires, one row (source "hook", check id, session, ISO time in SGT) joins the same queue and
// flushes the same way (only where the permission check already says allow). No reply text, no client content.
export type HookRow = { source: 'hook'; check: string; session: string; time: string; date: string; chat: string; words: string; wrong: string; category: string; covered: boolean; rule: string; count: number; auto: true }
export const sgtIso = (now: number): string => new Date(now + 8 * 3_600_000).toISOString().slice(0, 19) + '+08:00'
export const hookRow = (check: string, session: string, now: number): HookRow => ({
  source: 'hook', check, session, time: sgtIso(now), date: sgtIso(now).slice(0, 10), chat: '', words: '', wrong: `hook fired: ${check}`,
  category: 'hook check', covered: true, rule: check, count: 1, auto: true,
})
// Which checks put text into `text`: every check message (placeholders as wildcards) and every added check message found in it.
export const firedIn = (text: string): string[] => {
  const out = new Set<string>()
  const esc = (m: string): RegExp => new RegExp(m.split(/\{\w+\}/).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?'))
  for (const [id, c] of Object.entries(RULES.checks)) for (const m of Object.values(c.messages)) if (m.length >= 12 && esc(m).test(text)) out.add(id)
  for (const a of RULES.add) if (text.includes(a.message)) out.add(a.id)
  return [...out]
}
// 0.6.10 self-catch metric: a firing row is held in $.store (PENDING_KEY) until the end of the main turn after the one it fired in,
// then queued with `fixed: true/false` and `fixed_by` (the evidence, or why not). Rule (deterministic, see README "fixed"):
//   fixed = no J correction row logged in this session after the firing (corr-log / J-correction)
//         AND the same check did not fire again in the next turn
//         AND fix evidence in the rest of the firing turn or the next turn (fixEvidence below).
// A row still pending after PENDING_TTL_MS (no next turn in this session) is queued without `fixed` (the page counts it unresolved).
const PENDING_KEY = 'hookPending'
const PENDING_KEEP = 200
export const PENDING_TTL_MS = 24 * 3_600_000
export type Pending = { id: string; data: HookRow; sid: string; at: number; ends: number; ev?: string; corrected?: boolean }
export type TurnFacts = { facing: string; board: boolean; write: boolean; launch: boolean; guard: boolean; answered: boolean }
const BOARD_FIX = new Set(['finish-row', 'board-dispatch'])
const SOURCE_FIX = new Set(['legal-cite-source', 'verify-proof', 'source-addendum'])
// The first piece of fix evidence for `check` in one turn's facts, or undefined.
export const fixEvidence = (check: string, t: TurnFacts): string | undefined => {
  const req = RULES.add.find(a => a.id === check)?.requires
  if (req !== undefined) return req.test(t.facing) ? 'requires' : undefined
  if (BOARD_FIX.has(check)) return t.board ? 'board-write' : undefined
  switch (check) {
    case 'miss-landing': if (t.write || t.launch) return 'write'; if (rx('miss-landing', 'ok').test(t.facing)) return 'rule-named'; break
    case 'parked-fix': case 'promise-proof': case 'unsaved-promise': case 'offer-guard': case 'held-for-j':
      if (t.write || t.launch) return 'write'; if (check !== 'promise-proof' && NEEDS_J.test(t.facing)) return 'needs-you'; break
    case 'running-proof': if (t.launch) return 'launch'; break
    case 'idle-guard': if (t.guard && t.answered) return 'guard-reply'; break
    case 'checked-line': if (/^\W*checked\b[^:\n]{0,20}:/im.test(t.facing)) return 'checked-line'; break
  }
  if (SOURCE_FIX.has(check) && /https?:\/\//.test(t.facing)) return 'link'
  return CORRECTION_LINE.test(t.facing) ? 'correction-line' : undefined
}
export const settleRow = (p: Pending, refired: ReadonlySet<string>): HookRow & { fixed: boolean; fixed_by: string } => {
  const fixed = !p.corrected && !refired.has(p.data.check) && p.ev !== undefined
  const by = p.corrected ? 'j-correction' : refired.has(p.data.check) ? 'refired' : p.ev ?? 'no-evidence'
  return { ...p.data, fixed, fixed_by: by }
}
// Every pending-row change runs on one chain, so concurrent hooks never drop a row.
let pendingChain: Promise<unknown> = Promise.resolve()
const onPending = <T>(f: () => Promise<T>): Promise<T | undefined> => {
  const run = pendingChain.then(f, f).catch(() => undefined)
  pendingChain = run
  return run
}
async function pendingRows($: EngineInterface): Promise<Pending[]> {
  const v = await $.store.get(PENDING_KEY)
  return Array.isArray(v) ? v as Pending[] : []
}
async function enqueue($: EngineInterface, rows: { id: string; data: unknown }[]): Promise<void> {
  if (rows.length === 0) return
  await $.store.set(CORR_KEY, [...await corrQueue($), ...rows as never[]].slice(-CORR_KEEP))
  await corrFlush($).catch(() => 0)
}
// `ends`: 1 for a firing at a turn's end (it resolves at the next turn's end), 0 for one during a turn (prompt or tool time).
export async function hookLog($: EngineInterface, ids: string[], ends = 0): Promise<string[]> {
  if (ids.length === 0) return []
  if (ends === 0) for (const id of ids) firedTurn.add(id)
  return (await onPending(async () => {
    try {
      const now = Number(await $.clock.now()) || Date.now()
      const sid = String(await $.session.id())
      const rows: Pending[] = ids.map(id => ({ id: `hook-${sid.slice(0, 8)}-${id}-${now.toString(36)}`, data: hookRow(id, sid, now), sid, at: now, ends }))
      const all = [...await pendingRows($), ...rows]
      const over = all.length > PENDING_KEEP ? all.slice(0, all.length - PENDING_KEEP) : []
      await $.store.set(PENDING_KEY, all.slice(-PENDING_KEEP))
      await enqueue($, over.map(p => ({ id: p.id, data: p.data }))) // overflow: sent unresolved
      return rows.map(p => p.id)
    } catch { return [] /* logging never affects a turn */ }
  })) ?? []
}
// Check ids that fired during the current main turn (prompt, tool and end): the "fired again" test for the previous turn's rows.
const firedTurn = new Set<string>()
// A J correction row was just logged: every pending row of this session is J-caught, except rows the same prompt fired
// (correction-prevention fires because of that very correction).
async function markCorrected($: EngineInterface, own: Promise<string[]>): Promise<void> {
  await onPending(async () => {
    const skip = new Set(await own)
    const sid = String(await $.session.id())
    const rows = await pendingRows($)
    if (rows.some(p => p.sid === sid && !skip.has(p.id))) await $.store.set(PENDING_KEY, rows.map(p => p.sid === sid && !skip.has(p.id) ? { ...p, corrected: true } : p))
  })
}
// End of a main turn: add this turn's evidence to the session's pending rows, settle those from the previous turn,
// age the rest; rows past the TTL (any session) go out unresolved.
export async function settle($: EngineInterface, facts: TurnFacts, refired: ReadonlySet<string>): Promise<void> {
  await onPending(async () => {
    try {
      const now = Number(await $.clock.now()) || Date.now()
      const sid = String(await $.session.id())
      const keep: Pending[] = []
      const out: { id: string; data: unknown }[] = []
      for (const p of await pendingRows($)) {
        if (p.sid !== sid) { if (now - p.at > PENDING_TTL_MS) out.push({ id: p.id, data: p.data }); else keep.push(p); continue }
        const ev = p.ev ?? fixEvidence(p.data.check, facts)
        const q = { ...p, ev }
        if (p.ends >= 1) out.push({ id: p.id, data: settleRow(q, refired) })
        else keep.push({ ...q, ends: p.ends + 1 })
      }
      await $.store.set(PENDING_KEY, keep)
      await enqueue($, out)
    } catch { /* logging never affects a turn */ }
  })
}
// Flush queued rows in one batch, only where the check already allows a database write.
let corrBusy = false // the flush's own ArtifactData call passes through this plugin's tool.call hook
export async function corrFlush($: EngineInterface): Promise<number> {
  if (corrBusy) return 0
  corrBusy = true
  flushDecision = 'unchecked'
  try { return await corrSend($) } catch (err) {
    await noteFlush($, { decision: flushDecision === 'unchecked' ? 'error' : flushDecision, error: excerpt(err), sent: 0, queued: (await corrQueue($).catch(() => [])).length })
    throw err
  } finally { corrBusy = false }
}
// W13: the last flush outcome is kept on disk (CORR_LAST_KEY), so a flush that never sends says why next time. Live 0.6.34 showed no
// corrVersions key at all: corrSend stopped at the permission check, which reports the session's declarative verdict before the mode
// settles an ask (no classifier, no dialog), so with no allow rule for ArtifactData it says `ask` even where the main chat's own writes
// pass. A hook's $.tool.call would run on that plain ask with nobody asked, so the hook never sends then: once a row has waited
// RELAY_AGE_MS it asks the main model (prompt context, at most once per RELAY_AGE_MS) to make the exact batch itself, through the
// session's normal permission path, and corrAbsorb dequeues what that call confirms. A `deny` is never relayed.
export const CORR_LAST_KEY = 'corrLastFlush'
export type LastFlush = { at: string; decision: string; error: string; sent: number; queued: number }
const CORR_SEEN_KEY = 'corrQueuedAt' // doc id -> when a flush first saw it queued (ms)
const CORR_RELAY_KEY = 'corrRelayAt' // when the last relay line went out (ms)
export const RELAY_AGE_MS = 30 * 60_000
export const RELAY_MAX_CHARS = 6000
let flushDecision = 'unchecked'
const excerpt = (x: unknown): string => String(x instanceof Error ? x.message : x ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
const objOf = <T>(v: unknown): Record<string, T> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, T> : {})
async function noteFlush($: EngineInterface, f: Omit<LastFlush, 'at'>): Promise<void> {
  try { await $.store.set(CORR_LAST_KEY, { at: sgtIso(await nowMs($)), ...f }) } catch { /* logging never affects a turn */ }
}
// The relay line for the prompt context, or undefined: only after a flush was told `ask`, a queued row has waited RELAY_AGE_MS,
// and no relay went out in the last RELAY_AGE_MS. Oldest rows first, pinned like the hook's own batch, capped at RELAY_MAX_CHARS.
export async function corrRelay($: EngineInterface): Promise<string | undefined> {
  const last = objOf<unknown>(await $.store.get(CORR_LAST_KEY))
  if (last.decision !== 'ask') return undefined
  const queue = await corrQueue($)
  if (queue.length === 0) return undefined
  const now = await nowMs($)
  const seen = objOf<number>(await $.store.get(CORR_SEEN_KEY))
  const oldest = Math.min(...queue.map(q => (typeof seen[q.id] === 'number' ? seen[q.id] as number : now)))
  if (now - oldest < RELAY_AGE_MS) return undefined
  const lastRelay = Number(await $.store.get(CORR_RELAY_KEY))
  if (Number.isFinite(lastRelay) && now - lastRelay >= 0 && now - lastRelay < RELAY_AGE_MS) return undefined
  const vers = objOf<{ v: number; at: number }>(await $.store.get(CORR_VER_KEY))
  const writes: CorrWrite[] = []
  let size = 0
  for (const q of queue.slice(0, 50)) {
    const w: CorrWrite = { op: 'set', collection: q.collection ?? 'corrections', doc_id: q.id, data: q.data }
    const p = vers[vkey(w.collection, w.doc_id)]
    const pinned = p === undefined ? w : { ...w, if_version: p.v }
    const s = JSON.stringify(pinned).length
    if (writes.length > 0 && size + s > RELAY_MAX_CHARS) break
    writes.push(pinned)
    size += s
  }
  await $.store.set(CORR_RELAY_KEY, now)
  return `${GUARD_TAG} scoreboard-flush: ${queue.length} Scoreboard row(s) queued, oldest ${Math.round((now - oldest) / 60_000)} min; the hook can't write them (permission check says "ask"). Make this one ArtifactData call now, input as given; if it is refused for a missing or stale if_version, get that doc and retry once with its version. It needs no mention in the reply. ${JSON.stringify({ action: 'batch', url: SCOREBOARD_URL, writes })}`
}
// A main-thread ArtifactData batch to the Scoreboard (the relayed flush, or one written by hand): record its confirmed versions and
// dequeue the rows it landed (same data only), as the hook's own send does.
export async function corrAbsorb($: EngineInterface, input: Record<string, unknown>, text: string, isError: boolean): Promise<number> {
  if (corrBusy || input.url !== SCOREBOARD_URL || input.action !== 'batch' || !Array.isArray(input.writes)) return 0
  const writes = (input.writes as CorrWrite[]).filter(w => w !== null && typeof w === 'object' && typeof w.doc_id === 'string')
  const now = await nowMs($)
  const vers: VerMap = objOf<{ v: number; at: number }>(await $.store.get(CORR_VER_KEY))
  const ok = confirmedWrites(text)
  for (const c of ok) vers[c.key] = { v: c.v, at: now }
  const okKeys = new Set(ok.map(c => c.key))
  const refused = REFUSED.test(text.replace(CONFIRMED, ''))
  const landed = new Map<string, string>()
  for (const w of writes) if (okKeys.has(vkey(w.collection ?? 'corrections', w.doc_id)) || (!isError && !refused)) landed.set(w.doc_id, JSON.stringify(w.data))
  if (refused) {
    const bad = refusedEntry(text, writes.filter(w => !okKeys.has(vkey(w.collection ?? 'corrections', w.doc_id))).map(w => w.doc_id))
    const w = bad === undefined ? undefined : writes.find(x => x.doc_id === bad.id)
    if (w !== undefined && bad?.v !== undefined) vers[vkey(w.collection ?? 'corrections', w.doc_id)] = { v: bad.v, at: now }
  }
  const rest = (await corrQueue($)).filter(q => !landed.has(q.id) || JSON.stringify(q.data) !== landed.get(q.id))
  await $.store.set(CORR_VER_KEY, pruneVers(vers, rest, now))
  await $.store.set(CORR_KEY, rest)
  await noteFlush($, { decision: 'relay', error: isError || refused ? excerpt(text) : '', sent: landed.size, queued: rest.length })
  return landed.size
}
// W11 pins: ArtifactData refuses a write to an existing document that carries no if_version (or a stale one), and one refused entry
// refuses the whole batch (the error names the first such entry, and the current version for a stale pin). So every confirmed write's
// version is kept in CORR_VER_KEY (`<collection>/<doc_id>` -> {v, at}) and pins that doc's next write (deep-stats upserts, the fixes
// version row). On a refusal the named entry's version comes from the error (else one `get`) and the batch is retried once with it;
// an entry still refused, or one the error does not name (the batch is then halved), is left out so the rest land, and stays queued.
const CORR_VER_KEY = 'corrVersions'
export const CORR_VER_TTL_MS = 48 * 3_600_000 // a deep-stats doc id carries its SGT date, so it is not rewritten after its day
export const CORR_VER_KEEP = 300
export const FLUSH_CALLS = 10 // ArtifactData calls per flush (batches and gets)
export type VerMap = Record<string, { v: number; at: number }>
const vkey = (collection: string, id: string): string => `${collection}/${id}`
const CONFIRMED = /\b(?:set|update)\s+"([^"]+)"\s*\/\s*"([^"]+)"\s*\(version\s+(\d+)\)/g
// Writes a batch result confirms: `set "<collection>"/"<doc_id>" (version N)`.
export const confirmedWrites = (text: string): { key: string; v: number }[] =>
  [...text.matchAll(CONFIRMED)].map(m => ({ key: vkey(m[1] ?? "", m[2] ?? ""), v: Number(m[3]) }))
const REFUSED = /refus|reject|nothing (?:was )?written|wrote nothing|not written|conflict|precondition|version mismatch|stale|changed since|already exists|(?:requires?|without|no|missing) (?:an? )?if_version/i
const ID_CHARS = 'A-Za-z0-9_\\-.~:@+'
const escRx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// The entry a refused batch names (the earliest-mentioned doc id of the batch) and the current version the error gives, if any.
export const refusedEntry = (text: string, ids: readonly string[]): { id: string; v?: number } | undefined => {
  let best: { id: string; at: number } | undefined
  for (const id of ids) {
    const m = new RegExp(`(?<![${ID_CHARS}])${escRx(id)}(?![${ID_CHARS}])`).exec(text)
    if (m !== null && (best === undefined || m.index < best.at)) best = { id, at: m.index }
  }
  if (best === undefined) return undefined
  const tail = text.slice(best.at + best.id.length, best.at + best.id.length + 240)
  const m = /(?:current(?:ly)?|now|latest|is at|exists at|actual)\D{0,24}?(\d+)/i.exec(tail) ?? /(?<!if_)\bversion\D{0,4}(\d+)/i.exec(tail)
  return m === null ? { id: best.id } : { id: best.id, v: Number(m[1]) }
}
// Drop map entries older than the TTL unless their doc is still queued; keep the newest CORR_VER_KEEP.
export const pruneVers = (m: VerMap, queued: readonly { id: string; collection?: string }[], now: number): VerMap => {
  const live = new Set(queued.map(q => vkey(q.collection ?? 'corrections', q.id)))
  const kept = Object.entries(m).filter(([k, e]) => live.has(k) || now - e.at <= CORR_VER_TTL_MS).sort((a, b) => b[1].at - a[1].at).slice(0, CORR_VER_KEEP)
  return Object.fromEntries(kept)
}
type CorrWrite = { op: 'set'; collection: string; doc_id: string; data: unknown; if_version?: number }
type CorrRan = { deny?: string; isError?: boolean; text?: string }
async function corrSend($: EngineInterface): Promise<number> {
  const queue = await corrQueue($)
  if (queue.length === 0) return 0
  const now = await nowMs($)
  const seenWas = objOf<number>(await $.store.get(CORR_SEEN_KEY)) // W13: first-seen time per queued row (the relay's age test)
  await $.store.set(CORR_SEEN_KEY, Object.fromEntries(queue.map(q => [q.id, typeof seenWas[q.id] === 'number' ? seenWas[q.id] : now])))
  const stored = await $.store.get(CORR_VER_KEY)
  const vers: VerMap = pruneVers(stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored as VerMap : {}, queue, now)
  const writes: CorrWrite[] = queue.slice(0, 50).map(q => ({ op: 'set', collection: q.collection ?? 'corrections', doc_id: q.id, data: q.data })) // 0.6.29: a row may name its collection (fixes)
  const pin = (w: CorrWrite): CorrWrite => { const p = vers[vkey(w.collection, w.doc_id)]; return p === undefined ? w : { ...w, if_version: p.v } }
  const batch = (ws: CorrWrite[]) => ({ action: 'batch', url: SCOREBOARD_URL, writes: ws.map(pin) })
  const verdict = await $.tool.check({ tool: 'ArtifactData', input: batch(writes) } as never)
  const decision = String(verdict?.decision ?? 'none')
  flushDecision = decision
  if (decision !== 'allow') { // W13: recorded; never sent from the hook (corrRelay hands an `ask` to the main model)
    await noteFlush($, { decision, error: excerpt(verdict?.reason ?? ''), sent: 0, queued: queue.length })
    return 0
  }
  let budget = FLUSH_CALLS
  let lastErr = ''
  const sent = new Map<string, string>()
  const repinned = new Set<string>()
  const lookup = async (w: CorrWrite): Promise<number | undefined> => {
    const input = { action: 'get', url: SCOREBOARD_URL, collection: w.collection, doc_id: w.doc_id }
    if (budget <= 0 || (await $.tool.check({ tool: 'ArtifactData', input } as never)).decision !== 'allow') return undefined
    budget--
    const got = await $.tool.call({ tool: 'ArtifactData', ...input } as never) as CorrRan
    if (got.deny !== undefined || got.isError) return undefined
    const m = /"version"\s*:\s*(\d+)|\bversion\D{0,4}(\d+)/i.exec(String(got.text ?? ''))
    return m === null ? undefined : Number(m[1] ?? m[2])
  }
  const send = async (ws: CorrWrite[]): Promise<void> => {
    if (ws.length === 0 || budget <= 0) return
    budget--
    const ran = await $.tool.call({ tool: 'ArtifactData', ...batch(ws) } as never) as CorrRan
    if (ran.deny !== undefined) { budget = 0; lastErr = excerpt(`denied: ${ran.deny}`); return }
    const text = String(ran.text ?? '')
    if (ran.isError || REFUSED.test(text.replace(CONFIRMED, ''))) lastErr = excerpt(text)
    const ok = confirmedWrites(text)
    for (const c of ok) vers[c.key] = { v: c.v, at: now }
    const okKeys = new Set(ok.map(c => c.key))
    const refused = REFUSED.test(text.replace(CONFIRMED, ''))
    if (!ran.isError && !refused) { for (const w of ws) sent.set(w.doc_id, JSON.stringify(w.data)); return }
    for (const w of ws) if (okKeys.has(vkey(w.collection, w.doc_id))) sent.set(w.doc_id, JSON.stringify(w.data)) // applied one at a time before the refusal
    if (!refused) { budget = 0; return } // not a write refusal (service down): retry next flush
    const rest = ws.filter(w => !okKeys.has(vkey(w.collection, w.doc_id)))
    const bad = refusedEntry(text, rest.map(w => w.doc_id))
    if (bad === undefined) { // unnamed: halve until the bad entry is alone
      if (rest.length > 1) { const h = Math.ceil(rest.length / 2); await send(rest.slice(0, h)); await send(rest.slice(h)) }
      return
    }
    const w = rest.find(x => x.doc_id === bad.id) as CorrWrite
    const k = vkey(w.collection, w.doc_id)
    if (!repinned.has(k)) {
      repinned.add(k)
      const v = bad.v ?? await lookup(w)
      if (v !== undefined && v !== vers[k]?.v) { vers[k] = { v, at: now }; await send(rest); return }
    }
    await send(rest.filter(x => x !== w)) // left out: stays queued for the next flush
  }
  try { await send(writes) } finally {
    await $.store.set(CORR_VER_KEY, pruneVers(vers, await corrQueue($), now))
    const rest = (await corrQueue($)).filter(q => !sent.has(q.id) || JSON.stringify(q.data) !== sent.get(q.id)) // an entry upserted during the send stays queued
    await $.store.set(CORR_KEY, rest)
    await noteFlush($, { decision, error: lastErr, sent: sent.size, queued: rest.length })
  }
  return sent.size
}
// A card from any hook version (header "Orchestrator card (", heading "# Orchestrator") already in the chat counts as loaded.
// An unreadable chat counts as loaded: a false alarm costs more than a missed one.
const CARD_SEEN = /Orchestrator card \(|^# Orchestrator\b/m
async function cardInChat($: EngineInterface): Promise<boolean> {
  try {
    const msgs = await $.session.messages()
    return !Array.isArray(msgs) || msgs.some(m => typeof m.text === 'string' && CARD_SEEN.test(m.text))
  } catch { return true }
}
async function corrLog($: EngineInterface, text: string): Promise<boolean> {
  if (!isJ(text) || !correcting(text)) return false
  const msgs = await $.session.messages()
  if (!Array.isArray(msgs) || !msgs.some(m => m.role === 'assistant')) return false // nothing to correct yet
  const chat = jText(msgs.find(m => m.role === 'user' && typeof m.text === 'string' && isJ(m.text))?.text ?? '').split('\n')[0]
  const now = await $.clock.now()
  const row = { ...corrRow(jText(text), await $.session.id(), chat, now), source: 'J' as const } // 0.6.4: one row per J prompt, tagged J
  await $.store.set(CORR_KEY, [...await corrQueue($), { id: corrId(row, now), data: row }].slice(-CORR_KEEP))
  await corrFlush($).catch(() => 0)
  return true
}

// 0.6.4 J-correction row: a J prompt that trips the correction-prevention trigger (leading quote/bold markers stripped per line)
// or uses revert phrasing queues one row {source "J", category, chat/session id, SGT time, words ""} - no prompt text.
// Same queue and flush path as hook-fire rows. 0.6.25: category from the prompt at write time (corrCategory; 'uncategorised' only when it finds none).
const REVERT = /\b(undo (?:that|this|it|the)|revert (?:that|this|it|the)|roll(?:ed)? ?back|no,? i meant|that[’']?s wrong|not what i (?:asked|wanted|said))\b/i
export const stripQuotes = (t: string): string => t.split('\n').map(l => l.replace(/^[\s>"'“”‘’*_`]+/, '')).join('\n')
export const jCorrection = (text: string): boolean => {
  const t = stripQuotes(jText(text))
  if (t === '') return false
  const cp = RULES.add.find(a => a.id === 'correction-prevention')
  return REVERT.test(t) || (cp !== undefined && cp.re.test(t))
}
export type JRow = { source: 'J'; category: string; chat: string; session: string; time: string; date: string; words: ''; covered: false; count: 1; auto: true }
export const jRow = (session: string, now: number, text = ''): JRow => {
  const c = corrCategory(stripQuotes(jText(text)))
  return { source: 'J', category: c === 'unclassified' ? 'uncategorised' : c, chat: session, session, time: sgtIso(now), date: sgtIso(now).slice(0, 10), words: '', covered: false, count: 1, auto: true }
}
async function jCorrLog($: EngineInterface, text: string): Promise<boolean> {
  if (!isJ(text) || !jCorrection(text)) return false
  const now = Number(await $.clock.now()) || Date.now()
  const sid = String(await $.session.id())
  await $.store.set(CORR_KEY, [...await corrQueue($), { id: `j-${sid.slice(0, 8)}-${now.toString(36)}`, data: jRow(sid, now, text) as never }].slice(-CORR_KEEP))
  await corrFlush($).catch(() => 0)
  return true
}

// Rule-pack load (0.5.8): fetched once per session, PACK_TIMEOUT_MS cap (and never past the hook's own budget).
// 404 (no pack published), a kill switch ({"disabled": true}) or a pack no newer than the bundled one → bundled, silently.
// Timeout, network error, bad JSON or a schema miss → bundled plus one context note per session.
// 0.6.7: `live` = a reachable pack's version when it is not newer than bundled (shown on the upload line, so a
// published fix that the bundled rules shadow is visible instead of silent).
export type PackStatus = { version: number; source: 'fetched' | 'bundled'; rules: Compiled; note?: string; live?: number }
const bundledStatus = (note?: string): PackStatus => ({ version: BUNDLED_VERSION, source: 'bundled', rules: bundledRules(), ...(note === undefined ? {} : { note }) })
const packNote = (why: string): string => `rulepack: ${why} — using bundled v${BUNDLED_VERSION}`
export async function loadPack($: EngineInterface, timeoutMs: number = PACK_TIMEOUT_MS): Promise<PackStatus> {
  let ac: AbortController | undefined
  try { ac = new AbortController() } catch {}
  let res: { status: number; ok: boolean; text: string } | 'timeout'
  try {
    const timer = $.clock.sleep(timeoutMs, ac === undefined ? undefined : { signal: ac.signal }).then(() => 'timeout' as const, () => new Promise<never>(() => {})) // no timer → wait on the fetch alone
    res = await Promise.race([$.http.fetch(PACK_URL), timer])
  } catch (err) {
    // An engine with no http.fetch at all (a bare test kit) has no pack to reach: bundled, silently.
    if (/no implementation for http\.fetch/.test(String(err))) return bundledStatus()
    return bundledStatus(packNote(`fetch failed (${String(err).slice(0, 60)})`))
  } finally { try { ac?.abort() } catch {} }
  if (res === 'timeout') return bundledStatus(packNote(`fetch timed out after ${Math.round(timeoutMs / 100) / 10} s`))
  if (res === undefined || res === null || typeof res !== 'object') return bundledStatus(packNote('fetch returned nothing'))
  if (res.status === 404) return bundledStatus()
  if (!res.ok) return bundledStatus(packNote(`fetch HTTP ${res.status}`))
  let pack: unknown
  try { pack = JSON.parse(String(res.text)) } catch { return bundledStatus(packNote('pack is not valid JSON')) }
  const o = (typeof pack === 'object' && pack !== null ? pack : {}) as Record<string, unknown>
  if (o.disabled === true) return bundledStatus()
  if (typeof o.version === 'number' && o.version <= BUNDLED_VERSION) return { ...bundledStatus(), live: o.version }
  const errs = validatePack(pack)
  if (errs.length > 0) return bundledStatus(packNote(`pack invalid (${errs[0].slice(0, 80)}${errs.length > 1 ? `; +${errs.length - 1} more` : ''})`))
  return { version: (pack as Pack).version, source: 'fetched', rules: mergePack(pack as Pack) }
}
const budgetMs = (next: unknown): number => {
  const left = Number((next as { budget?: { remainingMs?: unknown } } | null)?.budget?.remainingMs)
  return Number.isFinite(left) ? Math.max(200, Math.min(PACK_TIMEOUT_MS, left - 1500)) : PACK_TIMEOUT_MS
}
// foreground-wait (0.5.8): a Bash wait that holds the main loop. Never denied: re-run with run_in_background.
const UNIT: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }
const secs = (n: string | undefined, u: string | undefined): number => Number(n) * (UNIT[u ?? ''] ?? 1)
export const foregroundWait = (command: string): boolean => {
  const min = num('foreground-wait', 'minSeconds')
  for (const m of command.matchAll(rxg('foreground-wait', 'sleep'))) if (secs(m[1], m[2]) >= min) return true
  for (const m of command.matchAll(rxg('foreground-wait', 'timeout'))) if (secs(m[1], m[2]) >= min) return true
  return rx('foreground-wait', 'loop').test(command) || rx('foreground-wait', 'follow').test(command)
}
// Pack state: loaded once per session id (first hook call); the fallback note goes out once per session.
let packFor: string | undefined
let packLoad: Promise<PackStatus> | undefined
let packStatus: PackStatus = bundledStatus()
let packNoted: string | undefined
export const resetPack = (): void => { packFor = undefined; packLoad = undefined; packNoted = undefined; packStatus = bundledStatus(); setRules(packStatus.rules) }
export const packInfo = (): string => `rulepack v${packStatus.version} (${packStatus.source})${packStatus.live === undefined ? '' : `; live pack v${packStatus.live} not newer, ignored`}`
async function ensurePack($: EngineInterface, timeoutMs: number): Promise<string | undefined> {
  const sid = await Promise.resolve().then(() => $.session.id()).catch(() => '?')
  if (packFor !== sid || packLoad === undefined) {
    packFor = sid
    packLoad = loadPack($, timeoutMs).catch(() => bundledStatus())
  }
  packStatus = await packLoad
  setRules(packStatus.rules)
  if (packStatus.note === undefined || packNoted === sid) return undefined
  packNoted = sid
  return packStatus.note
}
// night-nudge: minutes after midnight in Singapore (UTC+8, no DST); each range wraps midnight when a > b.
const inMin = (t: number, a: number, b: number): boolean => (a === b ? false : a < b ? t >= a && t < b : t >= a || t < b)
// The tier's line for a time inside the window, else undefined.
export const nightLine = (ms: number): string | undefined => {
  const d = new Date(ms + 8 * 3_600_000)
  const t = d.getUTCHours() * 60 + d.getUTCMinutes()
  const [a, b, c, z] = ['startMin', 'tier2Min', 'tier3Min', 'endMin'].map(k => num('night-nudge', k))
  if (!inMin(t, a, z)) return undefined
  const tier = inMin(t, a, b) ? 'tier1' : inMin(t, c, z) ? 'tier3' : 'tier2'
  const base = msg('night-nudge', 'context', { line: msg('night-nudge', tier) })
  // 0.6.2: sleep log. Night date = the evening the night began (before noon SGT → previous day); 05:00+ = first_morning.
  const pad = (n: number): string => String(n).padStart(2, '0')
  const nd = new Date(ms + 8 * 3_600_000 - (t < 720 ? 86_400_000 : 0))
  const morning = t >= 300 && t < 720
  const log = msg('night-nudge', 'log', { date: `${nd.getUTCFullYear()}-${pad(nd.getUTCMonth() + 1)}-${pad(nd.getUTCDate())}`, field: morning ? 'first_morning' : 'last_evening', time: `${pad(Math.floor(t / 60))}:${pad(t % 60)}`, rule: msg('night-nudge', morning ? 'logMorning' : 'logEvening') })
  return `${base}\n${log}`
}
const addedHits = (on: 'answer' | 'prompt' | 'tool', text: string): { id: string; message: string }[] => RULES.add.filter(a => a.on === on && live(a.id) && a.re.test(text)).map(a => ({ id: a.id, message: a.message }))
const added = (on: 'answer' | 'prompt' | 'tool', text: string): string[] => addedHits(on, text).map(a => a.message)

// 0.6.0 leap-line: a substantive reply (≥minBullets list lines or ≥minWords prose words, more than one line) with no Leap: line.
export const missingLeap = (text: string): boolean => {
  const lines = proseLines(text).filter(l => l.trim() !== '')
  if (lines.length < 2 || rx('leap-line', 'leap').test(text)) return false
  const bullets = lines.filter(l => /^\s*([-*+•]|\d+[.)])\s+\S/.test(l)).length
  const words = lines.filter(l => !l.trim().startsWith('>')).join(' ').split(/\s+/).filter(Boolean).length
  return bullets >= num('leap-line', 'minBullets') || words >= num('leap-line', 'minWords')
}
// 0.6.0 arith-proof: numbers as tokens ("1,234.50" → "1234.5"); integers ≤10 are counts, not computed claims.
const NUM = /\d[\d,]*(?:\.\d+)?/g
const numKey = (t: string): string => String(Number(t.replace(/,/g, '')))
export const numbersIn = (t: string): string[] => (t.match(NUM) ?? []).map(numKey)
// Lines stating a computed number none of whose numbers were seen this turn (tool inputs/results, the turn's opening text).
// Blockquotes and inline code are quoted output: skipped. Versions, vN, clock times and ISO dates are no quantities.
export const uncomputed = (text: string, seen: ReadonlySet<string>): string[] => {
  const out: string[] = []
  for (const raw of proseLines(text)) {
    if (raw.trim().startsWith('>')) continue
    const l = raw.replace(/`[^`\n]*`/g, ' ').replace(rxg('arith-proof', 'skip'), ' ')
    if (!rx('arith-proof', 'claim').test(l)) continue
    const fresh = numbersIn(l).filter(n => !seen.has(n) && !(Number.isInteger(Number(n)) && Number(n) <= 10))
    if (fresh.length > 0) out.push(raw.trim())
  }
  return out
}
// A tool that runs code: any of them this turn could have computed the number.
const SCRIPT_TOOL = /^(Bash|NotebookEdit|REPL)$|(^|__)(run|exec|execute|eval|repl|python|run_code|code_execution)\w*$/i
export const scripts = (tool: string): boolean => SCRIPT_TOOL.test(tool)
// 0.6.0 repeat-miss: lines that state a non-prevention.
export const nonPreventions = (text: string): number => proseLines(text).filter(l => rx('repeat-miss', 'nonPrevention').test(l)).length
const NONPREV_KEY = 'nonPrevention'



// 0.6.15 reply modes. Deep (default): the reply is drafted inside check_reply and written as the final text once it returns PASS (mid-turn messages: SendUserMessage with the passed text). Light: as before.
export type ReplyMode = 'deep' | 'light'
export const MODE_KEY = 'replyMode'
export const DENY_KEY = 'deepDenials'
const MODE_CMD = /^\s*[*_`"']*(deep|light)\s+mode[*_`"']*(?:\s+(?:please|now|on))?\s*[.!]?\s*$/i
// A command only when the whole prompt is "deep mode" / "light mode" (optionally please/now/on, one . or !); anything after it is a sentence, not a command.
export const modeCommand = (text: string): ReplyMode | undefined => {
  const m = MODE_CMD.exec(jText(String(text ?? '')))
  return m === null ? undefined : (m[1].toLowerCase() as ReplyMode)
}
export async function readMode($: EngineInterface, cached?: ReplyMode): Promise<ReplyMode> {
  const v = await Promise.resolve().then(() => $.store.get(MODE_KEY)).catch(() => undefined)
  return v === undefined ? (cached ?? 'deep') : modeOf(v)
}
export const modeOf = (v: unknown): ReplyMode => (v === 'light' ? 'light' : 'deep')
export const CHECK_TOOL = 'mcp__dispatch-guard__check_reply'
export const SET_RULES_TOOL = 'mcp__dispatch-guard__set_rules'
export const RULES_KEY = 'standingRules' // `standingRules:<session>` = the user's standing rules text, capped at RULES_MAX chars
export const RULES_MAX = 12_000
// 0.6.28: an unchecked SendUserMessage runs the AI judge too (send = check), so a reply routed through it is checked before J sees it.
export const SEND_JUDGE = true
// 0.6.28: route every reply through SendUserMessage (the deep line says so). Off until a harness A/B shows it does not cost quality or speed.
export const SEND_ROUTE = false
export const ROUTE_LINE = `Send every reply to J with SendUserMessage: it runs the same check before J sees it and holds a failing draft (check_reply first is optional and saves a round). After it goes out, end the turn with no text.`
// 0.6.28: the Stop re-check (once per text): the reply reached J unchecked; check it now and send only a correction.
export const STOP_RECHECK = `Deep mode: this reply reached J without a check_reply PASS. Call ${CHECK_TOOL} now with this exact reply as text. If it passes, end the turn with no text: J already has it (if the app then asks for visible output, one line of at most 8 words with no claims, e.g. "Nothing to add."; it is not checked again). If it fails, send J only the correction (what was wrong, the fixed line) with SendUserMessage; never repeat the reply.`
// W24 (0.6.39): a final reply that differs (whitespace-normalised) from every text check_reply passed this turn is blocked with this instead.
export const STOP_REWORDED = 'Sent text differs from the passed draft. Re-run check_reply on the exact text you sent; from now on the final reply must be the passed text verbatim.'
// 0.6.29 (J 12:40, repeat loop): the Stop re-check's own exemptions. A short text (under deep-judge minWords, no claim word, not a yes/no
// answer) is never re-checked, whatever J asked; a re-check that fails only on footer lines is logged, not sent to J; the app's
// no-visible-output nudge is not a J message (no new epoch, no J turn), so its forced filler is never re-checked.
export const stopShort = (text: string): boolean => text.trim().split(/\s+/).length < num('deep-judge', 'minWords') && !rx('deep-judge', 'claim').test(text) && !/^\W*(?:yes|no)\b/i.test(text)
export const RECHECK_FOOTER: ReadonlySet<string> = new Set(['efficiency-line', 'leap-line', 'efficiency-none', 'prevention-line', 'efficiency-fix', 'closure-line'])
export const footerOnly = (probs: { id: string; text: string }[]): boolean => probs.length > 0 && probs.every(p => {
  if (!RECHECK_FOOTER.has(p.id)) return false
  if (p.id !== 'closure-line') return true
  const snips = [...p.text.matchAll(/"([^"]*)" \(/g)].map(m => m[1])
  return snips.length > 0 && snips.every(l => /^[\s*_>#-]*(?:efficiency|leap|prevention)\b/i.test(l)) // a Correction line's closure is substantive
})
export const NO_OUTPUT_NUDGE = /^\s*\[?\s*Your previous response had no visible output\b/i
export const DEEP_LINE = `Deep mode: draft the reply, call ${CHECK_TOOL} with {text, ask, evidence} (ask = J's message this turn, verbatim; evidence = one line per claim: <claim> ← <source: tool + time, agent report + time, J's words, or inferred/estimate>) and fix every listed problem until it returns PASS <hash>, then write that exact text as your final reply: nothing before or after it. Write the draft only inside the check_reply call; no visible text before the final reply. A mid-turn message to J goes out with the SendUserMessage tool, only after check_reply passed that exact text. Rule checks require: **Efficiency:** and **Leap:** lines on substantive replies; Correction with Prevention and "Why you caught it:"; every figure and done-claim in evidence or labelled inferred/estimate/requested; no unchecked absolutes, open questions or offers.`
export const replyHash = (t: string): string => { const n = String(t ?? '').replace(/\s+/g, ' ').trim(); return `${fnv8(n)}${n.length.toString(36)}` }
export const modeSwitchLine = (m: ReplyMode): string => m === 'deep'
  ? 'Mode switched to deep: replies are checked before J sees them (a few seconds slower).'
  : 'Mode switched to light: replies go straight out; the turn-end check may add a Correction: afterwards.'
export type DeepFacts = { asked: string; corpus: string; looked: boolean; anyTool: boolean; jTurn: boolean; acted: boolean; landed?: boolean; saved?: boolean; askTool?: boolean; wrote?: boolean; hadLeap?: boolean; hadEff?: boolean; launch?: boolean; changed?: boolean; acts?: Act[]; open?: boolean }
// Deterministic pre-send checks on one message's text (the same checks the turn-end pass runs); returns the exact problems.
export type Problem = { id: string; text: string; weak?: boolean }
const EFF_LINE = /(?:^|\n)\W*Efficiency\b\W*:/i
const substantive = (text: string): boolean => {
  const lines = proseLines(text).filter(l => l.trim() !== '')
  if (lines.length < 2) return false
  const bullets = lines.filter(l => /^\s*([-*+\u2022]|\d+[.)])\s+\S/.test(l)).length
  const words = lines.filter(l => !l.trim().startsWith('>')).join(' ').split(/\s+/).filter(Boolean).length
  return bullets >= num('deep-leap', 'minBullets') || words >= num('deep-leap', 'minWords')
}
// 0.6.16: deep-mode Leap/Efficiency use their own thresholds (pack check `deep-leap`: >=80 words or >=5 list lines), not leap-line's.
export const deepMissingLeap = (text: string): boolean => substantive(text) && !rx('leap-line', 'leap').test(text)
export const missingEfficiency = (text: string): boolean => substantive(text) && !EFF_LINE.test(text)
// Offers to do work later. A plain question to J ("do you want X signed?", "would you like A or B?") is a legitimate ask in a J-facing message, so it is not matched here.
const DEEP_OFFER = /\b(want me to|shall I|if you'?d like|say so|say the word|let me know if|just ping me)\b|\b(I|we) (can|could|will|'ll)\b[^.?\n]*\b(if you|when you|should you)\b|\b(want|like)\b[^.?\n]{0,15}\bme to\b|\b(happy|glad) to\b(?! (report|say|see|hear|confirm))/i
// 0.6.25 closure-line (J, 13 Nov): each Efficiency/Prevention/Correction line that names a change states its closure. Returns [line snippet, why] per miss.
// `changed` = a real change ran this turn (code/file edit, memory write outside handoffs/open items, skill proposal, Artifact publish, non-log ArtifactData write);
// `launch` = an agent/job launched this turn. Pattern keys live in the pack check `closure-line`.
// W5: "that prevention is a written rule in my job queue, not an automatic check." A present-tense "is/are ..., not ..." restatement; deferral, future or modal words exclude it.
const LIGHT_RESTATE = /\b(?:is|are|was|were)\b[^.\n]{1,60}?,?\s+not\s+(?:a|an|the|my|your|its)?\s*\w/i
const LIGHT_DEFER = /\b(?:parked|proposal|waiting|queued|later|next (?:build|plugin|zip|version|release|session)|handoff|hand-off|backlog|pending|to-?do|tomorrow|follow-?up|will|would|could|should|going to|from now on|next time|once|until)\b|\w['\u2019]ll\b/i
export const closureMisses = (text: string, f: { changed?: boolean; launch?: boolean }): [string, string][] => {
  const p = (k: string): RegExp => rx('closure-line', k)
  const out: [string, string][] = []
  for (const line of proseLines(text)) {
    const m = p('label').exec(line)
    if (m === null || (lightCorrection(line) && LIGHT_STATUS.test(line) && !/\b(?:parked|proposal|waiting|queued|later|next (?:build|plugin|zip)|handoff|backlog|will|would|could)\b/i.test(line))) continue // 0.6.32 W6: a light Correction that only states what is not yet built/seen names no change to close
    if (lightCorrection(line) && LIGHT_RESTATE.test(line) && !LIGHT_DEFER.test(line)) continue // W5 (live 0.6.32, 13 Nov 15:14/15:16): a light Correction that restates what a thing is ("X is Y, not Z") names no change to close; any deferral or future word keeps the check
    const body = String(m[1] ?? '').replace(/^[\s*_:]+/, '').trim()
    if (body === '' || /^none\b(?!\W*yet\b)/i.test(body) || !(p('change').test(body) || p('hindsight').test(body) || p('defer').test(body) || /\b(?:would|could|might)\b/i.test(body) || /^\W*Leap\b/i.test(line))) continue // hindsight, deferral, conditional and Leap ideas name a change too
    const snip = line.trim().slice(0, 80)
    if (p('needsJ').test(body)) continue
    const nd = new RegExp(p('noun').source, 'gi') // 0.6.27: "backlog merge", "queue runner" name a thing, not a deferral
    if (p('defer').test(body.replace(nd, ''))) { if (!(f.launch === true && p('running').test(body))) out.push([snip, 'later/queued/handoff is no closure unless it names a job launched this turn']); continue }
    if (p('hindsight').test(body)) { if (f.changed !== true) out.push([snip, 'hindsight line: make the change now and say where, or "needs J"']); continue }
    if (f.launch === true && p('running').test(body)) continue // 0.6.27: a job launched this turn named on the line closes it, deferral word or not
    if (/^\W*Correction\b/i.test(line) && p('reply').test(body)) continue // 0.6.27: "corrected in this reply": the reply is the fix
    const done = p('done'); const dm = new RegExp(done.source, done.flags.includes('g') ? done.flags : `${done.flags}g`)
    let closed = false
    for (const d of body.matchAll(dm)) {
      if (p('modal').test(body.slice(0, d.index))) continue // "would have saved", "will be added": not a closure
      if (!p('where').test(body.slice(d.index)) && !p('where').test(body.slice(0, d.index))) continue
      closed = f.changed === true || f.launch === true || p('past').test(body)
      if (closed) break
    }
    if (!closed && f.changed === true && p('whereNoun').test(body)) { const n = p('now').exec(body); closed = n !== null && !p('modal').test(body.slice(0, n.index)) } // 0.6.27: "the goal file now ..." after a real change this turn
    if (!closed) out.push([snip, 'no closure: end it "done in <where>" (changed this turn) or "needs J"'])
  }
  return out
}
// 0.6.28 claim-ahead: this turn's tool log as the deterministic claim check reads it. One entry per successful main-thread call:
// `write` (Edit/Write/memory write/ArtifactData write/Artifact publish/skill proposal/scheduled-task update/file-writing Bash), `launch` (Agent, SendMessage,
// send_later/create_trigger/fire_trigger, background Bash), `send` (SendMessage, SendUserMessage, other send/post tools), `report` (a finished agent's result).
// `tgt` = the call's path/url/collection/doc id (Bash: the command); `hay` = tgt plus the written content, lower-cased.
// `hay` of a plan/log write = its target only. `tag` = the words a "done in <place>" claim uses for the call's kind of place (memory, Scoreboard, agent brief, trigger...), plus a launch's result head (its id).
export type Act = { kind: 'write' | 'launch' | 'send' | 'report'; tgt: string; hay: string; tag?: string }
const ACT_TAGS: [RegExp, string][] = [
  [/^(?:Agent|Task)$/, 'agent background builder brief instructions prompt'],
  [/^SendMessage$/, 'agent builder brief instructions message'],
  [/(?:^|__)(?:create_trigger|send_later|fire_trigger|update_trigger)$/, 'trigger scheduler scheduled task check chain continuation'],
  [/(?:^|__)memory_\w+$/, 'memory'],
  [/(?:^|__)ArtifactData$/, 'artifact database collection'],
  [/(?:^|__)Artifact$/, 'artifact page'],
  [/(?:^|__)set_rules$/, 'dispatch-guard pre-send check reply checker rules'],
  [/(?:^|__)propose_skills$/, 'skill proposal'],
  [/^(?:Edit|Write|NotebookEdit|MultiEdit)$/, 'file'],
]
export const actsOf = (e: Record<string, unknown>, result = ''): Act[] => {
  const full = String(e.tool ?? ''), tool = full.replace(/^mcp__.*__/, ''), act = String(e.action ?? '') // an MCP-served Agent/Bash/SendMessage counts as the built-in one
  const cut = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v)).slice(0, 3000)
  const cmd = tool === 'Bash' ? String(e.command ?? '') : ''
  const tgt = (cmd !== '' ? cmd : [e.file_path, e.notebook_path, e.path, e.url, e.collection, e.doc_id, e.trigger_id, e.to, e.name, e.subagent_type].filter(x => typeof x === 'string').join(' ')).toLowerCase()
  const hay = `${tgt} ${[e.new_string, e.content, e.new_str, e.text, e.data, e.writes, e.edits, e.prompt, e.message, e.description, e.payload, e.batch, e.files].map(cut).join(' ')}`.toLowerCase()
  const url = String(e.url ?? '')
  const tag = [...ACT_TAGS.filter(([r]) => r.test(tool)).map(([, t]) => t), url.includes(SCOREBOARD_URL.split('/').pop() ?? '-') ? 'scoreboard corrections' : '', url.includes(BOARD_URL) ? 'status board' : '',
    typeof e.description === 'string' ? e.description : ''].join(' ').toLowerCase()
  // a plan or log write (handoff, open items, board row, Scoreboard row, rule-store load) is matched by its target and kind only: its text saying "done in X" never backs X
  const mk = (kind: Act['kind']): Act => ({ kind, tgt, hay: kind === 'write' && !realChange(e) ? tgt : hay, tag: kind === 'launch' || kind === 'send' ? `${tag} ${result.slice(0, 500).toLowerCase()}` : tag })
  if (AGENT_TOOLS.has(tool)) return [mk('launch'), ...(result.trim() === '' || /\b(?:launched|in the background|async)\b/i.test(result.slice(0, 300)) ? [] : [{ kind: 'report' as const, tgt: '', hay: result.slice(0, 6000).toLowerCase() }])] // a finished (foreground) agent's report backs what it did
  if (tool === 'SendMessage') return [mk('launch'), mk('send')]
  if (tool === 'SendUserMessage') return [mk('send')]
  if (TRIGGER_TOOL.test(tool) || /(^|__)fire_trigger$/.test(tool)) return [mk('launch')]
  if (tool === 'Bash') return [...(e.run_in_background === true ? [mk('launch')] : []), ...(BASH_CHANGE.test(cmd) ? [mk('write')] : [])]
  if (/^(?:Edit|Write|NotebookEdit|MultiEdit)$/.test(tool) || MEMORY_WRITE.test(tool) || /(^|__)(?:memory_delete|propose_skills|update_trigger|set_rules)$/.test(tool)) return [mk('write')]
  if (ARTIFACT_DATA.test(tool)) return ['set', 'update', 'str_replace', 'batch', 'delete'].includes(act) ? [mk('write')] : []
  if (/(^|__)Artifact$/.test(tool)) return act === '' || act === 'publish' ? [mk('write')] : []
  if (/Docs__(?:batch|update)$/.test(full)) return [mk('write')]
  if (/^\w*(?:send|post|reply)\w*$/i.test(tool) && tool !== 'check_reply') return [mk('send')]
  return []
}
// The words naming where a "done in <place>" claim landed: a path, file name or URL gives its last segment (matched against a write's target);
// a descriptive place ("my agent-brief template") gives its content words (5-letter stems, matched against a write's target or content).
const CLAIM_PATH = /`([^`\n]+)`|(https?:\/\/[^\s)]+)|((?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)+)|\b([\w-]+\.(?:md|ts|tsx|js|mjs|json|py|sh|html|txt|csv|patch|zip|docx|xlsx|yaml|yml))\b/
const CLAIM_STOP = /^(?:this|that|these|those|with|from|into|their|there|your|mine|file|files|line|lines|place|here|where|which|turn|reply|message|answer|today|same|every|each)$/
export const placeKeys = (place: string): { path: boolean; keys: string[] } => {
  const m = CLAIM_PATH.exec(place)
  if (m !== null) {
    const raw = String(m[1] ?? m[2] ?? m[3] ?? m[4]).replace(/(?::\d+(?:-\d+)?)?[.,;:)\]]*$/, '')
    const seg = raw.split(/[/?#\s]/).filter(Boolean)
    return { path: true, keys: [(seg.length > 0 ? seg[seg.length - 1] : raw).toLowerCase()] }
  }
  const words = (place.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []).flatMap(w => w.split('-')).filter(w => w.length >= 4 && !CLAIM_STOP.test(w))
  return { path: false, keys: [...new Set(words.map(w => w.slice(0, 5)))] }
}
// 0.6.28 claim-ahead (deterministic, no judge): each Correction/Prevention/Efficiency/Status/Next line whose done-claim ("done in <place>", built, saved,
// running, launched, sent) has no matching action in this turn's tool log. Returns [line snippet, why] per miss (one per line). Pattern keys: pack check `claim-ahead`.
export const claimAhead = (text: string, f: { acts?: Act[]; launch?: boolean; open?: boolean }): [string, string][] => {
  const p = (k: string): RegExp => rx('claim-ahead', k)
  const g = (k: string): RegExp => { const r = p(k); return new RegExp(r.source, r.flags.includes('g') ? r.flags : `${r.flags}g`) }
  const acts = f.acts ?? []
  const any = (kinds: Act['kind'][], ok: (a: Act) => boolean = () => true): boolean => acts.some(a => kinds.includes(a.kind) && ok(a))
  const out: [string, string][] = []
  for (const line of proseLines(text)) {
    const m = p('label').exec(line)
    if (m === null) continue
    const body = String(m[1] ?? '').replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, ' ') // quoted words are reported speech, not a claim
    if (/^[\s*_:]*none\b/i.test(body) || /\(needs you\)/i.test(body.split(':')[0])) continue // "Next (needs you):" waits on J
    const snip = line.trim().slice(0, 80)
    const corr = /^[\s>*_+•-]*correction\b/i.test(line) // a Correction narrates the past miss: only its place claims and "now"/"this turn" clauses claim this turn's work
    let miss: string | undefined
    for (const clause of body.split(/;\s+|(?<=[.!?])\s+(?=[A-Z(*_`'])|\s+[—–]\s+|\s+--\s+/)) {
      if (miss !== undefined) break
      if (p('exempt').test(clause)) continue
      const live = (i: number, len: number): boolean => !p('before').test(clause.slice(0, i)) && !p('after').test(clause.slice(i + len))
      const placeAt = new Set<number>()
      for (const d of clause.matchAll(g('place'))) {
        const vlen = (/^\w+/.exec(d[0]) ?? [''])[0].length
        placeAt.add(d.index)
        if (!live(d.index, vlen)) continue
        const rest = clause.slice(d.index + d[0].length)
        const place = (/^(?:`[^`\n]*`|[^,;()\n])*?(?=[,;()]|\.(?:\s|$)|\s+(?:and|but|so|with|for|—|-)\s|$)/.exec(rest) ?? [rest])[0].slice(0, 100)
        const { path, keys } = placeKeys(place)
        const where = (a: Act): string => path && a.kind === 'write' ? a.tgt : a.kind === 'launch' || a.kind === 'send' ? `${a.tgt} ${a.tag ?? ''}` : `${a.hay} ${a.tag ?? ''}`
        const ok = keys.length === 0 ? any(['write', 'report', 'launch']) : any(['write', 'report', 'launch', 'send'], a => keys.some(k => where(a).includes(k)))
        if (!ok) { miss = `"${d[0].trim()}${place.trim().slice(0, 40)}": no write or agent report this turn names ${keys.length === 0 ? 'any place' : `"${keys.join('/')}"`}`; break }
      }
      if (miss !== undefined) break
      if (corr && !p('fresh').test(clause)) continue
      for (const d of clause.matchAll(g('write'))) {
        if (placeAt.has(d.index) || !live(d.index, d[0].length)) continue
        if (!any(['write', 'report'])) { miss = `"${d[0]}": no write ran this turn`; break }
      }
      if (miss !== undefined) break
      for (const d of clause.matchAll(g('launch'))) {
        if (!live(d.index, d[0].length)) continue
        if (f.launch !== true && !any(['launch']) && !(f.open === true && /^running$/i.test(d[0]))) { miss = `"${d[0]}": no agent, message or job launched this turn${/^running$/i.test(d[0]) ? ' and no live job on record' : ''}`; break } // "running": a job launched in an earlier turn and still open counts
      }
      if (miss !== undefined) break
      for (const d of clause.matchAll(g('send'))) {
        if (!live(d.index, d[0].length)) continue
        if (f.launch !== true && !any(['launch', 'send'])) { miss = `"${d[0]}": nothing was sent this turn`; break }
      }
    }
    if (miss !== undefined) out.push([snip, miss])
  }
  return out
}
// W3 (13 Nov; AB-0628 cause W "work named but not done", 27 of 67 failed first drafts): with deep-cap 1 the redraft after a denial passes unjudged, so the
// denial is the drafter's only feedback. Per undone-work line it now names the exact next action (tool + target from this turn's tool log) and the line
// ending that closes it under closure-line and claim-ahead once that call has run. Text only: whether a draft is refused is unchanged. Pack check `next-action`.
export type NextKind = 'claim' | 'hindsight' | 'offer' | 'plan' | 'later' | 'idea' | 'effect'
export type NextAction = { line: string; kind: NextKind; call: string; close: string }
const naWhat = (s: string, n = 60): string => s.replace(/\*\*|__|`/g, '').replace(/^[\s>*+•-]+/, '').replace(/"/g, "'").replace(/\s+/g, ' ').trim().slice(0, n)
const naHead = (t: string): string => t.split(/\s+/)[0] ?? ''
// The plan/log writes this turn (handoff, open items, board or Scoreboard row): matched by target only, so their hay is the target (see actsOf).
export const planTargets = (acts: Act[]): string[] => [...new Set(acts.filter(a => a.kind === 'write' && a.tgt !== '' && a.hay.trim() === a.tgt.trim()).map(a => naHead(a.tgt)))].slice(0, 2)
const realTargets = (acts: Act[]): string[] => [...new Set(acts.filter(a => a.kind === 'write' && a.tgt !== '' && a.hay.trim() !== a.tgt.trim()).map(a => naHead(a.tgt)))].slice(0, 3)
export const nextAction = (line: string, f: { acts?: Act[]; today?: string; claim?: boolean }): NextAction => {
  const p = (k: string): RegExp => rx('next-action', k)
  const acts = f.acts ?? []
  const l = line.trim()
  const body = l.replace(/^[\s>*_+•-]*(?:\*\*|__)?\s*[A-Za-z][\w ()'’,-]{0,60}?:(?:\*\*|__)?\s*/, '')
  const what = naWhat(body)
  const whole = l.replace(/^[\s>*_+•-]*(?:\*\*|__)?\s*(?:Efficiency|Prevention|Correction|Leap|Status)\b/i, '') // shape words in a label ("Prevention (requested, not built):") count; the label word does not
  const real = realTargets(acts), plan = planTargets(acts)
  const launch = acts.find(a => a.kind === 'launch')
  const write = 'Edit / memory_str_replace / Artifact publish on the file or store that enforces it'
  const done = (w: string): NextAction => ({ line: l, kind: w as NextKind, call: real.length > 0 ? `name the write that holds it (this turn wrote: ${real.join(', ')}), or make it now: ${write}` : `make it now: ${write}`, close: '— done in <the target written>' })
  if (f.claim === true) return done('claim')
  if (p('hindsight').test(whole)) return { line: l, kind: 'hindsight', call: real.length > 0 ? `none, or name the change this turn made (${real.join(', ')})` : 'none', close: 'replace the line with a fact: "the first draft lacked <what>." (or make the change now and end "done in <where>")' }
  if (p('offer').test(whole)) return { ...done('offer'), close: '— done in <the target written>; only if no tool here reaches it: "— needs J: <the blocker>"' }
  if (p('plan').test(whole) && !p('later').test(whole.replace(p('plan'), ''))) {
    if (launch !== undefined) return { line: l, kind: 'plan', call: `none: ${naHead(launch.tgt) || 'a job'} was launched this turn`, close: '— requested; <that job> running' }
    const named = real.filter(t => { const stem = (t.split('/').pop() ?? '').replace(/\.[\w]+$/, '').toLowerCase(); return stem.length >= 3 && l.toLowerCase().includes(stem) }) // W5 (live 15:16): the line names a file this turn already wrote: no build agent
    if (named.length > 0) return { line: l, kind: 'plan', call: `none: this turn already wrote ${named.join(', ')}; name that write on the line`, close: `— done in ${named[0]}` }
    return { line: l, kind: 'plan', call: `Agent({ run_in_background: true, description: "build: ${naWhat(body, 40)}", prompt: "<the rule, the file that must enforce it, the test>"${plan.length > 0 ? ` (brief: ${plan.join(', ')})` : ''} }), or make it now: ${write}`, close: '— requested; build agent running (launched this turn) | — done in <the target written>' }
  }
  if (p('later').test(body) || p('later').test(whole)) {
    const c = p('clock').exec(whole)
    let hm = ''
    if (c !== null) {
      let h = Number(c[1] ?? c[4]); const m = c[2] ?? c[5] ?? '00'; const ap = String(c[3] ?? '').toLowerCase()
      if (ap === 'pm' && h < 12) h += 12
      if (ap === 'am' && h === 12) h = 0
      if (h <= 23) hm = `${String(h).padStart(2, '0')}:${m}`
    }
    const when = hm !== '' ? `at: "${f.today ?? '<YYYY-MM-DD>'}T${hm}:00[Asia/Singapore]"` : `delay_minutes: ${num('next-action', 'delayMin')}`
    return { line: l, kind: 'later', call: `send_later({ ${when}, message: "${what}" })`, close: `— check-in launched (send_later, ${hm !== '' ? `${hm} SGT` : `${num('next-action', 'delayMin')} min`})` }
  }
  if (/^[\s>*_+•-]*(?:\*\*|__)?\s*Leap\b/i.test(l)) return { line: l, kind: 'idea', call: `Agent({ run_in_background: true, description: "build: ${naWhat(body, 40)}", prompt: "<the idea, where it lands, the test>" })`, close: '— build agent running (launched this turn) | — needs J: <why it is J\'s call>' }
  return { line: l, kind: 'effect', call: 'run the step that shows the effect this turn (test, read, launch), or drop the effect', close: '— <the result that shows it>' }
}
// The draft line a snippet or a judge quote names (whitespace and ** ignored).
const naNorm = (s: string): string => s.replace(/\*\*|__|`/g, '').replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase()
export const draftLineFor = (draft: string, frag: string): string | undefined => {
  const q = naNorm(frag).replace(/[….]+$/, '').slice(0, 40)
  if (q.length < 8) return undefined
  return proseLines(draft).find(l => naNorm(l).includes(q))
}
// Per problem: the undone lines it names and their next actions. closure-line / claim-ahead carry the line snippet; judge (c)/(e)/(g) quotes it.
// A judge (c) item that is a lookup left undone is W2's (claimLookups), not a work item.
export const nextActions = (probs: Problem[], draft: string, f: { acts?: Act[]; today?: string }): NextAction[][] => probs.map(pr => {
  const jm = /^judge:\s*\(([a-g])\)\s*/i.exec(pr.text)
  const frags = pr.id === 'closure-line' || pr.id === 'claim-ahead' ? [...pr.text.matchAll(/"([^"]{8,})" \(/g)].map(m => m[1])
    : pr.id === 'judge' && jm !== null && /^[ceg]$/i.test(jm[1]) && !(jm[1].toLowerCase() === 'c' && rx('next-action', 'lookup').test(pr.text)) ? judgeClaims(pr.text.slice(jm[0].length)).split('\n') : []
  const seen = new Set<string>()
  const out: NextAction[] = []
  for (const fr of frags) {
    const line = draftLineFor(draft, fr)
    if (line === undefined || seen.has(line)) continue
    seen.add(line)
    out.push(nextAction(line, { ...f, claim: pr.id === 'claim-ahead' }))
  }
  return out.slice(0, 3)
})
export const nextText = (as: NextAction[]): string => as.length === 0 ? '' : `${msg('next-action', 'head')} ${as.map((a, i) => `${String.fromCharCode(97 + i)}) "${naWhat(a.line, 50)}": ${a.call}; end it "${a.close}"`).join(' ')}`
// 0.6.25 stop-repeat: draft lines (3+ words, footers aside) whose words are mostly (>= 0.8 of the shorter line) in one line J already saw this turn.
export const STOP_FEEDBACK = /(?:^|\n)\s*Stop hook feedback\b/
const FOOTER_LINE = /^[\s>*_-]*(?:\*\*|__)?(?:Efficiency|Leap|Next|checked)\b[^:\n]{0,20}:/i
const wordsOf = (l: string): string[] => (l.toLowerCase().match(/[a-z0-9][a-z0-9.'-]*/g) ?? [])
export const repeatedLines = (draft: string, seen: string): string[] => {
  const sentences = (t: string): string[] => proseLines(t).filter(l => !FOOTER_LINE.test(l)).flatMap(l => l.split(/(?<=[.!?;])\s+/)).map(l => l.trim())
  const prior = sentences(seen).map(l => new Set(wordsOf(l))).filter(w => w.size >= 3)
  return sentences(draft).filter(l => {
    if (l === '' || FOOTER_LINE.test(l)) return false
    const w = new Set(wordsOf(l))
    if (w.size < 3) return false
    return prior.some(p => { let n = 0; for (const x of w) if (p.has(x)) n += 1; return n / Math.min(w.size, p.size) >= 0.8 })
  })
}
// 0.6.25 evidence-first (J, 13 Nov): the draft states current state or answers a J correction/re-ask. The caller checks "first check_reply, no evidence call yet".
export const evidenceFirstHit = (text: string, ask: string): boolean => {
  const t = proseLines(stripCode(text)).filter(l => !/^\s*>/.test(l)).join('\n')
  return rx('evidence-first', 'state').test(t) || (ask.trim() !== '' && (correcting(ask) || reasks(ask) || jCorrection(ask)))
}
// W2 (13 Nov): name the exact lookup per unbacked claim, by claim type (rulepack evidence-first patterns + lk_<kind> messages).
// Advisory only: it never changes whether a draft is refused. Kinds the hook can read itself get resolveLookups' result.
export const LOOKUP_KINDS = ['link', 'path', 'version', 'live', 'status', 'verified', 'done', 'figure', 'time', 'coverage'] as const
export type LookupKind = typeof LOOKUP_KINDS[number] | 'answer'
export type ClaimLookup = { kind: LookupKind; claims: string[]; lookup: string; targets: string[] }
const clip = (l: string, at: number): string => {
  const s = l.replace(/\*\*|__|^\s*(?:[-*•]|\d+[.)])\s*/g, '').trim()
  const i = Math.max(0, Math.min(at - 20, s.length - 70))
  return `${i > 0 ? '…' : ''}${s.slice(i, i + 70).trim()}${i + 70 < s.length ? '…' : ''}`.replace(/"/g, "'")
}
export const claimLookups = (text: string, max = 6): ClaimLookup[] => {
  const by = new Map<LookupKind, ClaimLookup>()
  for (const raw of proseLines(text).filter(l => !/^\s*>/.test(l))) {
    for (const k of LOOKUP_KINDS) {
      const line = k === 'link' || k === 'path' ? raw : stripCode(raw)
      const m = rx('evidence-first', k).exec(line)
      if (m === null) continue
      const c = by.get(k) ?? { kind: k, claims: [], lookup: msg('evidence-first', `lk_${k}`), targets: [] }
      const hit = (k === 'path' ? m[1] : m[0]) ?? m[0]
      if (c.claims.length < 2) c.claims.push(clip(raw, raw.indexOf(hit)))
      if (k === 'link' || k === 'path') for (const g of line.matchAll(rxg('evidence-first', k))) { const x = (g[1] ?? g[0]).replace(/[.:]+$/, ''); if (c.targets.length < 3 && !c.targets.includes(x)) c.targets.push(x) }
      by.set(k, c)
    }
  }
  return LOOKUP_KINDS.filter(k => by.has(k)).map(k => by.get(k) as ClaimLookup).slice(0, max)
}
// The read-only lookups the hook runs itself on a deny: synced plugin versions (plugin.json), the clock, local file existence. Never network, never a write.
export async function resolveLookups($: EngineInterface, ls: ClaimLookup[], budget = 1500): Promise<Map<LookupKind, string>> {
  const out = new Map<LookupKind, string>()
  const work = (async () => {
    if (ls.some(l => l.kind === 'version' || l.kind === 'live')) {
      const v = await syncedVersions($).catch(() => '')
      if (v !== '') for (const k of ['version', 'live'] as const) if (ls.some(l => l.kind === k)) out.set(k, v)
    }
    if (ls.some(l => l.kind === 'time')) out.set('time', `now ${sgtIso(await nowMs($))} (SGT)`)
    const p = ls.find(l => l.kind === 'path')
    if (p !== undefined) {
      const r: string[] = []
      for (const t of p.targets.filter(x => x.startsWith('/'))) {
        try { const m = Number((await $.fs.stat(t)).mtimeMs) || 0; r.push(`${t} exists${m > 0 ? `, modified ${sgtIso(m).slice(0, 16)} SGT` : ''}`) } catch { r.push(`${t} not found`) }
      }
      if (r.length > 0) out.set('path', r.join('; '))
    }
  })()
  const timer = Promise.resolve().then(() => $.clock.sleep(budget)).catch(() => new Promise<never>(() => {})) // no timer → wait on the local reads alone
  await Promise.race([work.catch(() => undefined), timer])
  return out
}
export const lookupText = (ls: ClaimLookup[], read: Map<LookupKind, string>, quote = true): string =>
  msg('evidence-first', 'head', { list: ls.map((l, i) => `${String.fromCharCode(97 + i)}) ${l.kind}${quote && l.claims.length > 0 ? ` (${l.claims.map(c => `"${c}"`).join(', ')})` : ''}: ${l.lookup}${read.has(l.kind) ? ` ${msg('evidence-first', 'hook', { x: read.get(l.kind) as string })}` : ''}`).join(' ') })
// W2: hook-run read-only lookups land in the session evidence (and, at the call site, this turn's hook evidence), so the judge sees them as tool results, not as the draft's say-so.
export const lookupRead = (rd: Map<LookupKind, string>): string => [...rd].map(([k, v]) => `${k}: ${v}`).join('; ')
async function hookLookups($: EngineInterface, mode: ReplyMode | undefined, ls: ClaimLookup[]): Promise<Map<LookupKind, string>> {
  const rd = await resolveLookups($, ls).catch(() => new Map<LookupKind, string>())
  if (rd.size > 0) await rec($, mode, 'tool', 'hook-lookup', lookupRead(rd)).catch(() => undefined)
  return rd
}
// Judge problem tagged (b): the claims it quotes, else its whole text.
export const judgeClaims = (p: string): string => {
  const q = [...p.matchAll(/"([^"]{3,240})"|“([^”]{3,240})”/g)].map(m => m[1] ?? m[2])
  return q.length > 0 ? q.join('\n') : p
}
export const deepProblems = (text: string, f: DeepFacts): Problem[] => {
  const out: Problem[] = []
  const add = (id: string, t: string): void => { out.push({ id, text: t }) }
  if (f.anyTool === false) { const q = openQuestions(text, f.asked); if (q.length > 0) add('open-question', `open question the reply could check itself: ${q.slice(0, 3).join('; ')}`) }
  if (!f.looked) { const a = absoluteClaims(text, f.asked); if (a.length > 0) add('unbacked-absolute', `unbacked absolute claim (check it with a tool or soften it): ${a.slice(0, 3).join('; ')}`) }
  const wd = weekdayMismatches(text, f.asked)
  if (wd.length > 0) add('stop-dates', `weekday/date mismatch: ${wd.slice(0, 3).join('; ')}`)
  if (correctionWithoutPrevention(text, f.asked)) add('prevention-line', 'Correction without a "Prevention:" line (change made, or "Prevention: none \u2014 why")')
  if (preventionWithoutWhy(text, f.asked)) add('prevention-line', 'Prevention/Correction without "Why you caught it:" (why J, not Claude, caught it)')
  if (f.anyTool || !f.jTurn) { const u = unsourcedFigures(text, f.corpus, f.asked); if (u.length > 0) add('stop-figures', `figures with no source in this turn: ${u.slice(0, 4).join(', ')}`) }
  const b = unsourcedBullets(text, f.asked)
  if (b >= 3) add('stop-sources', `${b} bullets with no source marker (add the source or tag unverified/inferred)`)
  if (f.jTurn && !f.acted) { const w = writeClaims(text, f.asked); if (w.length > 0) add('stop-writes', `claims a write that did not run this turn: ${w[0]}`) }
  // 0.6.16: the offer / parked-fix / miss / promise checks run here on the draft itself, pre-send (the turn-end pass skips a final text that matches a PASS).
  if (offers(text, f.askTool === true) && DEEP_OFFER.test(proseLines(text).join('\n'))) add('offer-guard', msg('offer-guard'))
  const cl = num('closure-line', 'enforce') > 0 ? closureMisses(text, f) : []
  if (cl.length > 0) add('closure-line', `${msg('closure-line')} ${cl.slice(0, 3).map(([l, w]) => `"${l}" (${w})`).join('; ')}`) // 0.6.25: wins over efficiency-fix on the same line
  if (parkedFix(text, f.acted)) add('parked-fix', msg('parked-fix'))
  else if (!cl.some(([l]) => /^\W*Efficiency\b/i.test(l)) && efficiencyFix(text, f.acted || f.launch === true)) add('efficiency-fix', msg('parked-fix')) // 0.6.28: closure-line wins on the Efficiency line only; a closure miss elsewhere no longer hides it for a round
  const ca = num('claim-ahead', 'enforce') > 0 ? claimAhead(text, f) : []
  if (ca.length > 0) add('claim-ahead', `${msg('claim-ahead')} ${ca.slice(0, 3).map(([l, w]) => `"${l}" (${w})`).join('; ')}`)
  if (missUnlanded(text, f.landed === true || f.acted)) add('miss-landing', msg('miss-landing'))
  if (unsavedPromise(text, f.saved === true, f.asked)) add('unsaved-promise', msg('unsaved-promise'))
  if (f.wrote !== true && promises(text)) add('promise-proof', msg('promise-proof'))
  if (f.jTurn && f.hadLeap !== true && deepMissingLeap(text)) add('leap-line', 'substantive reply with no "**Leap:**" line (one non-obvious idea beyond the next step, citing the event that shows the need, or "Leap: none")')
  if (f.jTurn && f.hadEff !== true && missingEfficiency(text)) add('efficiency-line', 'substantive reply with no "**Efficiency:**" line: state what the first draft lacked, as a fact; a could/would/should fix needs the change made this turn')
  return out
}
// 0.6.19 source gate (deterministic, pre-judge, deep-evidence.sourceGate: 0 off, 1 log-only (default; 'source-gate' is in DARK), 2 live). Each draft sentence with a state/done word
// needs an evidence line that names a specific source (time-stamped tool/agent report, "J's words", or a label) and shares a stem of one of the sentence's top 3 content words, or an inline label.
export const STATE_WORD = /\b(?:synced|done|fixed|saved|verified|passed|passes|published|shipped|updated|changed|written|created|complete|completed|sent|uploaded|deleted|booked|tested|confirmed|ran|merged|pushed|deployed|built|installed|rebuilt)\b|\b(?:live|working|running)\b(?:\W+\w+){0,3}?\W+(?:version|plugin|agent|release|v?\d+\.\d+(?:\.\d+)?)\b/i
const SRC_LABEL = /\b(?:intended|estimated?|inferred|planned|requested|unverified)\b/i
const GATE_EXEMPT_SENTENCE = /\b(?:not yet|never|will|once|to be|until|going to)\b|\b(?:won|can)['\u2019]t\b|['\u2019]ll\b/i
const GATE_EXEMPT_LINE = /^[\s>*_`-]*(?:Correction|Prevention|Why you caught it|Efficiency|Leap|Next|checked)\b[^:\n]{0,40}:/i
const EV_ARROW = /\u2190|<-/
const EV_SOURCE = /\b\d{1,2}:\d{2}\b|J['\u2019]s words|\b(?:inferred|estimate[ds]?|intended|planned|requested|unverified)\b/i
const GATE_SKIP_WORD = /^(?:\d|[0-9a-f]{7,}$|yesterday|today|tomorrow|tonight|morning|evening|afternoon|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december|earlier|later|again|already|minutes?|hours?|seconds?|today's|about|after|before|which|their|there|these|those|where|while|would|could|should|being|every|other)/i
const stem = (w: string): string => { const l = w.toLowerCase(); for (const suf of ['ation', 'ing', 'ion', 'ed', 's']) if (l.endsWith(suf) && l.length - suf.length >= 4) return l.slice(0, -suf.length); return l }
const contentStems = (sentence: string): string[] => (sentence.match(/[A-Za-z0-9][A-Za-z0-9_'-]{3,}/g) ?? []).filter(w => !STATE_WORD.test(w) && !GATE_SKIP_WORD.test(w)).sort((a, b) => b.length - a.length).slice(0, 3).map(stem)
// 0.6.25: a keyword list is 3+ comma parts of at most 2 words each; one claim with commas ("a = 1, b = 2") is still a claim.
export const keywordList = (claim: string): boolean => { const parts = claim.split(',').map(x => x.trim()).filter(x => x !== ''); return parts.length >= 3 && parts.every(x => x.split(/\s+/).length <= 2) }
// 0.6.25: a negated or habitual state word claims nothing done ("**Verified:** not quite", "not yet saved", "alarms get fixed only with evidence"); other state words in the sentence still count.
const STATE_CORE = 'synced|done|fixed|saved|verified|passed|passes|published|shipped|updated|changed|written|created|complete|completed|sent|uploaded|deleted|booked|tested|confirmed|ran|run|merged|pushed|deployed|built|installed|rebuilt|live|working|running'
const NEG_LABEL = new RegExp(`^[\\s>*_\`-]*(?:${STATE_CORE})[\\s*_\`]*:[\\s*_\`]*(?:no|not(?: quite| yet| fully)?|partly|partially|unverified|unknown|unclear)\\b`, 'i')
const NEG_STATE = new RegExp(`\\b(?:not|never|no longer|(?:is|was|are|were|has|have|did)n['\u2019]t)\\s+(?:(?:yet|been|fully|quite|actually|really|all)\\s+)*(?:${STATE_CORE})\\b|\\bgets?\\s+(?:\\w+ly\\s+)?(?:${STATE_CORE})\\b`, 'gi')
export const stateClaim = (sn: string): boolean => STATE_WORD.test(sn.replace(NEG_LABEL, '').replace(NEG_STATE, ' '))
export const sourceGate = (text: string, evidence: string): string[] => {
  const ev = String(evidence ?? '').split(/\n/).map(l => l.trim()).filter(l => {
    if (l === '' || !EV_ARROW.test(l)) return false
    const [claim, ...src] = l.split(EV_ARROW)
    return EV_SOURCE.test(src.join(' ')) && !keywordList(claim) // a keyword list is not a claim
  }).map(l => l.toLowerCase())
  const out: string[] = []
  for (const line of proseLines(text)) {
    if (GATE_EXEMPT_LINE.test(line)) continue
    for (const raw of line.split(/(?<=[.!?])\s+/)) {
      const sn = raw.trim()
      if (sn === '' || !stateClaim(sn) || SRC_LABEL.test(sn) || GATE_EXEMPT_SENTENCE.test(sn)) continue
      const ks = contentStems(sn)
      if (ks.length === 0 || ev.some(l => ks.some(k => l.includes(k)))) continue
      out.push(sn.slice(0, 80))
    }
  }
  return out
}
export const SOURCE_GATE_ID = 'source-gate'
export const DENY_LOG_KEY = 'deepDenialLog' // rows {time, session, n, checks[]}, last 500
export const CAUGHT_KEY = 'deepCaught' // running count of messages denied before J saw them


// 0.6.16: deep mode needs check_reply in the session's tool list; where the list is unreadable it is assumed present.
export const CHECK_SPEC = {
  name: 'check_reply',
  description: 'Deep mode pre-send check. Pass the full draft reply as text, plus ask (the user message, verbatim) and evidence (short summary of tool results backing its claims); returns "PASS <hash>" or a numbered problem list to fix. Fix and recheck until PASS, then write that exact text as your final reply (mid-turn messages: SendUserMessage with the passed text).',
  inputSchema: { type: 'object', properties: {
    text: { type: 'string', description: 'The full draft reply, exactly as it will be sent.' },
    ask: { type: 'string', description: "The user's message this turn, verbatim." },
    evidence: { type: 'string', description: "Short summary of the tool results backing the draft's claims." },
  }, required: ['text'] },
  isDeferred: false,
}
export const SET_SPEC = {
  name: 'set_rules',
  description: "Once per session, before the first check_reply: pass the user's saved preferences / standing rules text verbatim (max 12000 chars). The pre-send judge then flags clear breaches of them. A later call replaces the stored text only if longer.",
  inputSchema: { type: 'object', properties: { text: { type: 'string', description: "The user's standing rules text, verbatim." } }, required: ['text'] },
  isDeferred: false,
}
// 0.6.17: the deep line as injected: DEEP_LINE + the short-reply exemption (threshold from the pack) + the set_rules instruction.
export const deepLine = (): string => `${DEEP_LINE} Fill the evidence field first, then draft only claims it backs; a claim about current state (live, synced, running, done) needs a tool result from this turn, so run that check before drafting; label estimates, plans, requests, causes and a fix's intended effect as such (estimate / inferred / intended), never as fact. Replies under ${num('deep-judge', 'minWords')} words with no Correction/Prevention/done-claim word (fixed, saved, verified, passed, done, sent, live, yes ...) and not answering a yes/no question may skip check_reply and go out directly as the final text. Once per session, before your first check_reply, call ${SET_RULES_TOOL} with {text} = the user's saved preferences text verbatim.${SEND_ROUTE ? ` ${ROUTE_LINE}` : ''}`
export async function hasCheckTool($: EngineInterface): Promise<boolean> {
  let list: unknown
  try { list = await $.tool.list() } catch { return true }
  if (Array.isArray(list) && !list.some(t => t?.name === SET_RULES_TOOL || t?.name === SET_SPEC.name)) await Promise.resolve().then(() => $.tool.register(SET_SPEC)).catch(() => undefined)
  if (!Array.isArray(list) || list.some(t => t?.name === CHECK_TOOL || t?.name === CHECK_SPEC.name)) return true
  try { await $.tool.register(CHECK_SPEC); return true } catch { return false } // same name replaces; a lost registration is restored
}
// 0.6.16 pre-send AI judge. When it answers, the narrow checks it covers generically drop from deny to log-only (dark) in deep mode; without an answer (fallback path, unavailable) they still deny.
export const DEEP_DARK: ReadonlySet<string> = new Set(['open-question', 'unbacked-absolute', 'stop-dates'])
// 0.6.28: DARK ids, plus claim-ahead while its pack switch is below 2 (log-only).
export const logOnly = (id: string): boolean => DARK.has(id) || (id === 'claim-ahead' && num('claim-ahead', 'enforce') < 2)
// 0.6.28: the checks that read labelled footer lines (Correction/Prevention/Why, Efficiency, Leap, Status, Next). A refusal that stops before the full rule pass
// (evidence-first) still lists these, so one round names every footer problem.
export const FOOTER_IDS: ReadonlySet<string> = new Set(['prevention-line', 'leap-line', 'efficiency-line', 'closure-line', 'efficiency-fix', 'parked-fix', 'claim-ahead'])
export const EFF_NONE = /^[\s>*_-]*(?:\*\*|__)?Efficiency:(?:\*\*|__)?\s*none\b/im
export const JUDGE_KEY = 'judgeLog' // rows {time, session, ms, status: ok|fail|unavailable, problems}, last 500
export const JUDGE_MODEL = 'haiku'
export const JUDGE_TIMEOUT_MS = 8000
export { JUDGE_RULES }
export const judgeRules = (): string => RULES.checks['deep-judge'].messages.rules
// 0.6.17: failed checks per draft before PASS with a note (pack value `deep-cap`, 0-3).
export const denyCap = (): number => num('deep-cap', 'cap')
// 0.6.17: a short reply with no Correction/Prevention/done-claim word skips the judge (pack `deep-judge`: minWords, claim).
export const skipJudge = (text: string, ask = ''): boolean => !yesNoQuestion(jText(ask)) && text.trim().split(/\s+/).length < num('deep-judge', 'minWords') && !rx('deep-judge', 'claim').test(text)
// 0.6.17: the deterministic checks own the presence of Leap/Efficiency/Next/checked/sleep lines; a judge problem saying one is missing is dropped.
// 0.6.25 (judge FP audit): a hook-evidence result carries the input that produced it, so the judge never pairs one command's output with another's claim.
export const inputDigest = (e: Record<string, unknown>): string => {
  const { tool: _t, agentId: _a, tool_use_id: _u, description: _d, run_in_background: _b, timeout: _o, ...inp } = e
  const v = typeof inp.command === 'string' ? inp.command : Object.keys(inp).length === 0 ? '' : JSON.stringify(inp)
  const d = String(v).replace(/\s+/g, ' ').trim().slice(0, 160)
  return d === '' ? '' : ` $ ${d.replace(/\]/g, ')')}`
}
// 0.6.25: problems about length or style break the judge's own instructions (deterministic checks own length): dropped like MISSING_LINE.
export const STYLE_PROBLEM = /\b(?:words? per (?:point|line|bullet)|\d+\s+words\b|word (?:count|limit)|too (?:long|wordy)|punchline|fragments?\b|(?:explains?|drop|cut) the mechanism|mechanism unless)/i
// 0.6.25: once a reply to this prompt was delivered (a Stop-hook continuation keeps the prompt), the ask carries that fact, so (d) is not re-raised for it.
export const ANSWERED_NOTE = '[A reply to this message was already delivered this turn (see "Already sent to J this turn"); judge (d) only on what the user still lacks.]'
export const askNote = (ask: string, delivered: boolean): string => delivered ? `${ask}\n${ANSWERED_NOTE}` : ask
// 0.6.30 (J 13 Nov 12:38, cross-turn bleed): rule (d) is judged only on J's messages since the last final reply (pend). A final reply moves
// them to done (last 3), shown to the judge as context labelled already answered; the hook's ask overrides the model's `ask` argument, which
// carried a stale question into Stop re-checks. A Stop re-check of a reply judges the asks that were pending when that reply reached J.
export type AskState = { pend: string[]; done: string[] }
export const ASK_PEND_MAX = 5
export const ASK_DONE_MAX = 3
export const askPush = (s: AskState, t: string): void => {
  const x = t.trim()
  if (x === '' || s.pend[s.pend.length - 1] === x) return
  s.pend.push(x)
  if (s.pend.length > ASK_PEND_MAX) s.pend.shift()
}
export const askAnswered = (s: AskState): string[] => {
  const was = s.pend
  s.done = [...s.done.filter(t => !was.includes(t)), ...was].slice(-ASK_DONE_MAX)
  s.pend = []
  return was
}
export const NO_NEW_ASK = '(no new message from J since the last final reply; nothing here is unanswered under rule (d))'
export const EARLIER_ASKS = 'Earlier J messages, already answered by an earlier final reply (context only; never judge (d) on them)'
export const buildAsk = (cur: string[], done: string[], fallback = ''): { cur: string; ask: string } => {
  const c = cur.map(t => t.trim()).filter(t => t !== '')
  const d = done.map(t => t.trim()).filter(t => t !== '' && !c.includes(t))
  const head = c.length > 0 ? c.join('\n') : d.length > 0 ? '' : fallback.trim()
  const shown = head !== '' ? head : d.length > 0 ? NO_NEW_ASK : ''
  return { cur: head, ask: d.length === 0 ? shown : `${shown}\n[${EARLIER_ASKS}: ${d.map(t => `"${t.replace(/\s+/g, ' ').slice(0, 300)}"`).join(' | ')}]` }
}
export const MISSING_LINE = /\b(?:missing|absent|no|lacks?|without)\s+(?:a\s+|an\s+|the\s+)?\*{0,2}(?:leap|efficiency|next|checked|sleep)\b[^.\n]{0,15}\b(?:line|footer)s?\b|\b(?:leap|efficiency|next|checked|sleep)\*{0,2}\s+(?:line|footer)s?\b[^.\n]{0,50}\b(?:missing|absent|omitted)\b/i
export type JudgeResult = { status: 'ok' | 'fail' | 'unavailable'; problems: string[]; ms: number }
// 0.6.17: token usage of one judge call (names tolerated in camelCase or snake_case); cache = cache read + cache creation.
export const JUDGE_TOKENS_KEY = 'judgeTokens' // {date (SGT), calls, input, output, cache}: today's running total
export const tokensOf = (u: unknown): { input: number; output: number; cache: number } => {
  const o = (typeof u === 'object' && u !== null ? u : {}) as Record<string, unknown>
  const n = (...ks: string[]): number => ks.reduce((a, k) => a + (Number(o[k]) || 0), 0)
  return { input: n('inputTokens', 'input_tokens'), output: n('outputTokens', 'output_tokens'), cache: n('cacheReadTokens', 'cache_read_input_tokens', 'cacheCreationTokens', 'cache_creation_input_tokens') }
}
// Robust parse of the judge's reply: first {...} block (code fences tolerated); anything else -> undefined (fail open).
export const parseJudge = (text: unknown): { ok: boolean; problems: string[] } | undefined => {
  const m = /\{[\s\S]*\}/.exec(String(text ?? ''))
  if (m === null) return undefined
  try {
    const j = JSON.parse(m[0]) as { ok?: unknown; problems?: unknown }
    if (typeof j.ok !== 'boolean') return undefined
    const problems = (Array.isArray(j.problems) ? j.problems : []).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim().slice(0, 300)).slice(0, 3)
    if (j.ok === false && problems.length === 0) return undefined
    return { ok: j.ok, problems: j.ok ? [] : problems }
  } catch { return undefined }
}
const esc = (t: string): string => t.replace(/<\/(draft|ask|evidence|hook_evidence|session_evidence)>/gi, '<\\/$1>')
// 0.6.18 per-session rolling evidence (container-local; never written to the Scoreboard). Entries start with the RS char, newest last.
export const SESSION_EV_KEY = 'sessionEvidence'
export const AGENT_REPORTS_KEY = 'agentReports'
const AGENT_REPORT = /<(?:agent-message|task-notification)\b|\[Subagent hand-?back\]/i
// 0.6.25 evidence-first: calls that look at state. check_reply, SendUserMessage, ToolSearch, launches, messages and writes are not evidence.
export const evidenceCall = (e: Record<string, unknown>): boolean => {
  const tool = String(e.tool ?? ''), act = String(e.action ?? '')
  if (tool === 'Bash' || MEMORY_READ.test(tool) || /(^|__)memory_(list|search)$/.test(tool)) return true
  if (ARTIFACT_DATA.test(tool)) return ['get', 'list', 'query', 'profiles'].includes(act)
  if (/(^|__)Artifact$/.test(tool)) return ['read', 'list'].includes(act)
  return looksUp(tool) && !/^(Agent|Task|Skill)$/.test(tool)
}
// 0.6.25 closure-line: a call that changes something J would count as the fix landing. Plan and log writes (handoffs, open items, board rows, Scoreboard log rows) are not.
const LOG_COLLECTION = /^(?:corrections|fixes|context|metrics|status|spend|sleep|config)\b/
const BASH_CHANGE = /\bgit (?:commit|push)\b|\bsed -i\b|\btee\b|\b(?:cp|mv|install)\s|>>?\s*[\w\/.~-]+\.(?:ts|js|mjs|py|md|json|sh|html|txt)\b/
export const realChange = (e: Record<string, unknown>): boolean => {
  const tool = String(e.tool ?? ''), act = String(e.action ?? '')
  if (/^(Edit|Write|NotebookEdit)$/.test(tool) || /(^|__)propose_skills$/.test(tool)) return true
  if (MEMORY_WRITE.test(tool) || /(^|__)memory_delete$/.test(tool)) { const pth = String(e.path ?? ''); return !handoffPath(pth) && !/open-items/.test(pth) }
  if (/(^|__)Artifact$/.test(tool)) return act === '' || act === 'publish'
  if (ARTIFACT_DATA.test(tool)) {
    if (!['set', 'update', 'str_replace', 'batch', 'delete'].includes(act) || String(e.url ?? '').includes(BOARD_URL)) return false
    const cols = act === 'batch' ? (Array.isArray(e.writes) ? e.writes.map(w => String((w as Record<string, unknown> | null)?.collection ?? '')) : []) : [String(e.collection ?? '')]
    return cols.some(c => !LOG_COLLECTION.test(c))
  }
  return tool === 'Bash' && BASH_CHANGE.test(String(e.command ?? ''))
}
const RS = '\u241E'
const evChain = new Map<string, Promise<unknown>>() // serialises read-modify-write per session
export let evTurn = '' // turn id of the running main turn: its tool entries are already in hook_evidence
export const SESSION_INDEX_KEY = 'sessionIndex'
export const KEEP_SESSIONS = 20
// 0.6.18: evidence is kept in deep mode only.
async function rec($: EngineInterface, mode: ReplyMode | undefined, kind: 'tool' | 'agent' | 'reply', label: string, text: string): Promise<void> {
  if ((await readMode($, mode)) === 'deep') await recordEvidence($, kind, label, text)
}
export async function recordEvidence($: EngineInterface, kind: 'tool' | 'agent' | 'reply', label: string, text: string): Promise<void> {
  const cap = num('deep-evidence', 'sessionChars')
  if (cap <= 0 || text.trim() === '') return
  const sid = String(await Promise.resolve().then(() => $.session.id()).catch(() => '?'))
  const run = async (): Promise<void> => {
    const t = sgtIso(await nowMs($))
    const body = text.slice(0, kind === 'tool' ? 800 : kind === 'agent' ? 1500 : 600)
    const key = `${SESSION_EV_KEY}:${sid}`
    const old = String(await $.store.get(key) ?? '')
    if (old === '') { // first entry of this session: index it, clear the evidence of all but the last KEEP_SESSIONS sessions
      const ix = await $.store.get(SESSION_INDEX_KEY)
      const all = [...(Array.isArray(ix) ? (ix as unknown[]).map(String) : []).filter(x => x !== sid), sid]
      for (const gone of all.slice(0, -KEEP_SESSIONS)) { await $.store.set(`${SESSION_EV_KEY}:${gone}`, ''); await $.store.set(`${AGENT_REPORTS_KEY}:${gone}`, []) }
      await $.store.set(SESSION_INDEX_KEY, all.slice(-KEEP_SESSIONS))
    }
    await $.store.set(key, `${old}${RS}[#${evTurn.replace(/[^\w-]/g, '')} ${t.slice(5, 16)} ${kind}${label === '' ? '' : ' ' + label}] ${body}\n`.slice(-cap))
    if (kind === 'agent') {
      const ik = `${AGENT_REPORTS_KEY}:${sid}`
      const idx = await $.store.get(ik)
      await $.store.set(ik, [...(Array.isArray(idx) ? idx : []), { time: t, chars: body.length, head: body.slice(0, 80) }].slice(-50))
    }
  }
  const prev = evChain.get(sid) ?? Promise.resolve()
  const next = prev.then(run, run).catch(() => undefined)
  evChain.set(sid, next)
  await next
}
// 0.6.18: one bounded "Session facts" line for the writer (deep mode, J turns, main thread), built from the store.
const VERSION_SEEN = /\b([a-z][a-z0-9-]{2,30})(?:@|\s+v?|\s+version\s+|"\s*:\s*")(\d+\.\d+\.\d+)\b/gi
export const factsLine = (raw: string, idx: unknown, running: number, max: number): string => {
  if (max <= 0) return ''
  const head = (t: string): string => t.replace(/\s+/g, ' ').trim().slice(0, 80)
  const reports = (Array.isArray(idx) ? idx : []).slice(-3).reverse().map((r: { time?: string; head?: string }) => `${String(r.time ?? '').slice(11, 16)} \u00b7 ${head(String(r.head ?? ''))}`)
  const reply = raw.split(RS).reverse().find(x => /^\[#\S* \S+ reply\]/.test(x))
  const vers = new Map<string, string>()
  for (const m of [...raw.matchAll(VERSION_SEEN)].reverse()) if (!vers.has(m[1].toLowerCase()) && vers.size < 4 && !/^(?:node|python|version|v)$/i.test(m[1])) vers.set(m[1].toLowerCase(), m[2])
  const parts = [`agents running: ${running}`, `last agent reports: ${reports.length === 0 ? 'none' : reports.join(' | ')}`, `last reply: ${reply === undefined ? 'none' : head(reply.replace(/^\[[^\]]*\]\s*/, ''))}`]
  if (vers.size > 0) parts.push(`versions seen in tool results: ${[...vers].map(([k, v]) => `${k} ${v}`).join(', ')}`)
  return `Session facts: ${parts.join('; ')}`.slice(0, max)
}
// Most recent first, at most `max` chars (whole-entry order reversed, the oldest entry cut).
export const sessionBlock = (raw: string, max: number, turn = evTurn): string => {
  if (max <= 0) return ''
  const cur = turn.replace(/[^\w-]/g, '')
  // the assistant's own prior replies never back a claim; the running turn's tool results are already in hook_evidence
  const keep = (x: string): boolean => !/^\[#\S* \S+ reply\]/.test(x) && !(/^\[#\S* \S+ tool\b/.test(x) && x.startsWith(`[#${cur} `))
  return raw.split(RS).filter(x => x.trim() !== '' && keep(x)).reverse().join('\n').slice(0, max)
}
// 0.6.25 pre-filter for judge rule (e): lines with deferral words when no real change or launch ran this turn (mirrored in tools/judge-evals/judge_run.py).
export const PREFILTER = /\b(?:next (?:build|zip|version|release|session)|later|follow-?up|queued|would|could|should|none yet|will)\b|['\u2019]ll\b/i
export const prefilterLines = (text: string, changedOrLaunched: boolean): string[] =>
  changedOrLaunched ? [] : proseLines(text).map(l => l.trim()).filter(l => l !== '' && !l.startsWith('>') && PREFILTER.test(l)).map(l => l.slice(0, 120)).slice(0, 5)
const prefilterNote = (text: string, changedOrLaunched: boolean): string => {
  const ls = prefilterLines(text, changedOrLaunched)
  return ls.length === 0 ? '' : `\nPre-filter (deferral words, no change or launch this turn; check each under (e)): ${ls.map(l => `"${l}"`).join('; ')}`
}
export async function judgeReply($: EngineInterface, text: string, ask: string, evidence: string, hookEvidence: string, f: DeepFacts): Promise<JudgeResult> {
  const t0 = Date.now()
  const done = async (status: JudgeResult['status'], problems: string[], usage?: unknown): Promise<JudgeResult> => {
    const tk = tokensOf(usage)
    const ms = Date.now() - t0
    await Promise.resolve().then(async () => {
      const log = await $.store.get(JUDGE_KEY)
      await $.store.set(JUDGE_KEY, [...(Array.isArray(log) ? log : []), { time: sgtIso(await nowMs($)), session: await $.session.id(), ms, status, problems: problems.length, ...tk }].slice(-500))
      const date = sgtIso(await nowMs($)).slice(0, 10), tot = await $.store.get(JUDGE_TOKENS_KEY) as { date?: string; calls?: number; input?: number; output?: number; cache?: number } | undefined
      const base = tot?.date === date ? tot : { calls: 0, input: 0, output: 0, cache: 0 }
      await $.store.set(JUDGE_TOKENS_KEY, { date, calls: (base.calls ?? 0) + 1, input: (base.input ?? 0) + tk.input, output: (base.output ?? 0) + tk.output, cache: (base.cache ?? 0) + tk.cache })
    }).catch(() => undefined)
    await statsJudge($, status, tk, ms).catch(() => undefined)
    if (status === 'unavailable') await Promise.resolve().then(async () => {
      const log = await $.store.get(DENY_LOG_KEY)
      await $.store.set(DENY_LOG_KEY, [...(Array.isArray(log) ? log : []), { time: sgtIso(await nowMs($)), session: await $.session.id(), n: 0, judge: 'unavailable', checks: [] }].slice(-500))
    }).catch(() => undefined)
    return { status, problems, ms }
  }
  const sid = String(await Promise.resolve().then(() => $.session.id()).catch(() => '?'))
  const rawSess = String(await Promise.resolve().then(() => $.store.get(`${SESSION_EV_KEY}:${sid}`)).catch(() => '') ?? '')
  const fixed = Math.min((ask || '(not provided)').length, 1500) + Math.min((evidence || '(none provided)').length, 2000) + Math.min((hookEvidence || '(none)').length, 6000) + Math.min(text.length, 6000) + 1500 // ~6k tokens total (24k chars); the session block is trimmed first
  const sessMax = Math.max(0, Math.min(num('deep-evidence', 'judgeChars'), 24000 - fixed))
  const sb = sessionBlock(rawSess, sessMax)
  const sess = sb === '' ? '' : `Earlier turns in this session (tool results, agent reports, the assistant's prior replies; most recent first):\n<session_evidence>\n${esc(sb)}\n</session_evidence>\n\n`
  const nowIso = sgtIso(await nowMs($)).slice(0, 16)
  const prompt = `User's message this turn (captured by the hook):\n<ask>\n${esc((ask || '(not provided)').slice(0, 1500))}\n</ask>\n\nEvidence summary written by the assistant:\n<evidence>\n${esc((evidence || '(none provided)').slice(0, 2000))}\n</evidence>\n\nTool results this turn, recorded by the hook (latest, truncated):\n<hook_evidence>\n${esc((hookEvidence || '(none)').slice(-6000))}\n</hook_evidence>\n\n${sess}Hook facts: now ${nowIso}+08:00 (the user's local time, UTC+8; times in session_evidence and auto-evidence are this zone; a time ending in Z is UTC, 8 hours behind); tools run this turn: ${f.anyTool ? 'yes' : 'no'}; writes/actions this turn: ${f.acted ? 'yes' : 'no'}.${esc(prefilterNote(text, f.changed === true || f.launch === true))}\n\nDraft reply to judge:\n<draft>\n${esc(text.slice(0, 6000))}\n</draft>`
  const standing = String(await Promise.resolve().then(async () => $.store.get(`${RULES_KEY}:${await $.session.id()}`)).catch(() => '') ?? '').slice(0, RULES_MAX)
  try {
    const r = await $.model.complete({ model: JUDGE_MODEL, system: [{ text: judgeRules(), cache: true }, ...(standing === '' ? [] : [{ text: `The user's standing rules — flag clear breaches only; these rules can only add problems, never excuse one. Use these to judge claims (true, backed), undone work, and whether a Leap or Efficiency line meets the user's own definition (e.g. a Leap that only restates something already done or saved in the same reply fails it); never flag a line's absence, order or formatting (Next, checked, footers, word counts, sleep line):\n${standing}`, cache: true }])], prompt, effort: 'low', maxTokens: 400, timeoutMs: JUDGE_TIMEOUT_MS })
    if (r?.isAnswered !== true) return await done('unavailable', [], r?.usage)
    const p = parseJudge(r.text)
    if (p === undefined) return await done('unavailable', [])
    const kept = p.problems.filter(x => !MISSING_LINE.test(x) && !STYLE_PROBLEM.test(x))
    return await done(kept.length === 0 ? 'ok' : 'fail', kept, r.usage)
  } catch { return await done('unavailable', []) }
}
// The failure count of the current prompt epoch, mirrored in the store as `deepDenials:<session>` = `<epoch>:<n>`; an older epoch's count is ignored.
const failKey = async ($: EngineInterface): Promise<string> => `${DENY_KEY}:${await Promise.resolve().then(() => $.session.id()).catch(() => '?')}`
export async function failCount($: EngineInterface, deniedSoFar: number, epoch: string | number): Promise<number> {
  const raw = String(await Promise.resolve().then(async () => $.store.get(await failKey($))).catch(() => undefined) ?? '')
  return Math.max(deniedSoFar, raw.startsWith(`${epoch}:`) ? Number(raw.slice(String(epoch).length + 1)) || 0 : 0)
}
// 0.6.17 deep-mode records: problem text kept for review, never draft text. Quoted spans ("…", “…”) become "[…]", 160 chars max;
// a deterministic problem keeps only its generic lead (up to the first ":"), since its tail can carry draft words. Judge problems keep their text.
export const cleanProblem = (t: string, id = 'judge'): string => {
  let x = t.replace(/^judge:\s*/i, '').replace(/"[^"]*"|“[^”]*”|(?<![\w])'[^'\n]*'(?![\w])|‘[^’]*’/g, '"[…]"')
  if (id !== 'judge') x = x.split(':')[0]
  return x.trim().slice(0, 160)
}
export type DeepRow = { source: 'deep'; category: string; category_orig: 'pre-send'; check_ids: string[]; problems: string[]; outcome: 'fixed' | 'sent at cap'; session: string; time: string; date: string; chat: ''; words: ''; wrong: string; covered: false; rule: ''; count: 1; auto: true }
// 0.6.17 privacy: Scoreboard rows carry generic labels only, never problem text (it can repeat draft or client words).
export const PROBLEM_LABELS = ['unsupported claim', 'contradicted claim', 'undone work', 'unanswered question', 'footer/format', 'other'] as const
export const problemLabel = (p: Problem): string => {
  if (p.id === 'judge') {
    const m = /^(?:judge:\s*)?\(?([a-g])(?:\|[a-g])?\)/i.exec(p.text.trim())
    if (m !== null) return ({ a: 'contradicted claim', b: 'unsupported claim', c: 'undone work', d: 'unanswered question', e: 'undone work', f: 'footer/format', g: 'footer/format' } as Record<string, string>)[m[1].toLowerCase()]
    const t = p.text.toLowerCase()
    return /contradict/.test(t) ? 'contradicted claim' : /not shown|unsupported|no evidence|unbacked|not backed|unverified/.test(t) ? 'unsupported claim' : /undone|not started|could do|offer|left/.test(t) ? 'undone work' : /not answer|unanswered|question/.test(t) ? 'unanswered question' : /footer|leap|efficiency|format/.test(t) ? 'footer/format' : 'other'
  }
  return /^(?:unbacked-absolute|stop-figures|stop-sources|stop-writes|stop-dates|source-gate|evidence-first)$/.test(p.id) ? 'unsupported claim' : /^(?:open-question|offer-guard|parked-fix|efficiency-fix|miss-landing|unsaved-promise|promise-proof|closure-line|claim-ahead)$/.test(p.id) ? 'undone work' : /^(?:prevention-line|leap-line|efficiency-none|answer-first|checked-line|dangling-ref)$/.test(p.id) ? 'footer/format' : 'other'
}
// 0.6.25 write-time category from the problem labels (precedence as in the 13 Nov Scoreboard triage).
export const deepCategory = (labels: readonly string[]): string =>
  labels.some(l => l === 'unsupported claim' || l === 'contradicted claim') ? 'unverified claim' : labels.includes('unanswered question') ? 'wrong scope' : labels.includes('undone work') ? 'ignored a rule' : 'format/style miss'
export const deepRow = (probs: Problem[], outcome: DeepRow['outcome'], session: string, now: number): DeepRow => {
  const checks = [...new Set(probs.map(x => x.id))]
  const labels = [...new Set(probs.map(problemLabel))]
  return { source: 'deep', category: deepCategory(labels), category_orig: 'pre-send', check_ids: checks, problems: labels, outcome, session, time: sgtIso(now).slice(11, 16), date: sgtIso(now).slice(0, 10), chat: '', words: '', wrong: `pre-send: ${checks.join(', ')}`, covered: false, rule: '', count: 1, auto: true }
}
const OPEN_KEY = 'deepOpen' // `deepOpen:<session>` = {epoch, rows:[{id,data}]}: this prompt's failed drafts awaiting an outcome
async function upsertRows($: EngineInterface, rows: { id: string; data: unknown }[]): Promise<void> {
  const ids = new Set(rows.map(r => r.id))
  await $.store.set(CORR_KEY, [...(await corrQueue($)).filter(q => !ids.has(q.id)), ...rows as never[]].slice(-CORR_KEEP))
}
// 0.6.19 deep-stats: one Scoreboard row per session per day, upserted (same doc id, op "set") at each deep J-prompt turn end through the corrLog queue.
// Counts only, no draft, problem or evidence text. Epoch state (rounds, failed) lives in `deepStats:<session>`, written by recordOutcome (the same
// epoch that keys deepOpen/deepDenials); judge calls and tokens are summed from `judgeLog` (this session, this SGT day).
// prompts_judged = deep J prompts whose reply was checked (>= 1 check_reply / fallback round) or was a short reply that skips the judge;
// first_draft_pass = of those, prompts with no failed round (a short reply going out directly counts as a pass).
// judge_ok = judge calls that answered (ok or fail); judge_unavailable = calls with no usable answer.
export const STATS_KEY = 'deepStats'
// 0.6.22: tools whose calls change nothing (left out of the auto-evidence digest).
export const READ_ONLY_TOOL = /^(?:Read|Glob|Grep|ToolSearch|TaskGet|TaskList|WebSearch|WebFetch)$|(?:^|__)memory_(?:read|list)$/
export const PLUGIN_VERSION = '0.6.39'
// 0.6.29 version row: this version's CHANGELOG line (tools/build-zip.sh fails unless CHANGELOG.md has "- <PLUGIN_VERSION>: <CHANGELOG_LINE>").
export const CHANGELOG_LINE = 'Deep mode: a final reply that differs from the text check_reply passed is blocked at Stop with a short order to re-check the exact sent text and send passed text verbatim; each such send is counted (reworded_sends).'
export const FIX_CATEGORY = 'unchecked reply'
export const VERSION_ROW_KEY = 'fixesRowVersion' // the last PLUGIN_VERSION whose fixes row was queued
export const versionRow = (date: string, time: string): { id: string; collection: string; data: Record<string, unknown> } => ({ id: `f-auto-dg${PLUGIN_VERSION.replace(/\./g, '')}`, collection: 'fixes', data: { category: FIX_CATEGORY, date, kind: 'hook', status: 'landed', title: `dispatch-guard ${PLUGIN_VERSION} (auto)`, detail: `dispatch-guard ${PLUGIN_VERSION} first deep turn ${date} ${time} SGT: ${CHANGELOG_LINE}`, plugin_version: PLUGIN_VERSION, auto: true } })
// Queued once per version (store key), flushed with the corrections rows; a store failure skips it (logging never affects a turn).
export async function queueVersionRow($: EngineInterface): Promise<boolean> {
  try {
    if (await $.store.get(VERSION_ROW_KEY) === PLUGIN_VERSION) return false
    await $.store.set(VERSION_ROW_KEY, PLUGIN_VERSION)
    const now = sgtIso(await nowMs($))
    await enqueue($, [versionRow(now.slice(0, 10), now.slice(11, 16))])
    return true
  } catch { return false }
}
type Stats = { date: string; prompts: number; firstPass: number; rounds: number; unchecked: number; uu: number; att?: string; so?: string; jc: number; jok: number; jun: number; tin: number; tout: number; tcache: number; epoch?: string; eRounds: number; eFail: boolean; closed?: string; fc: Record<string, number>; dh: Record<string, number>; ds: Record<string, string[]>; tms: number; tn: number; tmax: number; jms: number; crms: number; fs: number[]; fl: number; frms: number; frn: number; frmax: number; fims: number; cms: number; eT0?: number; eT1?: number; ft?: number[]; ff?: number[]; fck?: number[]; ftr?: string[]; flt?: number; flw?: number; lb?: Record<string, LatB>; pf?: number; sbj?: number; rw?: number }
export type StatsRow = { source: 'deep-stats'; date: string; session: string; plugin_version: string; prompts_judged: number; first_draft_pass: number; unchecked: number; unchecked_unattended: number; attended: string; session_origin: string; rounds_total: number; judge_calls: number; judge_ok: number; judge_unavailable: number; tokens_in: number; tokens_out: number; tokens_cache: number; fail_checks: Record<string, number>; dark_hits: Record<string, number>; dark_samples: Record<string, string[]>; turn_ms_total: number; turn_count: number; turn_ms_max: number; judge_ms_total: number; checker_rounds_ms_total: number; final_ms_total: number; final_count: number; final_ms_max: number; first_ms_total: number; check_ms_total: number; post_first_ms_total: number; stopped_by_j: number; reworded_sends: number; lat_ack: LatB; lat_question: LatB; lat_task1: LatB; lat_taskN: LatB }
// 0.6.24 speed meter: wall ms turn.start -> turn.complete of deep J-prompt turns (total, count, max), judge call ms, and checker rounds ms (first to last check_reply round end, per prompt; a one-round prompt adds 0). Counts only.
// 0.6.23: dark-check would-be hits per id (dark_hits) and the last 3 snippets each (dark_samples, whole field <= 3000 chars), so a reviewer can tell real misses from false alarms. Snippets are reply text or the check's own message only.
export const DARK_SAMPLES_CAP = 3000
const trimSamples = (ds: Record<string, string[]>): Record<string, string[]> => {
  const o: Record<string, string[]> = Object.fromEntries(Object.entries(ds).map(([k, v]) => [k, v.slice(-3)]))
  while (JSON.stringify(o).length > DARK_SAMPLES_CAP) {
    const big = Object.keys(o).sort((a, b) => o[b].length - o[a].length || b.length - a.length)[0]
    if (big === undefined) break
    if (o[big].length > 1) o[big] = o[big].slice(1)
    else delete o[big]
  }
  return o
}
const readStats = async ($: EngineInterface, sid: string, date: string): Promise<Stats> => {
  const v = await Promise.resolve().then(() => $.store.get(`${STATS_KEY}:${sid}`)).catch(() => undefined) as Partial<Stats> | undefined
  const fresh = v?.date === date
  const n = (x: unknown): number => (fresh ? Number(x) || 0 : 0)
  return { date, prompts: n(v?.prompts), firstPass: n(v?.firstPass), rounds: n(v?.rounds), unchecked: n(v?.unchecked), uu: n(v?.uu), att: typeof v?.att === 'string' ? v.att : undefined, so: typeof v?.so === 'string' ? v.so : undefined, jc: n(v?.jc), jok: n(v?.jok), jun: n(v?.jun), tin: n(v?.tin), tout: n(v?.tout), tcache: n(v?.tcache), epoch: v?.epoch, eRounds: Number(v?.eRounds) || 0, eFail: v?.eFail === true, closed: v?.closed, tms: n(v?.tms), tn: n(v?.tn), tmax: n(v?.tmax), jms: n(v?.jms), crms: n(v?.crms), fs: fresh && Array.isArray(v?.fs) ? v.fs.map(Number).filter(Number.isFinite).slice(-200) : [], fl: n(v?.fl), frms: n(v?.frms), frn: n(v?.frn), frmax: n(v?.frmax), fims: n(v?.fims), cms: n(v?.cms), sbj: n(v?.sbj), rw: n(v?.rw), ...latRead(v, fresh), eT0: Number(v?.eT0) || undefined, eT1: Number(v?.eT1) || undefined, fc: fresh && v?.fc && typeof v.fc === 'object' ? Object.fromEntries(Object.entries(v.fc).map(([k, c]) => [k, Number(c) || 0]).filter(([, c]) => (c as number) > 0)) : {}, dh: fresh && v?.dh && typeof v.dh === 'object' ? Object.fromEntries(Object.entries(v.dh).map(([k, c]) => [k, Number(c) || 0]).filter(([, c]) => (c as number) > 0)) : {}, ds: fresh && v?.ds && typeof v.ds === 'object' ? Object.fromEntries(Object.entries(v.ds).map(([k, a]) => [k, Array.isArray(a) ? a.map(x => String(x).slice(0, 160)) : []])) : {} }
}
// One or more dark would-be hits ({id, snip}); live checks never reach here. Refreshes today's row when it already exists.
export async function statsDark($: EngineInterface, hits: { id: string; snip?: string }[]): Promise<void> {
  if (hits.length === 0) return
  try {
    const sid = String(await $.session.id()), date = sgtIso(await nowMs($)).slice(0, 10), st = await readStats($, sid, date)
    for (const h of hits) {
      st.dh[h.id] = (st.dh[h.id] ?? 0) + 1
      const snip = String(h.snip ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
      st.ds[h.id] = [...(st.ds[h.id] ?? []), ...(snip === '' ? [] : [snip])].slice(-3)
    }
    st.ds = trimSamples(st.ds)
    await $.store.set(`${STATS_KEY}:${sid}`, st)
    if (st.prompts + st.unchecked + (st.uu ?? 0) > 0) { await upsertRows($, [{ id: `deepstats-${sid}-${date}`, data: statsRow(sid, date, st) }]); await corrFlush($).catch(() => 0) }
  } catch { /* logging never affects a turn */ }
}
// W14: per-letter judge failures as fail_checks keys judge:a ... judge:g (beside the 'judge' total), from each judge problem's leading "(c)" or "(a|b)". Once per round per letter.
export const judgeLetters = (probs: { id: string; text: string }[]): string[] => probs.filter(p => p.id === 'judge').flatMap(p => { const m = /^judge:\s*\(?\s*([a-g](?:\s*[|/,]\s*[a-g])*)\s*\)/i.exec(p.text); return m === null ? [] : m[1].toLowerCase().split(/[^a-g]+/).filter(Boolean).map(l => `judge:${l}`) })
async function statsRound($: EngineInterface, epoch: string | number, failed: boolean, ids: string[] = []): Promise<void> {
  const sid = String(await $.session.id()), date = sgtIso(await nowMs($)).slice(0, 10), st = await readStats($, sid, date), e = String(epoch)
  const same = st.epoch === e, at = await nowMs($)
  await $.store.set(`${STATS_KEY}:${sid}`, { ...st, eT0: same && st.eT0 !== undefined ? st.eT0 : at, eT1: at, rounds: st.rounds + 1, epoch: e, eRounds: (same ? st.eRounds : 0) + 1, eFail: (same && st.eFail) || failed, fc: failed ? ids.reduce((a, id) => ({ ...a, [id]: (a[id] ?? 0) + 1 }), { ...st.fc }) : st.fc })
}
export const statsRow = (sid: string, date: string, st: Stats): StatsRow => ({ source: 'deep-stats', date, session: sid, plugin_version: PLUGIN_VERSION, prompts_judged: st.prompts, first_draft_pass: st.firstPass, unchecked: st.unchecked, unchecked_unattended: st.uu ?? 0, attended: st.att ?? '', session_origin: st.so ?? '', rounds_total: st.rounds,
  judge_calls: st.jc, judge_ok: st.jok, judge_unavailable: st.jun, tokens_in: st.tin, tokens_out: st.tout, tokens_cache: st.tcache, fail_checks: { ...st.fc }, dark_hits: { ...st.dh }, dark_samples: trimSamples(st.ds), turn_ms_total: st.tms, turn_count: st.tn, turn_ms_max: st.tmax, judge_ms_total: st.jms, checker_rounds_ms_total: st.crms, ...finalRow(st), stopped_by_j: st.sbj ?? 0, reworded_sends: st.rw ?? 0, first_ms_total: st.fims, check_ms_total: st.cms })
// 0.6.33 reply latency. final_* (the main metric): per J message (prompt.submit, or the delivery of a mid-turn one), ms until the LAST J-visible message
// (SendUserMessage that went out, or final text; a Stop re-check correction included) before the next J prompt or the end of the turn chain. The open group
// (fs = its message arrival times, fl = its last visible message) is added provisionally by finalOf and committed (frms/frn/frmax) when the next J prompt starts.
// first_ms_total = ms to the FIRST visible reply per message; check_ms_total = ms inside check_reply / send-path judge before that first reply. Counts only.
// W14 latency tiers: each J message gets a tier from its own text at arrival, before any work (so a slow reply cannot move itself to a harder tier):
// 'ack' (thanks/ok/noted-type, or <= 6 words with no ask), 'question' (asks for an answer/explanation/status, no build verb), 'task' (a build verb, or files attached),
// split by askCount into task1 (one ask) and taskN (2+). askCount = '?' runs on plain lines + numbered/bulleted lines + quoted excerpts ('>' blocks, "..." of 4+ words), min 1.
// lat_<tier> = { t: final ms, n: messages, f: first-reply ms, c: check ms, p: ms added after the first reply (final - first), tools_total: main-thread tool calls
// from arrival to the group's last J-visible message (SendUserMessage/check_reply/set_rules excluded; a subagent's own calls unseen, its launch counts 1),
// words_total: words of that last visible message }. post_first_ms_total = sum(final - first) over all messages. A message from state written before W14
// (no tier) is in the totals only. Counts only, no text.
export type LatB = { t: number; n: number; f: number; c: number; p: number; tools_total: number; words_total: number }
export const LAT_TIERS = ['ack', 'question', 'task1', 'taskN'] as const
export type Tier = typeof LAT_TIERS[number]
const ACK_ONLY = /^(?:(?:ok(?:ay)?|k|thanks?|thank you|thx|ty|cheers|noted|got it|great|good|nice|cool|perfect|sure|yes|yep|yeah|no|nope|done|fine|right|understood|sounds good|lgtm|go ahead|proceed|carry on|continue|approved?)\b[\s,.!]*)+$/i
const BUILD_VERB = /\b(?:build|fix|make|change|run|find|compare|create|write|draft|redraft|add|remove|delete|update|edit|implement|check|verify|review|test|search|look up|look into|research|rewrite|redo|summari[sz]e|translate|mark up|markup|send|book|order|buy|install|set up|setup|deploy|publish|refactor|rename|move|merge|split|convert|generate|calculate|compute|replace|adjust|tweak|improve|investigate|debug|audit|list|prepare|plan|schedule|consume|resume|continue per)\b/i
const QUESTION = /\?|^(?:what|why|how|when|where|who|whom|which|whose|is|are|was|were|do|does|did|can|could|should|would|will|has|have|any)\b|\b(?:explain|status|what's|whats)\b/i
const FILES = /<uploaded_files>|\/mnt\/user-data\/uploads\/|<file_path>|\[(?:image|pasted image|file|attachment)\b[^\]]*\]/i
const attachN = (e: unknown): number => { const a = (e as Record<string, unknown>)?.attachments; return Array.isArray(a) ? a.length : 0 }
const LIST_LINE = /^\s*(?:\d{1,2}[.)]|\(?[a-z]\)|[-*\u2022])\s+\S/i
export const askCount = (text: unknown): number => {
  let n = 0, inQuote = false
  for (const line of jText(String(text ?? '')).split(/\r?\n/)) {
    if (/^\s*>/.test(line)) { if (!inQuote) n += 1; inQuote = true; continue }
    inQuote = false
    if (LIST_LINE.test(line)) { n += 1; continue }
    n += (line.match(/\?+/g) ?? []).length + (line.match(/["\u201c][^"\u201c\u201d]*["\u201d]/g) ?? []).filter(q => wordCount(q.slice(1, -1)) >= 4).length
  }
  return Math.max(1, n)
}
export const classifyTier = (text: unknown, attachments = 0): Tier => {
  const raw = String(text ?? ''), t = jText(raw).replace(/\s+/g, ' ').trim()
  const task = (): Tier => (askCount(raw) >= 2 ? 'taskN' : 'task1')
  if (attachments > 0 || FILES.test(raw)) return task()
  if (t === '' || ACK_ONLY.test(t)) return 'ack'
  if (BUILD_VERB.test(t)) return task()
  if (QUESTION.test(t)) return 'question'
  return wordCount(t) <= 6 ? 'ack' : 'question'
}
const latZero = (): LatB => ({ t: 0, n: 0, f: 0, c: 0, p: 0, tools_total: 0, words_total: 0 })
export const wordCount = (t: unknown): number => String(t ?? '').trim().split(/\s+/).filter(Boolean).length
const numOrNaN = (x: unknown): number => (x === null || x === undefined || x === '' ? NaN : Number(x))
const latRead = (v: Partial<Stats> | undefined, fresh: boolean): Pick<Stats, 'ft' | 'ff' | 'fck' | 'ftr' | 'flt' | 'flw' | 'lb' | 'pf'> => {
  const len = fresh && Array.isArray(v?.fs) ? v.fs.map(Number).filter(Number.isFinite).slice(-200).length : 0
  const arr = (a: unknown): number[] => { const x = fresh && Array.isArray(a) ? a.map(numOrNaN).slice(-200) : []; return x.length === len ? x : Array.from({ length: len }, () => NaN) } // misaligned (pre-W14 state): totals only
  const lb: Record<string, LatB> = {}
  for (const k of LAT_TIERS) { const o = (fresh && v?.lb && typeof v.lb === 'object' ? (v.lb as Record<string, Partial<LatB>>)[k] : undefined) ?? {}; lb[k] = { t: Number(o.t) || 0, n: Number(o.n) || 0, f: Number(o.f) || 0, c: Number(o.c) || 0, p: Number(o.p) || 0, tools_total: Number(o.tools_total) || 0, words_total: Number(o.words_total) || 0 } }
  const tr = fresh && Array.isArray(v?.ftr) ? v.ftr.map(x => String(x ?? '')).slice(-200) : []
  return { ft: arr(v?.ft), ff: arr(v?.ff), fck: arr(v?.fck), ftr: tr.length === len ? tr : Array.from({ length: len }, () => ''), flt: fresh ? Number(v?.flt) || 0 : 0, flw: fresh ? Number(v?.flw) || 0 : 0, lb, pf: fresh ? Number(v?.pf) || 0 : 0 }
}
type FinalSt = Pick<Stats, 'fs' | 'fl' | 'frms' | 'frn' | 'frmax' | 'ft' | 'ff' | 'fck' | 'ftr' | 'flt' | 'flw' | 'lb' | 'pf'>
type FinalOut = { final_ms_total: number; final_count: number; final_ms_max: number; post_first_ms_total: number; lb: Record<string, LatB> }
const finalOf = (st: FinalSt): FinalOut => {
  let t = st.frms, n = st.frn, m = st.frmax, pf = st.pf ?? 0
  const lb: Record<string, LatB> = Object.fromEntries(LAT_TIERS.map(k => [k, { ...latZero(), ...(st.lb?.[k] ?? {}) }]))
  const fs = st.fs ?? [], fl = st.fl ?? 0
  fs.forEach((w, i) => {
    if (fl < w) return
    const ms = Math.round(fl - w); t += ms; n += 1; m = Math.max(m, ms)
    const ff = st.ff?.[i] ?? NaN, ft = st.ft?.[i] ?? NaN, ck = st.fck?.[i] ?? NaN
    const post = Number.isFinite(ff) && ff >= w && fl >= ff ? Math.round(fl - ff) : NaN
    if (Number.isFinite(post)) pf += post
    const b = lb[st.ftr?.[i] ?? '']
    if (b === undefined || !Number.isFinite(post)) return // pre-W14 entry (no tier): totals only
    b.t += ms; b.n += 1; b.f += Math.round(ff - w); b.c += Number.isFinite(ck) ? Math.round(ck) : 0; b.p += post; b.tools_total += Number.isFinite(ft) ? Math.max(0, (st.flt ?? 0) - ft) : 0; b.words_total += st.flw ?? 0
  })
  return { final_ms_total: t, final_count: n, final_ms_max: m, post_first_ms_total: pf, lb }
}
const finalRow = (st: FinalSt): Pick<StatsRow, 'final_ms_total' | 'final_count' | 'final_ms_max' | 'post_first_ms_total' | 'lat_ack' | 'lat_question' | 'lat_task1' | 'lat_taskN'> => {
  const f = finalOf(st)
  return { final_ms_total: f.final_ms_total, final_count: f.final_count, final_ms_max: f.final_ms_max, post_first_ms_total: f.post_first_ms_total, lat_ack: f.lb.ack, lat_question: f.lb.question, lat_task1: f.lb.task1, lat_taskN: f.lb.taskN }
}
const commitGroup = (st: Stats): void => { const f = finalOf(st); st.frms = f.final_ms_total; st.frn = f.final_count; st.frmax = f.final_ms_max; st.pf = f.post_first_ms_total; st.lb = f.lb; st.fs = []; st.ft = []; st.ff = []; st.fck = []; st.ftr = []; st.fl = 0; st.flt = 0; st.flw = 0 }
// W23 stopped_by_j: J message(s) whose turn ended by interruption, or that the next J prompt found unanswered, with no visible reply: the wait up to that
// moment is recorded as if it were the reply (final_ms and first_ms: a lower bound), and stopped_by_j counts one per such event. Counts only.
// A J-visible message went out. `waits` = arrival times of the J messages this is the first reply to (may be empty: a later message of the same chain).
// `sz` (W14): main-thread tool-call counter now and at each start's arrival, each start's tier (both parallel to starts), and this message's word count.
export async function statsReply($: EngineInterface, waits: number[], checkMs = 0, newGroup = false, starts: number[] = waits, sz: { tools?: number; at?: number[]; tier?: string[]; words?: number; stopped?: boolean } = {}): Promise<void> {
  try {
    const sid = String(await $.session.id()), date = sgtIso(await nowMs($)).slice(0, 10), st = await readStats($, sid, date), at = await nowMs($)
    if (newGroup) commitGroup(st) // the previous prompt's group is final (its next J prompt has started)
    for (const w of waits) st.fims += Number.isFinite(w) && w > 0 ? Math.max(0, Math.round(at - w)) : 0
    st.cms += Number.isFinite(checkMs) && checkMs > 0 ? Math.round(checkMs) : 0
    const keep = starts.map((w, i) => i).filter(i => Number.isFinite(starts[i]) && starts[i] > 0)
    const ck = Number.isFinite(checkMs) && checkMs > 0 ? Math.round(checkMs) : 0
    st.ft = [...(st.ft ?? []), ...keep.map(i => numOrNaN(sz.at?.[i]))].slice(-200)
    st.ff = [...(st.ff ?? []), ...keep.map(() => at)].slice(-200)
    st.fck = [...(st.fck ?? []), ...keep.map((_, j) => (j === 0 ? ck : 0))].slice(-200) // check ms since the oldest wait began: on the oldest message
    st.ftr = [...(st.ftr ?? []), ...keep.map(i => String(sz.tier?.[i] ?? ''))].slice(-200)
    st.fs = [...st.fs, ...keep.map(i => starts[i])].slice(-200)
    st.fl = at; st.flt = Number(sz.tools) || 0; st.flw = Number(sz.words) || 0
    if (sz.stopped === true) st.sbj = (st.sbj ?? 0) + 1 // W23: the wait ended with nothing J-visible (J stopped the turn or moved on)
    await $.store.set(`${STATS_KEY}:${sid}`, st)
    if (st.prompts + st.unchecked + (st.uu ?? 0) > 0) { await upsertRows($, [{ id: `deepstats-${sid}-${date}`, data: statsRow(sid, date, st) }]); await corrFlush($).catch(() => 0) } // a later message of a closed prompt (Stop re-check correction) refreshes the row
  } catch { /* logging never affects a turn */ }
}
// One judge call: running per-session/day totals (never re-summed from the shared judgeLog).
export async function statsJudge($: EngineInterface, status: string, tk: { input: number; output: number; cache: number }, ms = 0): Promise<void> {
  const sid = String(await $.session.id()), date = sgtIso(await nowMs($)).slice(0, 10), st = await readStats($, sid, date)
  await $.store.set(`${STATS_KEY}:${sid}`, { ...st, jc: st.jc + 1, jok: st.jok + (status === 'unavailable' ? 0 : 1), jun: st.jun + (status === 'unavailable' ? 1 : 0), tin: st.tin + tk.input, tout: st.tout + tk.output, tcache: st.tcache + tk.cache, jms: st.jms + (Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0) })
}
// End of a deep J-prompt turn (also when the reply went out only via SendUserMessage: final text empty). `reply`: 'short' = exempt from check_reply,
// 'unchecked' = long final text that never went through check_reply, 'none' = no final text. A checked prompt (eRounds > 0) is counted from the epoch rounds.
export async function statsTurnEnd($: EngineInterface, epoch: string | number, reply: 'short' | 'unchecked' | 'none', turnMs = 0, who?: SessionWho): Promise<void> {
  try {
    const sid = String(await $.session.id()), date = sgtIso(await nowMs($)).slice(0, 10), st = await readStats($, sid, date), e = String(epoch)
    if (st.closed === e) return // one count per prompt
    const checked = st.epoch === e && st.eRounds > 0
    if (checked || reply === 'short') {
      st.prompts += 1
      if (!(checked && st.eFail)) st.firstPass += 1
    }
    if (reply === 'unchecked') { if (who?.unattended === true) st.uu += 1; else st.unchecked += 1 }
    if (who !== undefined) { st.att = who.attended; st.so = who.origin }
    st.closed = e
    const tm = Number.isFinite(turnMs) && turnMs > 0 ? Math.round(turnMs) : 0
    st.tms += tm; st.tn += 1; st.tmax = Math.max(st.tmax, tm)
    if (st.epoch === e && st.eT0 !== undefined && st.eT1 !== undefined) st.crms += Math.max(0, st.eT1 - st.eT0)
    await $.store.set(`${STATS_KEY}:${sid}`, st)
    if (st.prompts + st.unchecked + (st.uu ?? 0) === 0) return
    await upsertRows($, [{ id: `deepstats-${sid}-${date}`, data: statsRow(sid, date, st) }])
    await corrFlush($).catch(() => 0)
  } catch { /* logging never affects a turn */ }
}
// 0.6.28: who reads this session. `attended` / `origin` are the session's CLAUDE_CODE_SESSION_ATTENDED / CLAUDE_CODE_SESSION_ORIGIN ('' when unset);
// unattended = ATTENDED is "0" (a run nobody watches, e.g. a scheduled task's fresh session): its unchecked replies count apart (unchecked_unattended).
export type SessionWho = { attended: string; origin: string; unattended: boolean }
export async function sessionWho($: EngineInterface): Promise<SessionWho> {
  const get = async (k: 'a' | 'o'): Promise<string> => { try { return String((k === 'a' ? await $.env.get('CLAUDE_CODE_SESSION_ATTENDED') : await $.env.get('CLAUDE_CODE_SESSION_ORIGIN')) ?? '') } catch { return '' } }
  const attended = await get('a'), origin = await get('o')
  return { attended, origin, unattended: attended === '0' }
}
// 0.6.28: one unchecked reply seen at a Stop (each Stop of a Stop-hook chain, not only the last text turn.complete sees). Does not close the prompt.
export async function statsUnchecked($: EngineInterface, who?: SessionWho, reworded = false): Promise<void> {
  try {
    const sid = String(await $.session.id()), date = sgtIso(await nowMs($)).slice(0, 10), st = await readStats($, sid, date)
    if (who?.unattended === true) st.uu += 1; else st.unchecked += 1
    if (reworded) st.rw = (st.rw ?? 0) + 1 // W24: a final reply that differs from the text check_reply passed this turn
    if (who !== undefined) { st.att = who.attended; st.so = who.origin }
    await $.store.set(`${STATS_KEY}:${sid}`, st)
    await upsertRows($, [{ id: `deepstats-${sid}-${date}`, data: statsRow(sid, date, st) }])
    await corrFlush($).catch(() => 0)
  } catch { /* logging never affects a turn */ }
}
async function recordOutcome($: EngineInterface, epoch: string | number, probs: Problem[], kind: 'fail' | 'fixed' | 'cap', n: number): Promise<void> {
  await statsRound($, epoch, kind === 'fail' || (kind === 'cap' && probs.length > 0), [...new Set([...probs.map(x => x.id), ...judgeLetters(probs)])]).catch(() => undefined)
  const sid = String(await $.session.id()), now = await nowMs($), key = `${OPEN_KEY}:${sid}`
  const cur = await $.store.get(key) as { epoch?: unknown; rows?: { id: string; data: DeepRow }[] } | undefined
  const open = cur?.epoch === epoch && Array.isArray(cur.rows) ? cur.rows : []
  const resolve = (o: DeepRow['outcome']) => open.map(r => ({ id: r.id, data: { ...r.data, outcome: o } }))
  if (kind === 'fail') { // held in the store only: a row is queued once it has an outcome (fixed / sent at cap)
    const row = { id: `deep-${sid.slice(0, 8)}-${now.toString(36)}-${n}`, data: deepRow(probs, 'fixed', sid, now) }
    await $.store.set(key, { epoch, rows: [...open, row].slice(-5) })
    return
  }
  if (kind === 'fixed') { if (open.length > 0) { await upsertRows($, resolve('fixed')); await $.store.set(key, { epoch, rows: [] }) }; return }
  const rows = resolve('sent at cap')
  if (probs.length > 0) rows.push({ id: `deep-${sid.slice(0, 8)}-${now.toString(36)}-cap`, data: deepRow(probs, 'sent at cap', sid, now) })
  if (rows.length > 0) await upsertRows($, rows)
  await $.store.set(key, { epoch, rows: [] })
}
// Deep-mode checks on one draft: dark hits logged (dark:true); live problems count against the per-draft cap (store-mirrored) and log.
export async function deepGate($: EngineInterface, said: string, facts: DeepFacts, deniedSoFar: number, epoch: string | number = 0, judged?: { problems: Problem[] }, hold = false, pre: Problem[] = [], maxCap?: number): Promise<{ probs: Problem[]; denied: number; capped: boolean }> {
  // 0.6.20: maxCap (a reply to a mid-turn J message) lowers the cap and drops the extra (a)/(b) round.
  const cap = maxCap === undefined ? denyCap() : Math.min(maxCap, denyCap())
  const all = deepProblems(said, facts)
  // DARK checks are unvalidated: logged as would-be hits ({dark:true}), never denying. With a judge answer, DEEP_DARK ids are dark too; judge problems deny.
  const dark = (id: string): boolean => logOnly(id) || (judged !== undefined && DEEP_DARK.has(id))
  const before = await failCount($, deniedSoFar, epoch)
  const claimKey = `deepClaim:${await Promise.resolve().then(() => $.session.id()).catch(() => '?')}`
  const claimRound = String(await Promise.resolve().then(() => $.store.get(claimKey)).catch(() => '') ?? '') === String(epoch) // an earlier judged (a)/(b) round failed in this prompt: effective cap is one higher
  // 0.6.17: after a failed round in this prompt, "Efficiency: none" is not accepted. It counts (denies) only when the effective cap is at least 2; else it goes into the note.
  const effOk = cap >= 2 || (cap === 1 && claimRound)
  const effNone: Problem[] = before > 0 && EFF_NONE.test(said) ? [{ id: 'efficiency-none', weak: !effOk, text: `Efficiency: none after ${before} failed check round${before === 1 ? '' : 's'} — state what the first draft lacked, as a fact; a could/would/should fix needs the change made this turn` }] : []
  const probs = [...all.filter(x => !dark(x.id)), ...effNone, ...pre, ...(judged?.problems ?? [])]
  const soft = all.filter(x => dark(x.id))
  if (soft.length > 0) await Promise.resolve().then(async () => {
    const log = await $.store.get(DENY_LOG_KEY)
    await $.store.set(DENY_LOG_KEY, [...(Array.isArray(log) ? log : []), { time: sgtIso(await nowMs($)), session: await $.session.id(), n: 0, dark: true, checks: soft.map(x => x.id) }].slice(-500))
  }).catch(() => undefined)
  await statsDark($, soft.map(x => ({ id: x.id, snip: x.text })))
  const key = await failKey($)
  // 0.6.17 caps: any hard problem fails up to denyCap(); a judge problem tagged (a) contradicted / (b) unsupported claim, or Efficiency-none after such a round, gets one more round.
  const hard = probs.filter(x => x.weak !== true)
  const claim = probs.filter(x => x.id === 'judge' && /^judge:\s*\(?[ab](?:\|[ab])?\)/i.test(x.text))
  const extra = maxCap === undefined && cap > 0 && before < cap + 1 && (claim.length > 0 || (claimRound && cap === 1 && effNone.length > 0 && !effNone[0].weak))
  if (hard.length > 0 && (before < cap || extra)) {
    const n = before + 1
    // 0.6.28: this round fails, so "Efficiency: none" would be refused on the next one: name it now (same check, reported a round early; pass/fail unchanged).
    if (before === 0 && EFF_NONE.test(said)) probs.push({ id: 'efficiency-none', text: 'Efficiency: none will be flagged on the retry because this round fails \u2014 state what the first draft lacked, as a fact; a could/would/should fix needs the change made this turn' })
    if (claim.length > 0) await Promise.resolve().then(() => $.store.set(claimKey, String(epoch))).catch(() => undefined)
    await Promise.resolve().then(() => $.store.set(key, `${epoch}:${n}`)).catch(() => undefined)
    await Promise.resolve().then(async () => {
      const log = await $.store.get(DENY_LOG_KEY)
      await $.store.set(DENY_LOG_KEY, [...(Array.isArray(log) ? log : []), { time: sgtIso(await nowMs($)), session: await $.session.id(), n, checks: probs.map(x => x.id), problems: probs.map(x => cleanProblem(x.text, x.id)) }].slice(-500))
      if (n === 1) await $.store.set(CAUGHT_KEY, (Number(await $.store.get(CAUGHT_KEY)) || 0) + 1)
    }).catch(() => undefined)
    await recordOutcome($, epoch, probs, 'fail', n).catch(() => undefined)
    return { probs, denied: n, capped: false }
  }
  // At the cap the count stays at the cap for the rest of the prompt epoch; only a clean PASS (or a new prompt) resets it.
  if (probs.length === 0 && !hold) await Promise.resolve().then(() => $.store.set(key, `${epoch}:0`)).catch(() => undefined)
  await recordOutcome($, epoch, probs, probs.length === 0 && !hold ? 'fixed' : 'cap', before).catch(() => undefined)
  return { probs, denied: probs.length > 0 ? before : 0, capped: probs.length > 0 }
}

// 0.6.16: the check_reply rows show a short stub instead of the draft, ask or evidence; anything unexpected leaves the row as it came.
export const stubInput = (input: unknown): unknown => {
  try {
    if (input === null || typeof input !== 'object') return input
    const text = (input as Record<string, unknown>).text
    if (typeof text !== 'string') return input
    return { text: `draft \u00b7 ${text.length} chars` }
  } catch { return input }
}
export const stubOutput = (output: unknown): unknown => {
  try {
    const t = typeof output === 'string' ? output : JSON.stringify(output)
    if (typeof t !== 'string') return output
    if (/^\W*PASS\b/.test(t)) return 'PASS'
    const n = (t.match(/\b\d+\) /g) ?? []).length
    return n > 0 ? `${n} problem${n === 1 ? '' : 's'}` : output
  } catch { return output }
}

export const register: Register = on => {
  on('ui.render', { component: 'ToolUse', props: { tool: CHECK_TOOL } }, async ($, e, next) => {
    try { return await next({ ...e, props: { ...e.props, input: stubInput(e.props.input), ...(e.props.output === undefined ? {} : { output: stubOutput(e.props.output) }) } } as typeof e) } catch { return next(e) }
  })
  on('ui.render', { component: 'ToolResult', props: { tool: CHECK_TOOL } }, async ($, e, next) => {
    try { return await next({ ...e, props: { ...e.props, output: stubOutput(e.props.output) } } as typeof e) } catch { return next(e) }
  })
  registerGuards(on) // docx .text and uploads-write warnings (warn-only, once per target), post-compaction pointer (hooks/guards.ts)
  resetPack() // each load fetches afresh for its sessions
  resetClockOffset()
  let count = 0
  const agentCalls = new Map<string, number>() // tool calls per subagent loop, for the relay note
  const loops = new Map<string, { cmd: string; n: number; files: Map<string, number>; fired: boolean }>() // 0.6.4 loop guard, per agent
  let turnFired = false // the 4th-call reminder fires at most once per turn
  let handoffTurn = false // the handoff skill was loaded this main turn: no 4th-call reminder
  let pendingHandoff = false // a /handoff slash command was submitted; its turn is a handoff turn
  let proof = false // a launch id came back this main turn
  let acted = false // a write-type tool ran on the main thread this turn
  let landed = false // a write, memory-write or skill-proposal tool ran on the main thread this turn
  let stampFired = false // the board-timestamp lint went out this main turn
  let idleFired = false // the idle-guard reminder went out this main turn
  let savedWide = false // a Claude-wide save (memory write, propose_skills, skill/card file edit) ran this main turn
  let wrote = false // a write or dispatch tool ran this main turn
  let unread = false // this main turn wrote something and no read-back call has run since the last write
  let dispatched = false // an agent was launched or the ledger edited this main turn
  let chatDispatched = '' // session id of the chat that has dispatched an agent (the proof only matters then)
  let boarded = false // an ArtifactData write ran this main turn
  let fromGuard = false // this main turn began with the guard's own continuation prompt
  let submitted = false // the guard submitted a continuation not yet started
  let carry: string | undefined // the end-of-turn line, for the model with the next prompt only
  let injected: string | undefined // the session id this module last injected the card for
  let dueId: string | undefined // the session id the owed card is for
  let cardDue = false // a chat-start card is owed to the prompt in flight
  let asked = '' // the text that opened this main turn (J's prompt)
  let looked = false // a lookup tool ran this main turn
  let anyTool = false // 0.6.11: any main-turn tool call ran
  let finishedNote = false // this main turn opened on a completed task-notification
  let boardRow = false // a status-board ArtifactData write ran this main turn
  let turnT0 = 0 // clock ms at the main turn's turn.start (speed meter)
  let inTurn = false // a main turn is running (turn.start → turn.complete)
  let jTurn = false // this main turn was opened by J's own message (not an agent, notification or the guard)
  let replied = false // a SendUserMessage went out this main turn
  let firstFired = false // the first-reply line went out this main turn
  let midPending = false // a J message arrived mid-turn and no SendUserMessage has gone out since
  let midFired = false // the mid-turn line went out for the pending message
  let midSeen = false // a mid-turn J prompt has reached this hook (store MID_SEEN): the 4th-call fallback is off
  // 0.6.20 burst-safe mid-turn state (main thread). seq <= seenSeq: the model saw the message (it arrived before its last tool result came back).
  let midQ: MidMsg[] = [] // unanswered mid-turn J messages, oldest first
  let midSeq = 0
  let seenSeq = 0
  let replyWaits: number[] = [] // 0.6.33: arrival times of J messages with no J-visible reply yet
  let checkAcc = 0 // 0.6.33: ms inside check_reply / send-path judge since the oldest wait began
  let newGroup = false // 0.6.33: the next reply is the first of a new J prompt
  let replyTools: number[] = [] // W14: toolN at each replyWaits arrival (parallel)
  let replyTiers: string[] = [] // W14: classifyTier of each replyWaits message, set at arrival (parallel)
  let toolN = 0 // W14: main-thread tool calls that went through (SendUserMessage, check_reply, set_rules excluded)
  const takeReply = (): { w: number[]; c: number; g: boolean; at: number[]; tr: string[] } => { const r = { w: replyWaits, c: checkAcc, g: newGroup, at: replyTools, tr: replyTiers }; replyWaits = []; replyTools = []; replyTiers = []; checkAcc = 0; newGroup = false; return r }
  let lastJAt = 0 // when J's previous message (opening or mid-turn) arrived
  let midDenied = 0 // block denials for the pending set (valve)
  let earlyN = 0 // W23: non-reply main-thread tool calls that went through this J turn before its first SendUserMessage
  let earlyDenied = 0 // W23: early-reply denials this turn (valve)
  let earlySend: boolean | undefined // W23: the tool list affirmatively carries SendUserMessage (read once per turn, at the first threshold hit)
  let sendable = true // the session's tool list has SendUserMessage (unreadable list: assumed)
  const midCap = (): number | undefined => (midQ.length > 0 ? num('mid-turn', 'rounds') : undefined)
  let scripted = false // a code-running tool ran on the main thread this turn
  let seenNums = new Set<string>() // numbers in this turn's opening text, tool inputs and tool results
  let turnCorpus = '' // 0.6.14: this turn's opening text (J, hand-back or notification) + tool inputs + results
  let turnInputs = '' // tool inputs this main turn
  let corpus = '' // earlier turns' corpus (assistant text excluded), capped
  let agentLaunches: string[] = [] // 0.6.21 auto-evidence: this chat's Agent launches (description + model)
  let turnActs: string[] = [] // 0.6.22/0.6.24: rolling last 30 non-read-only tool calls across turns (this chat): SGT time + name + input + ok/error + result start
  let turnSends: string[] = [] // ... this turn's SendMessage texts and memory write strings
  let sentText: string[] = [] // SendUserMessage texts this main turn (J-facing too)
  const asks: AskState = { pend: [], done: [] } // 0.6.30: J's messages since the last final reply, and the last answered ones
  const askFor = new Map<string, string[]>() // 0.6.30: reply hash -> the asks pending when that reply reached J (a Stop re-check judges these)
  const replyDelivered = (t: string): void => {
    const h = replyHash(t)
    const was = askAnswered(asks)
    if (!askFor.has(h) && was.length > 0) { askFor.set(h, was); if (askFor.size > 10) askFor.delete(askFor.keys().next().value as string) }
  }
  // the judge's ask for one draft: the asks its reply answers (re-check), else the pending mid-turn burst, else the pending asks; the model's ask only with no hook state
  const judgeAsk = (text: string, mc: number | undefined, given: string): { cur: string; ask: string } => {
    const snap = askFor.get(replyHash(text))
    const mq = midQ.map(m => m.text.trim()).filter(t => asks.pend.includes(t)) // a queued message a delivered final reply already answered is not current
    const cur = snap ?? (mc !== undefined && mq.length > 0 ? mq : asks.pend)
    const none = snap === undefined && asks.pend.length + asks.done.length === 0 && mc === undefined
    return buildAsk(cur, asks.done, none ? given : '')
  }
  let delivered: string[] = [] // 0.6.25: final texts already delivered this prompt (a Stop-hook continuation keeps the prompt): the judge must not ask for them again
  // 0.6.8 per session id: whether artifacts were listed / reuse-first fired.
  const listedBy = new Set<string>()
  const reusedBy = new Set<string>()
  let webText = '' // web lookup results this main turn: names found there are public, not labels
  let docEdited = false // J's document was edited this main turn
  let qeFired = false
  const nonPrevSeen = new Map<string, number>() // per-session fallback when the store is unreadable
  const styleSeen = new Map<string, number>() // per-session style-flag count, fallback when the store is unreadable
  let styleOwed = false // the style escalation went out last turn: the next J turn owes a Correction: line
  let styleOwedNow = false // this main turn owes it
  let askAt: number | undefined // work calls (startsWork) before the first ask to J went out this main turn
  let work = 0 // 0.6.0 (#43): work calls this main turn — ask-first counts writes before the ask, not lookups
  let askTool = false // AskUserQuestion ran this main turn
  let mode: ReplyMode | undefined // reply mode cache for this module load; the store is the master
  let denied = 0 // pre-send denials for the message in progress (mirrored in the store)
  let early = '' // 0.6.10: text known before the first work call — the turn's opening text plus SendUserMessage texts sent at work 0

  let epoch = '0' // one per J prompt (time + random, survives a reload): the per-draft failure count in the store belongs to one epoch
  const newEpoch = (): void => { epoch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; denied = 0; countedUnchecked.clear(); stopBlocked.clear(); stopChainDone = false }
  const countedUnchecked = new Set<string>() // 0.6.28: hashes of unchecked replies already counted this prompt (Stop and turn end see the same text)
  let stopChainDone = false // 0.6.29: a Stop re-check passed, was footer-only or got its correction sent: no further Stop re-check until J's next prompt
  const stopBlocked = new Set<string>() // 0.6.28: hashes the Stop re-check already blocked once this prompt (never twice: no loop)
  let who: SessionWho | undefined // 0.6.28: read once per module load
  let turnResults = '' // this turn's tool results (tool + first 1500 chars each, last 6000 kept): the judge's hook evidence
  let sendOk = true // this session's tool list carries check_reply (re-registered at each deep prompt if missing); else deep behaves as light
  let hadLeap = false // an earlier text this turn (passed by check_reply or sent) already carried a Leap line
  let hadEff = false // ... an Efficiency line (set only by a delivered SendUserMessage or a final text that matched a PASS)
  const markLines = (t: string): void => { if (rx('leap-line', 'leap').test(t)) hadLeap = true; if (EFF_LINE.test(t)) hadEff = true }
  let savePass = false // 0.6.21: a check_reply PASS happened this turn (rule saves wait for it)
  let checkN = 0 // 0.6.25: main-thread check_reply calls this turn (evidence-first acts on the first only)
  let evTool = false // 0.6.25: an evidence call ran this turn (lookup, Bash, ArtifactData/Artifact read, memory read) or an agent report arrived
  let changed = false // 0.6.25: a real change ran this turn (closure-line): not a plan/log write
  let acts: Act[] = [] // 0.6.28 claim-ahead: this turn's successful main-thread writes, launches, sends and finished-agent reports
  let boardLive = false // 0.6.28 claim-ahead: the last task-list or status-board read (or a board write) this session showed a live job; not reset per turn
  let openNow = false // 0.6.28 claim-ahead: a job launched earlier is still open (launch records or the board), refreshed before each draft check
  let lastFacing: string[] = [] // 0.6.25: J-facing texts of the last main turn (sent messages + final reply)
  let priorFacing: string[] = [] // 0.6.25: in a Stop-hook continuation turn, what J already saw in the turn it blocked
  const finalPassed = new Set<string>() // hashes check_reply passed this turn: the final reply should be one of them
  const passed = new Map<string, string>() // 0.6.16: hashes of drafts check_reply passed -> note (sent-with-open-problems), consumed by the matching SendUserMessage
  const facts = (): DeepFacts => ({ asked, corpus: `${corpus} ${turnCorpus}`, looked, anyTool, jTurn, acted: acted || landed || wrote, landed, saved: savedWide, askTool, wrote, hadLeap, hadEff, launch: proof, changed, acts, open: openNow })
  const capNote = (probs: Problem[], c = denyCap()): string => `Deep mode: sent after ${c} failed checks with open problems (${probs.map(x => x.text).join('; ')}).`
  // 0.6.21: the judge also sees what SendUserMessage already told J this turn, so a final reply is not failed for 'not answering' a question a mid-turn message answered.
  const sentEvidence = (ev: string): string => {
    const auto = [...agentLaunches.slice(-15).map(a => `launched ${a}`), ...turnSends.slice(-15), ...turnActs.slice(-30)]
    const already = [...delivered, ...sentText]
    return `${ev}${already.length === 0 ? '' : `\nAlready sent to J this turn: ${already.join('\n---\n')}`}${auto.length === 0 ? '' : `\nAuto-evidence: ${auto.join('; ')}`}`.slice(-20_000)
  }
  const numbered = (probs: Problem[]): string => probs.map((x, i) => `${i + 1}) ${x.text}`).join(' ')

  // 0.6.16: the pre-send check as a tool, so a bad draft never reaches a message row J can see.
  on('session.start', async ($, e, next) => {
    await Promise.resolve().then(() => $.tool.register(CHECK_SPEC)).catch(() => undefined)
    return next(e)
  })

  // Once per chat: attach the orchestrator instruction to the first prompt, before the model's first reply.
  // Re-arms on a new session id (startup, /clear), so it needs no SessionStart hook.
  on('prompt.submit', async ($, e, next) => {
    const stamp = await stampPrompt($, e)
    let promptRows: Promise<string[]> = Promise.resolve([]) // 0.6.10: ids of the rows this prompt's own checks fired
    const note = await ensurePack($, budgetMs(next)).catch(() => undefined)
    if (note !== undefined) e = { ...e, context: [...(e.context ?? []), note] }
    if (e.command !== undefined) {
      if (/(^|:)handoff$/.test(e.command.name)) pendingHandoff = true
      if (!e.isMeta && !(e.turnId !== undefined || inTurn)) newEpoch()
      return next({ ...e, context: [...(e.context ?? []), stamp] })
    }
    e = { ...e, context: [...(e.context ?? []), stamp] }
    // 0.6.18: an agent hand-back, agent-message or task notification delivered to the main thread is session evidence.
    if (!e.isMeta && e.agentId === undefined && !String(e.text ?? '').trimStart().startsWith(GUARD_TAG) && (!jOrigin(e as never) || /<(agent-message|task-notification)\b|^\s*\[Subagent hand-?back\]/i.test(String(e.text ?? '')))) {
      await rec($, mode, 'agent', String(e.origin?.kind ?? ''), String(e.text ?? '')).catch(() => undefined)
      if ((e.turnId !== undefined || inTurn) && AGENT_REPORT.test(String(e.text ?? ''))) evTool = true // 0.6.25: an agent report delivered mid-turn is evidence
    }
    const compactNote = await takeCompactNote($)
    if (compactNote !== undefined) e = { ...e, context: [...(e.context ?? []), compactNote] }
    // 0.6.15 reply modes: a "deep mode" / "light mode" command is stored; deep (the default) drafts via check_reply, then writes the passed text as the final reply.
    if (!e.isMeta && jOrigin(e as never) && isJ(e.text) && !(e.turnId !== undefined || inTurn)) {
      newEpoch()
      if (replyWaits.length > 0 && (e as Record<string, unknown>).agentId === undefined) { const r = takeReply(); await statsReply($, r.w, r.c, r.g, r.w, { tools: toolN, at: r.at, tier: r.tr, words: 0, stopped: true }) } // W23: the previous message got no visible reply
      lastJAt = await nowMs($)
      replyWaits = [lastJAt]; replyTools = [toolN]; replyTiers = [classifyTier(e.text, attachN(e))]; checkAcc = 0; newGroup = true
      const cmd = modeCommand(e.text)
      if (cmd !== undefined) {
        mode = cmd
        await Promise.resolve().then(() => $.store.set(MODE_KEY, cmd)).catch(() => undefined)
        e = { ...e, context: [...(e.context ?? []), modeSwitchLine(cmd)] }
      }
      if ((cmd ?? await readMode($, mode)) === 'deep') {
        sendOk = await hasCheckTool($)
        if (sendOk) {
          e = { ...e, context: [...(e.context ?? []), deepLine()] }
          const fm = num('deep-evidence', 'factsChars')
          if (fm > 0 && e.agentId === undefined) {
            const sid = String(await Promise.resolve().then(() => $.session.id()).catch(() => '?'))
            const fl = factsLine(String(await Promise.resolve().then(() => $.store.get(`${SESSION_EV_KEY}:${sid}`)).catch(() => '') ?? ''), await Promise.resolve().then(() => $.store.get(`${AGENT_REPORTS_KEY}:${sid}`)).catch(() => undefined), await openCount($).catch(() => 0), fm)
            e = { ...e, context: [...(e.context ?? []), fl] }
          }
        }
      }
    }
    // 0.6.0 mid-turn: J's own message while a main turn runs (turnId set, or between turn.start and turn.complete).
    if ((e.turnId !== undefined || inTurn) && jOrigin(e as never) && isJ(e.text)) {
      midPending = true
      midFired = false
      // 0.6.20: queue it; the block (tool.call) holds every other tool until a SendUserMessage answers the queue.
      const at = await nowMs($)
      midQ.push({ text: jText(e.text), at, seq: ++midSeq, gap: lastJAt > 0 ? at - lastJAt : Infinity })
      askPush(asks, jText(e.text)) // 0.6.30
      lastJAt = at
      replyWaits.push(at); replyTools.push(toolN); replyTiers.push(classifyTier(e.text, attachN(e)))
      if (midQ.length > 50) midQ = midQ.slice(-50)
      let list: unknown
      try { list = await $.tool.list() } catch { list = undefined }
      sendable = !Array.isArray(list) || list.length === 0 || list.some(t => t?.name === 'SendUserMessage')
      if (e.turnId !== undefined && !midSeen) { midSeen = true; await Promise.resolve().then(() => $.store.set(MID_SEEN, true)).catch(() => undefined) }
    }
    if (rx('upload-check', 'uploaded').test(jText(e.text))) e = { ...e, context: [...(e.context ?? []), `${await syncedVersions($).catch(() => 'synced: unreadable')}; ${packInfo()}`] }
    if (!e.isMeta) {
      const ph = addedHits('prompt', jText(e.text))
      if (ph.length > 0) promptRows = hookLog($, ph.map(h => h.id))
      for (const h of ph) e = { ...e, context: [...(e.context ?? []), h.message] }
    }
    const night = !e.isMeta && isJ(e.text) ? nightLine(await nowMs($)) : undefined
    if (night !== undefined) e = { ...e, context: [...(e.context ?? []), night] }
    // one row per J prompt; 0.6.10: a logged J correction marks this session's pending firing rows fixed: false
    if (!e.isMeta && ((await corrLog($, e.text).catch(() => false)) || (await jCorrLog($, e.text).catch(() => false)))) await markCorrected($, promptRows).catch(() => undefined)
    if (!e.isMeta && e.agentId === undefined && !isJ(e.text)) { // W13: queued Scoreboard rows the hook may not send go to the main model; 0.6.37: only on non-J (task/notification) turns, never while J waits
      const relay = await corrRelay($).catch(() => undefined)
      if (relay !== undefined) e = { ...e, context: [...(e.context ?? []), relay] }
    }
    await close($, finished(e.text)) // a notification may arrive as a submitted prompt
    if (carry !== undefined) {
      e = { ...e, context: [...(e.context ?? []), carry] }
      carry = undefined
    }
    if (reasks(e.text)) e = { ...e, context: [...(e.context ?? []), `${GUARD_TAG} ${msg('reask-guard', 'context')}`] }
    const scope = await scopeCarry($, e.text).catch(() => scopeCtx(e.text))
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

  // 0.6.25: the prompt-type Stop hook (hooks.json) judges a reply after J saw it; its criteria now run in check_reply's judge, so a final
  // reply check_reply passed this turn ends the chain here and the Stop hook only reviews replies that skipped check_reply.
  // 0.6.28: every Stop of a deep J turn whose text needs check_reply (not short-exempt) and matched no PASS is counted here, so a reply the Stop
  // hook blocked and the continuation replaced still counts (turn.complete sees only the last text). In an attended session the first such Stop
  // of a text is blocked once with STOP_RECHECK: the model checks the text J already has and sends only a correction, or nothing.
  // W24 (0.6.39): when check_reply passed another text this turn, the block carries STOP_REWORDED instead and counts reworded_sends.
  on('classic.Stop', async ($, e, next) => {
    const last = String((e as Record<string, unknown>).last_assistant_message ?? '')
    if (last.trim() !== '') replyDelivered(last) // 0.6.30: this text reached J; the asks pending now are answered by it
    if (last.trim() !== '' && finalPassed.has(replyHash(last))) return {}
    if (stopChainDone) return {} // 0.6.29: the re-check already ran in this chain; a forced closing line is never re-blocked
    if (last.trim() !== '' && jTurn && sendOk && !stopShort(last) && (await readMode($, mode)) === 'deep') {
      const h = replyHash(last)
      who ??= await sessionWho($)
      const reworded = finalPassed.size > 0
      if (!countedUnchecked.has(h)) { countedUnchecked.add(h); await statsUnchecked($, who, reworded) }
      if (!who.unattended && !stopBlocked.has(h)) { stopBlocked.add(h); return { block: reworded ? STOP_REWORDED : STOP_RECHECK } }
    }
    return next(e)
  })

  // Main loop only: a new main turn (user message or agent notification) resets the count.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      evTurn = String(e.turnId ?? '')
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
      savedWide = false
      unread = false
      dispatched = false
      boarded = false
      looked = false
      anyTool = false
      inTurn = true
      turnT0 = await nowMs($)
      replied = false
      firstFired = false
      midPending = false
      midFired = false
      midQ = []
      seenSeq = midSeq
      midDenied = 0
      earlyN = 0
      earlyDenied = 0
      earlySend = undefined
      scripted = false
      seenNums = new Set(numbersIn(e.text))
      corpus = `${corpus} ${turnCorpus}`.slice(-600_000)
      turnCorpus = String(e.text ?? '')
      turnInputs = ''
      turnResults = ''
      sentText = []
      delivered = []
      turnSends = []
      finalPassed.clear()
      savePass = false
      checkN = 0
      changed = false
      acts = !isJ(e.text) && AGENT_REPORT.test(String(e.text ?? '')) ? [{ kind: 'report', tgt: '', hay: String(e.text ?? '').slice(0, 20_000).toLowerCase() }] : [] // 0.6.28: a turn opened by an agent report carries that report
      evTool = !isJ(e.text) && AGENT_REPORT.test(String(e.text ?? '')) // 0.6.25: a turn opened by an agent report has its evidence
      priorFacing = STOP_FEEDBACK.test(String(e.text ?? '').slice(0, 600)) ? lastFacing : [] // 0.6.25: a Stop-hook continuation
      hadLeap = false
      hadEff = false
      webText = ''
      docEdited = false
      qeFired = false
      if (!midSeen) midSeen = (await Promise.resolve().then(() => $.store.get(MID_SEEN)).catch(() => undefined)) === true
      askAt = undefined
      work = 0
      early = String(e.text ?? '')
      askTool = false
      finishedNote = completedNote(e.text)
      boardRow = false
      asked = jText(e.text)
      fromGuard = submitted || e.text.trimStart().startsWith(GUARD_TAG)
      submitted = false
      jTurn = !fromGuard && isJ(e.text)
      if (jTurn) askPush(asks, asked) // 0.6.30
      styleOwedNow = jTurn && styleOwed // the line carried in with this prompt: this turn owes the Correction:
      if (styleOwed && jTurn) styleOwed = false
      await close($, finished(e.text))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Warn only: always run the tool, then append a reminder to its result.
  on('tool.call', async ($, e, next) => {
    // 0.6.20: whatever this call returns, every mid-turn message queued so far reaches the model with its result: mark it seen.
    const ckT0 = e.tool === CHECK_TOOL && e.agentId === undefined && replyWaits.length > 0 ? await nowMs($) : 0
    try {
    if (e.tool === SET_RULES_TOOL) {
      const t = String((e as Record<string, unknown>).text ?? '').slice(0, RULES_MAX)
      if (e.agentId !== undefined || t.trim() === '') return { result: 'set_rules: nothing stored (empty text or a subagent call).' }
      const rk = `${RULES_KEY}:${await $.session.id()}`
      // W22: a later call replaces the stored text only when it is longer (a fuller copy of the same rules); same-length or shorter calls keep the first.
      const prev = String(await Promise.resolve().then(() => $.store.get(rk)).catch(() => '') ?? '')
      if (prev !== '' && t.length <= prev.length) return { result: `set_rules: already set for this session (${prev.length} chars); only a longer text replaces it.` }
      await Promise.resolve().then(() => $.store.set(rk, t)).catch(() => undefined)
      return { result: `Standing rules ${prev !== '' ? 'replaced' : 'stored'} for this session (${t.length} chars).` }
    }
    if (e.tool === CHECK_TOOL) {
      await ensurePack($, budgetMs(next)).catch(() => undefined) // pack values (cap, judge floor, judge rules) apply even when check_reply is the first call
      const text = String((e as Record<string, unknown>).text ?? '')
      if (e.agentId !== undefined) return { result: `PASS ${replyHash(text)}` } // a subagent never touches the main thread's counts, logs or judge
      if (text.trim() === '') return { result: 'Deep mode: text is empty; pass the full draft reply as text.' }
      if (!sendOk || (await readMode($, mode)) !== 'deep') return { result: `PASS ${replyHash(text)}` }
      const x = e as Record<string, unknown>
      // 0.6.25 evidence-first: the turn's first check_reply is refused once when the draft states current state or answers a correction/re-ask before any evidence call.
      checkN += 1
      openNow = boardLive || (await openCount($).catch(() => 0)) > 0
      const ef = num('evidence-first', 'enforce')
      if (checkN === 1 && ef > 0 && !evTool && priorFacing.length === 0 && evidenceFirstHit(text, midQ.length > 0 ? midQ.map(m => m.text).join('\n') : asked || String(x.ask ?? ''))) {
        await Promise.resolve().then(async () => { const log = await $.store.get(DENY_LOG_KEY); await $.store.set(DENY_LOG_KEY, [...(Array.isArray(log) ? log : []), { time: sgtIso(await nowMs($)), session: await $.session.id(), n: 0, ...(ef < 2 ? { dark: true } : {}), checks: ['evidence-first'] }].slice(-500)) }).catch(() => undefined)
        if (ef < 2) await statsDark($, [{ id: 'evidence-first', snip: text.slice(0, 160) }])
        else {
          await recordOutcome($, epoch, [{ id: 'evidence-first', text: msg('evidence-first') }], 'fail', 0).catch(() => undefined)
          // 0.6.28: the footer checks run now too, so the redraft fixes them with the lookup instead of failing a round later. Listed only: this refusal's outcome is unchanged.
          const ff0 = deepProblems(text, facts()).filter(p => FOOTER_IDS.has(p.id) && !logOnly(p.id))
          const na0 = nextActions(ff0, text, { acts, today: sgtIso(await nowMs($)).slice(0, 10) }) // W3: the footer list names its next actions too
          const ff = ff0.map((p, i) => { const a = nextText(na0[i] ?? []); return a === '' ? p : { ...p, text: `${p.text} → ${a}` } })
          // W2: name the lookup per claim type; run the read-only ones here so the redraft needs no extra call. The refusal itself is unchanged.
          const cl = claimLookups(text, 6)
          const lk = cl.length === 0 || /^\W*(?:yes|no|yep|nope|correct|right)\b/im.test(proseLines(text).join('\n')) ? [...cl, { kind: 'answer' as const, claims: [], lookup: msg('evidence-first', 'lk_answer'), targets: [] }] : cl
          const rd = await hookLookups($, mode, lk)
          if (rd.size > 0) turnResults = `${turnResults} [hook-lookup] ${lookupRead(rd)}`.slice(-6000)
          return { result: `Deep mode: ${msg('evidence-first')} ${lookupText(lk, rd)}${ff.length === 0 ? '' : ` Also fix these footer lines in the redraft: ${numbered(ff)}`}` }
        }
      }
      const mc = midCap() // 0.6.20: a reply to a pending mid-turn message gets mid-turn.rounds failed rounds, no extra round
      const cap = mc === undefined ? denyCap() : Math.min(mc, denyCap())
      const f = mc === undefined ? facts() : { ...facts(), asked: midQ.map(m => m.text).join('\n') } // the judge reads the pending burst as the ask
      const atCap = await failCount($, denied, epoch) >= cap // at the cap the draft passes with a note: no judge call
      let sg: string[] = []
      const gateMode = num('deep-evidence', 'sourceGate') // 0 off, 1 log-only (DARK), 2 live
      const ja = judgeAsk(text, mc, String(x.ask ?? '')) // 0.6.30
      if (gateMode > 0 && !skipJudge(text, ja.cur)) { // the short-reply exemption runs first
        sg = sourceGate(text, String(x.evidence ?? ''))
        if (sg.length > 0 && DARK.has(SOURCE_GATE_ID) && gateMode < 2) { // dark: logged as a would-be hit, never denying
          await Promise.resolve().then(async () => { const log = await $.store.get(DENY_LOG_KEY); await $.store.set(DENY_LOG_KEY, [...(Array.isArray(log) ? log : []), { time: sgtIso(await nowMs($)), session: await $.session.id(), n: 0, dark: true, checks: [SOURCE_GATE_ID] }].slice(-500)) }).catch(() => undefined)
          await statsDark($, [{ id: SOURCE_GATE_ID, snip: sg[0] }])
          sg = []
        }
      }
      const pre: Problem[] = sg.length > 0 ? [{ id: SOURCE_GATE_ID, text: `cite a source in evidence or label it (inferred / estimate / unverified / requested / planned): ${sg.slice(0, 3).join(' | ')}` }] : []
      // 0.6.25: the dangling-reference check (undefined labels, missing D-items) runs pre-send too, not only after J saw the text.
      const dr = danglingRefs(text, saidIn(String(await Promise.resolve().then(() => $.session.id()).catch(() => '?'))), webText)
      if (dr.length > 0) pre.push({ id: 'dangling-ref', text: danglingMsg(dr) })
      // 0.6.25: after a Stop-hook block, the continuation sends only what is new (nothing, if the fix was bookkeeping).
      const rp = priorFacing.length > 0 ? repeatedLines(text, [...priorFacing, ...sentText].join('\n')) : []
      if (rp.length > 0) pre.push({ id: 'stop-repeat', text: `Stop-hook continuation: J already saw this; send only what is new, or no text if the fix was bookkeeping: ${rp.slice(0, 3).map(l => `"${l.slice(0, 60)}"`).join('; ')}` })

      // 0.6.22: cheap rule checks run first; a draft that already fails one comes back at once, without the slower judge call.
      const ruleFirst = !atCap && deepProblems(text, f).some(p => !logOnly(p.id) && !DEEP_DARK.has(p.id))
      const jr = pre.length > 0 || ruleFirst || skipJudge(text, ja.cur) ? undefined : await judgeReply($, text, ja.ask, sentEvidence(String(x.evidence ?? '')), turnResults, f)
      const g = await deepGate($, text, f, denied, epoch, jr === undefined || jr.status === 'unavailable' ? undefined : { problems: jr.problems.map(t => ({ id: 'judge', text: `judge: ${t}` })) }, atCap && jr === undefined, pre, mc)
      denied = g.denied
      const recheck = stopBlocked.has(replyHash(text))
      // 0.6.29: a Stop re-check (J already has the text) failing only on footer lines is logged to stats, never sent to J as a correction.
      if (recheck && g.probs.length > 0 && footerOnly(g.probs)) {
        await statsDark($, g.probs.map(p => ({ id: `recheck-footer:${p.id}`, snip: p.text.slice(0, 160) })))
        stopChainDone = true
        finalPassed.add(replyHash(text))
        return { result: `PASS ${replyHash(text)} (Stop re-check: footer-line gaps only, logged; J already has the reply. End the turn with no text; send J nothing about it.)` }
      }
      if (g.probs.length > 0 && !g.capped) {
        // W2: a judge (b) problem (unsupported claim) names the lookup per claim type it quotes, with the hook's read-only result where it has one. Text only: the outcome is unchanged.
        const per = g.probs.map(p => p.id === 'judge' && /^judge:\s*\(b\)/i.test(p.text) ? claimLookups(judgeClaims(p.text.replace(/^judge:\s*\(b\)\s*/i, '')), 3) : [])
        const rd = per.some(l => l.length > 0) ? await hookLookups($, mode, per.flat()) : new Map<LookupKind, string>()
        if (rd.size > 0) turnResults = `${turnResults} [hook-lookup] ${lookupRead(rd)}`.slice(-6000)
        // W3: an undone-work problem (closure-line, claim-ahead, judge (c)/(e)/(g)) names the exact next call and the closing line ending per line. Text only.
        const today = sgtIso(await nowMs($)).slice(0, 10)
        const na = nextActions(g.probs, text, { acts, today })
        const shown = g.probs.map((p, i) => { const l = per[i] ?? []; const a = nextText(na[i] ?? []); const t = l.length === 0 ? p.text : `${p.text} → ${lookupText(l, rd, false)}`; return { ...p, text: a === '' ? t : `${t} → ${a}` } })
        return { result: `Deep mode: fix these, then call check_reply again (${g.denied}/${cap}): ${numbered(shown)}` }
      }
      const holdNote = atCap && jr === undefined && !g.capped ? `Deep mode: sent at the ${cap}-failure cap; the judge was skipped for this draft.` : ''
      passed.set(replyHash(text), g.capped ? capNote(g.probs, cap) : holdNote)
      finalPassed.add(replyHash(text))
      if (recheck) stopChainDone = true // 0.6.29: re-check passed: nothing after it in this chain is re-checked
      savePass = true
      if (passed.size > 50) passed.delete(passed.keys().next().value!)
      const midTag = mc === undefined || !g.capped ? '' : ' (mid-turn reply: one check round only; tag these open problems in the reply, then send it)'
      return { result: `PASS ${replyHash(text)}${holdNote !== '' ? ` (note: ${cap} failed checks this prompt, judge skipped at the cap)` : ''}${g.capped ? ` (note: ${cap} failed checks, open problems: ${g.probs.map(x => x.text).join('; ')})${midTag}` : ''}` }
    }
    const packMsg = await ensurePack($, budgetMs(next)).catch(() => undefined)
    let waitNote: string | undefined
    // Main thread only: a subagent often waits on purpose for its own build, and its wait holds no J message.
    if (e.agentId === undefined && e.tool === 'Bash' && e.run_in_background !== true && foregroundWait(String(e.command ?? ''))) {
      e = { ...e, run_in_background: true }
      waitNote = msg('foreground-wait', 'note')
    }
    if (e.agentId !== undefined) { // subagents: big-result warning + relay note at call RELAY_AT, never blocked
      const n = (agentCalls.get(e.agentId) ?? 0) + 1
      agentCalls.set(e.agentId, n)
      if (agentCalls.size > KEEP_LAUNCHES) agentCalls.delete(agentCalls.keys().next().value!)
      const r = await next(e)
      if (r.deny !== undefined) return r
      const add: string[] = []
      if (packMsg !== undefined) add.push(packMsg)
      if (waitNote !== undefined) add.push(waitNote)
      const big = r.isError ? 0 : bigResult(r)
      if (big > 0) add.push(BIG_MSG(big))
      if (n === RELAY_AT) add.push(RELAY_MSG)
      const lp = loops.get(e.agentId) ?? { cmd: '', n: 0, files: new Map<string, number>(), fired: false }
      loops.set(e.agentId, lp)
      if (loops.size > KEEP_LAUNCHES) loops.delete(loops.keys().next().value!)
      let looped = false
      if (e.tool === 'Bash') {
        const c = normCmd(String(e.command ?? ''))
        if (r.isError) { lp.n = c === lp.cmd ? lp.n + 1 : 1; lp.cmd = c; looped = lp.n >= LOOP_AT } else { lp.cmd = ''; lp.n = 0 }
      } else if (e.tool === 'Edit') {
        const f = String((e as Record<string, unknown>).file_path ?? '')
        if (r.isError) { const k = (lp.files.get(f) ?? 0) + 1; lp.files.set(f, k); looped = k >= LOOP_AT } else lp.files.delete(f)
      }
      if (looped && !lp.fired) { lp.fired = true; add.push(LOOP_MSG) }
      return add.length > 0 ? { ...r, context: [...(r.context ?? []), ...add] } : r
    }
    // 0.6.25: prompt.submit runs when a queued mid-turn message is delivered to the model (not when J typed it), so every message registered
    // before this call started was in the model's context when it chose the call: a SendUserMessage answers all of them.
    seenSeq = midSeq
    // 0.6.20 burst-safe: an unanswered mid-turn J message blocks every other main-thread tool until a SendUserMessage answers it.
    if (midQ.length > 0 && sendable && !MID_OPEN.has(e.tool)) {
      midDenied += 1
      if (midDenied <= num('mid-turn', 'valve')) return { deny: msg('mid-turn', 'block', { n: midQ.length, list: midList(midQ) }) }
    }
    // W23 early reply: a J turn with nothing J-visible yet; reset by a SendUserMessage (replied) or the next turn.
    if (jTurn && !replied && !EARLY_OPEN.has(e.tool) && earlyDenied < EARLY_REPLY_VALVE
      && (earlyN >= EARLY_REPLY_CALLS || (turnT0 > 0 && (await nowMs($)) - turnT0 >= EARLY_REPLY_SECS * 1000))) {
      if (earlySend === undefined) {
        let list: unknown
        try { list = await $.tool.list() } catch { list = undefined }
        earlySend = Array.isArray(list) && list.some(t => t?.name === 'SendUserMessage')
      }
      if (earlySend) { earlyDenied += 1; return { deny: EARLY_REPLY_MSG } }
    }
    // 0.6.25: the 0.6.20 burst fold-in deny is gone: it assumed prompt.submit fires when J types, so it held replies to messages the model had already seen.
    // 0.6.21 save-gate: a rule save waits for a check_reply PASS earlier in the same turn. Dark (log-only) unless save-gate.enforce is 2.
    // Main thread, deep mode only. Exempt: /areas/handoffs/ memory paths (bookkeeping) and every other tool (ArtifactData etc. never match SAVE_TOOL).
    if (e.agentId === undefined && SAVE_TOOL.test(e.tool) && !savePass && sendOk && !handoffPath((e as Record<string, unknown>).path) && num('save-gate', 'enforce') > 0 && (await readMode($, mode)) === 'deep') {
      const live2 = num('save-gate', 'enforce') >= 2
      await Promise.resolve().then(async () => { const log = await $.store.get(DENY_LOG_KEY); await $.store.set(DENY_LOG_KEY, [...(Array.isArray(log) ? log : []), { time: sgtIso(await nowMs($)), session: await $.session.id(), n: 0, ...(live2 ? {} : { dark: true }), checks: ['save-gate'] }].slice(-500)) }).catch(() => undefined)
      if (!live2) await statsDark($, [{ id: 'save-gate', snip: 'rule save with no earlier check_reply PASS this turn' }])
      if (live2) return { deny: msg('save-gate') }
    }
    const notes: string[] = []
    if (packMsg !== undefined) notes.push(packMsg)
    if (waitNote !== undefined) notes.push(waitNote)
    const th = addedHits('tool', `${e.tool} ${JSON.stringify(e)}`)
    if (th.length > 0) void hookLog($, th.map(h => h.id))
    notes.push(...th.map(h => h.message))
    // A handoff resume/write turn is a short fixed sequence; handing it to an agent only slows it.
    if (e.tool === 'Skill' && /(^|:)handoff$/.test(String((e as Record<string, unknown>).skill ?? ''))) handoffTurn = true
    if (e.tool === 'AskUserQuestion') { askTool = true; askAt ??= work }
    if (e.tool === 'SendUserMessage') {
      const said = String((e as Record<string, unknown>).message ?? '')
      let preChecked = false // 0.6.25: check_reply already ran dangling-ref on this exact text
      // 0.6.16 deep mode: a draft check_reply passed (same normalised text) goes out silently; an unchecked one is checked here and denied on problems.
      if (said.trim() !== '' && sendOk && (await readMode($, mode)) === 'deep') {
        const h = replyHash(said)
        const pass = passed.get(h)
        if (pass !== undefined) {
          passed.delete(h)
          preChecked = true
          if (pass !== '') notes.push(pass)
        } else {
          const mc = midCap() // 0.6.20: a reply to a pending mid-turn message: mid-turn.rounds, no extra round
          openNow = boardLive || (await openCount($).catch(() => 0)) > 0 // 0.6.28 claim-ahead: refresh before facts() so the send path sees open jobs
          // 0.6.28 send = check: an unchecked SendUserMessage gets the same AI judge as check_reply (rule checks first; none at the cap or for a short text).
          const sf = facts(), sAsk = mc === undefined ? sf.asked : midQ.map(m => m.text).join('\n')
          const sCap = await failCount($, denied, epoch) >= (mc === undefined ? denyCap() : Math.min(mc, denyCap()))
          const sRule = deepProblems(said, sf).some(p => !DARK.has(p.id) && !DEEP_DARK.has(p.id))
          const sja = judgeAsk(said, mc, '') // 0.6.30
          const sjT0 = await nowMs($)
          const sj = SEND_JUDGE && !sCap && !sRule && !skipJudge(said, sja.cur) ? await judgeReply($, said, sja.ask, sentEvidence(''), turnResults, { ...sf, asked: sAsk }) : undefined
          if (sj !== undefined && replyWaits.length > 0) checkAcc += Math.max(0, (await nowMs($)) - sjT0)
          // judge problems go in as `pre`, not `judged`: the narrow checks stay live on this path (never loosened by the judge's answer)
          const g = await deepGate($, said, sf, denied, epoch, undefined, false, sj === undefined || sj.status === 'unavailable' ? [] : sj.problems.map(t => ({ id: 'judge', text: `judge: ${t}` })), mc)
          denied = g.denied
          if (g.probs.length > 0 && !g.capped) return { deny: `Deep mode: call check_reply first. Fix these before J sees the reply (${g.denied}/${mc === undefined ? denyCap() : Math.min(mc, denyCap())}), check with check_reply, then resend with SendUserMessage: ${numbered(g.probs)}` }
          if (g.capped) notes.push(capNote(g.probs, mc === undefined ? denyCap() : Math.min(mc, denyCap())))
        }
        markLines(said)
      }
      sentText.push(said)
      if (work === 0) early += `\n${said}`
      // 0.6.10: a mid-turn ask counts as held only when it was knowable before the work (knowableAsks); one sent before any work never is.
      if (asksJ(said) && (work === 0 || knowableAsks(said, early).length > 0)) askAt ??= work
      const dangling = preChecked ? [] : danglingRefs(said, saidIn(await $.session.id()), webText)
      if (dangling.length > 0) notes.push(danglingMsg(dangling))
    }
    const sidT = await Promise.resolve().then(() => $.session.id()).catch(() => '?')
    const act = String((e as Record<string, unknown>).action ?? 'publish')
    if (e.tool === 'Artifact' && READ_ACTIONS.has(act)) listedBy.add(sidT)
    if (e.tool === 'Artifact' && act === 'publish' && (e as Record<string, unknown>).url === undefined && (e as Record<string, unknown>).asset !== true
      && !listedBy.has(sidT) && !reusedBy.has(sidT)) { reusedBy.add(sidT); notes.push(msg('reuse-first', 'create')) }
    if (e.tool === 'AskUserQuestion' && !looked) notes.push(msg('reuse-first', 'ask'))
    if (/(^|__)(update|batch)$/.test(e.tool) && /Docs/i.test(e.tool) && jTurn && questionOnly(asked)) {
      docEdited = true
      if (!qeFired) { qeFired = true; notes.push(msg('question-edit')) }
    }
    if (!exempt(e.tool)) {
      count += 1
      if (!midSeen && count >= LIMIT + 1 && !turnFired && !handoffTurn && !finishing(e as Record<string, unknown>)) {
        turnFired = true
        notes.push(TURN_MSG)
      }
    }
    if (startsWork(e as unknown as Record<string, unknown>)) work += 1
    if (e.agentId === undefined && e.tool !== 'SendUserMessage') toolN += 1 // W14 work size (denied calls returned above)
    if (jTurn && !replied && !EARLY_OPEN.has(e.tool)) earlyN += 1 // W23 (main thread: subagent calls returned above)
    // 0.6.0: event triggers in place of the 8-call silence count and the 4th-call count.
    if (e.tool === 'SendUserMessage') {
      replied = true
      if (e.agentId === undefined && String((e as Record<string, unknown>).message ?? '').trim() !== '') { const r = takeReply(); await statsReply($, r.w, r.c, r.g, r.w, { tools: toolN, at: r.at, tier: r.tr, words: wordCount((e as Record<string, unknown>).message) }) } // 0.6.33: allowed through (a denied send returned above)
      if (stopBlocked.size > 0) stopChainDone = true // 0.6.29: the re-check's correction went out: the chain ends here
      midQ = sendable ? midQ.filter(m => m.seq > seenSeq) : [] // answered: every message the model had seen; a later one stays pending (nudge-only sessions: all, as before)
      midPending = midQ.length > 0
      midDenied = 0
    }
    else if (!handoffTurn && !exempt(e.tool) && !finishing(e as Record<string, unknown>)) {
      if (midPending && !midFired) { midFired = true; notes.push(msg('mid-turn')) }
      else if (jTurn && !replied && !firstFired && startsWork(e as unknown as Record<string, unknown>)) { firstFired = true; notes.push(msg('first-reply')) }
    }
    let resend: Awaited<ReturnType<typeof resendNotes>> | undefined
    if (e.tool === 'SendUserFile') { resend = await resendNotes($, e as unknown as Record<string, unknown>).catch(() => undefined); if (resend) notes.push(...resend.notes) }
    const timed = e.tool === 'Bash' && e.run_in_background !== true
    if (timed && rx('long-bash', 'hint').test(String(e.command ?? ''))) notes.push(msg('long-bash', 'hint'))
    if (e.tool === 'Bash' && !idleFired && removesLedger(e.command)) {
      idleFired = true
      notes.push(msg('idle-guard'))
    }
    if (!stampFired && ARTIFACT_DATA.test(e.tool)) {
      const miss = staleStamp(e)
      if (miss !== undefined) {
        stampFired = true
        notes.push(miss)
      }
    }
    if (turnInputs.length < 400_000) turnInputs += ` ${JSON.stringify(e)}`
    if (e.agentId === undefined) { // 0.6.21 auto-evidence digest for the judge (each field cut to 300 chars)
      const x = e as Record<string, unknown>, cut = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
      if (AGENT_TOOLS.has(e.tool)) { agentLaunches.push(`${cut(x.description)} (model ${cut(x.model) || 'default'})`); if (agentLaunches.length > 20) agentLaunches.shift() }
      else if (e.tool === 'SendMessage') turnSends.push(`SendMessage: ${cut(x.message)}`)
      else if (SAVE_TOOL.test(e.tool) && !/propose_skills$/.test(e.tool)) turnSends.push(`${e.tool.replace(/^.*__/, '')} ${cut(x.path)}: ${x.old_str !== undefined || x.new_str !== undefined ? `old "${cut(x.old_str)}" -> new "${cut(x.new_str)}"` : cut(x.content ?? x.text)}`)
    }
    if (WRITE_TOOLS.has(e.tool)) acted = true
    if (e.agentId === undefined && savesClaudeWide(e as unknown as Record<string, unknown>)) savedWide = true
    if (WRITE_TOOLS.has(e.tool) || LANDING_TOOL.test(e.tool)) landed = true
    if (e.agentId === undefined) { const cn = await takeCompactNote($); if (cn !== undefined) notes.push(cn) }
    const startedAt = timed ? await nowMs($) : 0
    const ran = await next(e)
    const endedAt = timed ? await nowMs($) : 0
    if (e.agentId === undefined && !READ_ONLY_TOOL.test(e.tool) && e.tool !== CHECK_TOOL && e.tool !== 'SendUserMessage') { // 0.6.22 generic auto-evidence (a denied or errored call counts: a later retry that succeeded is visible)
      const { tool: _t, agentId: _a, tool_use_id: _u, ...inp } = e as Record<string, unknown>
      const rs = String(ran.deny !== undefined ? ran.deny : ran.text ?? (typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? ''))).replace(/\s+/g, ' ').trim().slice(0, 200)
      turnActs.push(`[${sgtIso(await nowMs($)).slice(5, 16)}] ${e.tool.replace(/^.*__/, '')} ${JSON.stringify(inp).slice(0, 200)} -> ${ran.deny !== undefined ? 'denied' : ran.isError ? 'errored' : 'ok'}: ${rs}`)
      if (turnActs.length > 30) turnActs.shift()
    }
    if (timed) {
      const took = (endedAt - startedAt) / 1000
      if (took >= num('long-bash', 'maxSeconds')) notes.push(msg('long-bash', 'took', { n: Math.round(took) }))
    }
    if (resend && ran.deny === undefined && !ran.isError) await resend.commit()
    if (ran.deny === undefined && !ran.isError) {
      if (scripts(e.tool)) scripted = true
      if (e.agentId === undefined) {
        const rt = String(ran.text ?? (typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? '')))
        await rec($, mode, e.tool === 'SubagentHandback' ? 'agent' : 'tool', e.tool === 'SubagentHandback' ? 'hand-back' : e.tool, e.tool === 'SubagentHandback' ? String((e as Record<string, unknown>).message ?? rt) : rt).catch(() => undefined)
      }
      turnResults = `${turnResults} [${e.tool}${inputDigest(e as unknown as Record<string, unknown>)}] ${String(ran.text ?? (typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? ''))).slice(0, 1500)}`.slice(-6000)
      if (turnCorpus.length < 1_500_000) turnCorpus += ` ${JSON.stringify(e)} ${ran.text ?? (typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? ''))}`.slice(0, 400_000)
      if (seenNums.size < 20000) {
        const t = `${JSON.stringify(e)} ${ran.text ?? (typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? ''))}`
        for (const n of numbersIn(t.slice(0, 400_000))) seenNums.add(n)
      }
      if (writes(e.tool)) wrote = true
      if (readsBack(e as unknown as Record<string, unknown>)) unread = false
      else if (startsWork(e as unknown as Record<string, unknown>)) unread = true
      if (looksUp(e.tool)) looked = true
      anyTool = true
      if (e.agentId === undefined && evidenceCall(e as unknown as Record<string, unknown>)) evTool = true
      if (e.agentId === undefined && realChange(e as unknown as Record<string, unknown>)) changed = true
      if (e.agentId === undefined && e.tool !== CHECK_TOOL && acts.length < 400) acts.push(...actsOf(e as unknown as Record<string, unknown>, String(ran.text ?? (typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? '')))))
      if (/^(WebSearch|WebFetch)$|__(get_page_text|read_page)$/.test(e.tool) && webText.length < 200_000) webText += ` ${ran.text ?? (typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? ''))}`
      if (e.agentId === undefined) { const bl = liveJobsOf(e as unknown as Record<string, unknown>, String(ran.text ?? (typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? '')))); if (bl !== undefined) boardLive = bl }
      if (ARTIFACT_DATA.test(e.tool) && ['set', 'update', 'batch'].includes(String((e as Record<string, unknown>).action))) {
        boarded = true
        if (boardWrite(e as unknown as Record<string, unknown>)) boardRow = true
        if (e.agentId === undefined) await corrAbsorb($, e as unknown as Record<string, unknown>, String(ran.text ?? (typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? ''))), false).catch(() => 0) // W13: the relayed flush
        await corrFlush($).catch(() => 0) // the session's own write just passed the check: queued rows can follow
      }
      if (AGENT_TOOLS.has(e.tool) || editsLedger(e as unknown as Record<string, unknown>)) {
        dispatched = true
        chatDispatched = await $.session.id()
      }
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
    } finally {
      if (e.agentId === undefined) seenSeq = midSeq
      if (ckT0 > 0 && replyWaits.length > 0) checkAcc += Math.max(0, (await nowMs($)) - ckT0)
    }
  }).catch(async ($, e, next) => {
    if (e.tool === CHECK_TOOL) {
      await Promise.resolve().then(async () => {
        const log = await $.store.get(DENY_LOG_KEY)
        await $.store.set(DENY_LOG_KEY, [...(Array.isArray(log) ? log : []), { time: sgtIso(await nowMs($)), session: await $.session.id(), n: 0, error: 'check_reply', checks: [] }].slice(-500))
      }).catch(() => undefined)
      return { result: 'PASS (check error, fail-open)' }
    }
    return next(e)
  })

  // End of the main turn: never blocks or re-prompts. At most one line beneath the answer (an
  // unproven "(running" claim, or an idle claim with no ledger check), handed to the model once
  // with the next prompt so it acts on it then.
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined) {
      await close($, [e.agentId])
      return ran
    }
    inTurn = false
    if (e.reason === 'answer' && String(e.answer ?? '').trim() !== '') { delivered.push(String(e.answer).slice(0, 3000)); if (delivered.length > 5) delivered.shift(); replyDelivered(String(e.answer)) }
    midPending = false
    if (e.reason !== 'answer') { // 0.6.10: an aborted/limited turn still ends the previous turn's window
      const aborted = (e as Record<string, unknown>).isAborted === true || /abort|interrupt|cancel/i.test(String(e.reason ?? ''))
      if (aborted && replyWaits.length > 0) { const r = takeReply(); await statsReply($, r.w, r.c, r.g, r.w, { tools: toolN, at: r.at, tier: r.tr, words: 0, stopped: true }) } // W23: J stopped it before any visible reply
      const refired = new Set(firedTurn)
      firedTurn.clear()
      void settle($, { facing: sentText.join('\n\n'), board: boardRow, write: acted || landed || wrote, launch: proof, guard: fromGuard, answered: false }, refired)
      return ran
    }
    await rec($, mode, 'reply', '', String(e.answer ?? '')).catch(() => undefined) // 0.6.18: earlier turns' statements stay visible to the judge
    lastFacing = [...priorFacing, ...sentText, String(e.answer ?? '')].filter(t => t.trim() !== '') // 0.6.25: kept across a chain of continuations
    // 0.6.16: deep mode's final reply is the draft check_reply passed; a final text with no matching PASS this turn is logged (never blocked).
    const finalText = String(e.answer ?? '').trim() !== ''
    const isDeep = jTurn && sendOk && finalText && (await readMode($, mode)) === 'deep'
    const skipDeep = isDeep && finalPassed.has(replyHash(e.answer)) // already checked pre-send by the same checks: no double count, no carry line
    if (isDeep) await queueVersionRow($) // 0.6.29: first deep J turn on a new version writes its Scoreboard fixes row
    if (skipDeep) markLines(e.answer)
    if (isDeep && !skipDeep) {
      await Promise.resolve().then(async () => {
        const log = await $.store.get(DENY_LOG_KEY)
        await $.store.set(DENY_LOG_KEY, [...(Array.isArray(log) ? log : []), { time: sgtIso(await nowMs($)), session: await $.session.id(), n: 0, final: skipJudge(String(e.answer ?? ''), asked) ? 'short' : 'unchecked', checks: [] }].slice(-500))
      }).catch(() => undefined)
    }
    if (!jTurn && stopBlocked.size > 0 && finalText && sendOk) await statsReply($, [], 0, false, [], { tools: toolN, words: wordCount(e.answer) }) // 0.6.33: the guard-started continuation of a Stop re-check: its final text is the last J-visible message of the prompt
    // W23: a final text outside the deep J-turn path below (an agent/notification turn's text, light mode) also ends the wait, so the next J prompt
    // never books it as stopped_by_j; it is recorded as the reply in deep mode, dropped (as before) otherwise.
    const deepNow = sendOk && (await readMode($, mode)) === 'deep'
    if (finalText && replyWaits.length > 0 && !(jTurn && deepNow)) { const r = takeReply(); if (deepNow) await statsReply($, r.w, r.c, r.g, r.w, { tools: toolN, at: r.at, tier: r.tr, words: wordCount(e.answer) }) }
    if (jTurn && sendOk && (await readMode($, mode)) === 'deep') {
      who ??= await sessionWho($)
      const seen = countedUnchecked.has(replyHash(String(e.answer ?? ''))) // 0.6.28: already counted at its Stop
      if (finalText) { const r = takeReply(); await statsReply($, r.w, r.c, r.g, r.w, { tools: toolN, at: r.at, tier: r.tr, words: wordCount(e.answer) }) } // 0.6.33: nothing went out mid-turn: the final text is the first reply
      await statsTurnEnd($, epoch, !finalText ? 'none' : skipJudge(String(e.answer ?? ''), asked) ? 'short' : skipDeep || seen ? 'none' : 'unchecked', turnT0 > 0 ? await nowMs($) - turnT0 : 0, who)
    }
    let line: string | undefined
    if (rx('running-proof','claim').test(e.answer) && unproven(e.answer, proof || (await openCount($)) > 0)) line = msg('running-proof')
    else if (!idleFired && idleClaim(e.answer)) line = msg('idle-guard')
    // miss-landing wins over parked-fix: a turn gets at most one of the two lines.
    if (!skipDeep && missUnlanded(e.answer, proof || landed)) line = msg('miss-landing')
    else if (line === undefined && !skipDeep && live('parked-fix') && parkedFix(e.answer, proof || acted)) line = msg('parked-fix')
    else if (line === undefined && !skipDeep && efficiencyFix(e.answer, proof || acted || landed || wrote)) line = msg('parked-fix')
    let continued = false
    if (line === msg('idle-guard')) {
      idleFired = true
      // Idle claim with nothing open: one continuation turn, never from the guard's own turn.
      if (!fromGuard && (await openCount($)) === 0) {
        submitted = true
        void $.prompt.submit({ text: idlePrompt() })
        continued = true
      }
    }
    const extra: string[] = []
    // 0.6.21 save-gate (reply half): a deep-mode final reply long enough to need check_reply that no PASS matched. Logged dark; one short carry line only when live.
    if (isDeep && !skipDeep && !skipJudge(String(e.answer ?? ''), asked) && num('save-gate', 'enforce') > 0) {
      const live2 = num('save-gate', 'enforce') >= 2
      await Promise.resolve().then(async () => { const log = await $.store.get(DENY_LOG_KEY); await $.store.set(DENY_LOG_KEY, [...(Array.isArray(log) ? log : []), { time: sgtIso(await nowMs($)), session: await $.session.id(), n: 0, ...(live2 ? {} : { dark: true }), checks: ['unchecked-reply'] }].slice(-500)) }).catch(() => undefined)
      if (!live2) await statsDark($, [{ id: 'unchecked-reply', snip: String(e.answer ?? '').slice(0, 160) }])
      if (live2) extra.push(msg('save-gate', 'miss'))
    }
    if (!skipDeep && line !== msg('idle-guard') && offers(e.answer, askTool)) extra.push(msg('offer-guard'))
    const [n, m] = live('verify-proof') ? unverified(e.answer) : [0, 0]
    if (n + m > 0) extra.push(verifyMsg(n, m))
    if (!skipDeep && !wrote && promises(e.answer)) extra.push(msg('promise-proof'))
    if (!skipDeep && unsavedPromise(e.answer, savedWide, asked)) extra.push(msg('unsaved-promise'))
    if (live('board-dispatch') && dispatched && !boarded) extra.push(msg('board-dispatch'))
    if (finishedNote && !boardRow) extra.push(msg('finish-row'))
    const sid = await $.session.id()
    if (chatDispatched === sid && (await $.state.get(remindedSession)).value === sid && (await $.state.get(orchLoaded)).value !== sid
      && (await $.state.get(orchNagged)).value !== sid && !(await cardInChat($))) {
      await $.state.set(orchNagged, sid)
      extra.push(msg('orchestrator-proof'))
    }
    if (yesNoQuestion(asked) && !answersFirst(e.answer)) extra.push(msg('answer-first'))
    if (live('lookup-first') && !looked && unknowns(e.answer)) extra.push(msg('lookup-first'))
    if (rawEta([...sentText, e.answer].join('\n\n'))) extra.push(msg('eta-proof')) // 0.6.21: SendUserMessage texts count too
    if (missingChecked(asked, e.answer)) extra.push(msg('checked-line'))
    if (!skipDeep && !anyTool && openQuestions(e.answer, asked).length > 0) extra.push(msg('open-question'))
    if (!skipDeep && !looked && absoluteClaims(e.answer, asked).length > 0) extra.push(msg('unbacked-absolute')) // 0.6.11: no lookup tool this turn
    const dangling = skipDeep ? [] : danglingRefs(e.answer, saidIn(sid), webText) // 0.6.25: a passed reply had this check pre-send
    if (dangling.length > 0) extra.push(danglingMsg(dangling))
    if (jTurn && !qeFired && redrafts(asked, e.answer, docEdited)) extra.push(msg('question-edit'))
    if (reasks(asked) && !rx('reask-guard','ok').test(e.answer)) extra.push(msg('reask-guard'))
    const long = live('style') ? longPoints(e.answer) : 0
    if (long > 0) {
      // 0.6.3 style escalation: the second flag in one chat (and every later one) swaps in the stronger line and owes a Correction: line next turn.
      const key = `styleFlags:${sid}`
      const stored = Number(await Promise.resolve().then(() => $.store.get(key)).catch(() => undefined)) || 0
      const before = Math.max(stored, styleSeen.get(sid) ?? 0)
      styleSeen.set(sid, before + 1)
      await Promise.resolve().then(() => $.store.set(key, before + 1)).catch(() => undefined)
      if (before > 0) { extra.push(styleEscMsg()); styleOwed = true } else extra.push(styleMsg(long))
    }
    const held = askAt ?? (knowableAsks(e.answer, early).length > 0 ? work : undefined) // 0.6.10: knowable asks only
    if (held !== undefined && held >= num('ask-first', 'minCalls')) extra.push(msg('ask-first', 'line', { n: held }))
    if (buriedAsks(e.answer) > 0) extra.push(msg('ask-standout'))
    const hits = addedHits('answer', stripDrafts(e.answer, asked)).filter(h => !(skipDeep && h.id === 'closure-status')) // 0.6.25: no second firing on a passed reply
    extra.push(...hits.map(h => h.message))
    // 0.6.0 J-facing text of the turn: the answer plus every SendUserMessage.
    const facing = [...sentText, e.answer].join('\n\n')
    if (live('leap-line') && jTurn && missingLeap(facing)) extra.push(msg('leap-line'))
    if (live('done-claim') && unread && rx('done-claim', 'claim').test(facing)) extra.push(msg('done-claim')) // once: one end-of-turn pass
    if (live('arith-proof') && !scripted && uncomputed(facing, seenNums).length > 0) extra.push(msg('arith-proof'))
    // 0.6.14 ported answer checks (drafts, code and quotes excluded). stop-dates, page-cite: one line; DARK ids: logged only.
    const said = facing
    const darkIds: string[] = []
    const wd = weekdayMismatches(said, asked)
    if (!skipDeep && wd.length > 0) extra.push(msg('stop-dates', 'line', { list: wd.join('; ') }))
    const pc = unopenedPageCites(said, `${asked} ${turnInputs} ${turnCorpus.slice(0, 20_000)}`, asked)
    if (skipDeep) { /* pre-send check ran the Correction/Prevention/Why lines */ } else if (correctionWithoutPrevention(said, asked)) extra.push(msg('prevention-line'))
    else if (preventionWithoutWhy(said, asked)) extra.push(msg('prevention-line', 'why'))
    if (pc.length > 0) extra.push(msg('page-cite', 'line', { list: pc.slice(0, 4).join(', ') }))
    if (!skipDeep && (anyTool || !jTurn) && unsourcedFigures(said, `${corpus} ${turnCorpus}`, asked).length > 0) darkIds.push('stop-figures')
    if (!skipDeep && unsourcedBullets(said, asked) >= 3) darkIds.push('stop-sources')
    if (!skipDeep && jTurn && !(acted || landed || wrote) && writeClaims(said, asked).length > 0) darkIds.push('stop-writes')
    const darkLive = darkIds.filter(id => !DARK.has(id))
    for (const id of darkLive) extra.push(msg(id, 'line', { list: id === 'stop-writes' ? writeClaims(said, asked)[0] : unsourcedFigures(said, `${corpus} ${turnCorpus}`, asked).slice(0, 4).join(', '), n: unsourcedBullets(said, asked) }))
    const darkLogged = darkIds.filter(id => DARK.has(id))
    const nonPrev = nonPreventions(facing)
    if (nonPrev > 0) {
      const key = `${NONPREV_KEY}:${sid}`
      const stored = Number(await Promise.resolve().then(() => $.store.get(key)).catch(() => undefined)) || 0
      const before = Math.max(stored, nonPrevSeen.get(sid) ?? 0)
      if (before > 0 || nonPrev > 1) extra.push(msg('repeat-miss'))
      nonPrevSeen.set(sid, before + nonPrev)
      await Promise.resolve().then(() => $.store.set(key, before + nonPrev)).catch(() => undefined)
    }
    // 0.6.0 source-addendum: an unsourced-claim miss after the reply went out → one continuation: a short addendum
    // with the missing source(s), never a redo. Once per turn; never from the guard's own turn or a turn already continued.
    const unsourced = live('source-addendum') && (n > 0 || hits.some(h => rx('source-addendum', 'ids').test(h.id)))
    if (unsourced && !fromGuard && !continued && !submitted) {
      submitted = true
      continued = true
      void $.prompt.submit({ text: `${GUARD_TAG} ${msg('source-addendum', 'prompt')}` })
    }
    // 0.6.3 style escalation owes a Correction: line: a carry line for the next prompt (0.6.16: no forced turn).
    if (live('style') && styleOwedNow && jTurn && !fromGuard && !CORRECTION_LINE.test(facing)) extra.push(`${styleEscMsg()} — add a Correction: line naming the fix.`)
    // 0.6.1 requires: a prompt→answer check shipped as pack data. J's prompt (`asked`) matched an `on: prompt` add that has
    // `requires`, and no J-facing line of this turn matches it → the add's message as a carry line (0.6.16: no forced turn).
    if (jTurn && !fromGuard) {
      const unmet = RULES.add.find(a => a.on === 'prompt' && live(a.id) && a.requires !== undefined && a.re.test(asked) && !a.requires.test(facing))
      if (unmet !== undefined) extra.push(unmet.message)
    }
    const all = [...(line === undefined ? [] : [line]), ...extra].join(' ')
    // 0.6.10: settle the previous turn's firing rows (evidence from this turn), then log this turn's end firings (ends 1).
    const endIds = all === '' ? [] : firedIn(all)
    const refired = new Set([...firedTurn, ...endIds])
    firedTurn.clear()
    const facts: TurnFacts = { facing, board: boardRow, write: acted || landed || wrote, launch: proof, guard: fromGuard, answered: true }
    void settle($, facts, refired)
    if (darkLogged.length > 0) {
      void hookLog($, darkLogged, 1)
      await statsDark($, darkLogged.map(id => ({ id, snip: id === 'stop-writes' ? writeClaims(said, asked)[0] : id === 'stop-figures' ? unsourcedFigures(said, `${corpus} ${turnCorpus}`, asked).slice(0, 4).join(', ') : 'three or more bullets with a date or amount and no source' })))
    }
    void hookLog($, endIds, 1) // both join the pending chain now, in this order
    if (all === '') return ran
    if (!continued || all !== msg('idle-guard')) carry = all
    return { ...ran, text: all }
  }).catch(($, e, next) => next(e))
}
