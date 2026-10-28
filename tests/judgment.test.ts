// Judgment quality and what is observed of it: the Stop gate demoted by its
// labels (A3), each gate's latency (A7), Jev's instruction reading applied in
// active (instruction reading), and read_coordinate asked by the latest
// request (F5).
import type { HttpResponse } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { STOP_DEMOTED_KEY } from '../hooks/register'
import { DEMOTE_LABELS, latencyReport, shouldDemoteStop, stopPrecision, type ShadowRecord } from '../hooks/report'
import { harnessSettingsFrom } from '../hooks/settings'
import { AGENTS } from './fixtures'
import { HOME, KEY_ENV, drain, prompt, records, settle, setup } from './kit'

const ROOT = `${HOME}/.context-harness/state`
const START = { cwd: '/proj', surface: 'terminal', isInteractive: true } as never
const ANNOUNCE: HttpResponse = {
  status: 200,
  ok: true,
  headers: {},
  text: JSON.stringify({ model: 'jev-1.14.0', answers: { stop: { type: 'choice', choice: 'announce', confidence: 0.98, probabilities: { announce: 0.99, report: 0.01 } } }, usage: { input_tokens: 1, output_tokens: 1 } }),
}
const STOP = { stop_hook_active: false, last_assistant_message: 'Next, I will refactor the cache.' } as never

// A3: `n` labeled stop judgments, all flagged by Jev, `wrong` of them labeled as not announcing.
const labeled = (n: number, wrong: number): Record<string, string> => {
  const files: Record<string, string> = {}
  for (let i = 0; i < n; i++) {
    const id = `r${String(i).padStart(4, '0')}`
    files[`${ROOT}/records/s/stop/${id}.json`] = JSON.stringify({ id, ts: 't', sessionId: 's', point: 'stop', mode: 'active', sent: null, jev: 0.99, hookMs: 1, jevMs: 300 })
    files[`${ROOT}/records/labels/labels/${id}.json`] = JSON.stringify({ id, label: i >= wrong, ts: 't' })
  }

  return files
}

test('precision is the share of flagged, labeled stops the person called announcements', () => {
  const rec = (id: string, jev: number): ShadowRecord => ({ id, ts: 't', sessionId: 's', point: 'stop', mode: 'shadow', sent: null, jev, hookMs: 1 })
  const p = stopPrecision([rec('a', 0.9), rec('b', 0.9), rec('c', 0.1), rec('d', 0.9)], new Map([['a', true], ['b', false], ['c', false]]), 0.7)

  expect(p).toEqual({ labeled: 3, flagged: 2, precision: 0.5 })
  expect(shouldDemoteStop({ labeled: DEMOTE_LABELS - 1, precision: 0 })).toBe(false)
  expect(shouldDemoteStop({ labeled: DEMOTE_LABELS, precision: 0.89 })).toBe(true)
  expect(shouldDemoteStop({ labeled: DEMOTE_LABELS, precision: 0.9 })).toBe(false)
})

test('150 labels under 0.9 precision demote an active Stop gate to shadow, say so, and keep it', { options: { stopGate: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: () => ANNOUNCE, files: labeled(150, 20) })
  await $.session.start(START)

  expect(io.toasts.some(t => t.includes('now only records (shadow)'))).toBe(true)
  expect((io.store.get(STOP_DEMOTED_KEY) as { labeled: number }).labeled).toBe(150)
  // Judged and recorded, but the turn is not held.
  expect((await $.classic.Stop(STOP)).block).toBe(undefined)
  await settle(() => records(io.writes, 'stop').length > 0)
  expect(records(io.writes, 'stop')[0]?.mode).toBe('shadow')
  const report = String((await $.command.run({ command: 'jev-report', args: '' } as never)).text)
  expect(report).toContain('context-harness: stop shadow,')
  expect(report).toContain('stop demoted to shadow')
})

test('at 0.9 precision or above, or under 150 labels, the gate stays active', { options: { stopGate: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: () => ANNOUNCE, files: { ...labeled(150, 15), ...{} } })
  await $.session.start(START)
  expect(io.store.get(STOP_DEMOTED_KEY)).toBe(undefined)
  expect((await $.classic.Stop(STOP)).block).toBeDefined()
})

test('under 150 labels nothing is demoted, however wrong', { options: { stopGate: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: () => ANNOUNCE, files: labeled(149, 100) })
  await $.session.start(START)
  expect(io.store.get(STOP_DEMOTED_KEY)).toBe(undefined)
})

test('the 150th label, given with /jev-mark, demotes the gate at once', { options: { stopGate: 'active' } }, async ($, on) => {
  const files = labeled(150, 20)
  delete files[`${ROOT}/records/labels/labels/r0149.json`]
  const io = setup(on, { env: KEY_ENV, fetch: () => ANNOUNCE, files })
  await $.session.start(START)
  expect(io.store.get(STOP_DEMOTED_KEY)).toBe(undefined)

  const text = String((await $.command.run({ command: 'jev-mark', args: 'r0149 y' } as never)).text)
  expect(text).toContain('it now only records (shadow)')
  expect((await $.classic.Stop(STOP)).block).toBe(undefined)
})

test('a shadow Stop gate is never touched by the labels', { options: { stopGate: 'shadow' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: () => ANNOUNCE, files: labeled(150, 100) })
  await $.session.start(START)
  expect(io.store.get(STOP_DEMOTED_KEY)).toBe(undefined)
})

// A7
test('the timeout stays 2 seconds by default', () => {
  expect(harnessSettingsFrom({}).timeoutMs).toBe(2000)
})

test('/jev-report gives each gate its Jev and hook latency, p50 and p95', { options: { stopGate: 'shadow' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: () => ANNOUNCE, files: labeled(3, 0) })
  await $.session.start(START)
  await $.classic.Stop(STOP)
  await settle(() => records(io.writes, 'stop').length > 0)
  const report = String((await $.command.run({ command: 'jev-report', args: '' } as never)).text)

  expect(report).toContain('## latency (timeout 2000 ms)')
  expect(report).toMatch(/stop: jev p50 \d+ ms, p95 \d+ ms; hook p50 \d+ ms, p95 \d+ ms; 4 calls, 0 timed out/)
})

test('latency is split by gate, and timeouts are counted', () => {
  const rec = (point: string, jevMs: number, error?: 'timeout'): ShadowRecord => ({ id: 'x', ts: 't', sessionId: 's', point, mode: 'shadow', sent: null, hookMs: 2, jevMs, error })
  const text = latencyReport([rec('stop', 100), rec('stop', 300), rec('stop', 2000, 'timeout'), rec('fold', 50)], 2000) ?? ''

  expect(text.split('\n')).toEqual([
    '## latency (timeout 2000 ms)',
    'fold: jev p50 50 ms, p95 50 ms; hook p50 2 ms, p95 2 ms; 1 calls, 0 timed out',
    'stop: jev p50 300 ms, p95 2000 ms; hook p50 2 ms, p95 2 ms; 3 calls, 1 timed out',
  ])
  expect(latencyReport([], 2000)).toBe(undefined)
})

// Instruction reading, applied in active.
const USER = `${HOME}/.agents/AGENTS.md`
const FILES = [{ path: USER, kind: 'user', content: AGENTS }]
const context = (files: typeof FILES) => ({ blocks: [{ name: 'claudeMd', text: 'rendered' }], instructionFiles: files }) as never
// Jev: the web page rule is conditional, the LLM rule already said; the rest is needed.
const jevReads = (body: Record<string, unknown>): HttpResponse => {
  const state = String((body.state as Record<string, unknown>).instructions ?? '')
  const byNumber = new Map(state.split(/\n\n(?=#\d+ \[)/).map(part => [Number(/^#(\d+)/.exec(part)?.[1]), part]))
  const answers = Object.fromEntries(
    Object.keys(body.questions as object).map(name => {
      const text = byNumber.get(Number(name.slice(1))) ?? ''
      if (name.startsWith('s')) {
        const p = text.includes('Jina') ? 0.99 : 0.02
        return [name, { type: 'choice', choice: p > 0.5 ? 'conditional' : 'always', confidence: 0.9, probabilities: { always: 1 - p, conditional: p } }]
      }
      const p = text.includes('subscription runtimes') ? 0.99 : 0.01
      return [name, { type: 'choice', choice: p > 0.5 ? 'covered' : 'new', confidence: 0.9, probabilities: { covered: p, partly: 0, new: 1 - p } }]
    }),
  )
  return { status: 200, ok: true, headers: {}, text: JSON.stringify({ model: 'jev-1.14.0', answers, usage: { input_tokens: 4000, output_tokens: 80 } }) }
}

test('active: once Jev has read the files, the chunks it calls repeated or needed only for some work leave; the always-kept stay', { options: { instructionFilter: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: jevReads })
  await $.prompt.context(context(FILES))
  // The first load goes on as it is: Jev has not answered yet.
  expect(io.loaded[0]).toEqual(FILES)
  await settle(() => records(io.writes, 'instr-filter').filter(r => r.decision !== 'sent').length >= 10)
  await drain()

  await $.prompt.context(context(FILES))
  const loaded = io.loaded[1]![0]!.content
  expect(loaded).not.toContain('Jina')
  expect(loaded).not.toContain('subscription runtimes')
  expect(loaded).toContain('(Jev: said there already)')
  expect(loaded).toContain('(Jev: needed only for some work)')
  // The always-kept rules, and the Orca rule a rule (not Jev) would defer, stay.
  expect(loaded).toContain('## 언어')
  expect(loaded).toContain('ask before splitting work across workers')
  expect(io.toasts.some(t => t.includes('Jev read as repeated or needed only for some work'))).toBe(true)
  // The records say what was applied, not what would be.
  const decisions = records(io.writes, 'instr-filter').map(r => r.decision)
  expect(decisions).toContain('drop')
  expect(decisions).toContain('defer')
})

test('shadow: Jev\'s reading is recorded, never applied', { options: { instructionFilter: 'shadow' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: jevReads })
  await $.prompt.context(context(FILES))
  await settle(() => records(io.writes, 'instr-filter').filter(r => r.decision !== 'sent').length >= 10)
  await drain()
  await $.prompt.context(context(FILES))

  expect(io.loaded[1]).toEqual(FILES)
})

// F5
const LOG = Array.from({ length: 200 }, (_, i) => `line ${i + 1} of the server log ${i === 99 ? 'FAIL here' : 'with some words in it'}`).join('\n')
const KEPT = JSON.stringify({ id: 'toolu_x', tool: 'Read', input: { file_path: '/proj/server.log' }, text: LOG, isError: false })
const onlyFailures = (body: Record<string, unknown>): HttpResponse => {
  const state = body.state as Record<string, unknown> | undefined
  const score = typeof state?.passage === 'string' ? (String(state.passage).includes('FAIL') ? 0.95 : 0.05) : 0.95

  return {
    status: 200,
    ok: true,
    headers: {},
    text: JSON.stringify({ model: 'jev-1.14.0', answers: Object.fromEntries(Object.keys(body.questions as object).map(name => [name, { type: 'noul', noul: score }])), usage: { input_tokens: 1, output_tokens: 1 } }),
  }
}

test('read_coordinate with no query keeps what bears on the person\'s latest request', { options: { foldBlocks: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: onlyFailures, messages: [prompt('earlier'), prompt('why does the server fail?')], files: { [`${ROOT}/archive/sess-1/toolu_x.json`]: KEPT } })
  const text = String((await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_x' } as never)).result)

  expect(text).toContain('FAIL here')
  expect(text).toMatch(/Left out: lines/)
  expect(JSON.stringify(io.fetches.map(f => f.body))).toContain('why does the server fail?')
})

test('read_coordinate with a range, or full, returns the lines asked for and asks Jev nothing', { options: { foldBlocks: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: onlyFailures, messages: [prompt('why does the server fail?')], files: { [`${ROOT}/archive/sess-1/toolu_x.json`]: KEPT } })
  const ranged = String((await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_x', offset: 1, limit: 3 } as never)).result)
  const full = String((await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_x', full: true } as never)).result)

  expect(ranged).toContain('lines 1-3 of 200')
  expect(full).toContain('line 1 of the server log')
  expect(io.fetches.length).toBe(0)
})
