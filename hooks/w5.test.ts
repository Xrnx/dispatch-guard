import { expect, test } from 'claude-code/testing'
import { closureMisses, nextAction, actsOf, setRules } from './register'
import { bundledRules } from './rulepack'

// W5 judge/check false-alarm audit (live 0.6.32, 13 Nov 15:14-15:16 SGT). Real denied line, quoted in guard-rounds/DRAFT-REVIEW.md "Live 0.6.32 note".
const LIVE = 'Correction: that prevention is a written rule in my job queue, not an automatic check.'
const QUEUE_EDIT = actsOf({ tool: 'Edit', file_path: '/home/claude/improve/queue.md', old_string: 'x', new_string: "speed metric ending where J's experience ends (his final answer, corrections included)" }, 'The file /home/claude/improve/queue.md has been updated successfully.')
const OTHER_EDIT = actsOf({ tool: 'Edit', file_path: '/home/claude/improve/w5/src/hooks/register.ts', old_string: 'a', new_string: 'b' }, 'The file has been updated successfully.')

test('W5 closure-line: a light Correction restating what a thing is ("X is Y, not Z") is not an unclosed change', () => {
  setRules(bundledRules())
  expect(closureMisses(LIVE, {})).toEqual([])
  expect(closureMisses(LIVE, { changed: true })).toEqual([])
  expect(closureMisses(`Done.\n\n**${LIVE.replace('Correction:', 'Correction:**')}`, {})).toEqual([])
})

test('W5 closure-line: the same shape still fires when it defers, promises or admits a miss', () => {
  setRules(bundledRules())
  for (const t of [
    'Correction: that prevention is a rule I will add to my job queue, not an automatic check.',
    "Correction: that prevention is a rule I'll add to my job queue, not an automatic check.",
    'Correction: that prevention is queued for the next build, not an automatic check.',
    'Correction: that prevention is a backlog rule, not an automatic check.',
    'Correction: I was wrong, that prevention is a written rule in my job queue, not an automatic check.',
  ]) expect([t, closureMisses(t, {}).length]).toEqual([t, 1])
})

test('W5 next-action: a plan-word line naming a file this turn already wrote gets "done in <file>", not a build agent', () => {
  setRules(bundledRules())
  const a = nextAction(LIVE, { acts: QUEUE_EDIT })
  expect(a.kind).toBe('plan')
  expect(a.call).not.toContain('Agent(')
  expect(a.call).toContain('/home/claude/improve/queue.md')
  expect(a.close).toBe('— done in /home/claude/improve/queue.md')
})

test('W5 next-action: a plan line with no write, or a write to an unrelated file, still gets the build-agent hint', () => {
  setRules(bundledRules())
  const t = '**Prevention (requested, not built):** a rule in my job queue so agent briefs re-check claims.'
  expect(nextAction(t, { acts: [] }).call).toContain('Agent(')
  expect(nextAction(t, { acts: OTHER_EDIT }).call).toContain('Agent(')
  expect(nextAction(LIVE, { acts: [] }).call).toContain('Agent(')
})
