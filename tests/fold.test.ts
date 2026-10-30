import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { DEFAULT_SETTINGS, FOLD_MARK, foldTranscript, partialCut, turnsAgoOf, pointerFor, shouldFold, sliceLines, splitForSummary, stillIdle, type FoldCandidate, type FoldPolicy } from '../hooks/fold'
import { judgedPolicy } from '../hooks/fold-judge'

const BIG = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n')

const prompt = (text: string, handle: string): SessionMessage => ({ role: 'user', text, toolUses: [], handle })
const call = (id: string, tool: string, input: Record<string, unknown>, handle: string): SessionMessage => ({
  role: 'assistant',
  text: '',
  toolUses: [{ tool_use_id: id, tool, input }],
  handle,
})
const answer = (id: string, text: string, handle: string, isError = false): SessionMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text, isError }],
  handle,
})

// Two turns: an old Read, then the turn in view with its own Read.
const TRANSCRIPT: SessionMessage[] = [
  prompt('read the app', 'h0'),
  call('toolu_old', 'Read', { file_path: 'src/app.ts' }, 'h1'),
  answer('toolu_old', BIG, 'h2'),
  prompt('now the config', 'h3'),
  call('toolu_new', 'Read', { file_path: 'src/config.ts' }, 'h4'),
  answer('toolu_new', BIG, 'h5'),
]

// The tests' own policy, so they hold whatever shouldFold becomes.
const foldOlderTurns: FoldPolicy = c => c.turnsAgo >= 1

test('a result from an earlier turn folds to a pointer and is archived', () => {
  const { messages, archived, savedChars } = foldTranscript(TRANSCRIPT, foldOlderTurns)

  const folded = messages[2]!
  expect(folded.handle).toBe(undefined)
  expect(folded.toolResults?.[0]?.text.startsWith(FOLD_MARK)).toBe(true)
  expect(folded.toolResults?.[0]?.text).toContain('Read · src/app.ts · 300 lines')
  expect(folded.toolResults?.[0]?.text).toContain('read_coordinate("toolu_old")')

  expect(archived.map(a => a.id)).toEqual(['toolu_old'])
  expect(archived[0]?.text).toBe(BIG)
  expect(savedChars).toBe(BIG.length - (folded.toolResults?.[0]?.text.length ?? 0))
})

test('the turn in view and every message without a folded result keep their handle', () => {
  const { messages } = foldTranscript(TRANSCRIPT, foldOlderTurns)

  expect(messages.map(m => m.handle)).toEqual(['h0', 'h1', undefined, 'h3', 'h4', 'h5'])
  expect(messages[5]!.toolResults?.[0]?.text).toBe(BIG)
})

test('an already folded result stays as it is and is not archived again', () => {
  const once = foldTranscript(TRANSCRIPT, foldOlderTurns)
  const twice = foldTranscript(once.messages, () => true)

  expect(twice.messages[2]!.toolResults?.[0]?.text).toBe(once.messages[2]!.toolResults?.[0]?.text)
  expect(twice.archived.map(a => a.id)).toEqual(['toolu_new'])
})

test('a result shorter than its pointer is never folded', () => {
  const short = [prompt('go', 'a'), call('toolu_s', 'Bash', { command: 'true' }, 'b'), answer('toolu_s', 'ok', 'c'), prompt('next', 'd')]
  const { messages, archived } = foldTranscript(short, () => true)

  expect(archived.length).toBe(0)
  expect(messages[2]!.handle).toBe('c')
})

test('a policy that folds nothing changes nothing', () => {
  const { messages, archived, savedChars } = foldTranscript(TRANSCRIPT, () => false)

  expect(messages).toEqual(TRANSCRIPT)
  expect(archived.length).toBe(0)
  expect(savedChars).toBe(0)
})

test('a long path keeps its file name in the pointer, a long command its start', () => {
  const base: FoldCandidate = { tool: 'Read', input: {}, text: BIG, isError: false, turnsAgo: 3 }
  const path = `/private/tmp/${'deep/'.repeat(20)}alpha.txt`

  const pointer = pointerFor('toolu_p', { ...base, input: { file_path: path } })
  expect(pointer.startsWith('[folded Read · …deep/')).toBe(true)
  expect(pointer).toContain('/alpha.txt · 300 lines')
  expect(pointerFor('toolu_c', { ...base, tool: 'Bash', input: { command: `cat ${path}` } })).toContain('Bash · cat /private/tmp/deep/')
})

test('the policy folds large results from ten or more model turns ago', () => {
  // A model turn is one assistant message, so ten turns is ten more calls or
  // replies after the result, whoever prompted them.
  const old: FoldCandidate = { tool: 'Bash', input: { command: 'ls' }, text: 'x'.repeat(1000), isError: false, turnsAgo: 10 }

  expect(shouldFold(old)).toBe(true)
  expect(shouldFold({ ...old, turnsAgo: 9 })).toBe(false)
  expect(shouldFold({ ...old, text: 'x'.repeat(999) })).toBe(false)
})

test('the policy keeps state tools and short errors', () => {
  const old: FoldCandidate = { tool: 'Bash', input: {}, text: 'x'.repeat(1500), isError: false, turnsAgo: 15 }

  for (const tool of ['TodoWrite', 'AskUserQuestion', 'ExitPlanMode']) expect(shouldFold({ ...old, tool })).toBe(false)
  expect(shouldFold({ ...old, isError: true })).toBe(false)
  expect(shouldFold({ ...old, isError: true, text: 'x'.repeat(2000) })).toBe(true)
})

test('sliceLines returns the asked lines and clamps out-of-range requests', () => {
  expect(sliceLines(BIG, 2, 3)).toEqual({ body: 'line 2\nline 3\nline 4', total: 300, from: 2, to: 4 })
  expect(sliceLines(BIG, 299, 50)).toEqual({ body: 'line 299\nline 300', total: 300, from: 299, to: 300 })
  expect(sliceLines(BIG, -5, 1).from).toBe(1)
})

test('read_coordinate answers with the archived lines', async ($, on) => {
  const kept = { id: 'toolu_old', tool: 'Read', input: { file_path: 'src/app.ts' }, text: BIG, isError: false }
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.exists', (_, e) => ({ value: e.path === '/home/test/.claude-context-fold/sess-1/toolu_old.json' }))
  on('fs.read', () => ({ value: JSON.stringify(kept) }))

  // The engine takes a plugin tool's result only as a string or content blocks.
  const found = await $.tool.call({ tool: 'mcp__conjev__read_coordinate', id: 'toolu_old', offset: 10, limit: 2 })
  expect(found.result).toBe('Read {"file_path":"src/app.ts"} — lines 10-11 of 300\nline 10\nline 11')

  const missing = await $.tool.call({ tool: 'mcp__conjev__read_coordinate', id: 'toolu_gone' })
  expect(missing.deny).toBe('No folded result is kept under \"toolu_gone\".')
  expect(missing.result).toBe(undefined)
})

test('the partial cut falls on a model turn, keeping that many turns whole', () => {
  // Six messages, two model turns: the call that reads the app and the one
  // that reads the config. The cut is the assistant message itself.
  expect(partialCut(TRANSCRIPT, 1)).toBe(4)
  expect(partialCut(TRANSCRIPT, 2)).toBe(1)
  expect(partialCut(TRANSCRIPT, 3)).toBe(0)
  expect(partialCut(TRANSCRIPT, 0)).toBe(0)
})

test('the partial cut never splits a tool_use from its tool_result', () => {
  const cut = partialCut(TRANSCRIPT, 1)
  const older = TRANSCRIPT.slice(0, cut)
  const recent = TRANSCRIPT.slice(cut)
  const usesIn = (part: SessionMessage[]) => new Set(part.flatMap(m => m.toolUses.map(u => u.tool_use_id)))
  const resultsIn = (part: SessionMessage[]) => new Set(part.flatMap(m => (m.toolResults ?? []).map(r => r.tool_use_id)))

  // The kept window opens on the turn's own message, which holds the call;
  // its answer follows it, so both sides of the cut hold whole pairs.
  expect(TRANSCRIPT[cut]?.toolUses[0]?.tool_use_id).toBe('toolu_new')
  expect([...usesIn(older)]).toEqual([...resultsIn(older)])
  expect([...usesIn(recent)]).toEqual([...resultsIn(recent)])
  expect([...usesIn(recent)]).toEqual(['toolu_new'])
})

test('a prompt older than the cut is still carried over the summary whole', () => {
  // The cut keeps only the last model turn, so "now the config" lies before
  // it even though it asked for that turn. The summary is handed the rest of
  // the older part; the person's words come back as they wrote them.
  const { older, keptPrompts } = splitForSummary(TRANSCRIPT, partialCut(TRANSCRIPT, 1))

  expect(keptPrompts.map(m => m.text)).toEqual(['read the app', 'now the config'])
  expect(older.map(m => m.handle)).toEqual(['h1', 'h2'])
})

test('a session prompted once still folds: only the last ten model turns stay whole', () => {
  // The reason turns are model turns: under /goal or a long task the person
  // writes once and the model runs on. Counted by prompts, every result after
  // that one prompt would stay recent and nothing would ever fold.
  const run: SessionMessage[] = [prompt('take the whole refactor to the end', 'p')]
  for (let i = 0; i < 15; i++) run.push(call(`toolu_${i}`, 'Read', { file_path: `src/f${i}.ts` }, `c${i}`), answer(`toolu_${i}`, BIG, `a${i}`))

  const { archived } = foldTranscript(run, shouldFold)
  // Under the default of ten, the first five results are ten or more turns old.
  expect(archived.map(a => a.id)).toEqual(['toolu_0', 'toolu_1', 'toolu_2', 'toolu_3', 'toolu_4'])
  // A partial summary keeps the same ten turns, opening on the sixth call.
  expect(run[partialCut(run, DEFAULT_SETTINGS.keepRecentTurns)]?.handle).toBe('c5')
})

// The engine hands one response over as a row per block: its thinking, its
// text, each tool_use. Those rows are one model turn, not three or four.
test('a response handed over as several rows is one model turn', () => {
  const said = (text: string, handle: string): SessionMessage => ({ role: 'assistant', text, toolUses: [], handle })
  const rows: SessionMessage[] = [
    prompt('check both files', 'p'),
    said('', 'think'),
    said('Reading both.', 'text'),
    call('toolu_a', 'Read', { file_path: 'a.ts' }, 'ua'),
    call('toolu_b', 'Read', { file_path: 'b.ts' }, 'ub'),
    answer('toolu_a', BIG, 'ra'),
    answer('toolu_b', BIG, 'rb'),
    said('Both read.', 'done'),
  ]

  // Two responses after the prompt: the four rows that read, and the closing line.
  expect(turnsAgoOf(rows)[0]).toBe(2)
  expect(turnsAgoOf(rows)[5]).toBe(1)
  // Keeping one turn cuts before the closing line; keeping two cuts where the
  // first response starts, never between its rows.
  expect(rows[partialCut(rows, 1)]?.handle).toBe('done')
  expect(rows[partialCut(rows, 2)]?.handle).toBe('think')
})

// A turn can start while an earlier call is still unanswered (a reminder the
// engine injected between them, say). Cutting there would hand the call to the
// summary and keep its answer, so the cut moves to an earlier turn.
test('the partial cut never leaves an answer without its call', () => {
  const rows: SessionMessage[] = [
    prompt('go', 'p'),
    call('toolu_a', 'Read', { file_path: 'a.ts' }, 'ua'),
    prompt('<system-reminder>context</system-reminder>', 'inj'),
    call('toolu_b', 'Read', { file_path: 'b.ts' }, 'ub'),
    answer('toolu_a', BIG, 'ra'),
    answer('toolu_b', BIG, 'rb'),
  ]

  expect(partialCut(rows, 1)).toBe(1)
  const cut = partialCut(rows, 1)
  const used = new Set(rows.slice(0, cut).flatMap(m => m.toolUses.map(u => u.tool_use_id)))
  const answeredLater = rows.slice(cut).flatMap(m => (m.toolResults ?? []).map(r => r.tool_use_id))
  expect(answeredLater.filter(id => used.has(id))).toEqual([])
})

test('an automatic fold stands down when the person writes first', () => {
  // Nobody wrote while it waited: the moment is still its own.
  expect(stillIdle(undefined, 1000)).toBe(true)
  // They wrote before it began waiting: an earlier turn, not this one.
  expect(stillIdle(900, 1000)).toBe(true)
  // At the same instant is not after it, so the fold keeps the moment.
  expect(stillIdle(1000, 1000)).toBe(true)
  // They wrote while it waited: their turn goes first.
  expect(stillIdle(1001, 1000)).toBe(false)
})

test('with Jev judging, a needed result stays, a finished recent one folds, and the rule stays the floor', () => {
  const settings = { ...DEFAULT_SETTINGS, keepRecentTurns: 2, minFoldChars: 100 }
  const big = 'x'.repeat(500)
  const at = (id: string, turnsAgo: number, extra: Partial<FoldCandidate> = {}): FoldCandidate => ({ id, tool: 'Read', input: {}, text: big, isError: false, turnsAgo, ...extra })
  const policy = judgedPolicy(settings, new Map([['old-needed', 0.8], ['old-done', 0.1], ['recent-done', 0.05], ['recent-needed', 0.9], ['small-done', 0.0], ['err-done', 0.0]]), 0.3)

  // Old enough for the rule to fold: Jev keeps the one still needed.
  expect(policy(at('old-needed', 5))).toBe(false)
  expect(policy(at('old-done', 5))).toBe(true)
  // Recent, so the rule keeps it: Jev folds the one it says is done with.
  expect(policy(at('recent-done', 0))).toBe(true)
  expect(policy(at('recent-needed', 0))).toBe(false)
  // The floor holds whatever Jev says: too small, or a short error.
  expect(policy(at('small-done', 5, { text: 'tiny' }))).toBe(false)
  expect(policy(at('err-done', 5, { isError: true, text: 'E'.repeat(150) }))).toBe(false)
  // Not judged: the rule's own verdict, so a failed request never folds more.
  expect(policy(at('unjudged-old', 5))).toBe(true)
  expect(policy(at('unjudged-recent', 0))).toBe(false)
})
