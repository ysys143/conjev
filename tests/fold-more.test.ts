// What the fold keeps beyond tool results, and how it treats the turn around it:
// large tool inputs (D4), the conversation a summary replaces (E2), the
// person's /compact instructions (E3), the interval between compactions (D5),
// the Stop gate during the cleanup a fold asks for (A6), and the excerpt the
// fold judgment sends (E6/F4).
import type { HttpResponse, SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { DEFAULT_SETTINGS, FOLD_MARK, conversationArchive, foldTranscript, makePolicy } from '../hooks/fold'
import { EXCERPT_CHARS } from '../hooks/fold-judge'
import { PRESERVE_INSTRUCTIONS } from '../hooks/register'
import { compactReport, type ShadowRecord } from '../hooks/report'
import { HOME, KEY_ENV, drain, prompt, records, settle, setup, smallRounds } from './kit'

const call = (id: string, tool: string, input: Record<string, unknown>): SessionMessage => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] })
const answer = (id: string, text: string): SessionMessage => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError: false }] })
const ARCHIVE = `${HOME}/.conjev/state/archive/sess-1`
const BODY = 'export const a = 1\n'.repeat(200)
const START = { cwd: '/proj', surface: 'terminal', isInteractive: true } as never

// D4. Ten small rounds between the two Writes put the first one twelve model
// turns back and leave the second in the turn in view.
const WRITES: SessionMessage[] = [
  prompt('Write the module'),
  call('w', 'Write', { file_path: '/proj/a.ts', content: BODY }),
  answer('w', 'File written'),
  call('e', 'Edit', { file_path: '/proj/b.ts', old_string: 'x', new_string: 'y' }),
  answer('e', 'ok'),
  prompt('next'),
  ...smallRounds(10, 'l'),
  prompt('and next'),
  call('w2', 'Write', { file_path: '/proj/c.ts', content: BODY }),
  answer('w2', 'File written'),
]

test('an older Write body leaves the window as a pointer; a small edit and a recent one stay', () => {
  const out = foldTranscript(WRITES, makePolicy(DEFAULT_SETTINGS))
  const old = out.messages[1]!.toolUses[0]!.input as Record<string, unknown>

  expect(String(old.content).startsWith(`${FOLD_MARK}input · Write · /proj/a.ts`)).toBe(true)
  expect(String(old.content)).toContain('read_coordinate("w:input")')
  expect(old.file_path).toBe('/proj/a.ts')
  // Too small to be worth a pointer, and too recent: both whole.
  expect(out.messages[3]).toBe(WRITES[3])
  expect(out.messages.at(-2)).toBe(WRITES.at(-2))
  expect(out.archived.map(a => a.id)).toEqual(['w:input'])
  expect(out.archived[0]!.text).toBe(`--- content ---\n${BODY}`)
  expect(out.savedChars).toBeGreaterThan(BODY.length - 200)
})

test('a long Bash command folds too, and a folded input is not folded again', () => {
  const command = `python3 - <<'EOF'\n${'print(1)\n'.repeat(200)}EOF`
  const messages = [prompt('run it'), call('b', 'Bash', { command, description: 'run' }), answer('b', 'ok'), ...smallRounds(10), prompt('next'), prompt('and next')]
  const once = foldTranscript(messages, makePolicy(DEFAULT_SETTINGS))
  const input = once.messages[1]!.toolUses[0]!.input as Record<string, unknown>

  expect(String(input.command).startsWith(`${FOLD_MARK}input · Bash · python3 -`)).toBe(true)
  expect(input.description).toBe('run')
  expect(foldTranscript(once.messages, makePolicy(DEFAULT_SETTINGS)).archived).toEqual([])
})

test('a compaction keeps a folded body, and read_coordinate returns it', async ($, on) => {
  const io = setup(on, { transcript: WRITES, messages: WRITES })
  await $.session.start(START)
  const out = await $.session.compact({ trigger: 'manual', messages: WRITES } as never)

  expect(String((out.messages?.[1]?.toolUses[0]?.input as Record<string, unknown>).content).startsWith(FOLD_MARK)).toBe(true)
  expect(io.writes.some(w => w.path === `${ARCHIVE}/w_input.json`)).toBe(true)
  const read = await $.tool.call({ tool: 'mcp__conjev__read_coordinate', id: 'w:input', full: true } as never)
  expect(String(read.result)).toContain('export const a = 1')
})

// E2 and E3. The Read is ten model turns back, so it folds under the default.
const OLD: SessionMessage[] = [prompt('Look at a.ts'), call('a', 'Read', { file_path: '/proj/a.ts' }), answer('a', 'x\n'.repeat(1500)), prompt('next'), ...smallRounds(10), prompt('and next')]
const SMALL: SessionMessage[] = [prompt('What does the parser do?'), { role: 'assistant', text: 'It splits the input into tokens.', toolUses: [] }]

test('a summary over nothing foldable keeps the conversation it replaces first, and points to it', async ($, on) => {
  const io = setup(on, { transcript: SMALL })
  await $.session.start(START)
  const out = await $.session.compact({ trigger: 'manual', messages: SMALL } as never)

  const kept = io.writes.find(w => w.path.startsWith(`${ARCHIVE}/conversation-`))
  expect(kept).toBeDefined()
  expect(JSON.parse(kept!.text).text).toContain('It splits the input into tokens.')
  const id = JSON.parse(kept!.text).id as string
  expect(out.messages?.at(-1)?.text).toContain(`read_coordinate("${id}")`)
  const read = await $.tool.call({ tool: 'mcp__conjev__read_coordinate', id, full: true } as never)
  expect(String(read.result)).toContain('What does the parser do?')
})

test('a partial summary keeps the older part it replaces, beside the folded results', { options: { foldJev: 'off' } }, async ($, on) => {
  // A tiny window, so the fold alone leaves it crowded and the older part is summarized.
  const io = setup(on, { transcript: OLD, window: 10 })
  await $.session.start(START)
  const out = await $.session.compact({ trigger: 'manual', messages: OLD } as never)

  expect(io.summarizedOver.length).toBe(1)
  const pointer = out.messages?.find(m => m.text.includes('The summary above replaced'))?.text ?? ''
  expect(pointer).toContain('[folded conversation')
  expect(pointer).toContain('read_coordinate("a")')
})

test('the summary is told what the person typed after /compact first, then to keep their words and the pointers', async ($, on) => {
  const io = setup(on, { transcript: SMALL })
  await $.session.start(START)
  await $.session.compact({ trigger: 'manual', messages: SMALL, instructions: 'focus on the parser' } as never)

  expect(io.summarizedWith).toEqual([`focus on the parser\n\n${PRESERVE_INSTRUCTIONS}`])
})

test('with nothing typed after /compact the summary still gets the plugin\'s request', async ($, on) => {
  const io = setup(on, { transcript: OLD, window: 10 })
  await $.session.start(START)
  await $.session.compact({ trigger: 'auto', messages: OLD } as never)

  expect(io.summarizedWith).toEqual([PRESERVE_INSTRUCTIONS])
  expect(PRESERVE_INSTRUCTIONS).toContain('[folded ')
})

test('the conversation archive holds each message, its calls and its results', () => {
  const item = conversationArchive(OLD, 'conversation-x')

  expect(item.text).toContain('## user\nLook at a.ts')
  expect(item.text).toContain('-> Read {"file_path":"/proj/a.ts"} (a)')
  expect(item.text).toContain('<- a\nx\n')
})

// D5
test('each compaction records how many prompts, turns and how long since the one before', async ($, on) => {
  const io = setup(on, { transcript: OLD, startedAt: 1_700_000_000_000 })
  await $.session.start(START)
  await $.prompt.submit({ text: 'one', wait: false, origin: { kind: 'composer' } } as never)
  await $.prompt.submit({ text: 'two', wait: false, origin: { kind: 'composer' } } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  await $.prompt.submit({ text: 'three', wait: false, origin: { kind: 'composer' } } as never)
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)

  const facts = records(io.writes, 'compact').map(r => r.facts as Record<string, string>)
  expect(facts.map(f => [f.sincePrompts, f.sinceTurns])).toEqual([['2', '1'], ['1', '0']])
  expect(Number(facts[0]!.sinceMs)).toBeGreaterThan(0)
})

test('/jev-report sums up the intervals between compactions', () => {
  const rec = (sincePrompts: string, sinceTurns: string, sinceMs: string): ShadowRecord => ({
    id: 'x', ts: 't', sessionId: 's', point: 'compact', mode: 'active', sent: null, hookMs: 5, decision: 'folded', facts: { trigger: 'auto', sincePrompts, sinceTurns, sinceMs },
  })
  const text = compactReport([rec('4', '3', '60000'), rec('10', '8', '600000'), rec('2', '2', '30000')]) ?? ''

  expect(text).toContain('between compactions: prompts p50 4, turns p50 3, time p50 60.0s')
})

// A6
const ANNOUNCE: HttpResponse = {
  status: 200,
  ok: true,
  headers: {},
  text: JSON.stringify({ model: 'jev-1.14.0', answers: { stop: { type: 'choice', choice: 'announce', confidence: 0.98, probabilities: { announce: 0.99, report: 0.01 } } }, usage: { input_tokens: 1, output_tokens: 1 } }),
}
const STOP = { stop_hook_active: false, last_assistant_message: 'Next, I will update PHASE.md.' } as never

test('the turn that answers the fold\'s request to update the status board is not held by the Stop gate', { options: { stopGate: 'active', phaseFile: '/proj/PHASE.md' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: () => ANNOUNCE, messages: OLD, percent: 90, files: { '/proj/PHASE.md': '# PHASE\n' }, mtimes: { '/proj/PHASE.md': 1000 }, startedAt: 2000 })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle(() => io.appended.length > 0)
  expect(io.appended.join()).toContain('consolidate')

  // The cleanup turn: let through, recorded as such, Jev not asked.
  expect((await $.classic.Stop(STOP)).block).toBe(undefined)
  await drain()
  expect(records(io.writes, 'stop')[0]?.skipped).toBe('fold-cleanup')
  expect(io.fetches.length).toBe(0)
  // The turn after it is judged again.
  expect((await $.classic.Stop(STOP)).block).toBeDefined()
})

// E6/F4
test('the fold judgment sends the opening of each result, personal information masked and cut to the limit', { options: { foldJev: 'shadow' } }, async ($, on) => {
  const text = `연락처 010-1234-5678, 담당 a@b.co\n${'y'.repeat(5000)}`
  const messages = [prompt('Look at it'), call('r', 'Read', { file_path: '/proj/r.txt' }), answer('r', text), ...smallRounds(10), prompt('next'), prompt('and next')]
  const io = setup(on, { transcript: messages, env: KEY_ENV, fetch: () => ({ status: 500, ok: false, headers: {}, text: '' }) })
  await $.session.compact({ trigger: 'manual', messages } as never)
  await settle(() => records(io.writes, 'fold').length > 0)

  const instructions = (Object.values(io.fetches[0]!.body.questions as Record<string, { instructions: string }>)[0]!).instructions
  const excerpt = instructions.split('\nIts output begins:\n')[1]!
  expect(excerpt.startsWith('연락처')).toBe(true)
  expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_CHARS)
  for (const raw of ['1234', '5678', 'a@b.co']) expect(instructions).not.toContain(raw)
  // What was sent is recorded beside the judgment.
  expect(String((records(io.writes, 'fold')[0]?.sent as Record<string, string>).excerpt)).toBe(excerpt)
})
