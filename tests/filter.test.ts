// The instruction filter at prompt.context: what loads, what is recorded, what is sent.
import type { HttpResponse } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { HOME, KEY_ENV, drain, records, settle, setup } from './kit'
import { AGENTS } from './fixtures'

const USER = `${HOME}/.agents/AGENTS.md`
const PROJECT = '/proj/AGENTS.md'
const WEB = '### 웹 페이지 가져오기\n\nFetch a page through Jina Reader first: https://r.jina.ai/<URL>, then the built-in tool.\n'

const context = (files: { path: string; kind: string; content: string }[]) =>
  ({ blocks: [{ name: 'claudeMd', text: 'rendered' }], instructionFiles: files }) as never

const FILES = [
  { path: USER, kind: 'user', content: AGENTS },
  { path: PROJECT, kind: 'project', content: `## Project rules\n\nRun the suites before a commit, every time.\n\n${WEB}` },
]

// Jev's answers by what each numbered chunk says: the web page rule is
// conditional, the LLM rule is already said earlier, the rest is needed.
const jev = (body: Record<string, unknown>): HttpResponse => {
  const state = String((body.state as Record<string, unknown>).instructions ?? '')
  const byNumber = new Map(state.split(/\n\n(?=#\d+ \[)/).map(part => [Number(/^#(\d+)/.exec(part)?.[1]), part]))
  const answers = Object.fromEntries(
    Object.keys(body.questions as object).map(name => {
      const text = byNumber.get(Number(name.slice(1))) ?? ''
      if (name.startsWith('s')) {
        const p = text.includes('Jina') ? 0.99 : 0.02
        return [name, { type: 'choice', choice: p > 0.5 ? 'conditional' : 'always', confidence: 0.9, probabilities: { always: 1 - p, conditional: p } }]
      }
      if (name.startsWith('c')) {
        const p = text.includes('subscription runtimes') ? 0.99 : 0.01
        return [name, { type: 'choice', choice: p > 0.5 ? 'covered' : 'new', confidence: 0.9, probabilities: { covered: p, partly: 0, new: 1 - p } }]
      }
      return [name, { type: 'choice', choice: 'applies', confidence: 0.9, probabilities: { applies: 0.99, not: 0.01 } }]
    }),
  )
  return { status: 200, ok: true, headers: {}, text: JSON.stringify({ model: 'jev-1.14.0', answers, usage: { input_tokens: 4000, output_tokens: 80 } }) }
}

test('off by default: the files load as they are and nothing is recorded or sent', async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: jev })
  await $.prompt.context(context(FILES))
  await drain()
  expect(io.loaded[0]).toEqual(FILES)
  expect(io.fetches.length).toBe(0)
  expect(io.writes.length).toBe(0)
})

const DUPED = [FILES[0]!, { ...FILES[1]!, content: `## Project rules\n\nRun the suites before a commit, every time.\n\n${WEB.replace('first:', 'first:  ')}` }]

test('active: a chunk loaded twice leaves the later file, with a line saying where it is kept', { options: { instructionFilter: 'active' } }, async ($, on) => {
  const io = setup(on)
  await $.prompt.context(context(DUPED))
  const project = io.loaded[0]?.find(f => f.path === PROJECT)?.content ?? ''
  expect(project).toBe('## Project rules\n\nRun the suites before a commit, every time.\n\n[conjev: left out "웹 페이지 가져오기", loaded from ~/.agents/AGENTS.md]\n\n')
  expect(io.loaded[0]?.find(f => f.path === USER)?.content).toBe(AGENTS)
  expect(io.toasts.some(t => t.includes('left out 1 instruction chunks loaded twice'))).toBe(true)
  await settle(() => records(io.writes, 'instr-filter').length > 0)
  expect(records(io.writes, 'instr-filter').filter(r => r.decision === 'drop').length).toBe(1)
  // No key: nothing was sent, and the records say why Jev did not judge.
  expect(io.fetches.length).toBe(0)
  expect(records(io.writes, 'instr-filter').some(r => (r.facts as Record<string, string>).jev === 'no-key')).toBe(true)
})

test('shadow: the same files load unchanged, and the duplicate is recorded as what active would leave out', { options: { instructionFilter: 'shadow' } }, async ($, on) => {
  const io = setup(on)
  await $.prompt.context(context(DUPED))
  expect(io.loaded[0]).toEqual(DUPED)
  await settle(() => records(io.writes, 'instr-filter').length > 0)
  const dropped = records(io.writes, 'instr-filter').filter(r => r.decision === 'would-drop')
  expect(dropped.map(r => [r.heuristic, (r.facts as Record<string, string>).file])).toEqual([[true, '/proj/AGENTS.md']])
})

test('Jev reads the chunks after the request has gone, keeps late answers, and is asked once per set of files', { options: { instructionFilter: 'shadow' } }, async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => (release = resolve))
  const io = setup(on, { env: KEY_ENV, fetch: async body => (await gate, jev(body)) })
  await $.prompt.context(context(FILES))
  // The files went on before Jev answered.
  expect(io.loaded.length).toBe(1)
  release()
  await settle(() => records(io.writes, 'instr-filter').filter(r => r.decision !== 'sent').length >= 10)
  await drain()
  // A background wait long enough for a late answer, not the 2 s a gate waits.
  expect(io.sleeps.includes(15_000)).toBe(true)

  const byHeading = new Map(records(io.writes, 'instr-filter').filter(r => r.decision !== 'sent').map(r => [(r.facts as Record<string, string>).heading, r]))
  const at = (heading: string) => byHeading.get(`# AGENTS.md — rules > ${heading}`)
  expect(at('## 도구 우선순위 > ### 웹 페이지 가져오기')?.decision).toBe('would-defer')
  expect(at('## LLM 호출 경로')?.decision).toBe('would-drop')
  expect(at('## 언어')?.decision).toBe('would-keep')
  expect((at('## 언어')?.facts as Record<string, string>).reason).toBe('always kept')
  expect(at('## 도구 우선순위 > ### Orca 오케스트레이션')?.decision).toBe('would-defer')

  // The second question set is asked over the chunks that would stay: the deferred web page rule is not a coverer.
  const coverCall = io.fetches.find(f => Object.keys(f.body.questions as object).some(k => k.startsWith('c')))
  expect(String((coverCall?.body.state as Record<string, unknown>).instructions)).not.toContain('Jina')
  // Each call is kept as a record of exactly what it carried, scrubbed.
  const sent = records(io.writes, 'instr-filter').filter(r => r.decision === 'sent')
  expect(sent.length).toBe(2)
  expect(JSON.stringify(sent.map(r => r.sent))).not.toContain(HOME)

  const calls = io.fetches.length
  await $.prompt.context(context(FILES))
  await drain()
  expect(io.fetches.length).toBe(calls)
})

test('every origin is measured against the deferred chunks, and a tool use of their kind is recorded without sending', { options: { instructionFilter: 'shadow' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: jev })
  await $.prompt.context(context(FILES))
  await settle(() => records(io.writes, 'instr-filter').filter(r => r.decision !== 'sent').length >= 10)
  await drain()

  // A tool use of the web kind before any prompt was judged: the deferred chunk would have been missing.
  await $.tool.call({ tool: 'WebFetch', url: 'https://example.com', prompt: 'summarize' } as never)
  await settle(() => records(io.writes, 'instr-tool').length > 0)
  expect((records(io.writes, 'instr-tool')[0]?.facts as Record<string, string>).signature).toBe('web')

  const before = io.fetches.length
  await $.prompt.submit({ text: '/wdl:ship now', wait: false, origin: { kind: 'composer' }, command: { name: 'wdl:ship', args: 'now' } } as never)
  await settle(() => records(io.writes, 'instr-defer').length > 0)
  expect(io.fetches.length).toBe(before + 1)
  expect((io.fetches.at(-1)?.body.state as Record<string, unknown>).request).toBe('/wdl:ship now')
  expect(records(io.writes, 'instr-defer').every(r => r.decision === 'would-attach')).toBe(true)

  const report = (await $.command.run({ command: 'jev-report', args: '' } as never)).text ?? ''
  expect(report).toContain('instruction filter shadow')
  expect(report).toContain('would defer 2')
  expect(report).toContain('would-miss, web: 1 tool uses, 1 with the chunk not yet attached (100%)')
})
