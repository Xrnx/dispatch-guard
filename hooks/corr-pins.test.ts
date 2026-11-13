import { expect, test } from 'claude-code/testing'
import { confirmedWrites, refusedEntry, pruneVers, CORR_VER_TTL_MS, CORR_VER_KEEP, SCOREBOARD_URL } from './register'

// W11: a fake ArtifactData with the service's write rules — a write to an existing doc with no if_version refuses the whole batch
// (naming the first such entry, no version); a stale pin refuses it naming the current version; `poison` docs are always refused.
const T0 = Date.parse('2026-11-13T08:00:00Z')
const fakeDb = (on: any, opts: { poison?: Set<string>; unnamed?: Set<string>; down?: boolean } = {}) => {
  const mem: Record<string, unknown> = {}
  const db = new Map<string, { v: number; data: unknown }>()
  const calls: any[] = []
  const clock = { now: T0 }
  on('store.get', (_$: any, e: any) => ({ value: mem[e.key] }))
  on('store.set', (_$: any, e: any) => { mem[e.key] = e.value; return { value: undefined } })
  on('session.id', () => ({ value: 'session-W1100000' }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: clock.now }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', (_$: any, e: any) => {
    calls.push(e)
    if (e.tool !== 'ArtifactData') return { result: {}, text: '' }
    if (e.url !== SCOREBOARD_URL) return { result: {}, text: '' } // the session's own write that triggers the flush
    if (opts.down) return { isError: true, result: {}, text: 'Service unavailable (503)' }
    if (e.action === 'get') {
      const d = db.get(`${e.collection}/${e.doc_id}`)
      return d === undefined ? { isError: true, result: {}, text: `Document "${e.collection}"/"${e.doc_id}" not found.` } : { result: {}, text: JSON.stringify({ doc_id: e.doc_id, version: d.v, data: d.data }) }
    }
    for (const w of e.writes) {
      const k = `${w.collection}/${w.doc_id}`
      const cur = db.get(k)
      if (opts.unnamed?.has(w.doc_id)) return { isError: true, result: {}, text: 'Batch refused: one entry failed validation; nothing written.' }
      if (opts.poison?.has(w.doc_id)) return { isError: true, result: {}, text: `Batch refused at set "${w.collection}"/"${w.doc_id}": data rejected by the page's rules; nothing written.` }
      if (cur !== undefined && w.if_version === undefined) return { isError: true, result: {}, text: `Batch refused: set "${w.collection}"/"${w.doc_id}" targets an existing document and carries no if_version; read it first. Nothing written.` }
      if (cur !== undefined && w.if_version !== cur.v) return { isError: true, result: {}, text: `Batch refused: set "${w.collection}"/"${w.doc_id}" if_version ${w.if_version} is stale; current version is ${cur.v}. Nothing written.` }
      if (cur === undefined && w.if_version !== undefined) return { isError: true, result: {}, text: `Batch refused: set "${w.collection}"/"${w.doc_id}" is pinned but does not exist. Nothing written.` }
    }
    const lines = e.writes.map((w: any) => {
      const k = `${w.collection}/${w.doc_id}`
      const v = (db.get(k)?.v ?? 0) + 1
      db.set(k, { v, data: w.data })
      return `set "${w.collection}"/"${w.doc_id}" (version ${v})`
    })
    return { result: {}, text: `Batch applied atomically (${lines.length} writes):\n${lines.join('\n')}` }
  })
  const batches = () => calls.filter(c => c.tool === 'ArtifactData' && c.action === 'batch')
  const gets = () => calls.filter(c => c.tool === 'ArtifactData' && c.action === 'get')
  return { mem, db, calls, clock, batches, gets }
}
// The flush runs (as in production) right after a main-thread ArtifactData write passes; the test `$` is the engine's, not the plugin's.
const flush = async ($: any): Promise<void> => { await $.tool.call({ tool: 'ArtifactData', action: 'set', url: 'https://claude.ai/artifact/x', collection: 'status', doc_id: 'trigger', data: {} }) }
const DS = 'deepstats-session-W1100000-2026-11-13'
const row = (id: string, data: unknown, collection?: string) => ({ id, data, ...(collection === undefined ? {} : { collection }) })

test('W11 parsers: confirmed writes, the refused entry and its current version', () => {
  expect(confirmedWrites('ok:\nset "corrections"/"a-1" (version 2)\nset "fixes"/"f-auto-dg0633" (version 1)')).toEqual([{ key: 'corrections/a-1', v: 2 }, { key: 'fixes/f-auto-dg0633', v: 1 }])
  expect(refusedEntry('set "corrections"/"x-12" if_version 1 is stale; current version is 3', ['x-1', 'x-12'])).toEqual({ id: 'x-12', v: 3 })
  expect(refusedEntry('entry "x-12" exists at version 4 (you sent if_version 2)', ['x-12'])).toEqual({ id: 'x-12', v: 4 })
  expect(refusedEntry('entry "x-12" carries no if_version', ['x-12'])).toEqual({ id: 'x-12' })
  expect(refusedEntry('one entry failed', ['x-12'])).toBeUndefined()
})

test('W11 (a) the second upsert of a deep-stats row lands, pinned from the stored version', async ($, on) => {
  const f = fakeDb(on)
  f.mem.corrLog = [row(DS, { prompts_judged: 1 })]
  await flush($)
  expect(f.db.get(`corrections/${DS}`)?.v).toBe(1)
  f.mem.corrLog = [row(DS, { prompts_judged: 2 }), row('auto-W1100000-a', { n: 1 }), row('hook-W1100000-b', { n: 2 })]
  await flush($)
  expect(f.db.get(`corrections/${DS}`)).toEqual({ v: 2, data: { prompts_judged: 2 } })
  expect(f.batches().length).toBe(2) // no refusal, no retry
  expect(f.batches()[1].writes[0].if_version).toBe(1)
  expect(f.batches()[1].writes[1].if_version).toBeUndefined()
  expect(f.mem.corrLog).toEqual([])
  expect((f.mem.corrVersions as any)[`corrections/${DS}`].v).toBe(2)
})

test('W11 (a) an existing doc the map does not know: refused, one get, retried once, everything lands', async ($, on) => {
  const f = fakeDb(on)
  f.db.set(`corrections/${DS}`, { v: 1, data: {} }) // written by an earlier version (every deepstats row is stuck at version 1)
  f.db.set('fixes/f-auto-dg0633', { v: 1, data: {} })
  f.mem.corrLog = [row('j-W1100000-1', { n: 1 }), row(DS, { prompts_judged: 5 }), row('f-auto-dg0633', { title: 't' }, 'fixes'), row('auto-W1100000-c', { n: 3 })]
  await flush($)
  expect(f.db.get(`corrections/${DS}`)).toEqual({ v: 2, data: { prompts_judged: 5 } })
  expect(f.db.get('fixes/f-auto-dg0633')?.v).toBe(2)
  expect(f.gets().map(g => g.doc_id)).toEqual([DS, 'f-auto-dg0633'])
  expect(f.batches().length).toBe(3)
  expect(f.mem.corrLog).toEqual([])
})

test('W11 (a) a stale pin is corrected from the error, no get', async ($, on) => {
  const f = fakeDb(on)
  f.db.set(`corrections/${DS}`, { v: 3, data: {} })
  f.mem.corrVersions = { [`corrections/${DS}`]: { v: 1, at: T0 } }
  f.mem.corrLog = [row(DS, { prompts_judged: 7 }), row('auto-W1100000-d', { n: 4 })]
  await flush($)
  expect(f.db.get(`corrections/${DS}`)?.v).toBe(4)
  expect(f.gets().length).toBe(0)
  expect(f.batches().map(b => b.writes[0].if_version)).toEqual([1, 3])
})

test('W11 (b) a refused entry does not block the others and stays queued', async ($, on) => {
  const f = fakeDb(on, { poison: new Set(['auto-W1100000-bad']) })
  f.mem.corrLog = [row('auto-W1100000-bad', { n: 0 }), row('auto-W1100000-e', { n: 1 }), row(DS, { prompts_judged: 1 })]
  await flush($)
  expect(f.db.has('corrections/auto-W1100000-e')).toBe(true)
  expect(f.db.has(`corrections/${DS}`)).toBe(true)
  expect((f.mem.corrLog as any[]).map(q => q.id)).toEqual(['auto-W1100000-bad'])
  expect(f.batches().length).toBeLessThanOrEqual(3)
})

test('W11 (b) an unnamed refusal is halved until the bad entry is alone', async ($, on) => {
  const f = fakeDb(on, { unnamed: new Set(['auto-W1100000-u']) })
  const ids = ['auto-W1100000-1', 'auto-W1100000-2', 'auto-W1100000-u', 'auto-W1100000-4', 'auto-W1100000-5']
  f.mem.corrLog = ids.map(id => row(id, { id }))
  await flush($)
  expect((f.mem.corrLog as any[]).map(q => q.id)).toEqual(['auto-W1100000-u'])
  expect(f.batches().length).toBeLessThanOrEqual(10)
})

test('W11 (b) a non-refusal error (service down) keeps everything queued and stops after one call', async ($, on) => {
  const f = fakeDb(on, { down: true })
  f.mem.corrLog = [row('auto-W1100000-1', {}), row(DS, {})]
  await flush($)
  expect((f.mem.corrLog as any[]).length).toBe(2)
  expect(f.batches().length + f.gets().length).toBe(1)
})

test('W11 (c) the version map is used, then pruned by age unless the doc is still queued', async ($, on) => {
  const f = fakeDb(on)
  f.mem.corrLog = [row(DS, { a: 1 }), row('auto-W1100000-f', { a: 2 })]
  await flush($)
  expect(Object.keys(f.mem.corrVersions as any).sort()).toEqual(['corrections/auto-W1100000-f', `corrections/${DS}`])
  f.clock.now = T0 + CORR_VER_TTL_MS + 60_000
  f.mem.corrLog = [row('auto-W1100000-g', { a: 3 })]
  await flush($)
  expect(Object.keys(f.mem.corrVersions as any)).toEqual(['corrections/auto-W1100000-g'])
  // a stale entry whose doc is still queued is kept (its pin is needed)
  const m = { 'corrections/old': { v: 4, at: T0 }, 'corrections/gone': { v: 2, at: T0 } }
  expect(Object.keys(pruneVers(m, [{ id: 'old' }], T0 + CORR_VER_TTL_MS + 1))).toEqual(['corrections/old'])
  // size cap keeps the newest
  const big = Object.fromEntries(Array.from({ length: CORR_VER_KEEP + 5 }, (_, i) => [`corrections/r${i}`, { v: 1, at: T0 + i }]))
  const p = pruneVers(big, [], T0 + CORR_VER_KEEP + 5)
  expect(Object.keys(p).length).toBe(CORR_VER_KEEP)
  expect(p['corrections/r0']).toBeUndefined()
  expect(p[`corrections/r${CORR_VER_KEEP + 4}`]).toBeDefined()
})

test('W11 batches still go to the Scoreboard', async ($, on) => {
  const f = fakeDb(on)
  f.mem.corrLog = [row('auto-W1100000-h', {})]
  await flush($)
  expect(f.batches()[0].url).toBe(SCOREBOARD_URL)
})
