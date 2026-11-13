import { expect, test } from 'claude-code/testing'
import { claimLookups, resolveLookups, lookupText, judgeClaims, evidenceFirstHit, setRules, resetClockOffset } from './register'
import { bundledRules } from './rulepack'

// W2 (13 Nov 2026): the evidence-first and judge-(b) denials name the exact lookup per claim type.
// Fixtures: live drafts from the main chat's check_reply calls, 13 Nov 2026 (transcript, verbatim lines).
const D49 = 'Confirmed: 0.6.29 is now installed. I\'ve marked it live on the Scoreboard and closed its upload card on the board.' // 13:17 SGT, judge (a)
const D18 = '2. **Same build (running):** the "no conceding without proof" rule, plus a hook that runs the needed lookups before drafting. Missing lookups are the top cause of failed drafts, 30 of 67.' // 08:48, evidence-first
const D10 = '- **Clean first drafts:** 4.8% vs 21.5% live; stricter checks now catch work left undone and missing lookups.' // 08:00, judge (b)
const D10E = '- **Efficiency:** none; every result reached the board when it landed.' // 08:00, judge (b)/(d)
const D39 = 'About 45 minutes, estimated: 0.6.29 is being built now, and I\'ll send the zip here.' // 12:41, evidence-first
const D24 = '0.6.27 is live. 0.6.28 is being scored, due about 11:45.' // 09:34, judge (b)
const D17 = '- **Covers:** every agent brief and my own runs.' // 08:46, judge (e)
const kinds = (t: string) => claimLookups(t).map(l => l.kind)
const kindOf = (t: string, k: string) => claimLookups(t).find(l => l.kind === k)

test('W2 claim type: plugin version → synced plugin.json grep', () => {
  setRules(bundledRules())
  const v = kindOf(D49, 'version')
  expect(v?.lookup).toMatch(/plugins\/synced\/\*\/\*\/\.claude-plugin\/plugin\.json/)
  expect(v?.claims[0]).toMatch(/0\.6\.29 is now installed/)
})

test('W2 claim type: agent/job status → board status rows (ArtifactData list)', () => {
  setRules(bundledRules())
  for (const d of [D18, D39, D24]) expect([d.slice(0, 20), kindOf(d, 'status')?.lookup]).toEqual([d.slice(0, 20), expect.stringMatching(/ArtifactData list, collection "status".*1pV8oEewdbsBMqi6EYDAA8/)])
})

test('W2 claim type: figure → the file or report it came from', () => {
  setRules(bundledRules())
  for (const d of [D18, D10, 'Saves roughly $300 a week.', 'Riven finder ~1.85x faster.']) expect([d.slice(0, 20), kindOf(d, 'figure')?.lookup]).toEqual([d.slice(0, 20), expect.stringMatching(/file or report the figure came from/)])
  expect(kindOf('dispatch-guard 0.6.29 shipped', 'figure')).toBeUndefined() // a version is not a figure
})

test('W2 claim type: time → the clock', () => {
  setRules(bundledRules())
  for (const d of [D39, D24, 'ETA 15:00.']) expect([d.slice(0, 20), kindOf(d, 'time')?.lookup]).toEqual([d.slice(0, 20), expect.stringMatching(/TZ=Asia\/Singapore date/)])
  expect(kindOf('dispatch-guard 0.6.29', 'time')).toBeUndefined() // "6.29" is not a clock time
})

test('W2 claim type: link → HTTP status', () => {
  setRules(bundledRules())
  const l = kindOf('Buy link: https://shop.example.sg/item/42 (in stock).', 'link')
  expect(l?.lookup).toMatch(/http_code/)
  expect(l?.targets).toEqual(['https://shop.example.sg/item/42'])
})

test('W2 claim type: local file, live, verified, done, coverage', () => {
  setRules(bundledRules())
  expect(kindOf('Saved to /home/claude/improve/dg-W2/W2.patch.', 'path')?.targets).toEqual(['/home/claude/improve/dg-W2/W2.patch'])
  expect(kindOf(D24, 'live')?.lookup).toMatch(/plugin\.json grep.*Artifact read/)
  expect(kindOf(D49, 'done')?.lookup).toMatch(/write's own result/)
  expect(kindOf(D10E, 'done')).toBeDefined()
  expect(kindOf(D17, 'coverage')?.lookup).toMatch(/whole set/)
  expect(kindOf('Because the hook only reminds me to check. Verified in the plugin code.', 'verified')?.lookup).toMatch(/test run or source/) // live 08:43, judge (b)
  expect(kindOf(D49, 'verified')).toBeDefined()
})

test('W2 no loosening: the gate trigger is unchanged; the table only adds text', () => {
  setRules(bundledRules())
  for (const d of [D49, D39, D24]) expect(evidenceFirstHit(d, '')).toBe(true)
  expect(evidenceFirstHit(D18, '')).toBe(false) // this line alone never tripped the gate (its draft did, on other lines): the table adds no trigger
  expect(evidenceFirstHit('Noted. Two options left.', '')).toBe(false)
  expect(kinds('Noted. Two options left.')).toEqual([])
  expect(claimLookups(`${D49}\n${D18}\n${D10}\n${D39}\n${D17}\nhttps://x.example/a /tmp/a`, 6).length).toBe(6) // capped
})

test('W2 judge (b): the quoted claims are classified, not the judge commentary', () => {
  setRules(bundledRules())
  const p = '"Two new checks (running)... False alarms cut; tests next" and "Blocker cleared" claim work done/verified: evidence shows only an agent report that fixes were applied, not verified tests.'
  expect(judgeClaims(p)).toBe('Two new checks (running)... False alarms cut; tests next\nBlocker cleared')
  expect(claimLookups(judgeClaims(p), 3).map(l => l.kind)).toEqual(['status'])
  expect(judgeClaims('no quote here at all')).toBe('no quote here at all')
})

// Fake engine surface for the hook-run lookups: one synced dispatch-guard plugin.json, a clock, one existing file.
const SR = '/root/.claude/plugins/synced'
const fake = (sleeps = false) => {
  const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
  const files: Record<string, { text: string; mtimeMs: number }> = {
    [`${SR}/plug_1/dispatch-guard/.claude-plugin/plugin.json`]: { text: '{"name":"dispatch-guard","version":"0.6.29"}', mtimeMs: Date.parse('2026-11-13T13:10:00+08:00') },
    '/home/claude/improve/dg-W2/W2.patch': { text: 'x', mtimeMs: Date.parse('2026-11-13T13:50:00+08:00') },
  }
  const net: string[] = []
  return {
    net,
    $: {
      session: { cwd: async () => '/w', id: async () => 's' },
      clock: { now: async () => Date.parse('2026-11-13T13:45:00+08:00'), sleep: async (ms: number) => { if (sleeps) await new Promise(r => setTimeout(r, Math.min(ms, 5))); else await new Promise(() => {}) } },
      http: { fetch: async (u: string) => { net.push(u); return { status: 200 } } },
      fs: {
        list: async (p: string) => p === SR ? [{ name: 'plug_1' }] : p === `${SR}/plug_1` ? [{ name: 'dispatch-guard' }] : enoent(),
        read: async (p: string) => files[p]?.text ?? enoent(),
        stat: async (p: string) => files[p] === undefined ? enoent() : { mtimeMs: files[p].mtimeMs },
      },
    } as any,
  }
}

test('W2 hook-run lookups: version from the synced plugin.json, clock, file existence; never network, never status', async () => {
  setRules(bundledRules())
  resetClockOffset()
  const { $, net } = fake()
  const ls = claimLookups(`${D49}\n${D39}\nSaved to /home/claude/improve/dg-W2/W2.patch and /tmp/nope.txt.\nSee https://x.example/a`, 10)
  const rd = await resolveLookups($, ls)
  expect(rd.get('version')).toMatch(/dispatch-guard 0\.6\.29 \(13:10\)/)
  expect(rd.get('time')).toBe('now 2026-11-13T13:45:00+08:00 (SGT)')
  expect(rd.get('path')).toBe('/home/claude/improve/dg-W2/W2.patch exists, modified 2026-11-13T13:50 SGT; /tmp/nope.txt not found')
  expect(rd.has('status')).toBe(false)
  expect(rd.has('link')).toBe(false)
  expect(net).toEqual([])
  const t = lookupText(ls, rd)
  expect(t).toMatch(/^Lookup per claim type: a\) link/)
  expect(t).toMatch(/version \("Confirmed: 0\.6\.29 is now installed[\s\S]*?\): plugin: grep .* Hook read \(read-only, just now; cite it as hook evidence, no extra call needed\): synced: dispatch-guard 0\.6\.29/)
})

test('W2 hook-run lookups: a slow read is cut at the budget and the deny still goes out', async () => {
  setRules(bundledRules())
  const { $ } = fake(true)
  $.fs.list = () => new Promise(() => {}) // hangs
  const rd = await resolveLookups($, claimLookups(D49), 5)
  expect(rd.has('version')).toBe(false)
})
