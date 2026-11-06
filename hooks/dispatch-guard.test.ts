import { expect, mock, test } from 'claude-code/testing'
import { CARD, SECTIONS } from './orchestrator-card'
import { DIR_TOKEN, SKILLS_ROOT, fnv8, inlineSections, sectionNames, stripFrontmatter } from './register'

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
// What the embedded fallback sends: a tiered core has its sections inlined after it.
const SENT = EMBEDDED.includes(DIR_TOKEN) ? inlineSections(EMBEDDED) : EMBEDDED

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

test('verify-proof: "verified" with no source on its line, or unverified/TBC markers, get one line', async ($, on) => {
  engine(on)
  const r = await done($, 't1', '**Verified** no duty on transmission.\n- Sch 4 title [confirm]\n- cap is unverified')
  expect(r).toMatch(/verify-proof: 1 "verified" with no source on its line, 2 unverified\/TBC markers/)
  expect(r.split('\n').length).toBe(1)
  expect(await done($, 't2', '**Verified**: s 4(1) — https://sso.agc.gov.sg/Act/SDA1929')).not.toMatch(/verify-proof/)
  expect(await done($, 't3', 'Verified — source: /areas/recent-work.md')).not.toMatch(/verify-proof/)
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


// 0.4.2 tiered card: the core names on-demand section files under {SKILL_DIR}.
const TIERED = '---\nname: orchestrator\n---\n# Core\nDir: `{SKILL_DIR}`. Agents → `dispatch.md`; handover → `handover.md`.'
const tierFs = (on: any, have: string[]) => {
  const dir = `${SKILLS_ROOT}/s1/orchestrator`
  const miss = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
  on('fs.list', (_$: any, e: any) => (e.path === SKILLS_ROOT ? { value: [{ name: 's1', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] } : miss()))
  on('fs.stat', (_$: any, e: any) => (e.path === `${dir}/SKILL.md` ? { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } } : miss()))
  on('fs.read', (_$: any, e: any) => (e.path === `${dir}/SKILL.md` ? { value: TIERED } : miss()))
  on('fs.exists', (_$: any, e: any) => ({ value: have.some(n => e.path === `${dir}/${n}`) }))
  return dir
}

test('tiered card: all section files on disk → {SKILL_DIR} becomes their dir, sections not inlined', async ($, on) => {
  const h = chat(on)
  const dir = tierFs(on, ['dispatch.md', 'handover.md'])
  await $.prompt.submit({ text: 'first' } as any)
  expect(h.seen[0]).toContain(`Dir: \`${dir}\``)
  expect(h.seen[0]).not.toContain(DIR_TOKEN)
  expect(h.seen[0]).not.toMatch(/\(inlined\)/)
})

test('tiered card: a missing section file → every section inlined from the build, token never left raw', async ($, on) => {
  const h = chat(on)
  tierFs(on, ['dispatch.md'])
  await $.prompt.submit({ text: 'first' } as any)
  expect(h.seen[0]).not.toContain(DIR_TOKEN)
  expect(h.seen[0]).toContain('--- dispatch.md (inlined) ---')
  expect(h.seen[0]).toContain('--- handover.md (inlined) ---')
})

test('tiered card: section names come from backticked *.md in the core; the build embeds each one the shipped core names', () => {
  expect(sectionNames('`a.md` and `b-c.md`, `SKILL.md`, `a.md`')).toEqual(['a.md', 'b-c.md'])
  for (const n of sectionNames(stripFrontmatter(CARD))) expect(typeof SECTIONS[n]).toBe('string')
  expect(inlineSections('x `{SKILL_DIR}` `zz.md`')).toContain('(missing from this build')
})
