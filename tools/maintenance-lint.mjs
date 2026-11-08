// Implementation of tools/maintenance-lint (see that wrapper for usage). Plain ESM; imports the rule pack module directly.
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const root = path.resolve(opt('--plugin-root') ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..'))
const memDir = opt('--memory-dir')
const out = []
const say = (s = '') => out.push(s)
let issues = 0
const issue = (s) => { issues++; say('  ISSUE  ' + s) }

const walk = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name), base) : [path.join(d, e.name)])
const mem = new Map() // '/areas/x.md' -> text
if (memDir !== undefined && fs.existsSync(memDir)) for (const f of walk(memDir)) mem.set('/' + path.relative(memDir, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8'))
const existing = new Set(mem.keys())
const idx = opt('--memory-index')
if (idx !== undefined) for (const l of fs.readFileSync(idx, 'utf8').split('\n')) if (l.trim().startsWith('/')) existing.add(l.trim().split(/\s+/)[0])
const names = new Set()
for (const p of existing) names.add(path.basename(p, '.md'))
for (const [, t] of mem) { const m = /^aliases:\s*\[([^\]]*)\]/m.exec(t); if (m) for (const a of m[1].split(',')) names.add(a.trim().toLowerCase()) }

// ---- plugin side texts: cards and the core card
const cardTexts = new Map()
const cdir = path.join(root, 'cards')
if (fs.existsSync(cdir)) for (const f of fs.readdirSync(cdir)) if (f.endsWith('.md')) cardTexts.set('cards/' + f, fs.readFileSync(path.join(cdir, f), 'utf8'))
try { const m = await import(path.join(root, 'hooks/orchestrator-card.ts')); cardTexts.set('hooks/orchestrator-card.ts (CARD)', String(m.CARD)) } catch { /* optional */ }
const allCards = [...cardTexts.values()].join('\n')

// ---- artifact URL list mode
const URL_RE = /https:\/\/claude\.ai\/artifact\/([A-Za-z0-9]+)/g
const urls = new Set()
for (const t of [...mem.values(), ...cardTexts.values()]) for (const m of t.matchAll(URL_RE)) urls.add(m[0])
if (args.includes('--list-urls')) { console.log([...urls].join('\n')); process.exit(0) }

// ---- 1. pointer integrity
const slug = (h) => h.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-')
const headings = (t) => new Set([...t.matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => slug(m[1])))
const MEMPATH = /(?<![\w./-])(\/(?:areas|topics|projects)\/[\w./-]+?\.md|\/preferences\.md|\/profile\.md)(?:#([\w-]+))?(?![\w-])/g
const DIRLIST = /(\/projects\/[\w-]+\/areas\/):\s*([^.()]*?)\s*\(\.md\)/g
const WIKI = /\[\[([^\]#|]+)(?:#([^\]|]+))?\]\]/g
const LINENO = /\b[\w-]+\.(?:ts|js|mjs|py|sh|md):\d+\b|\b[\w-]+\.(?:ts|js|mjs|py|sh|md) (?:l\.?|lines?) ?\d+\b/g
const LOCAL = /\b((?:tools|hooks|cards|scripts|tests|docs)\/[\w.-]+\.\w+)\b/g
const CARDHEAD = /orchestrator card "([^"\n]{3,60})"/g

const scan = (label, text, isMem) => {
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const at = `${label}:${i + 1}`
    for (const m of line.matchAll(MEMPATH)) {
      if (!existing.has(m[1])) issue(`${at} memory path ${m[1]} not found`)
      else if (m[2] && mem.has(m[1]) && !headings(mem.get(m[1])).has(m[2].toLowerCase())) issue(`${at} anchor #${m[2]} not a heading in ${m[1]}`)
    }
    for (const m of line.matchAll(DIRLIST)) for (const n of m[2].split(',').map(s => s.trim()).filter(Boolean)) if (!existing.has(m[1] + n + '.md')) issue(`${at} ${m[1]}${n}.md not found (directory list)`)
    for (const m of line.matchAll(WIKI)) {
      const n = m[1].trim().toLowerCase()
      if (!names.has(n)) issue(`${at} [[${m[1]}]] resolves to no memory file or alias`)
      else if (m[2] && existing.has('/' + n + '.md') && mem.has('/' + n + '.md') && !headings(mem.get('/' + n + '.md')).has(slug(m[2]))) issue(`${at} [[${m[1]}#${m[2]}]] heading not found`)
    }
    for (const m of line.matchAll(LINENO)) issue(`${at} line-number pointer "${m[0]}" (rots on edit; point to a name or heading)`)
    if (isMem && /dispatch-guard/i.test(line)) for (const m of line.matchAll(LOCAL)) if (!fs.existsSync(path.join(root, m[1]))) issue(`${at} plugin path ${m[1]} not found under ${root}`)
    for (const m of line.matchAll(CARDHEAD)) if (!allCards.includes(m[1])) issue(`${at} orchestrator card section "${m[1]}" not found in cards`)
  })
}
say('== 1. Pointer integrity ==')
say(`memory files scanned: ${mem.size}; known paths: ${existing.size}; card files: ${cardTexts.size}`)
for (const [p, t] of mem) scan(p, t, true)
for (const [p, t] of cardTexts) scan(p, t, false)
// artifact URLs
const art = new Map()
const af = opt('--artifacts')
if (af !== undefined) for (const l of fs.readFileSync(af, 'utf8').split('\n')) { const [u, s] = l.trim().split(/\t+/); if (u) art.set(u, (s ?? '').trim()) }
let unchecked = 0
for (const u of urls) { const s = art.get(u); if (s === 'ok') continue; if (s === undefined) unchecked++; else issue(`artifact ${u} -> ${s}`) }
say(`artifact URLs: ${urls.size} (${[...urls].filter(u => art.get(u) === 'ok').length} ok, ${unchecked} unchecked: pass --artifacts)`)
say('local plugin paths: checked only on memory lines that name dispatch-guard')

// ---- 2. duplicate prose rules
const rp = await import(path.join(root, 'hooks/rulepack.ts'))
const reg = fs.readFileSync(path.join(root, 'hooks/register.ts'), 'utf8')
const setOf = (n) => { const m = new RegExp(`${n}[^=]*=\\s*new Set\\(\\[([^\\]]*)\\]`).exec(reg); return new Set(m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : []) }
const OFF = setOf('OFF'), DARK = setOf('DARK')
const norm = (s) => s.toLowerCase().replace(/\{[^}]*\}/g, ' ').replace(/[^a-z0-9()'’:×]+/g, ' ').trim()
const STOP = new Set('the a an of to in on and or with no it is this that for be as at by from'.split(' '))
const ents = []
for (const [id, d] of Object.entries(rp.BUNDLED)) ents.push({ id, msgs: Object.values(d.messages ?? {}) })
for (const a of rp.BUNDLED_ADD) ents.push({ id: a.id, msgs: [a.message] })
// curated keyword groups (every term of a group must appear in the normalised clause) + what the hook does NOT cover
const KW = {
  'answer-first': [[['confidence first']], 'hook: only yes/no questions, checks the opening'],
  'unbacked-absolute': [[['exclusive or superlative']], 'hook: only exclusive/universal words with no tool run this turn'],
  'promise-proof': [[['from now on', 'delete the line']], 'hook: only Efficiency/Prevention/"from now on" lines with no write or dispatch'],
  'parked-fix': [[['never describe and wait']], 'hook: wording patterns for a named-but-unstarted fix'],
  'offer-guard': [[['offer waiting on j']], 'hook: offer phrases with no (needs you) mark'],
  'running-proof': [[['launch id from this turn']], 'hook: "(running" claim with nothing launched'],
  'first-reply': [[['on it, eta']], 'hook: no SendUserMessage before other work'],
  'ask-standout': [[['asks to j: own lines']], 'hook: own-line only; "at the end" and the question-tool preference are not enforced'],
  'held-for-j': [[['never held behind another j step']], 'hook: held-back items reported in the reply'],
  'reask-guard': [[['never flip on pushback']], 'hook: fires only when J re-asks; checks Correction:/confidence label'],
  'correction-prevention': [[['reply line prevention:']], 'hook: only when J\'s prompt is a correction or fix probe'],
  'prevention-line': [[['prevention: none']], 'hook: Correction: line present with no Prevention: line'],
  'checked-line': [[['one line checked:']], 'hook: option asks only; checks the line exists, not that it is true'],
  'orchestrator-proof': [[["skill load 'orchestrator'"]], 'hook: injects the card and flags a missing Skill load; the clause is the fallback instruction'],
  'eta-proof': [[['without e×r']], 'hook: minute ETA stated with no calibration read; the E×R formula itself stays'],
  'leap-line': [[['leap:']], null],
  style: [[['20 words per point']], null],
  'lookup-first': [[['own tools before asking']], null],
}
const fingerprints = (e) => { const sh = new Set(); for (const t of e.msgs) { const w = norm(t).split(' '); for (let i = 0; i + 4 <= w.length; i++) { const g = w.slice(i, i + 4); if (g.filter(x => !STOP.has(x)).length >= 3) sh.add(g.join(' ')) } } return sh }
const sigs = new Map(ents.map(e => [e.id, fingerprints(e)]))
// ids whose hyphenated form is an ordinary word in rule prose: matched by curated keywords only
const GENERIC = new Set(['mid-turn', 'open-question', 'first-reply', 'idle-guard', 'night-nudge'])
const status = (id) => OFF.has(id) ? 'OFF (not enforced)' : DARK.has(id) ? 'DARK (logged only, not shown)' : 'live'

const sources = new Map()
if (mem.has('/preferences.md')) sources.set('/preferences.md', mem.get('/preferences.md'))
for (const [p, t] of cardTexts) sources.set(p, t)
say('')
say('== 2. Prose rules a hook already enforces (report only; memory is never edited) ==')
if (!mem.has('/preferences.md')) say('  note: /preferences.md not in --memory-dir, so only the card was scanned')
const seen = new Set(); let dupes = 0, keep = 0
for (const [file, text] of sources) text.split('\n').forEach((line, i) => {
  for (const cl of line.split(/;\s|\.\s|\s—\s/)) {
    const n = norm(cl)
    if (n.length < 12) continue
    for (const e of ents) {
      const why = []
      if (cl.toLowerCase().includes(e.id) && e.id.includes('-') && !GENERIC.has(e.id)) why.push('check id')
      const g = KW[e.id]; if (g && g[0].some(grp => grp.every(k => n.includes(k)))) why.push('keywords')
      const sh = [...sigs.get(e.id)].filter(x => n.includes(x)); if (sh.length >= 3) why.push(`${sh.length} message phrases`)
      if (!why.length) continue
      const k = `${file}:${i + 1}:${e.id}:${n.slice(0, 40)}`; if (seen.has(k)) continue; seen.add(k)
      const st = status(e.id)
      if (st === 'live') { dupes++; say(`  DELETE? ${file}:${i + 1} [${e.id}; ${why.join(', ')}] "${cl.trim().slice(0, 110)}"${g && g[1] ? `\n          covers: ${g[1]}` : ''}`) }
      else { keep++; say(`  keep    ${file}:${i + 1} [${e.id} is ${st}] "${cl.trim().slice(0, 90)}"`) }
    }
  }
})
say(`suggested deletions: ${dupes}; kept (check off or dark): ${keep}. A partial "covers" note means the hook enforces only that slice: trim the clause to the uncovered rest, do not drop all of it.`)
say('')
say(issues === 0 ? 'RESULT: OK' : `RESULT: FAILED (${issues} issues)`)
console.log(out.join('\n'))
process.exit(issues === 0 ? 0 : 1)
