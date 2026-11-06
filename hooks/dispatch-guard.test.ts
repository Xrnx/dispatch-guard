import { expect, mock, test } from 'claude-code/testing'
import { CARD } from './orchestrator-card'
import { longPoints, unverified, unproven, DIR_TOKEN, SKILLS_ROOT, fnv8, scopeCtx, splitCard, stripFrontmatter, correcting, corrCategory, SCOREBOARD_URL } from './register'

const TURN = /4th tool call this turn/
const BASH = /Foreground Bash looks long-running/
const ctx = (r: any): string => (r?.context ?? []).join('\n')

test('reminds on the 4th main-thread call only; exempt and subagent calls do not count', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  for (let i = 0; i < 3; i++) {
    expect(ctx(await $.tool.call({ tool: 'Edit', file_path: '/x' } as any))).not.toMatch(TURN)
  }
  await $.tool.call({ tool: 'SendMessage', to: 'main', message: 'x' } as any)
  await $.tool.call({ tool: 'Edit', file_path: '/x', agentId: 'a1' } as any)
  const fourth = await $.tool.call({ tool: 'Edit', file_path: '/x' } as any)
  expect(ctx(fourth)).toMatch(TURN)
  expect((fourth as any).deny).toBeUndefined()
  expect(ctx(await $.tool.call({ tool: 'Edit', file_path: '/x' } as any))).not.toMatch(TURN)
})

test('read-only tools do not count toward the 4th-call reminder', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  for (let i = 0; i < 4; i++) {
    expect(ctx(await $.tool.call({ tool: 'Read', file_path: '/x' } as any))).not.toMatch(TURN)
  }
  expect(ctx(await $.tool.call({ tool: 'Edit', file_path: '/x' } as any))).not.toMatch(TURN)
})

test('4th counted call still reminds after read-only calls', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Read', file_path: '/x' } as any)
  await $.tool.call({ tool: 'Read', file_path: '/x' } as any)
  await $.tool.call({ tool: 'Edit', file_path: '/x' } as any)
  await $.tool.call({ tool: 'Edit', file_path: '/x' } as any)
  expect(ctx(await $.tool.call({ tool: 'Write', file_path: '/x' } as any))).not.toMatch(TURN)
  expect(ctx(await $.tool.call({ tool: 'Edit', file_path: '/x' } as any))).toMatch(TURN)
})

test('no 4th-call reminder in a turn that loaded the handoff skill', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Skill', skill: 'anthropic-skills:handoff' } as any)
  for (let i = 0; i < 5; i++) {
    expect(ctx(await $.tool.call({ tool: 'Read', file_path: '/x' } as any))).not.toMatch(TURN)
  }
})

test('a /handoff slash command makes its turn a handoff turn; the next turn re-arms', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('prompt.submit', (_$: any, e: any) => e)
  on('turn.start', (_$: any, e: any) => e)
  await $.prompt.submit({ text: '', command: { name: 'anthropic-skills:handoff', args: '' } } as any)
  await $.turn.start({ text: '', turnId: 'h1' } as any)
  for (let i = 0; i < 5; i++) {
    expect(ctx(await $.tool.call({ tool: 'Edit', file_path: '/x' } as any))).not.toMatch(TURN)
  }
  await $.turn.start({ text: 'hi', turnId: 'h2' } as any)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Edit', file_path: '/x' } as any)
  expect(ctx(await $.tool.call({ tool: 'Edit', file_path: '/x' } as any))).toMatch(TURN)
})

test('flags long-looking foreground Bash, not background Bash', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  expect(ctx(await $.tool.call({ tool: 'Bash', command: 'npm test' } as any))).toMatch(BASH)
  expect(ctx(await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true } as any))).not.toMatch(BASH)
  expect(ctx(await $.tool.call({ tool: 'Bash', command: 'ls' } as any))).not.toMatch(BASH)
})

const START = /Load the orchestrator skill/

// A chat harness: the session id the engine reports, a store, and the prompts' context as seen.
const chat = (on: any, opts: { loseState?: () => boolean } = {}) => {
  const h = { id: 'session-A', seen: [] as string[] }
  mock.store(on)
  on('session.id', () => ({ value: h.id }))
  if (opts.loseState) {
    on('state.get', (_$: any, e: any, next: any) => (opts.loseState!() ? { value: { value: undefined, version: 0 } } : next(e)))
  }
  on('prompt.submit', (_$: any, e: any) => { h.seen.push((e.context ?? []).join('\n')); return { text: e.text, context: e.context } })
  return h
}

test('orchestrator reminder rides the first prompt only', async ($, on) => {
  const h = chat(on)
  await $.prompt.submit({ text: 'test' } as any)
  await $.prompt.submit({ text: 'second' } as any)
  await $.prompt.submit({ text: 'third' } as any)
  expect(h.seen[0]).toMatch(START)
  expect(h.seen[1]).not.toMatch(START)
  expect(h.seen[2]).not.toMatch(START)
})

// A fake synced-skills dir: the test's fs hooks stand for the disk (nothing else sits beneath them).
const fakeSkills = (on: any, files: Record<string, { text: string; mtimeMs: number }> | undefined) => {
  const miss = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
  on('fs.list', (_$: any, e: any) => {
    if (files === undefined || e.path !== SKILLS_ROOT) miss()
    return { value: Object.keys(files!).map(id => ({ name: id, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  const at = (p: string) => Object.entries(files ?? {}).find(([id]) => p === `${SKILLS_ROOT}/${id}/orchestrator/SKILL.md`)?.[1]
  on('fs.stat', (_$: any, e: any) => { const f = at(e.path); if (!f) miss(); return { value: { kind: 'file', size: f!.text.length, mtimeMs: f!.mtimeMs, isLink: false } } })
  on('fs.exists', (_$: any, e: any) => ({ value: at(e.path) !== undefined }))
  on('fs.read', (_$: any, e: any) => { const f = at(e.path); if (!f) miss(); return { value: f!.text } })
}
const EMBEDDED = stripFrontmatter(CARD)
// Without a working cards dir the card goes out whole (core + inline sections).
const SENT = EMBEDDED

test('orchestrator card (skill text) rides the first prompt only, after the reminder', async ($, on) => {
  const h = chat(on)
  fakeSkills(on, undefined)
  await $.prompt.submit({ text: 'test' } as any)
  await $.prompt.submit({ text: 'second' } as any)
  expect(h.seen[0]).toContain(SENT)
  expect(h.seen[0].indexOf(SENT)).toBeGreaterThan(h.seen[0].search(START))
  expect(h.seen[1]).not.toMatch(/Orchestrator card/)
  expect(h.seen[1]).not.toContain(EMBEDDED)
})

test('card: the newest synced SKILL.md on disk wins and is tagged live with its body hash', async ($, on) => {
  const h = chat(on)
  const newer = '---\nname: orchestrator\n---\n\n# Orchestrator NEW\nlive body'
  fakeSkills(on, { old: { text: '---\nname: x\n---\n# OLD', mtimeMs: 1 }, fresh: { text: newer, mtimeMs: 2 } })
  await $.prompt.submit({ text: 'first' } as any)
  const body = '# Orchestrator NEW\nlive body'
  expect(h.seen[0]).toContain(`Orchestrator card (${fnv8(body)}, live)`)
  expect(h.seen[0]).toContain(body)
  expect(h.seen[0]).not.toContain('# OLD')
  expect(h.seen[0]).not.toContain(EMBEDDED)
})

test('card: no synced skills dir falls back to the embedded card, tagged embedded', async ($, on) => {
  const h = chat(on)
  fakeSkills(on, undefined)
  await $.prompt.submit({ text: 'first' } as any)
  expect(h.seen[0]).toContain(`Orchestrator card (${fnv8(EMBEDDED)}, embedded)`)
  expect(h.seen[0]).toContain(SENT)
})

test('card: YAML frontmatter is stripped from live and embedded text', async ($, on) => {
  expect(CARD.startsWith('---')).toBe(true)
  expect(EMBEDDED.startsWith('# Orchestrator')).toBe(true)
  expect(stripFrontmatter('---\na: 1\nb: "x"\n---\n\nBody')).toBe('Body')
  expect(stripFrontmatter('No frontmatter\n---\nrule')).toBe('No frontmatter\n---\nrule')
  const h = chat(on)
  fakeSkills(on, { s1: { text: '---\nname: orchestrator\ndescription: "d"\n---\nBODY ONLY', mtimeMs: 5 } })
  await $.prompt.submit({ text: 'first' } as any)
  expect(h.seen[0]).not.toMatch(/name: orchestrator|description: "d"/)
  expect(h.seen[0]).toContain('BODY ONLY')
})

test('a plugin reload in the same chat does not remind again, even if session state is lost', async ($, on) => {
  let lost = false
  const h = chat(on, { loseState: () => lost })
  await $.prompt.submit({ text: 'first' } as any)
  await $.prompt.submit({ text: 'second' } as any)
  lost = true // plugin re-saved / worker respawned: the state value reads as never written
  await $.prompt.submit({ text: 'after reload' } as any)
  await $.prompt.submit({ text: 'again' } as any)
  expect(h.seen[0]).toMatch(START)
  expect(h.seen.slice(1).join('\n')).not.toMatch(START)
})

test('/clear re-arms the reminder with no SessionStart hook run', async ($, on) => {
  const h = chat(on)
  let sessionStarts = 0
  on('classic.SessionStart', () => { sessionStarts += 1; return {} })
  await $.prompt.submit({ text: 'first' } as any)
  await $.prompt.submit({ text: 'second' } as any)
  h.id = 'session-B' // /clear: same process, new session id; SessionStart is never raised
  await $.prompt.submit({ text: 'after clear' } as any)
  await $.prompt.submit({ text: 'next' } as any)
  expect(sessionStarts).toBe(0)
  expect(h.seen[0]).toMatch(START)
  expect(h.seen[1]).not.toMatch(START)
  expect(h.seen[2]).toMatch(START)
  expect(h.seen[3]).not.toMatch(START)
})

test('slash commands neither get nor use up the reminder', async ($, on) => {
  const h = chat(on)
  await $.prompt.submit({ text: '/help', command: { name: 'help' } } as any)
  await $.prompt.submit({ text: 'hello' } as any)
  expect(h.seen[0]).not.toMatch(START)
  expect(h.seen[1]).toMatch(START)
})

const RUNNING = /\(running\) claimed but nothing launched this turn/
const IDLE = /^Idle guard: read \/areas\/open-items\.md/
const turn = (id: string) => ({ text: 'go', turnId: id } as any)
const end = (id: string, answer: string) => ({ answer, turnId: id, reason: 'answer', durationMs: 1, isAborted: false } as any)
// The engine beneath: tools answer as given, a turn's end echoes its answer, prompts record their context.
const texts: string[] = []
const engine = (on: any, results: Record<string, any> = {}) => {
  const seen: string[] = []
  mock.store(on)
  on('session.id', () => ({ value: 'session-A' }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('tool.call', (_$: any, e: any) => results[e.tool] ?? { result: {}, text: '' })
  on('prompt.submit', (_$: any, e: any) => { seen.push((e.context ?? []).join('\n')); texts.push(e.text); return { text: e.text, context: e.context } })
  return seen
}

test('running-proof: "(running" with no launch id gets one line beneath the answer, and the model sees it once', async ($, on) => {
  const seen = engine(on)
  await $.prompt.submit({ text: 'first' } as any)
  await $.turn.start(turn('t1'))
  await $.tool.call({ tool: 'Read', file_path: '/x' } as any)
  const r = await $.turn.complete(end('t1', 'Next: build it (running, ETA 5 min)'))
  expect(r.text).toMatch(RUNNING)
  expect(r.text.split('\n').length).toBe(1)
  await $.prompt.submit({ text: 'second' } as any)
  await $.prompt.submit({ text: 'third' } as any)
  expect(seen[1]).toMatch(RUNNING)
  expect(seen[2]).not.toMatch(RUNNING)
})

test('running-proof: an agent id, a background Bash id or a trigger id proves the claim', async ($, on) => {
  const launches: [string, any, any][] = [
    ['Agent', { tool: 'Agent', prompt: 'x', description: 'x', run_in_background: true }, { result: { status: 'async_launched', agentId: 'a1b2c3d4' }, text: 'agentId: a1b2c3d4' }],
    ['SendMessage', { tool: 'SendMessage', to: 'w', message: 'go' }, { result: {}, text: '{"resumedAgentId":"a9z8y7x6"}' }],
    ['Bash', { tool: 'Bash', command: 'make', run_in_background: true }, { result: {}, text: 'Command running in background with ID: b77' }],
    ['mcp__claude-code-remote__send_later', { tool: 'mcp__claude-code-remote__send_later', message: 'x', delay_minutes: 5 }, { result: {}, text: '{"trigger_id":"trg_0123"}' }],
  ]
  engine(on, Object.fromEntries(launches.map(([tool, , result]) => [tool, result])))
  for (const [tool, call] of launches) {
    await $.turn.start(turn(`t-${tool}`))
    await $.tool.call(call)
    const r = await $.turn.complete(end(`t-${tool}`, 'Next: it runs (running, ETA 5 min)'))
    expect(r.text).not.toMatch(RUNNING)
  }
})

test('running-proof: a finished foreground agent or an errored launch is no proof', async ($, on) => {
  engine(on, {
    Agent: { result: { status: 'completed', agentId: 'a1b2c3d4' }, text: 'done' },
    Bash: { isError: true, result: {}, text: 'Command running in background with ID: b77' },
  })
  await $.turn.start(turn('t1'))
  await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'x' } as any)
  await $.tool.call({ tool: 'Bash', command: 'make', run_in_background: true } as any)
  expect((await $.turn.complete(end('t1', 'Next: (running)'))).text).toMatch(RUNNING)
})

test('idle-guard: removing the ledger adds the reminder to that Bash result, once per turn', async ($, on) => {
  engine(on)
  await $.turn.start(turn('t1'))
  const first = await $.tool.call({ tool: 'Bash', command: 'rm "$L"' } as any)
  const again = await $.tool.call({ tool: 'Bash', command: 'rm -rf ~/.claude/orchestrator/' } as any)
  expect(ctx(first)).toMatch(IDLE)
  expect(ctx(again)).not.toMatch(IDLE)
  expect((await $.turn.complete(end('t1', 'Ledger cleared, queue empty.'))).text).not.toMatch(IDLE)
  for (const command of ['rm $L', 'rm -f .claude/orchestrator/ledger.md']) {
    await $.turn.start(turn(command))
    expect(ctx(await $.tool.call({ tool: 'Bash', command } as any))).toMatch(IDLE)
  }
})

test('idle-guard: "queue empty" in the answer gets one line beneath it', async ($, on) => {
  engine(on)
  await $.turn.start(turn('t1'))
  const r = await $.turn.complete(end('t1', 'All done, queue empty.'))
  expect(r.text).toMatch(IDLE)
  expect(r.text.split('\n').length).toBe(1)
})

test('idle-guard: other rm commands and other words do not fire', async ($, on) => {
  engine(on)
  await $.turn.start(turn('t1'))
  for (const command of ['rm $LOG', 'rm -rf build/', 'rm notes/orchestrator.md', 'echo "$L"']) {
    expect(ctx(await $.tool.call({ tool: 'Bash', command } as any))).not.toMatch(IDLE)
  }
})

test('a clean turn produces zero hook output', async ($, on) => {
  const seen = engine(on)
  await $.prompt.submit({ text: 'first' } as any)
  await $.turn.start(turn('t1'))
  await $.tool.call({ tool: 'Skill', skill: 'anthropic-skills:orchestrator' } as any)
  const a = await $.tool.call({ tool: 'Read', file_path: '/x' } as any)
  const b = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  const answer = 'Result: fixed. Next: nothing running; review the diff (needs you).'
  const r = await $.turn.complete(end('t1', answer))
  await $.prompt.submit({ text: 'second' } as any)
  expect(ctx(a)).toBe('')
  expect(ctx(b)).toBe('')
  expect(r.text).toBe(answer)
  expect(seen[1]).toBe('')
})

const LAUNCH = { result: { status: 'async_launched', agentId: 'a1b2c3d4' }, text: 'agentId: a1b2c3d4' }
const AGENT_CALL = { tool: 'Agent', prompt: 'x', description: 'x', run_in_background: true } as any

test('running-proof: a launch from an earlier turn that is still open proves a later claim', async ($, on) => {
  engine(on, { Agent: LAUNCH })
  await $.turn.start(turn('t1'))
  await $.tool.call(AGENT_CALL)
  await $.turn.complete(end('t1', 'Next: audit (running, ETA 10 min)'))
  await $.turn.start(turn('t2'))
  const r = await $.turn.complete(end('t2', 'Still going (running, ETA 5 min)'))
  expect(r.text).toBe('Still going (running, ETA 5 min)')
})

test('running-proof: once the earlier launch is reported finished, a new claim is flagged', async ($, on) => {
  engine(on, { Agent: LAUNCH })
  await $.turn.start(turn('t1'))
  await $.tool.call(AGENT_CALL)
  await $.turn.complete(end('t1', 'Next: audit (running, ETA 10 min)'))
  const note = '<task-notification>\n<task-id>a1b2c3d4</task-id>\n<status>completed</status>\n</task-notification>'
  await $.turn.start({ text: note, turnId: 't2' } as any)
  expect((await $.turn.complete(end('t2', 'Next: follow-up (running)'))).text).toMatch(RUNNING)
})

test('idle-guard: an idle claim with nothing open submits one continuation prompt; none from its own turn or with a launch open', async ($, on) => {
  engine(on, { Agent: { result: { status: 'async_launched', agentId: 'a1b2c3d4' }, text: 'agentId: a1b2c3d4' } })
  const sent = texts
  sent.length = 0
  await $.turn.start(turn('t1'))
  await $.turn.complete(end('t1', 'Going idle until J replies.'))
  await new Promise(r => setTimeout(r, 20))
  expect(sent.filter(t => t.startsWith('[dispatch-guard] Idle guard')).length).toBe(1)
  await $.turn.start({ ...turn('t2'), text: '[dispatch-guard] Idle guard: read' } as any)
  await $.turn.complete(end('t2', 'Nothing queued.'))
  expect(sent.filter(t => t.startsWith('[dispatch-guard]')).length).toBe(1)
  await $.turn.start(turn('t3'))
  await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'x', run_in_background: true } as any)
  await $.turn.complete(end('t3', 'Nothing queued.'))
  expect(sent.filter(t => t.startsWith('[dispatch-guard]')).length).toBe(1)
})

const STAMP = /board-timestamp: `updated` .* off the live clock — re-stamp from `date`\./
const AD = (data: any, extra: any = {}) => ({ tool: 'ArtifactData', action: 'set', url: 'https://claude.ai/artifact/1pV8oEewdbsBMqi6EYDAA8', collection: 'rows', doc_id: 'r1', data, ...extra } as any)
const iso = (offsetMin: number) => new Date(Date.now() + offsetMin * 60_000).toISOString()

test('board-timestamp: a fresh `updated`, or none, produces no output', async ($, on) => {
  engine(on)
  await $.turn.start(turn('t1'))
  expect(ctx(await $.tool.call(AD({ status: 'x', updated: iso(-1) })))).toBe('')
  expect(ctx(await $.tool.call(AD({ status: 'x' })))).toBe('')
})

test('board-timestamp: 26 h old and +10 min each add one line, never deny', async ($, on) => {
  engine(on)
  await $.turn.start(turn('t1'))
  const old = await $.tool.call(AD({ updated: iso(-26 * 60) }))
  expect(ctx(old)).toMatch(STAMP)
  expect(ctx(old)).toMatch(/1560 min off/)
  expect(ctx(old).split('\n').length).toBe(1)
  expect((old as any).deny).toBeUndefined()
  await $.turn.start(turn('t2'))
  const fut = await $.tool.call(AD({ updated: iso(10) }, { action: 'update' }))
  expect(ctx(fut)).toMatch(/1[01] min off/)
})

test('board-timestamp: a batch with one bad row adds one line', async ($, on) => {
  engine(on)
  await $.turn.start(turn('t1'))
  const writes = [{ action: 'set', data: { updated: iso(0) } }, { action: 'set', data: { updated: iso(-300) } }, { action: 'set', data: { updated: iso(-600) } }]
  const r = await $.tool.call(AD(undefined, { action: 'batch', writes }))
  expect(ctx(r)).toMatch(STAMP)
  expect(ctx(r).split('\n').length).toBe(1)
})

test('board-timestamp: a second miss in the same turn adds no second line; a new turn re-arms', async ($, on) => {
  engine(on)
  await $.turn.start(turn('t1'))
  expect(ctx(await $.tool.call(AD({ updated: iso(-600) })))).toMatch(STAMP)
  expect(ctx(await $.tool.call(AD({ updated: iso(-600) })))).not.toMatch(STAMP)
  await $.turn.start(turn('t2'))
  expect(ctx(await $.tool.call(AD({ updated: iso(-600) })))).toMatch(STAMP)
})

test('board-timestamp: subagent calls are ignored and do not use up the turn', async ($, on) => {
  engine(on)
  await $.turn.start(turn('t1'))
  expect(ctx(await $.tool.call({ ...AD({ updated: iso(-600) }), agentId: 'a1' }))).toBe('')
  expect(ctx(await $.tool.call(AD({ updated: iso(-600) })))).toMatch(STAMP)
})

test('board-timestamp: an unparseable `updated` counts as a miss', async ($, on) => {
  engine(on)
  await $.turn.start(turn('t1'))
  expect(ctx(await $.tool.call(AD({ updated: 'sometime this morning' })))).toMatch(/board-timestamp: `updated` "sometime this morning" is unparseable/)
})

const PARKED = /^Fix named but not started — dispatch it this turn/
const GAP = "It doesn't flag ties. That should be a cheap page fix."

test('parked-fix: a named fix with no launch or write gets one line', async ($, on) => {
  engine(on)
  await $.turn.start(turn('p1'))
  const r = await $.turn.complete(end('p1', GAP))
  expect(r.text).toMatch(PARKED)
  expect(r.text.split('\n').length).toBe(1)
})

test('parked-fix: a launch id or an Edit this turn means no line', async ($, on) => {
  engine(on, { Agent: { result: { status: 'async_launched', agentId: 'a1b2c3d4' }, text: 'agentId: a1b2c3d4' } })
  await $.turn.start(turn('p2'))
  await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'x', run_in_background: true } as any)
  expect((await $.turn.complete(end('p2', GAP))).text).not.toMatch(PARKED)
  await $.turn.start(turn('p3'))
  await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' } as any)
  expect((await $.turn.complete(end('p3', GAP))).text).not.toMatch(PARKED)
})

test('parked-fix: past-tense reports and (needs you) are no miss', async ($, on) => {
  engine(on)
  await $.turn.start(turn('p4'))
  expect((await $.turn.complete(end('p4', 'Fix landed and published.'))).text).not.toMatch(PARKED)
  await $.turn.start(turn('p5'))
  expect((await $.turn.complete(end('p5', `${GAP} Next: (needs you)`))).text).not.toMatch(PARKED)
})

const MISS = /^Miss named but nothing landed — fix it this turn/

test('miss-landing: "Correction:" with no writes gets one line', async ($, on) => {
  engine(on)
  await $.turn.start(turn('m1'))
  const r = await $.turn.complete(end('m1', '**Correction:** the count was 36, not 37.'))
  expect(r.text).toMatch(MISS)
  expect(r.text.split('\n').length).toBe(1)
})

test('miss-landing: a memory_append this turn means silent', async ($, on) => {
  engine(on)
  await $.turn.start(turn('m2'))
  await $.tool.call({ tool: 'mcp__memory__memory_append', path: '/x', content: 'y' } as any)
  expect((await $.turn.complete(end('m2', 'Miss: skipped the rules step.'))).text ?? '').not.toMatch(MISS)
})

test('miss-landing: "existing rule covers" is exempt', async ($, on) => {
  engine(on)
  await $.turn.start(turn('m3'))
  expect((await $.turn.complete(end('m3', 'Correction: wrong date. The existing rule covers it.'))).text ?? '').not.toMatch(MISS)
})

test('miss-landing: wins over parked-fix, one line only', async ($, on) => {
  engine(on)
  await $.turn.start(turn('m4'))
  const r = await $.turn.complete(end('m4', "- Gap: no tie flag. That should be a cheap page fix."))
  expect(r.text).toMatch(MISS)
  expect(r.text).not.toMatch(PARKED)
  expect(r.text.split('\n').length).toBe(1)
})

// 0.3.10 fail-safe card: injection never depends on fs, crypto or the store succeeding.
const TAIL = "If this card is absent in your context, Skill-load 'orchestrator'."
// An in-memory store that logs each write (mock.store would claim the store.set hook).
const storeLog = (on: any, order?: string[]) => {
  const mem: Record<string, unknown> = {}
  const log: { key: string; value: unknown }[] = []
  on('store.get', (_$: any, e: any) => ({ value: mem[e.key] }))
  on('store.set', (_$: any, e: any) => { mem[e.key] = e.value; log.push({ key: e.key, value: e.value }); order?.push(`store:${e.key}`); return { value: undefined } })
  return log
}
const chatLogged = (on: any, order?: string[]) => {
  const seen: string[] = []
  on('session.id', () => ({ value: 'session-L' }))
  on('prompt.submit', (_$: any, e: any) => { order?.push('inject'); seen.push((e.context ?? []).join('\n')); return { text: e.text, context: e.context } })
  return { seen, log: storeLog(on, order) }
}

test('card: $.fs.list throwing still injects the embedded card, and lastCard records the error', async ($, on) => {
  const { seen, log } = chatLogged(on)
  const h = { seen }
  on('fs.list', () => { throw new Error('list exploded') })
  await $.prompt.submit({ text: 'first' } as any)
  expect(h.seen[0]).toMatch(START)
  expect(h.seen[0]).toContain(`Orchestrator card (${fnv8(EMBEDDED)}, embedded)`)
  expect(h.seen[0]).toContain(SENT)
  expect(h.seen[0]).toContain(TAIL)
  const last = log.find(x => x.key === 'lastCard')?.value as any
  expect(last.source).toBe('embedded')
  expect(last.tag).toBe(fnv8(EMBEDDED))
  expect(last.files).toBe(0)
  expect(last.root).toBe(SKILLS_ROOT)
  expect(String(last.error)).toContain('fs.list') // the kit reports a throwing hook as "no implementation for fs.list"
  expect(Number.isNaN(Date.parse(last.at))).toBe(false)
})

test('card: with crypto undefined the card still injects, tagged by FNV-1a', async ($, on) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true })
  try {
    expect((globalThis as any).crypto).toBeUndefined()
    const { seen, log } = chatLogged(on)
    const h = { seen }
    fakeSkills(on, { s1: { text: '---\nname: orchestrator\n---\nLIVE BODY', mtimeMs: 3 } })
    await $.prompt.submit({ text: 'first' } as any)
    expect(fnv8('LIVE BODY')).toMatch(/^[0-9a-f]{8}$/)
    expect(h.seen[0]).toContain(`Orchestrator card (${fnv8('LIVE BODY')}, live)`)
    const last = log.find(x => x.key === 'lastCard')?.value as any
    expect(last.source).toBe('live')
    expect(last.files).toBe(1)
    expect(last.error).toBeUndefined()
  } finally {
    if (saved) Object.defineProperty(globalThis, 'crypto', saved)
  }
})

test('card: the once-per-chat store write happens after the injection, and a failing store skips nothing', async ($, on) => {
  const order: string[] = []
  const { seen } = chatLogged(on, order)
  fakeSkills(on, undefined)
  await $.prompt.submit({ text: 'first' } as any)
  expect(order[0]).toBe('inject')
  expect(order.slice(1).every(x => x.startsWith('store:'))).toBe(true)
  expect(order).toContain('store:remindedSessions')
  expect(order).toContain('store:lastCard')
  expect(seen[0]).toMatch(START)
})

test('card: store and fs both throwing still inject once, not again on the next prompt', async ($, on) => {
  on('session.id', () => ({ value: 'session-T' }))
  on('store.get', () => { throw new Error('store down') })
  on('store.set', () => { throw new Error('store down') })
  on('fs.list', () => { throw new Error('fs down') })
  const seen: string[] = []
  on('prompt.submit', (_$: any, e: any) => { seen.push((e.context ?? []).join('\n')); return { text: e.text, context: e.context } })
  await $.prompt.submit({ text: 'first' } as any)
  await $.prompt.submit({ text: 'second' } as any)
  expect(seen[0]).toMatch(START)
  expect(seen[0]).toContain(SENT)
  expect(seen[1]).not.toMatch(START)
})

test('4th call being a single ArtifactData save is silent', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Edit', file_path: '/x' } as any)
  expect(ctx(await $.tool.call({ tool: 'ArtifactData', action: 'set', url: 'u' } as any))).not.toMatch(TURN)
})

test('4th = Artifact publish silent, 5th = WebSearch reminds', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Edit', file_path: '/x' } as any)
  expect(ctx(await $.tool.call({ tool: 'Artifact', file_path: '/p.html' } as any))).not.toMatch(TURN)
  expect(ctx(await $.tool.call({ tool: 'WebSearch', query: 'q' } as any))).toMatch(TURN)
})

test('non-finishing 4th reminds once, not again on the 6th', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Edit', file_path: '/x' } as any)
  expect(ctx(await $.tool.call({ tool: 'Edit', file_path: '/x' } as any))).toMatch(TURN)
  await $.tool.call({ tool: 'Edit', file_path: '/x' } as any)
  expect(ctx(await $.tool.call({ tool: 'Edit', file_path: '/x' } as any))).not.toMatch(TURN)
})

// Checks for covered-but-recurring misses: each fires one line beneath the answer, never blocks.
const done = async ($: any, id: string, answer: string, calls: any[] = []) => {
  await $.turn.start(turn(id))
  for (const c of calls) await $.tool.call(c)
  return (await $.turn.complete(end(id, answer))).text as string
}
const SKILL_ORCH = { tool: 'Skill', skill: 'anthropic-skills:orchestrator' } as any

test('style: blockquoted and fenced lines are exempt from the 20-word cap', async ($, on) => {
  engine(on)
  const quote = '> ' + Array(30).fill('word').join(' ')
  const code = '```\n' + Array(30).fill('word').join(' ') + '\n```'
  expect(await done($, 't1', `**Rule** saved.\n\n${quote}\n\n${code}`)).not.toMatch(/points over 20 words/)
  expect(await done($, 't2', Array(25).fill('word').join(' '))).toMatch(/Style: 1 points over 20 words/)
})

test('offer-guard: an answer ending on an offer gets one line; (needs you) and D1 questions do not', async ($, on) => {
  engine(on)
  expect(await done($, 't1', 'Timers left on. If you want them off, say so.')).toMatch(/offer-guard/)
  expect(await done($, 't2', 'Done. Want me to queue the next batch?')).toMatch(/offer-guard/)
  expect(await done($, 't3', 'Next: approve the push (needs you). Want me to draft it?')).not.toMatch(/offer-guard/)
  expect(await done($, 't4', 'Built.\n\nD1: should I merge tonight?')).not.toMatch(/offer-guard/)
  expect(await done($, 't5', 'Queue empty, all dispatched.')).not.toMatch(/offer-guard/)
})

test('verify-proof: "verified" with no source and verbatim quote on its line, or unverified/TBC markers, get one line', async ($, on) => {
  engine(on)
  const r = await done($, 't1', '**Verified** no duty on transmission.\n- Sch 4 title [confirm]\n- cap is unverified')
  expect(r).toMatch(/verify-proof: 1 "verified" with no source and verbatim quote on its line, 2 unverified\/TBC markers/)
  expect(r.split('\n').length).toBe(1)
  expect(await done($, 't2', '**Verified**: s 4(1) — https://sso.agc.gov.sg/Act/SDA1929 "no duty is payable"')).not.toMatch(/verify-proof/)
  expect(await done($, 't3', 'Verified — source: /areas/recent-work.md “Cayman SPA signed”')).not.toMatch(/verify-proof/)
  expect(await done($, 't4', 'Label each claim "verified" or "unverified" per the rule.')).not.toMatch(/verify-proof/)
})

test('promise-proof: an Efficiency/Prevention line with no write this turn is flagged; with a write, or "none", it is not', async ($, on) => {
  engine(on)
  expect(await done($, 't1', 'Done.\n**Efficiency:** reload orchestrator on start.')).toMatch(/promise-proof/)
  expect(await done($, 't2', 'From now on I will stamp from date.', [{ tool: 'Read', file_path: '/x' }])).toMatch(/promise-proof/)
  expect(await done($, 't3', 'Done.\nPrevention: skill step added.', [{ tool: 'Edit', file_path: '/s.md', old_string: 'a', new_string: 'b' }])).not.toMatch(/promise-proof/)
  expect(await done($, 't4', 'Done.\n**Efficiency:** none')).not.toMatch(/promise-proof/)
  expect(await done($, 't5', 'Saved.', [{ tool: 'mcp__memory__memory_read', path: '/x' }])).not.toMatch(/promise-proof/)
})

test('orchestrator-proof: an injected chat-start card counts as loaded, so no line', async ($, on) => {
  engine(on)
  await $.prompt.submit({ text: 'first' } as any)
  expect(await done($, 't1', 'Hi.')).not.toMatch(/orchestrator-proof/)
  expect(await done($, 't2', 'Hi again.')).not.toMatch(/orchestrator-proof/)
})

test('orchestrator-proof: loading the skill before the answer prevents the line', async ($, on) => {
  engine(on)
  await $.prompt.submit({ text: 'first' } as any)
  expect(await done($, 't1', 'Hi.', [SKILL_ORCH])).not.toMatch(/orchestrator-proof/)
})

test('board-dispatch: an agent launch or ledger edit with no board write gets the reminder; a board write clears it', async ($, on) => {
  engine(on, { Agent: LAUNCH })
  expect(await done($, 't1', 'Dispatched.', [AGENT_CALL])).toMatch(/Status board not updated for this dispatch/)
  expect(await done($, 't2', 'Logged.', [{ tool: 'Bash', command: 'echo "- W3 audit" >> "$L"' }])).toMatch(/Status board not updated/)
  expect(await done($, 't3', 'Logged.', [{ tool: 'Edit', file_path: '/root/.claude/orchestrator/ledger-x.md', old_string: 'a', new_string: 'b' }])).toMatch(/Status board not updated/)
  const board = { tool: 'ArtifactData', action: 'update', url: 'u', collection: 'rows', doc_id: 'r', data: { status: 'running' } }
  expect(await done($, 't4', 'Dispatched.', [AGENT_CALL, board])).not.toMatch(/Status board not updated/)
  expect(await done($, 't5', 'Read only.', [{ tool: 'Bash', command: 'cat "$L"' }])).not.toMatch(/Status board not updated/)
})


// Round 2: answer-time checks for re-ask rows. `ask` opens the turn with J's prompt text.
const ask = async ($: any, id: string, prompt: string, answer: string, calls: any[] = []) => {
  await $.turn.start({ text: prompt, turnId: id } as any)
  for (const c of calls) await $.tool.call(c)
  return (await $.turn.complete(end(id, answer))).text as string
}

test('verify-proof: a Sources: line anywhere sources every "verified" in the answer', async ($, on) => {
  engine(on)
  expect(await done($, 't1', '**Verified** no cap: "no weekly cap applies".\n\nSources: [Help](https://support.claude.com/x)')).not.toMatch(/verify-proof/)
  expect(await done($, 't2', '**Verified** no cap: "no weekly cap applies".\n- cap [confirm]\n\nSources: [Help](https://support.claude.com/x)')).toMatch(/verify-proof: 1 unverified/)
})

test('idle-guard: "nothing running" in the Next: footer is not an idle claim', async ($, on) => {
  engine(on)
  expect(await done($, 't1', 'No limit found.\n\n**Next:** nothing running. Ask support.')).not.toMatch(/Idle guard/)
  expect(await done($, 't2', 'Nothing running, queue empty.')).toMatch(/Idle guard/)
})

test('answer-first: a yes/no question answered without yes/no or a confidence label up front gets one line', async ($, on) => {
  engine(on)
  expect(await ask($, 't1', 'no its a question. is your header only limited to f i and j?', 'I rewrote the header to cover all deductions.')).toMatch(/answer-first/)
  expect(await ask($, 't2', 'is it really buyer who decides what is due?', '**Unverified → no.** Para 3 lets Buyer withhold; it does not say Buyer decides.')).not.toMatch(/answer-first/)
  expect(await ask($, 't3', 'can you shorten it?', 'Shortened to 3 lines.')).not.toMatch(/answer-first/)
  expect(await ask($, 't4', 'list the deduction heads', 'Heads (a)–(j) listed.')).not.toMatch(/answer-first/)
})

test('lookup-first: "I don\'t know" or asking J with no lookup tool this turn gets one line', async ($, on) => {
  engine(on)
  expect(await ask($, 't1', 'what is the limit', "I don't know the exact limit.")).toMatch(/lookup-first/)
  expect(await ask($, 't2', 'what is the icon', 'Could you send a screenshot of the icon?')).toMatch(/lookup-first/)
  expect(await ask($, 't3', 'what is the limit', "I don't know — no page states it.", [{ tool: 'WebSearch', query: 'x' }])).not.toMatch(/lookup-first/)
  expect(await ask($, 't4', 'what is the icon', 'Not in the key; send a screenshot (needs you).', [{ tool: 'mcp__memory__memory_read', path: '/x' }])).not.toMatch(/lookup-first/)
})

test('eta-proof: a minute ETA with no E×R gets one line', async ($, on) => {
  engine(on)
  expect(await done($, 't1', 'audit: ETA ~40 min')).toMatch(/eta-proof/)
  expect(await done($, 't2', 'audit: ~12 min (40×0.3), done ≈ 17:10')).not.toMatch(/eta-proof/)
  expect(await done($, 't3', 'Took 40 min to read.')).not.toMatch(/eta-proof/)
})

test('checked-line: a long answer to an option ask with no "checked:" line gets one line', async ($, on) => {
  engine(on)
  const long = Array(70).fill('board').join(' ')
  expect(await ask($, 't1', 'best wireless split keyboard with decent keys?', long)).toMatch(/checked-line/)
  expect(await ask($, 't2', 'best wireless split keyboard with decent keys?', long + '\nchecked: wired boards, 40-key boards')).not.toMatch(/checked-line/)
  expect(await ask($, 't3', 'best wireless split keyboard?', 'Corne wireless.')).not.toMatch(/checked-line/)
  expect(await ask($, 't4', 'redraft para 3', long)).not.toMatch(/checked-line/)
})

test('reask-guard: a re-ask adds context before the answer; an answer without Correction: or a label gets one line', async ($, on) => {
  const seen = engine(on)
  await $.prompt.submit({ text: 'verified where?' } as any)
  expect(seen.at(-1)).toMatch(/reask-guard: J is correcting/)
  await $.prompt.submit({ text: 'thanks' } as any)
  expect(seen.at(-1)).not.toMatch(/reask-guard/)
  expect(await ask($, 't1', 'verified where?', 'The fixed duties page.')).toMatch(/reask-guard: J re-asked/)
  expect(await ask($, 't2', 'verified where?', 'Correction: not on that page; unverified until adjudicated.')).not.toMatch(/reask-guard/)
  expect(await ask($, 't3', 'what is para 19', '**Verified** — para 19 is the dispute procedure. source: SPA p.40')).not.toMatch(/reask-guard/)
})

test('scope-quote: J\'s stated limits are quoted back in one Scope: line of at most 20 words', async ($, on) => {
  const seen = engine(on)
  const cases: [string, RegExp][] = [
    ['list the deduction heads, just f, i, j', /"just f, i, j"/],
    ['best split keyboard, not just 40 keys', /"not just 40 keys"/],
    ['best split keyboard? not just 40 keys and wireless', /not just 40 keys/],
    ['finish the limit before the reset', /"finish the limit"/],
    ['redraft para 3 except the carve-out', /"except the carve-out"/],
    ['summary in at most 5 bullets please', /"at most 5 bullets"/],
    ['compare both buyers and sellers', /"both buyers and sellers"/],
    ['only the schedules 2 and 3', /"only the schedules 2"/],
    ['and also the novation deed', /"and also the novation deed"/],
  ]
  for (const [text, re] of cases) {
    const line = scopeCtx(text)
    expect(line).toMatch(/^Scope: /)
    expect(line).toMatch(re)
    expect(line!.split(/\s+/).length).toBeLessThanOrEqual(20)
  }
  await $.prompt.submit({ text: 'just f, i, j' } as any)
  expect(seen.at(-1)).toMatch(/Scope: J said "just f, i, j"/)
})

test('scope-quote: 20 ordinary messages and guard/notification prompts do not trigger', async () => {
  const plain = [
    'thanks', 'looks good, ship it', 'what is para 19', 'verified where?', 'continue',
    'redraft clause 4.2 in a firmer tone', 'summarise the SPA for me', 'is the skincare plan working?',
    'check the board and tell me what is open', 'why did the hash change?', 'yes go ahead',
    'open the DPS Lab and add the new weapon', 'what should I eat tonight near 439945',
    'draft the email to the Cayman counsel', 'did the audit finish?', 'sounds right, do it',
    'fix the redline tool so it handles tables', 'where is the handoff file?', 'rerun the tests',
    'I am just checking in, no rush',
  ]
  expect(plain).toHaveLength(20)
  const hits = plain.filter(t => scopeCtx(t) !== undefined)
  expect(hits.length).toBeLessThanOrEqual(1)
  expect(hits).toEqual([])
  expect(scopeCtx('[dispatch-guard] continue only the open items')).toBeUndefined()
  expect(scopeCtx('<task-notification>only 3 left</task-notification>')).toBeUndefined()
})

test('verify-proof: "verified" needs a verbatim quote on its line or the next, besides the source', async ($, on) => {
  engine(on)
  expect(await done($, 't1', '**Verified**: https://www.iras.gov.sg/x')).toMatch(/verify-proof: 1 "verified" with no source and verbatim quote/)
  expect(await done($, 't2', '**Verified** — https://www.iras.gov.sg/x\n> not payable on vesting by operation of law')).not.toMatch(/verify-proof/)
  expect(await done($, 't3', '**Verified** — [IRAS](https://www.iras.gov.sg/x)\n“not payable on vesting”')).not.toMatch(/verify-proof/)
  expect(await done($, 't4', '**Verified**\n\nOther line "quoted words"\n\nSources: [IRAS](https://www.iras.gov.sg/x)')).toMatch(/verify-proof: 1/)
  expect(await done($, 't5', 'Checked and dropped: Dygma Raise 2 (not a spacebar).\n\nSources: [Dygma](https://dygma.com/raise/)')).toMatch(/verify-proof: 1/)
  expect(await done($, 't6', 'Checked and dropped: Dygma (no spacebar: "thumb keys only").\n\nSources: [Dygma](https://dygma.com/raise/)')).not.toMatch(/verify-proof/)
})

// corr-log (0.4.5): J corrections are queued in the store and flushed to the scoreboard only when allowed.
test('corr-log: detector catches corrections and leaves plain asks alone', () => {
  for (const t of ['verified where?', 'where', 'just f i and j>', 'Are you sure. So 70db is safe?', 'what is para 19', 'And wireless', 'I just told you I\'m at 59%', 'Can you not mix up icons in future', 'its too long can shorten?', 'vcc doesnt have directors?'])
    expect(correcting(t)).toBe(true)
  for (const t of ['Status', 'ok', 'write a board resolution for removal of director', 'what is the indoor management rule', 'ETA', 'Can you keep yourself busy for next 24h', 'Try: split, wireless, ' + 'x '.repeat(100) + 'again'])
    expect(correcting(t)).toBe(false)
  expect(corrCategory('verified where?')).toBe('unverified claim')
  expect(corrCategory('just f i and j')).toBe('wrong scope')
})

const corrEngine = (on: any, decision: string | (() => string), msgs: any[] = [{ role: 'user', text: 'Stamp duty on shares' }, { role: 'assistant', text: 'Verified: none.' }]) => {
  const mem: Record<string, unknown> = {}
  const calls: any[] = []
  on('store.get', (_$: any, e: any) => ({ value: mem[e.key] }))
  on('store.set', (_$: any, e: any) => { mem[e.key] = e.value; return { value: undefined } })
  on('session.id', () => ({ value: 'session-C1234567' }))
  on('session.messages', () => ({ value: msgs }))
  on('clock.now', () => ({ value: Date.parse('2026-11-06T17:00:00Z') }))
  on('tool.check', () => ({ decision: typeof decision === 'function' ? decision() : decision }))
  on('tool.call', (_$: any, e: any) => { calls.push(e); return { result: {}, text: '' } })
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text, context: e.context }))
  return { mem, calls }
}

test('corr-log: a correction after an answer flushes one scoreboard row when the check allows', async ($, on) => {
  const { mem, calls } = corrEngine(on, 'allow')
  await $.prompt.submit({ text: 'verified where?' } as any)
  const w = calls.find(c => c.tool === 'ArtifactData')
  expect(w.url).toBe(SCOREBOARD_URL)
  expect(w.action).toBe('batch')
  expect(w.writes[0].collection).toBe('corrections')
  expect(w.writes[0].data).toMatchObject({ date: '2026-11-07', chat: 'Stamp duty on shares', words: 'verified where?', category: 'unverified claim', covered: false, count: 1, auto: true })
  expect(mem.corrLog).toEqual([])
  expect(calls.filter(c => c.tool === 'ArtifactData').length).toBe(1) // its own call does not re-flush
})

test('corr-log: an "ask" verdict never calls the tool and keeps the row queued', async ($, on) => {
  const { mem, calls } = corrEngine(on, 'ask')
  await $.prompt.submit({ text: 'are you sure' } as any)
  expect(calls.some(c => c.tool === 'ArtifactData')).toBe(false)
  expect((mem.corrLog as any[]).length).toBe(1)
})

test('corr-log: plain asks, agent messages and first prompts are not logged', async ($, on) => {
  const { mem } = corrEngine(on, 'ask')
  await $.prompt.submit({ text: 'Status' } as any)
  await $.prompt.submit({ text: 'Another Claude session sent a message: why did you stop' } as any)
  expect(mem.corrLog).toBeUndefined()
})

test('corr-log: no assistant message yet means nothing to correct', async ($, on) => {
  const { mem } = corrEngine(on, 'allow', [{ role: 'user', text: 'where' }])
  await $.prompt.submit({ text: 'where' } as any)
  expect(mem.corrLog).toBeUndefined()
})

test('corr-log: a main-thread ArtifactData write flushes the queue', async ($, on) => {
  let decision = 'ask'
  const { mem, calls } = corrEngine(on, () => decision)
  await $.prompt.submit({ text: 'why did you say this' } as any)
  expect((mem.corrLog as any[]).length).toBe(1)
  decision = 'allow'
  await $.tool.call({ tool: 'ArtifactData', action: 'set', url: 'https://claude.ai/artifact/x', collection: 'status', doc_id: 'd', data: {} } as any)
  expect(calls.filter(c => c.tool === 'ArtifactData' && c.action === 'batch').length).toBe(1)
  expect(mem.corrLog).toEqual([])
})

// 0.5.1-fa: false-alarm tuning, mis-parses only (the 20-word cap itself is unchanged).
test('style: quoted spans, link URLs, headings and footer labels on one line are not over-long points', () => {
  const quoted = 'Para 3(f) covers documents "to which the Seller and/or any Seller\'s Affiliate is party or any of its related group companies" so Affiliates fit.'
  expect(longPoints(quoted)).toBe(0)
  expect(longPoints('- ' + 'word '.repeat(21).trim())).toBe(1)
  expect(longPoints('# ' + 'heading '.repeat(25) + '\n- short point')).toBe(0)
  expect(longPoints('**Next:** ' + 'ask for the extract before signing '.repeat(2).trim() + ' (needs you). **Efficiency:** none **Leap:** none')).toBe(0)
})
test('verify-proof: locator, named site and in-chat document count as sources; locators do not excuse an unverified marker', () => {
  expect(unverified('**Verified** in para 3: "directly or indirectly" appears only in 3(f).')).toEqual([0, 0])
  expect(unverified('**Verified** against the pasted Schedule 7.')).toEqual([0, 0])
  expect(unverified('Raise 2 back in; dygma.com lists no spacebar keycap (unverified).')).toEqual([0, 0])
  expect(unverified('Whether s 32C reaches it is unverified.')[1]).toBe(1)
  expect(unverified('**Verified safe.**')[0]).toBe(1)
})
test('running-proof: "running (Sonnet)" claims a launch like "(running"', () => {
  expect(unproven('**Next:** valuer gets both names — running (Sonnet), ETA 00:05.', false)).toBe(true)
  expect(unproven('Nothing is running now.', false)).toBe(false)
})

// 0.4.2 tiered card: one SKILL.md, sections after `<!-- section: x.md -->` markers; the hook writes them to
// <plugin root>/cards/ and injects the core only, or sends the whole text when the cards dir fails.
const TIERED = '---\nname: orchestrator\n---\n# Core\nDir: `{SKILL_DIR}`. Agents → `dispatch.md`; handover → `handover.md`.\n\n<!-- section: dispatch.md -->\n# D\nbrief rules\n\n<!-- section: handover.md -->\n# H\nblock rules\n'
const tierFs = (on: any, opts: { failWrite?: boolean } = {}) => {
  const disk: Record<string, string> = {}
  const dir = `${SKILLS_ROOT}/s1/orchestrator`
  const miss = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
  on('fs.list', (_$: any, e: any) => (e.path === SKILLS_ROOT ? { value: [{ name: 's1', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] } : miss()))
  on('fs.stat', (_$: any, e: any) => (e.path === `${dir}/SKILL.md` ? { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } } : miss()))
  on('fs.read', (_$: any, e: any) => (e.path === `${dir}/SKILL.md` ? { value: TIERED } : e.path in disk ? { value: disk[e.path] } : miss()))
  on('fs.write', (_$: any, e: any) => { if (opts.failWrite) throw new Error('EROFS'); disk[e.path] = e.text; return { value: undefined } })
  return disk
}

test('tiered card: sections go to <plugin root>/cards, the core alone is injected with the token set to that dir', async ($, on) => {
  const h = chat(on)
  const disk = tierFs(on)
  await $.prompt.submit({ text: 'first' } as any)
  const dir = Object.keys(disk).find(k => k.endsWith('/cards/dispatch.md'))!.replace(/\/dispatch\.md$/, '')
  expect(dir).toMatch(/^\/.+\/cards$/)
  expect(disk[`${dir}/dispatch.md`]).toBe('# D\nbrief rules\n')
  expect(disk[`${dir}/handover.md`]).toBe('# H\nblock rules\n')
  expect(h.seen[0]).toContain(`Dir: \`${dir}\``)
  expect(h.seen[0]).not.toContain(DIR_TOKEN)
  expect(h.seen[0]).not.toContain('brief rules')
  expect(h.seen[0]).not.toContain('<!-- section:')
})

test('tiered card: a failing cards write sends the whole text (sections inline), never the core alone', async ($, on) => {
  const h = chat(on)
  tierFs(on, { failWrite: true })
  await $.prompt.submit({ text: 'first' } as any)
  expect(h.seen[0]).toContain('brief rules')
  expect(h.seen[0]).toContain('block rules')
  expect(h.seen[0]).toContain(DIR_TOKEN)
})

test('tiered card: splitCard finds each marker; a card with no marker is untouched; the shipped card splits into its named sections', () => {
  const t = splitCard('# C `{SKILL_DIR}`\n\n<!-- section: a.md -->\nA\n\n\n<!-- section: b-c.md -->\nB')
  expect(t.core).toBe('# C `{SKILL_DIR}`\n')
  expect(t.sections).toEqual([['a.md', 'A\n'], ['b-c.md', 'B']])
  expect(splitCard('plain').sections).toEqual([])
  const shipped = splitCard(stripFrontmatter(CARD))
  for (const [n] of shipped.sections) expect(shipped.core).toContain(`\`${n}\``)
})
