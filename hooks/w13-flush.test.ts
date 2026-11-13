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
const prompt = async ($: any): Promise<void> => { await $.prompt.submit({ text: 'ok thanks' } as any) }
const DS = 'deepstats-session-W1300000-2026-11-13'
const row = (id: string, data: unknown, collection?: string) => ({ id, data, ...(collection === undefined ? {} : { collection }) })
const QUEUE = () => [row('hook-W1300000-a', { n: 1 }), row(DS, { prompts: 3 })]
const batchOf = (line: string): any => JSON.parse(line.slice(line.indexOf('{"action"')))

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
  expect(input.writes.map((w: any) => w.doc_id)).toEqual(['hook-W1300000-a', DS])
  expect(input.writes[1].if_version).toBe(2)
  expect(input.writes[0].if_version).toBeUndefined()
  await prompt($)
  expect(f.relays().length).toBe(1) // throttled
  expect(f.sbCalls()).toEqual([]) // the hook itself still sent nothing
  // the main model makes the call (its own permission path); the hook absorbs the result
  await $.tool.call({ tool: 'ArtifactData', ...input } as any)
  expect(f.db.get(`corrections/${DS}`)?.v).toBe(3)
  expect(f.mem.corrLog).toEqual([])
  expect((f.mem.corrVersions as any)[`corrections/${DS}`].v).toBe(3)
  expect((f.mem.corrVersions as any)['corrections/hook-W1300000-a'].v).toBe(1)
  expect(f.mem.corrLastFlush).toMatchObject({ decision: 'relay', sent: 2, queued: 0, error: '' })
})

test('W13 relay absorb keeps a row upserted after the relay went out', async ($, on) => {
  const f = rig(on, { decision: 'ask' })
  f.mem.corrLog = QUEUE()
  await flush($)
  f.clock.now = T0 + RELAY_AGE_MS + MIN
  await prompt($)
  const input = batchOf((f.relays()[0] as string).split('\n').find(l => l.includes('scoreboard-flush:')) as string)
  f.mem.corrLog = [row('hook-W1300000-a', { n: 1 }), row(DS, { prompts: 4 })] // turn end upserted the stats row
  await $.tool.call({ tool: 'ArtifactData', ...input } as any)
  expect(f.mem.corrLog).toEqual([row(DS, { prompts: 4 })])
  expect(f.mem.corrLastFlush).toMatchObject({ decision: 'ask', queued: 1 }) // the follow-up flush is told ask again
  expect((f.mem.corrVersions as any)[`corrections/${DS}`].v).toBe(1) // next relay pins it
})
