import { expect, test } from 'claude-code/testing'
import { setRules, CHECK_TOOL } from './register'
import { bundledRules } from './rulepack'

const engine = (on: any) => {
  const mem: Record<string, unknown> = {}
  on('store.get', (_$: any, e: any) => ({ value: mem[e.key] }))
  on('store.set', (_$: any, e: any) => { mem[e.key] = e.value; return { value: undefined } })
  setRules(bundledRules())
  on('http.fetch', () => ({ value: { status: 404, ok: false, headers: {}, text: '404: Not Found' } }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"ok":true,"problems":[]}', usage: {} } }))
  on('session.id', () => ({ value: 'session-FF' }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {}, text: '' }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text, context: e.context }))
}
const turn = (id: string) => ({ text: 'go', turnId: id } as any)
const check = (t: string) => ({ tool: CHECK_TOOL, text: t } as any)
const BADC = 'Correction: the date was wrong.'
const CLEAN = 'Noted. Two options left.'

test('footer-first: round 1 of a failing draft already names "Efficiency: none" (it is refused on the retry anyway)', async ($, on) => {
  engine(on)
  await $.turn.start(turn('t1'))
  const f = await $.tool.call(check(`${BADC}\n**Efficiency:** none`)) as any
  expect(f.result).toMatch(/Correction without a "Prevention:" line/)
  expect(f.result).toMatch(/Efficiency: none/)
})

test('footer-first: a clean draft with "Efficiency: none" still passes round 1 (pass/fail unchanged)', async ($, on) => {
  engine(on)
  await $.turn.start(turn('t1'))
  expect(((await $.tool.call(check(`${CLEAN}\n**Efficiency:** none`))) as any).result).toMatch(/^PASS /)
})

test('footer-first: both Prevention-line misses reported in round 1 of one check_reply call', async ($, on) => {
  engine(on)
  await $.turn.start(turn('t1'))
  const f = await $.tool.call(check('Fixed.\nPrevention: added a check.\nCorrection: date wrong.')) as any
  expect(f.result).toMatch(/Why you caught it/)
})
