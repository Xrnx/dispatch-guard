import { expect, test } from 'claude-code/testing'
import { claimAhead, actsOf, liveJobsOf, deepProblems, setRules, logOnly, CHECK_TOOL, type DeepFacts } from './register'
import { bundledRules, mergePack, BUNDLED_VERSION } from './rulepack'

const F: DeepFacts = { asked: '', corpus: '', looked: true, anyTool: true, jTurn: true, acted: true }
const ids = (t: string, f: Partial<DeepFacts> = {}) => deepProblems(t, { ...F, ...f }).map(p => p.id)
const ca = (t: string, acts: any[] = [], extra: Record<string, unknown> = {}) => claimAhead(t, { acts, launch: acts.some(a => a.kind === 'launch'), ...extra })
const act = (tool: string, input: Record<string, unknown> = {}, result = '') => actsOf({ tool, ...input }, result)

// Real DRAFT-REVIEW drafts (main transcript, 13 Nov 2026): a Prevention line claiming "done in my agent-brief ..." is backed only by the queue.md Edit.
const D11 = '- **Prevention:** done in my agent-brief template: every reported number must say what it counts and excludes. Scoreboard row logged.'
const BRIEF_EDIT = act('Edit', { file_path: '/home/claude/improve/queue.md', old_string: 'x', new_string: 'agent brief rules: define every reported metric by what it counts and excludes;' })
const ROW_ONLY = act('ArtifactData', { action: 'set', url: 'https://claude.ai/artifact/9eLvFVYqsp5CwzFY64V3pK', collection: 'corrections', doc_id: 'j-1', data: { fix: 'Prevention: done in my agent-brief template' } })
const D17 = '- **Prevention:** done in my agent-brief rules: before tuning or reporting any measured gap, trace its cause in the mechanism\'s own source. Scoreboard row logged.'
const D18 = 'Next: 0.6.28 zip here when both agents land (running, ETA midday, estimate).'
const D21 = '- **Prevention (requested from the 0.6.28 agent, running, due 11:15):** the hook gathers board status itself. Scoreboard row logged.'

test('claim-ahead: real idx 11/17 flag with an empty or row-only log, pass with the backing Edit', async () => {
  setRules(bundledRules())
  for (const d of [D11, D17]) {
    expect(ca(d, []).length).toBeGreaterThan(0)
    expect(ca(d, ROW_ONLY).length).toBeGreaterThan(0) // a log row quoting the claim never self-certifies it
    expect(ca(d, BRIEF_EDIT)).toEqual([])
  }
})

test('claim-ahead: real idx 18 "(running, ETA ...)" with no tools flags; a live job or a launch passes', async () => {
  setRules(bundledRules())
  expect(ca(D18, []).map(([, w]) => w).join()).toMatch(/running/)
  expect(ca(D18, [], { open: true })).toEqual([])
  expect(ca(D18, act('Agent', { subagent_type: 'general', description: 'build 0.6.28 zip', prompt: 'build' }, 'agentId: a1 started'))).toEqual([])
})

test('claim-ahead: real idx 21 "requested ... running" passes (labelled, agent was messaged)', async () => {
  setRules(bundledRules())
  expect(ca(D21, act('SendMessage', { to: 'a727d0122eb9d3323', message: 'Pre-fetch: hook gathers state itself 0.6.28 agent' }))).toEqual([])
})

test('claim-ahead held-out: "Status: zip built, tests running (ETA 10:30)." with no tools flags built and running; Write + background Bash pass', async () => {
  setRules(bundledRules())
  const t = 'Status: zip built, tests running (ETA 10:30).'
  const w = ca(t, []).map(([, x]) => x).join(' | ')
  expect(w).toMatch(/built/)
  expect(ca('Next: tests running (ETA 10:30).', []).length).toBe(1)
  const acts = [...act('Write', { file_path: '/x/build/dg.zip', content: 'zip' }), ...act('Bash', { command: 'bun test tests &', run_in_background: true }, 'Command running in background with ID: b1')]
  expect(ca(t, acts)).toEqual([])
})

test('claim-ahead real d03: "keep the DPS pass running" flags without a job and passes when one is open', async () => {
  setRules(bundledRules())
  const t = 'Next: keep the overnight DPS pass running so the pace holds.'
  expect(ca(t, []).length).toBeGreaterThan(0)
  expect(ca(t, [], { open: true })).toEqual([])
})

test('claim-ahead exempt phrases: conditionals, negations, durations, past anchors, needs-you, handed-back drafts', async () => {
  setRules(bundledRules())
  for (const t of [
    'Next: see whether it saved the file.',
    'Neither is built yet.',
    'I sent this answer before the check ran.',
    'Next (needs you): upload the zip.',
    'Result: done in about 10 min.',
    'The agent I launched last turn is still on it.',
    'Sent it back to the agent for a redo.',
    'Agent started 09:12, still going.',
    'Each message sent through the tool is checked.',
    'My running job list is empty.',
  ]) expect([t, ca(t, [])]).toEqual([t, []])
})

test('claim-ahead "running" exemption: only a launch this turn or an open job clears it', async () => {
  setRules(bundledRules())
  const t = 'Next: results land soon (running, ETA 10:30).'
  expect(ca(t, []).length).toBeGreaterThan(0)
  expect(ca(t, [], { open: true })).toEqual([])
  expect(ca(t, act('Bash', { command: 'sleep 600; run.sh', run_in_background: true }, 'Command running in background with ID: b2'))).toEqual([])
  expect(liveJobsOf({ tool: 'TaskList' }, 'a1 running build\nb2 completed')).toBe(true)
  expect(liveJobsOf({ tool: 'TaskList' }, 'b2 completed')).not.toBe(true)
})

test('claim-ahead is a deepProblems id and enforce < 2 makes it log-only', async () => {
  setRules(bundledRules())
  expect(ids('Status: zip built, tests running (ETA 10:30).', { acts: [] })).toContain('claim-ahead')
  expect(ids('Status: zip built, tests running (ETA 10:30).', { acts: [], open: true })).toContain('claim-ahead') // "built" still unbacked
  expect(logOnly('claim-ahead')).toBe(false)
  setRules(mergePack({ version: BUNDLED_VERSION + 1, checks: { 'claim-ahead': { numbers: { enforce: 1 } } } } as any))
  expect(logOnly('claim-ahead')).toBe(true)
  setRules(bundledRules())
})

test('footer-first: both Prevention-line misses are reported in one call', async () => {
  setRules(bundledRules())
  const p = deepProblems('Fixed.\nCorrection: the date was wrong.\nPrevention: added a check.', { ...F })
  const t = p.filter(x => x.id === 'prevention-line').map(x => x.text).join('|')
  expect(t).toMatch(/Why you caught it/)
  const q = deepProblems('Correction: the date was wrong.', { ...F }).filter(x => x.id === 'prevention-line')
  expect(q.length).toBeGreaterThan(0)
})

test('footer-first: a closure miss and the parked-fix miss on the same Efficiency line are both reported in one round', async () => {
  setRules(bundledRules())
  const got = ids('Fixed it.\n- **Efficiency:** could add a check next time.\n- **Leap:** none.', { acted: false, acts: [], launch: false })
  expect(got).toContain('closure-line'); expect(got).toContain('parked-fix')
})
