import { expect, test } from 'claude-code/testing'
import { blindDocxRead, writesUpload } from './guards'

const ok = (on: any) => on('tool.call', () => ({ result: { ok: true } }))
const denied = (r: any): boolean => r?.deny !== undefined || (r?.isError === true && /dispatch-guard/.test(String(r?.text ?? '')))

test('docx .text read: must fire / must not fire', () => {
  expect(blindDocxRead(`python3 -c "import docx; d=docx.Document('a.docx'); print([p.text for p in d.paragraphs])"`)).toBe(true)
  expect(blindDocxRead(`python3 -c "from docx import Document; print(Document('x.docx').paragraphs[0].text)"`)).toBe(true)
  expect(blindDocxRead(`python3 -I docx_tool.py read a.docx`)).toBe(false) // approved reader
  expect(blindDocxRead(`python3 -c "import docx; d=docx.Document(); d.add_paragraph('x'); d.save('new.docx')"`)).toBe(false) // no .text
  expect(blindDocxRead(`grep -c text notes.txt`)).toBe(false)
})

test('uploads writes: must fire / must not fire', () => {
  const U = '/mnt/user-data/uploads'
  expect(writesUpload('Write', { file_path: `${U}/SPA.docx` })).toBe(true)
  expect(writesUpload('Edit', { file_path: `${U}/a.md` })).toBe(true)
  expect(writesUpload('Bash', { command: `echo x > ${U}/a.txt` })).toBe(true)
  expect(writesUpload('Bash', { command: `sed -i 's/a/b/' ${U}/a.txt` })).toBe(true)
  expect(writesUpload('Bash', { command: `rm ${U}/old.pdf` })).toBe(true)
  expect(writesUpload('Bash', { command: `mv ${U}/a.docx /tmp/a.docx` })).toBe(true)
  expect(writesUpload('Bash', { command: `cp /tmp/a.docx ${U}/a.docx` })).toBe(true)
  expect(writesUpload('Bash', { command: `python3 -c "d.save('${U}/a.docx')"` })).toBe(true)
  expect(writesUpload('Bash', { command: `python3 x.py --out "${U}/b.docx"` })).toBe(true)
  // must not fire: reading or copying OUT of uploads, other dirs, quoted prose
  expect(writesUpload('Read', { file_path: `${U}/a.docx` })).toBe(false)
  expect(writesUpload('Write', { file_path: '/mnt/user-data/outputs/a.docx' })).toBe(false)
  expect(writesUpload('Bash', { command: `cp ${U}/a.docx /tmp/work/a.docx` })).toBe(false)
  expect(writesUpload('Bash', { command: `cat ${U}/a.txt > /tmp/a.txt` })).toBe(false)
  expect(writesUpload('Bash', { command: `pdftotext ${U}/a.pdf - | grep -n Price` })).toBe(false)
  expect(writesUpload('Bash', { command: `echo "never rm files" > /tmp/n.txt` })).toBe(false)
})

const ctx = (r: any): string => (r?.context ?? []).join('\n')

test('docx .text read and uploads write: never deny, one context warning per target', async ($, on) => {
  ok(on)
  const cmd = `python3 -c "import docx; print(docx.Document('a.docx').paragraphs[0].text)"`
  const first = await $.tool.call({ tool: 'Bash', command: cmd } as any)
  expect(denied(first)).toBe(false)
  expect(ctx(first)).toContain('docx_tool.py read')
  const again = await $.tool.call({ tool: 'Bash', command: cmd } as any)
  expect(denied(again)).toBe(false)
  expect(ctx(again)).not.toContain('docx_tool.py read') // same target: no second warning
  const other = await $.tool.call({ tool: 'Bash', command: cmd.replace('a.docx', 'b.docx') } as any)
  expect(ctx(other)).toContain('docx_tool.py read') // new target warns afresh
  const up = await $.tool.call({ tool: 'Write', file_path: '/mnt/user-data/uploads/x.docx', content: 'x' } as any)
  expect(denied(up)).toBe(false)
  expect(ctx(up)).toContain('original')
  const up2 = await $.tool.call({ tool: 'Write', file_path: '/mnt/user-data/uploads/x.docx', content: 'y' } as any)
  expect(ctx(up2)).not.toContain('original')
  const plain = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(denied(plain)).toBe(false)
  expect(ctx(plain)).not.toContain('dispatch-guard:') // (other dispatch-guard notes may still apply)
})

test('subagent calls are warned too (uploads are shared), never denied', async ($, on) => {
  ok(on)
  const r1 = await $.tool.call({ tool: 'Bash', command: 'rm /mnt/user-data/uploads/a.pdf', agentId: 'a1' } as any)
  expect(denied(r1)).toBe(false)
  expect(ctx(r1)).toContain('original')
  const r2 = await $.tool.call({ tool: 'Bash', command: 'rm /mnt/user-data/uploads/a.pdf', agentId: 'a1' } as any)
  expect(ctx(r2)).not.toContain('original')
})

const COMPACTED = { messages: [{ role: 'user', text: 'old', toolUses: [] }] } as any
const compactOn = (on: any) => on('session.compact', (_: any, e: any) => { seen.push(e.instructions); return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] } })
const seen: any[] = []
const sid = (on: any) => on('session.id', () => ({ value: 'S1' }))

test('no compaction: no note on a tool result or a prompt', async ($, on) => {
  ok(on); sid(on)
  expect(ctx(await $.tool.call({ tool: 'Read', file_path: '/x' } as any))).not.toContain('compact')
})

test('after a main-thread compaction the pointer note rides the next tool result once, even when a higher-priority prompt.context hook never calls next', async ($, on) => {
  ok(on); sid(on); compactOn(on)
  on('prompt.context', () => ({ blocks: [] })) // stands for a plugin that never calls next
  await $.session.compact(COMPACTED)
  expect(seen.at(-1)).toContain('Keep Next, In flight')
  const first = await $.tool.call({ tool: 'Read', file_path: '/x' } as any)
  expect(ctx(first)).toMatch(/ompact/)
  expect(ctx(await $.tool.call({ tool: 'Read', file_path: '/x' } as any))).not.toMatch(/ompact/)
})

test('the pointer note rides the next prompt when it comes first, then not again', async ($, on) => {
  ok(on); sid(on); compactOn(on)
  const got: string[] = []
  on('prompt.submit', (_: any, e: any) => { got.push((e.context ?? []).join('\n')); return { text: e.text, context: e.context } })
  await $.session.compact(COMPACTED)
  await $.prompt.submit({ text: 'next' } as any)
  expect(got[0]).toMatch(/ompact/)
  await $.prompt.submit({ text: 'again' } as any)
  expect(got[1]).not.toMatch(/ompact/)
  expect(ctx(await $.tool.call({ tool: 'Read', file_path: '/x' } as any))).not.toMatch(/ompact/)
})

test('a skipped or precomputed compaction, and a subagent one, owe nothing', async ($, on) => {
  ok(on); sid(on)
  on('session.compact', () => ({ skip: 'off' }))
  await $.session.compact(COMPACTED)
  expect(ctx(await $.tool.call({ tool: 'Read', file_path: '/x' } as any))).not.toMatch(/ompact/)
})
