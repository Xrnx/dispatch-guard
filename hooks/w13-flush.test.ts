import { expect, test } from 'claude-code/testing'
import { SCOREBOARD_URL, RELAY_AGE_MS } from './register'

// W13: every flush outcome lands in corrLastFlush; a permission `ask` is never sent from the hook but relayed to the main model
// (prompt context) once a row has waited RELAY_AGE_MS; the main model's batch is absorbed (rows dequeued, versions kept).
const T0 = Date.parse('2026-11-13T08:00:00Z')
const MIN = 60_000
const rig = (on: any, opts: { decision?: string; reason?: string; down?: string; deny?: string } = {}) => {
  const mem: Record<string, unknown> = {}
  const db = new Map<string, { v: number; data: unknown }>()
  const calls: any[] = []
  const ctx: string[] = []
  const clock = { now: T0 }
  on('store.get', (_$: any, e: any) => ({ value: mem[e.key] }))
  on('store.set', (_$: any, e: any) => { mem[e.key] = e.value; return { value: undefined } })
  on('session.id', () => ({ value: 'session-W1300000' }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: clock.now }))
  // A query ($.tool.check, no tool_use_id) gets the session's declarative verdict; a real call is allowed, as the classifier or the
  // person allows the main model's own write in production.
  on('tool.check', (_$: any, e: any) => e.tool_use_id !== undefined ? { decision: 'allow' } : { decision: opts.decision ?? 'allow', ...(opts.reason === undefined ? {} : { reason: opts.reason }) })
  on('prompt.submit', (_$: any, e: any) => { ctx.push((e.context ?? []).join('\n')); return { text: e.text, context: e.context } })
  on('tool.call', (_$: any, e: any) => {
    calls.push(e)
    if (e.tool !== 'ArtifactData' || e.url !== SCOREBOARD_URL) return { result: {}, text: '' }
    if (opts.deny !== undefined) return { deny: opts.deny }
    if (opts.down !== undefined) return { isError: true, result: {}, text: opts.down }
    for (const w of e.writes) {
      const cur = db.get(`${w.collection}/${w.doc_id}`)
      if (cur !== undefined && w.if_version !== cur.v) return { isError: true, result: {}, text: `Batch refused: set "${w.collection}"/"${w.doc_id}" if_version ${w.if_version} is stale; current version is ${cur.v}. Nothing written.` }
    }
    const lines = e.writes.map((w: any) => {
      const k = `${w.collection}/${w.doc_id}`
      const v = (db.get(k)?.v ?? 0) + 1
      db.set(k, { v, data: w.data })
      return `set "${w.collection}"/"${w.doc_id}" (version ${v})`
    })
    return { result: {}, text: `Batch applied atomically (${lines.length} writes):\n${lines.join('\n')}` }
  })
  const sbCalls = () => calls.filter(c => c.tool === 'ArtifactData' && c.url === SCOREBOARD_URL)
  const relays = () => ctx.filter(c => c.includes('scoreboard-flush:'))
  return { mem, db, calls, ctx, clock, sbCalls, relays }
}
// As in production: a flush follows a main-thread ArtifactData write that passed.
const flush = async ($: any): Promise<void> => { await $.tool.call({ tool: 'ArtifactData', action: 'set', url: 'https://claude.ai/artifact/x', collection: 'status', doc_id: 'trigger', data: {} }) }
const prompt = async ($: any): Promise<void> => { await $.prompt.submit({ text: '<task-notification><status>completed</status></task-notification>' } as any) }
const DS = 'deepstats-session-W1300000-2026-11-13'
const row = (id: string, data: unknown, collection?: string) => ({ id, data, ...(collection === undefined ? {} : { collection }) })
const QUEUE = () => [row('hook-W1300000-a', { n: 1 }), row(DS, { prompts: 3 })]
const batchOf = (line: string): any => JSON.parse(line.slice(line.indexOf('{"action"')))
// Every call a relay asks for (0.6.50: the one-shot batch, then one call per deepstats- upsert), each on its own line.
const callsOf = (relay: string): any[] => relay.split('\n').filter(l => l.includes('{"action"')).map(batchOf)

test('W13 ask: nothing sent from the hook, the outcome and first-seen times are on disk', async ($, on) => {
  const f = rig(on, { decision: 'ask' })
  f.mem.corrLog = QUEUE()
  await flush($)
  expect(f.sbCalls()).toEqual([])
  expect(f.mem.corrLastFlush).toMatchObject({ decision: 'ask', sent: 0, queued: 2, error: '' })
  expect(String((f.mem.corrLastFlush as any).at)).toMatch(/^2026-11-13T16:00:00\+08:00$/)
  expect(f.mem.corrQueuedAt).toEqual({ 'hook-W1300000-a': T0, [DS]: T0 })
  expect(f.mem.corrLog).toEqual(QUEUE())
  f.clock.now = T0 + 5 * MIN
  await flush($)
  expect((f.mem.corrQueuedAt as any)[DS]).toBe(T0) // first-seen kept across flushes
})

test('W13 deny: recorded with its reason, never relayed', async ($, on) => {
  const f = rig(on, { decision: 'deny', reason: 'ArtifactData denied by rule' })
  f.mem.corrLog = QUEUE()
  await flush($)
  expect(f.mem.corrLastFlush).toMatchObject({ decision: 'deny', error: 'ArtifactData denied by rule', sent: 0 })
  f.clock.now = T0 + 31 * MIN
  await prompt($)
  expect(f.relays()).toEqual([])
  expect(f.sbCalls()).toEqual([])
})

test('W13 allow: sent from the hook, outcome recorded', async ($, on) => {
  const f = rig(on)
  f.mem.corrLog = QUEUE()
  await flush($)
  expect(f.sbCalls().length).toBe(1)
  expect(f.mem.corrLog).toEqual([])
  expect(f.mem.corrLastFlush).toMatchObject({ decision: 'allow', sent: 2, queued: 0, error: '' })
})

test('W13 allow but the service errors: excerpt kept (200 chars max), rows stay queued', async ($, on) => {
  const f = rig(on, { down: `Service unavailable (503) ${'x'.repeat(400)}` })
  f.mem.corrLog = QUEUE()
  await flush($)
  const last = f.mem.corrLastFlush as any
  expect(last).toMatchObject({ decision: 'allow', sent: 0, queued: 2 })
  expect(last.error.startsWith('Service unavailable (503)')).toBe(true)
  expect(last.error.length).toBe(200)
})

test('W13 allow but the hook call is denied: recorded as denied', async ($, on) => {
  const f = rig(on, { deny: 'blocked by an org hook' })
  f.mem.corrLog = QUEUE()
  await flush($)
  expect(f.mem.corrLastFlush).toMatchObject({ decision: 'allow', error: 'denied: blocked by an org hook', sent: 0, queued: 2 })
})

test('W13 relay: only after 30 min, once per 30 min, pinned; the main model\'s batch is absorbed', async ($, on) => {
  const f = rig(on, { decision: 'ask' })
  f.db.set(`corrections/${DS}`, { v: 2, data: {} })
  f.mem.corrVersions = { [`corrections/${DS}`]: { v: 2, at: T0 } }
  f.mem.corrLog = QUEUE()
  await flush($)
  f.clock.now = T0 + 10 * MIN
  await prompt($)
  expect(f.relays()).toEqual([]) // rows younger than RELAY_AGE_MS
  f.clock.now = T0 + RELAY_AGE_MS + MIN
  await prompt($)
  expect(f.relays().length).toBe(1)
  const line = f.relays()[0] as string
  expect(line).toMatch(/\[dispatch-guard\] scoreboard-flush: 2 Scoreboard row\(s\) queued, oldest 31 min/)
  const input = batchOf(line.split('\n').find(l => l.includes('scoreboard-flush:')) as string)
  expect(input.url).toBe(SCOREBOARD_URL)
  expect(input.writes.map((w: any) => w.doc_id)).toEqual(['hook-W1300000-a'])
  expect(input.writes[0].if_version).toBeUndefined()
  const ups = callsOf(line)
  expect(ups.map(c => c.writes.map((w: any) => w.doc_id))).toEqual([['hook-W1300000-a'], [DS]]) // the upsert has its own call
  expect(ups[1].writes[0].if_version).toBe(2)
  await prompt($)
  expect(f.relays().length).toBe(1) // throttled
  expect(f.sbCalls()).toEqual([]) // the hook itself still sent nothing
  // the main model makes the call (its own permission path); the hook absorbs the result
  for (const c of ups) await $.tool.call({ tool: 'ArtifactData', ...c } as any)
  expect(f.db.get(`corrections/${DS}`)?.v).toBe(3)
  expect(f.mem.corrLog).toEqual([])
  expect((f.mem.corrVersions as any)[`corrections/${DS}`].v).toBe(3)
  expect((f.mem.corrVersions as any)['corrections/hook-W1300000-a'].v).toBe(1)
  expect(f.mem.corrLastFlush).toMatchObject({ decision: 'relay', sent: 1, queued: 0, error: '' }) // the last call (the upsert) landed 1
})

test('W13 relay absorb keeps a row upserted after the relay went out', async ($, on) => {
  const f = rig(on, { decision: 'ask' })
  f.mem.corrLog = QUEUE()
  await flush($)
  f.clock.now = T0 + RELAY_AGE_MS + MIN
  await prompt($)
  const sent = callsOf(f.relays()[0] as string)
  f.mem.corrLog = [row('hook-W1300000-a', { n: 1 }), row(DS, { prompts: 4 })] // turn end upserted the stats row
  for (const c of sent) await $.tool.call({ tool: 'ArtifactData', ...c } as any)
  expect(f.mem.corrLog).toEqual([row(DS, { prompts: 4 })])
  expect(f.mem.corrLastFlush).toMatchObject({ decision: 'ask', queued: 1 }) // the follow-up flush is told ask again
  expect((f.mem.corrVersions as any)[`corrections/${DS}`].v).toBe(1) // next relay pins it
})

// W25: rows the board already holds (written before the hook kept versions) made every relayed batch refuse and the queue never drained.
test('W25 a stale queue of rows already on the board drains; new rows are still sent; upserts are pinned, not dropped', async ($, on) => {
  const f = rig(on, { decision: 'ask' })
  for (const id of ['hook-W2500000-old1', 'hook-W2500000-old2', 'hook-W2500000-old3']) f.db.set(`corrections/${id}`, { v: 1, data: { n: 1 } })
  f.db.set(`corrections/${DS}`, { v: 4, data: { prompts: 1 } })
  f.mem.corrLog = [row('hook-W2500000-old1', { n: 1 }), row('hook-W2500000-fresh', { n: 9 }), row('hook-W2500000-old2', { n: 1 }), row(DS, { prompts: 5 }), row('hook-W2500000-old3', { n: 1 })]
  await flush($)
  f.clock.now = T0 + RELAY_AGE_MS + MIN
  let rounds = 0
  while ((f.mem.corrLog as any[]).length > 0 && rounds < 10) {
    rounds++
    await prompt($)
    const relay = f.relays().at(-1) as string | undefined
    if (relay === undefined) break
    for (const c of callsOf(relay)) await $.tool.call({ tool: 'ArtifactData', ...c } as any) // the main model sends each call as given
  }
  expect(f.mem.corrLog).toEqual([])
  expect(rounds).toBeLessThanOrEqual(6)
  expect(f.db.get('corrections/hook-W2500000-fresh')?.data).toEqual({ n: 9 }) // the new row was written, not dropped
  expect(f.db.get(`corrections/${DS}`)?.data).toEqual({ prompts: 5 }) // the upsert landed with its version
  expect(f.db.get('corrections/hook-W2500000-old1')?.v).toBe(1) // existing rows untouched
})

// 0.6.50: the hook (always told `ask`) never learns the version of a deepstats- doc already on the board. The old relay put that
// unpinned upsert in the one atomic batch with the new rows, so the server refused the whole batch and nothing landed.
test('0.6.50 an existing deepstats- doc with no known version cannot block the one-shot rows', async ($, on) => {
  const f = rig(on, { decision: 'ask' })
  const DS2 = 'deepstats-session-W1300001-2026-11-13'
  f.db.set(`corrections/${DS}`, { v: 7, data: { prompts: 1 } })
  f.db.set(`corrections/${DS2}`, { v: 3, data: { prompts: 1 } })
  f.mem.corrLog = [row(DS, { prompts: 2 }), row('hook-W1300000-a', { n: 1 }), row(DS2, { prompts: 2 }), row('hook-W1300000-b', { n: 2 })]
  await flush($)
  f.clock.now = T0 + RELAY_AGE_MS + MIN
  await prompt($)
  const relay = f.relays()[0] as string
  const cs = callsOf(relay)
  expect(cs[0].writes.map((w: any) => w.doc_id)).toEqual(['hook-W1300000-a', 'hook-W1300000-b']) // no deepstats- in the batch
  expect(cs.slice(1).map(c => c.writes.length)).toEqual([1, 1])
  // the main model sends them as given: the one-shot rows land even though both upserts are refused (no if_version known)
  for (const c of cs) await $.tool.call({ tool: 'ArtifactData', ...c } as any)
  expect(f.db.get('corrections/hook-W1300000-a')?.data).toEqual({ n: 1 })
  expect(f.db.get('corrections/hook-W1300000-b')?.data).toEqual({ n: 2 })
  expect((f.mem.corrLog as any[]).map(q => q.id).sort()).toEqual([DS, DS2].sort()) // refused upserts stay queued, not lost
  // the refusals taught their versions, so the next relay pins them and they land
  f.clock.now += RELAY_AGE_MS + MIN
  await prompt($)
  for (const c of callsOf(f.relays().at(-1) as string)) await $.tool.call({ tool: 'ArtifactData', ...c } as any)
  expect(f.db.get(`corrections/${DS}`)?.data).toEqual({ prompts: 2 })
  expect(f.db.get(`corrections/${DS2}`)?.data).toEqual({ prompts: 2 })
  expect(f.mem.corrLog).toEqual([])
})

// 0.6.52: a hand-written batch (data differs from the queued copy) refused because the doc already exists must still dequeue the row.
const existsRefusal = (id: string) => `version_mismatch: batch refused, nothing written: write targets corrections/${id}, which already exists, and carried no if_version`
test('0.6.52 a refusal naming an existing queued one-shot doc dequeues it even when the batch data differs', async ($, on) => {
  const f = rig(on, { decision: 'ask', down: existsRefusal('hook-W6520000-a') })
  f.mem.corrLog = [row('hook-W6520000-a', { n: 1 }), row('hook-W6520000-b', { n: 2 })]
  await $.tool.call({ tool: 'ArtifactData', action: 'batch', url: SCOREBOARD_URL, writes: [{ op: 'set', collection: 'corrections', doc_id: 'hook-W6520000-a', data: { n: 1, hand: true } }] } as any)
  expect((f.mem.corrLog as any[]).map(q => q.id)).toEqual(['hook-W6520000-b'])
})
test('0.6.52 a deepstats- row is not dequeued by an already-exists refusal', async ($, on) => {
  const f = rig(on, { decision: 'ask', down: existsRefusal(DS) })
  f.mem.corrLog = [row(DS, { prompts: 3 })]
  await $.tool.call({ tool: 'ArtifactData', action: 'batch', url: SCOREBOARD_URL, writes: [{ op: 'set', collection: 'corrections', doc_id: DS, data: { prompts: 9 } }] } as any)
  expect((f.mem.corrLog as any[]).map(q => q.id)).toEqual([DS])
})
