import type { EngineInterface, Register } from 'claude-code'

// Ports of three review items (Tooling Port Review S6, S7, S23 "re-inject after compaction"). Separate file so it merges into
// dispatch-guard with two lines in register.ts (import + `registerGuards(on)` first thing in `register`); the engine loads one
// hooks module per plugin, so it cannot be a second entry in hooks.json.
// Warn-only (J's rule: hooks never block or force a redo): S6/S7 add a one-line context warning on the tool call, once per target, never deny.

// --- S6: python-docx `.text` reads of Word drafts drop tracked insertions -----------------------------------------------
const DOCX_IMPORT = /\bfrom\s+docx\s+import\b|\bimport\s+docx\b/
const DOT_TEXT = /\.text\b/
const DOCX_TARGET = /\.docx\b|\bDocument\s*\(/
const APPROVED_READER = /docx_tool\.py|docx_core|legal-kit/
export const blindDocxRead = (cmd: string): boolean =>
  DOCX_IMPORT.test(cmd) && DOT_TEXT.test(cmd) && DOCX_TARGET.test(cmd) && !APPROVED_READER.test(cmd)
export const DOCX_MSG = 'Word drafts: read via legal-kit `docx_tool.py read FILE` (shows tracked [+ins+]/[-del-]); python-docx .text drops tracked insertions. Ignore this if the command is not reading a draft\'s content.'
// Target of a docx read = the .docx names in the command (else the command's first 80 chars).
export const docxTarget = (cmd: string): string => (cmd.match(/[\w./~-]+\.docx\b/g) ?? [cmd.slice(0, 80)]).join(',')

// --- S7: uploaded files are someone's original: never write, move or delete them in place ------------------------------
export const UPLOADS = '/mnt/user-data/uploads'
const UP = UPLOADS.replace(/[/.-]/g, m => `\\${m}`)
const QUOTES = /'[^'\n]*'|"[^"\n]*"/g
// Keep quoted spans that hold a path (bundle rule: quoted text with a slash is kept), blank the rest.
const unquote = (s: string): string => s.replace(QUOTES, q => (q.includes('/') ? q.slice(1, -1) : ' '))
const SEG = /\|\||&&|;|\n|\|/
const WRITE_SEG = new RegExp(
  [
    `>>?\\s*${UP}\\/`, // redirect into uploads
    `\\btee\\b[^\\n]*${UP}\\/`,
    `\\bsed\\b[^\\n]*\\s-i[^\\n]*${UP}\\/`,
    `\\b(?:rm|truncate|shred|unlink)\\b[^\\n]*${UP}\\/`,
    `\\bmv\\b[^\\n]*${UP}\\/`, // moving from OR into uploads removes/overwrites an original
    `\\bcp\\b[^\\n]*\\s${UP}\\/\\S*\\s*$`, // cp whose LAST argument is under uploads (copying out is fine)
    `\\.save\\(\\s*['"]?${UP}\\/`,
    `open\\(\\s*['"]${UP}\\/[^'"]*['"]\\s*,\\s*['"][wa]`,
    `--out(?:put)?[= ]['"]?${UP}\\/`,
  ].join('|'),
)
export const writesUpload = (tool: string, input: Record<string, unknown>): boolean => {
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const p = String(input.file_path ?? input.notebook_path ?? '')
    return p === UPLOADS || p.startsWith(`${UPLOADS}/`)
  }
  if (tool !== 'Bash') return false
  return unquote(String(input.command ?? '')).split(SEG).some(seg => WRITE_SEG.test(seg))
}
export const UPLOAD_MSG = `Uploaded file = someone's original: work on a copy under /mnt/user-data/outputs or the scratchpad, unless this change to the upload is intended.`
// Target of an upload write = the upload path(s) in the call (else the call's tool name).
export const uploadTarget = (tool: string, input: Record<string, unknown>): string => {
  if (tool !== 'Bash') return String(input.file_path ?? input.notebook_path ?? tool)
  return (String(input.command ?? '').match(new RegExp(`${UP}\\/[^\\s'"]*`, 'g')) ?? [tool]).join(',')
}

// --- S23: after a compaction, point the next prompt back at the card and the handoff ------------------------------------
export const COMPACT_MSG = 'Context was compacted: if the summary lacks Next/In flight, memory_read this chat\'s /areas/handoffs/ file once (handoff skill) and continue at its Next; re-load the orchestrator skill if its rules are not in the summary.'

const hash = (s: string): string => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(36)
}
const KEY = 'guards.warned' // $.store: hashes of targets already warned about (survives reloads; capped)
const KEEP = 200

export const registerGuards: Register = on => {
  const local = new Set<string>() // fallback when $.store is unreadable

  // Matched per tool: dispatch-guard's own tool.call hook is unmatched, and an event takes one unmatched hook per plugin.
  // Never denies: the call runs, and the first call per target gets a one-line context warning.
  for (const tool of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const input = e as unknown as Record<string, unknown>
      const docx = e.tool === 'Bash' && blindDocxRead(String(input.command ?? ''))
      const up = !docx && writesUpload(e.tool, input)
      if (!docx && !up) return next(e)
      const target = docx ? `docx ${docxTarget(String(input.command ?? ''))}` : `upload ${uploadTarget(e.tool, input)}`
      const k = hash(target)
      const r = await next(e)
      const stored = await Promise.resolve().then(() => $.store.get(KEY)).catch(() => undefined)
      const seen = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []
      if (seen.includes(k) || local.has(k)) return r // once per target
      local.add(k)
      await Promise.resolve().then(() => $.store.set(KEY, [...seen, k].slice(-KEEP))).catch(() => undefined)
      return { ...r, context: [...(r.context ?? []), `dispatch-guard: ${docx ? DOCX_MSG : UPLOAD_MSG}`] }
    }).catch(($, e, next) => next(e)) // a guard failure never blocks
  }

  // After a main-thread compaction the session owes one pointer note. It rides the next main-thread tool result or prompt
  // (takeCompactNote, called from register.ts), not prompt.context: another plugin's prompt.context hook may never call next.
  on('session.compact', async ($, e, next) => {
    const main = e.agentId === undefined && e.trigger !== 'precompute'
    const r = await next(main ? { ...e, instructions: `${e.instructions ?? ''}${COMPACT_KEEP}`.trim() } : e)
    if (main && (r as { skip?: string }).skip === undefined) {
      const sid = await Promise.resolve().then(() => $.session.id()).catch(() => '?')
      owed.add(sid)
    }
    return r
  }).catch(($, e, next) => next(e))
}

const owed = new Set<string>() // session ids owed the post-compaction note
export const COMPACT_KEEP = ' Keep Next, In flight and the /areas/handoffs/<slug> name.'
// Delivers the note once per compaction: the first caller after it gets the text, later ones nothing.
export async function takeCompactNote($: EngineInterface): Promise<string | undefined> {
  if (owed.size === 0) return undefined
  const sid = await Promise.resolve().then(() => $.session.id()).catch(() => '?')
  if (!owed.delete(sid)) return undefined
  return COMPACT_MSG
}
