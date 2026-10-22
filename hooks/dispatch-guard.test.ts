import { expect, test } from 'claude-code/testing'

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

test('flags long-looking foreground Bash, not background Bash', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  expect(ctx(await $.tool.call({ tool: 'Bash', command: 'npm test' } as any))).toMatch(BASH)
  expect(ctx(await $.tool.call({ tool: 'Bash', command: 'npm test', run_in_background: true } as any))).not.toMatch(BASH)
  expect(ctx(await $.tool.call({ tool: 'Bash', command: 'ls' } as any))).not.toMatch(BASH)
})
