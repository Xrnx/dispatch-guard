import { expect, mock, test } from 'claude-code/testing'

const TURN = /4th tool call this turn/
const BASH = /Foreground Bash looks long-running/
const ctx = (r: any): string => (r?.context ?? []).join('\n')

test('reminds on the 4th main-thread call only; exempt and subagent calls do not count', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  for (let i = 0; i < 3; i++) {
    expect(ctx(await $.tool.call({ tool: 'Read', file_path: '/x' } as any))).not.toMatch(TURN)
  }
  await $.tool.call({ tool: 'SendMessage', to: 'main', message: 'x' } as any)
  await $.tool.call({ tool: 'Read', file_path: '/x', agentId: 'a1' } as any)
  const fourth = await $.tool.call({ tool: 'Read', file_path: '/x' } as any)
  expect(ctx(fourth)).toMatch(TURN)
  expect((fourth as any).deny).toBeUndefined()
  expect(ctx(await $.tool.call({ tool: 'Read', file_path: '/x' } as any))).not.toMatch(TURN)
})

test('no 4th-call reminder in a turn that loaded the handoff skill', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Skill', skill: 'anthropic-skills:handoff' } as any)
  for (let i = 0; i < 5; i++) {
    expect(ctx(await $.tool.call({ tool: 'Read', file_path: '/x' } as any))).not.toMatch(TURN)
  }
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
