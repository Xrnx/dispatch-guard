import { expect, test } from 'claude-code/testing'
import { nextAction, nextActions, nextText, closureMisses, claimAhead, actsOf, setRules, type Act, type Problem } from './register'
import { bundledRules } from './rulepack'
import CASES from '../tests/w3-cases'

const act = (tool: string, input: Record<string, unknown> = {}, result = ''): Act[] => actsOf({ tool, ...input }, result)
const HANDOFF = act('mcp__memory__memory_str_replace', { path: '/areas/handoffs/check-reply.md', old_str: 'x', new_str: 'item 3c: judge rejects Prevention: none' })
const QUEUE_EDIT = act('Edit', { file_path: '/home/claude/improve/queue.md', old_string: 'x', new_string: 'agent brief footer: re-check claims' })

// Real lines (AB-0628 dev/holdout drafts and the 13 Nov transcript, tests/w3-cases.json).
test('W3 later: "Next: ... tomorrow" (d16) and a clock time (live 04:39) give send_later with the exact time', async () => {
  setRules(bundledRules())
  const a = nextAction('Next: trend panel on the Scoreboard, tomorrow.', { today: '2026-11-13' })
  expect(a.kind).toBe('later')
  expect(a.call).toMatch(/^send_later\(\{ delay_minutes: 60, message: "trend panel on the Scoreboard, tomorrow\." \}\)$/)
  const b = nextAction('- **Check-in:** check Outlook around 3 pm.', { today: '2026-11-13' })
  expect(b.call).toMatch(/at: "2026-11-13T15:00:00\[Asia\/Singapore\]"/)
  expect(b.close).toMatch(/check-in launched \(send_later, 15:00 SGT\)/)
  expect(nextAction("Estimated around 14:05. I'll send it here when it's done.", {}).kind).toBe('later')
})

test('W3 plan: a handoff item standing in for the prevention (h02/h15) gives an Agent launch with the handoff as brief', async () => {
  setRules(bundledRules())
  const a = nextAction('**Prevention:** added item 3c to the check-reply handoff. The judge must reject "Prevention: none" unless it names a blocker.', { acts: HANDOFF })
  expect(a.kind).toBe('plan')
  expect(a.call).toMatch(/^Agent\(\{ run_in_background: true, description: "build: /)
  expect(a.call).toMatch(/brief: \/areas\/handoffs\/check-reply\.md/)
  // a job already launched this turn: no new call, only the closing words
  const b = nextAction('- **Prevention (requested, not built):** I\'ve asked the 0.6.25 builder to move the Stop hook checks.', { acts: act('SendMessage', { to: 'aee24e3e', message: 'move the checks' }, 'sent') })
  expect(b.call).toMatch(/^none: aee24e3e was launched this turn/)
})

test('W3 offer, idea, hindsight, claim: each gets its own call and ending', async () => {
  setRules(bundledRules())
  expect(nextAction('Prevention: Scoreboard corrections row logged; preferences can\'t be edited from here, so paste this into a regular chat:', {}).kind).toBe('offer')
  const l = nextAction('**Leap:** have plugin assign category at write time — removes triage backlog entirely.', {})
  expect(l.kind).toBe('idea')
  expect(l.call).toMatch(/^Agent\(/)
  expect(nextAction('**Efficiency:** I should have said "building now" in the last reply instead of naming the handoff.', {}).kind).toBe('hindsight')
  const c = nextAction('- **Prevention:** done in my agent-brief template: every reported number must say what it counts.', { acts: QUEUE_EDIT, claim: true })
  expect(c.kind).toBe('claim')
  expect(c.call).toMatch(/this turn wrote: \/home\/claude\/improve\/queue\.md/)
})

test('W3 nextActions: maps closure-line snippets and judge (c)/(e) quotes to draft lines; skips a judge (c) lookup item', async () => {
  setRules(bundledRules())
  const draft = 'Done.\n- **Spare tokens:** I\'ll add agents here when a phase has independent parts.\n- **Caveat:** live pack coverage unverified.\n**Leap:** have the Idle guard triage placeholder rows.'
  const probs: Problem[] = [
    { id: 'judge', text: 'judge: (e) "Spare tokens: I\'ll add agents here when a phase has independent parts" states a future behaviour change' },
    { id: 'judge', text: 'judge: (c) "live pack coverage unverified" — the assistant could check pack coverage itself' },
    { id: 'closure-line', text: 'Close each fix line: ... "**Leap:** have the Idle guard triage placeholder rows." (no closure)' },
    { id: 'judge', text: 'judge: (b) "Done." has no evidence' },
  ]
  const na = nextActions(probs, draft, {})
  expect(na.map(x => x.map(a => a.kind))).toEqual([['later'], [], ['idea'], []])
  expect(nextText(na[0])).toMatch(/^Next action per undone line \(make the call, then end the line as shown\): a\) "Spare tokens: I'll add agents/)
})

// Corpus: the 27 AB-0628 "W" drafts + 13 live work-left-undone denials. "Fixed first time" = the one redraft deep-cap 1 allows, made by running every
// named call and ending each named line as shown, clears closure-line and claim-ahead on those lines, and no flagged line was left without an action
// (kind 'effect' = no exact action). The judge is not re-run on the redraft (at the cap it is skipped live too).
const probsOf = (fail: string): Problem[] => fail.replace(/^Deep mode:[^:]*?(?:\(\d+\/\d+\):|\.)\s*/, '').split(/\s\d\)\s/).map(t => t.replace(/^\d\)\s*/, '').trim()).filter(Boolean)
  .map(t => ({ id: /^judge:/.test(t) ? 'judge' : /^Close each fix/.test(t) ? 'closure-line' : /^Claim ahead/.test(t) ? 'claim-ahead' : 'other', text: t }))
const simulate = (draft: string, acts0: Act[], as: { line: string; kind: string }[]): boolean => {
  let text = draft; const acts = [...acts0]; const nls: string[] = []
  for (const a of as) {
    let nl = a.line
    if (a.kind === 'plan' || a.kind === 'idea') { acts.push(...act('Agent', { description: 'build', prompt: a.line }, 'Async agent launched: a1')); nl = `${a.line} — requested; build agent running (launched this turn)` }
    else if (a.kind === 'later') { acts.push(...act('mcp__claude-code-remote__send_later', { message: a.line, delay_minutes: 60 }, 'scheduled')); nl = `${a.line} — check-in launched (send_later, 60 min)` }
    else if (a.kind === 'offer' || a.kind === 'claim') { acts.push(...act('Edit', { file_path: '/x/rule-w3.md', old_string: 'a', new_string: a.line })); nl = `${a.line.replace(/\b(?:done|saved|built|written)\s+(?:in|to|into|at|under)\s+[^,;.()—]+/i, '')} — done in rule-w3.md` }
    else if (a.kind === 'hindsight') nl = `${(/^[\s>*_+•-]*(?:\*\*)?\s*(\w+)/.exec(a.line) ?? ['', 'Efficiency'])[1]}: the first draft lacked the step this line names.`
    text = text.replace(a.line, nl); nls.push(nl)
  }
  const f = { acts, launch: acts.some(x => x.kind === 'launch'), changed: acts.some(x => x.kind === 'write' && x.hay.trim() !== x.tgt.trim()) }
  const bad = [...closureMisses(text, f), ...claimAhead(text, f)].map(([l]) => l.trim().slice(0, 40))
  return !bad.some(b => nls.some(n => n.trim().startsWith(b)))
}
test('W3 corpus: real work-left-undone drafts, how many the denial would have fixed in the one redraft', async () => {
  setRules(bundledRules())
  const rows: string[] = []
  let covered = 0, fixed = 0, w = 0
  for (const c of CASES as { id: string; fail: string; draft: string; calls: Record<string, unknown>[] }[]) {
    w += 1
    const acts = c.calls.flatMap(x => actsOf(x, 'ok'))
    const probs = probsOf(c.fail)
    const na = nextActions(probs, c.draft, { acts, today: '2026-11-13' })
    const flat = na.flat()
    const wProbs = probs.filter(p => p.id === 'closure-line' || p.id === 'claim-ahead' || /^judge:\s*\([eg]\)/.test(p.text) || (/^judge:\s*\(c\)/.test(p.text) && !/\b(?:could (?:check|read|look|verify|grep|confirm)|look(?:s|ed)? (?:it |this |that )?up|lookup|unverified|unconfirmed|read (?:the|it|its))\b/i.test(p.text)))
    const allMapped = wProbs.every(p => (na[probs.indexOf(p)] ?? []).length > 0)
    const ok = flat.length > 0 && allMapped && flat.every(a => a.kind !== 'effect') && simulate(c.draft, acts, flat)
    if (flat.length > 0) covered += 1
    if (ok) fixed += 1
    rows.push(`${ok ? 'FIX ' : flat.length > 0 ? 'PART' : 'MISS'} ${c.id} w=${wProbs.length} kinds=${flat.map(a => a.kind).join(',')}`)
  }
  console.log(`W3 corpus: ${w} cases, covered ${covered}, fixed-first-redraft ${fixed}\n${rows.join('\n')}`)
  expect(w).toBe(40)
  expect(fixed).toBeGreaterThan(0)
})

// Held-out (written before any tuning on it; a shape absent from the corpus): an unlabelled-elsewhere "Follow-up:" line waiting on CI, quoted by judge (c).
test('W3 held-out: a "Follow-up:" line waiting on CI', async () => {
  setRules(bundledRules())
  const draft = 'Fixed the cache key.\n- **Follow-up:** open a PR to drop the stale cache once CI is green.'
  const na = nextActions([{ id: 'judge', text: 'judge: (c) "Follow-up: open a PR to drop the stale cache once CI is green" is work the assistant could start now' }], draft, {})
  console.log(`W3 held-out: ${JSON.stringify(na)}`)
  expect(na[0].length).toBe(1)
  // Result as first run, kept as the record: no shape matched ("once CI is green"), so the generic 'effect' action, not an exact call. Counted as a held-out miss in RESULT.md.
  expect(na[0][0].kind).toBe('effect')
})
