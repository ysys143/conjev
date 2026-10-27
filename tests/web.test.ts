// Web reading and kept fold blocks, through the engine's events.
import type { HttpResponse, SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { FOLD_MARK } from '../hooks/fold'
import { KEPT_MARK } from '../hooks/fold-blocks'
import { isPrivateHost } from '../hooks/web-flow'
import { HOME, KEY_ENV, drain, prompt, records, settle, setup } from './kit'

const URL = 'https://docs.example.org/rfc.html'
const filler = (i: number): string => `Paragraph ${i} is about something else entirely, ${'filler words '.repeat(30)}`
const HTML = [
  '<html><body><main><h1>Spec</h1><p>Front matter, written by a@b.co.</p>',
  ...Array.from({ length: 60 }, (_, i) => `<p>${filler(i)}</p>`),
  '<h2>421</h2><p>The 421 status code means the request was misdirected ANSWER, and nothing else is meant by it here.</p>',
  ...Array.from({ length: 60 }, (_, i) => `<p>${filler(i + 60)}</p>`),
  '</main></body></html>',
].join('\n')
const PAGE: HttpResponse = { status: 200, ok: true, headers: { 'content-type': 'text/html; charset=utf-8' }, text: HTML }

/** Jev in a test: yes to text holding ANSWER, in both stages. */
const jev = (body: Record<string, unknown>): HttpResponse => {
  const state = body.state as Record<string, unknown>
  const names = Object.keys(body.questions as object)
  const say = (text: string) => (text.includes('ANSWER') ? 0.95 : 0.03)
  const answers = Object.fromEntries(
    names.map(name => {
      const text = name === 'rel' ? String(state.passage) : String((state.passages as { id: string; text: string }[]).find(p => p.id === name)?.text)
      return [name, { type: 'noul', noul: say(text) }]
    }),
  )

  return { status: 200, ok: true, headers: {}, text: JSON.stringify({ model: 'jev-1.14.0', answers, usage: { input_tokens: 500, output_tokens: 5 } }) }
}

const sent = (io: { fetches: { body: Record<string, unknown> }[] }): string => JSON.stringify(io.fetches.map(f => f.body))

test('off: WebFetch is left alone, nothing is fetched or sent, and web_read is not offered', async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: jev, pages: { [URL]: PAGE } })
  await $.session.start({ cwd: '/proj' } as never)
  const result = await $.tool.call({ tool: 'WebFetch', url: URL, prompt: 'what is 421?' } as never)
  await drain()

  expect(result.result).toBe('ok')
  expect(io.pageFetches.length).toBe(0)
  expect(io.fetches.length).toBe(0)
})

test('shadow: WebFetch answers unchanged; what web_read would return is recorded beside it', { options: { webRead: 'shadow' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: jev, pages: { [URL]: PAGE } })
  const result = await $.tool.call({ tool: 'WebFetch', url: URL, prompt: 'what does 421 mean?' } as never)
  expect(result.result).toBe('ok')

  await settle(() => records(io.writes, 'web').length > 0)
  const [record] = records(io.writes, 'web')
  expect(record?.mode).toBe('shadow')
  expect(record?.decision).toBe('filtered')
  const facts = record?.facts as Record<string, string>
  expect(Number(facts.outTokens) < Number(facts.docTokens) / 4).toBe(true)
  expect(facts.webFetchChars).toBe('2')
  // The page text reached Jev scrubbed; the record keeps only its size.
  expect(sent(io)).toContain('ANSWER')
  expect(sent(io)).not.toContain('a@b.co')
  expect(JSON.stringify(record)).not.toContain('filler words')
  // Shadow keeps no page.
  expect(io.writes.some(w => w.path.includes('/archive/'))).toBe(false)
})

test('active: web_read returns the answering blocks verbatim and keeps the whole page for read_coordinate', { options: { webRead: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: jev, pages: { [URL]: PAGE } })
  const out = await $.tool.call({ tool: 'mcp__context-harness__web_read', url: URL, question: 'what does 421 mean?' } as never)
  const text = String(out.result)

  expect(out.isError).not.toBe(true)
  expect(text).toContain('# status: filtered')
  expect(text).toContain('## Spec > 421')
  expect(text).toContain('misdirected ANSWER')
  expect(text).toContain('a@b.co')
  expect(text).not.toContain('Paragraph 30 ')
  const id = /read_coordinate\("([^"]+)"\)/.exec(text)?.[1]
  expect(id).not.toBe(undefined)
  const whole = String((await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id } as never)).result)
  expect(whole).toContain('Paragraph 30 ')
})

test('active: without a key web_read says so and sends nothing', { options: { webRead: 'active' } }, async ($, on) => {
  const io = setup(on, { fetch: jev, pages: { [URL]: PAGE } })
  const out = await $.tool.call({ tool: 'mcp__context-harness__web_read', url: URL, question: 'q' } as never)
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain('TypeSafe key')
  expect(io.fetches.length).toBe(0)
})

test('active: a page that does not load is a fetch error, and Jev is not asked', { options: { webRead: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: jev, pages: {} })
  const out = await $.tool.call({ tool: 'mcp__context-harness__web_read', url: URL, question: 'q' } as never)
  expect(out.isError).toBe(true)
  expect(String(out.result)).toContain('fetch_error (HTTP 404)')
  expect(io.fetches.length).toBe(0)
})

// A transcript with one large old Read whose lines hold an answer, and a recent prompt.
const call = (id: string, tool: string, input: Record<string, unknown>): SessionMessage => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] })
const answer = (id: string, text: string): SessionMessage => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError: false }] })
const FILE = Array.from({ length: 400 }, (_, i) => (i === 250 ? `${i + 1}\tconst limit = 421 // ANSWER owner a@b.co` : `${i + 1}\tline ${i + 1} ${'x'.repeat(40)}`)).join('\n')
const TRANSCRIPT: SessionMessage[] = [
  prompt('read the server'),
  call('big', 'Read', { file_path: '/proj/server.ts' }),
  answer('big', FILE),
  prompt('ok'),
  prompt('what is the limit in the server?'),
]

test('fold blocks active: the needed lines stay verbatim under the pointer; the rest is archived', { options: { foldBlocks: 'active' } }, async ($, on) => {
  // A stopped timer: only Jev's answers settle the judgment, never its time budget.
  const io = setup(on, { transcript: TRANSCRIPT, env: KEY_ENV, fetch: jev, isTimerStopped: true })
  const out = await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT } as never)
  const folded = out.messages?.flatMap(m => m.toolResults ?? []).find(r => r.tool_use_id === 'big')?.text ?? ''

  expect(folded.startsWith(FOLD_MARK)).toBe(true)
  expect(folded).toContain(KEPT_MARK)
  expect(folded).toContain('251\tconst limit = 421 // ANSWER owner a@b.co')
  expect(folded.length < FILE.length / 2).toBe(true)
  expect(sent(io)).not.toContain('a@b.co')
  expect(sent(io)).toContain('what is the limit')
  expect(io.writes.some(w => w.path.endsWith('/archive/sess-1/big.json'))).toBe(true)
  await settle(() => records(io.writes, 'fold-blocks').length > 0)
  expect(records(io.writes, 'fold-blocks')[0]?.decision).toBe('keep')
})

test('fold blocks: the request is scrubbed before it is cut at 400', { options: { foldBlocks: 'shadow' } }, async ($, on) => {
  // The request carries a phone number starting at 393, so a cut at 400 lands
  // inside the label scrubbing leaves. The judgment scrubs once more on the way
  // out, so this site cannot leak on its own; the test holds the order anyway.
  const ask = `${'가 나 '.repeat(200).slice(0, 393)} 010-1234-5678`
  const messages = [prompt('read the server'), call('big', 'Read', { file_path: '/proj/server.ts' }), answer('big', FILE), prompt('ok'), prompt(ask)]
  const io = setup(on, { transcript: messages, env: KEY_ENV, fetch: jev, isTimerStopped: true })
  await $.session.compact({ trigger: 'manual', messages } as never)
  await settle(() => records(io.writes, 'fold-blocks').length > 0)

  expect(io.fetches.length).toBeGreaterThan(0)
  const bodies = sent(io)
  expect(bodies).not.toContain('1234')
  expect(bodies).not.toContain('5678')
})

test('fold blocks shadow: the fold is a pointer alone, and what would be kept is recorded', { options: { foldBlocks: 'shadow' } }, async ($, on) => {
  const io = setup(on, { transcript: TRANSCRIPT, env: KEY_ENV, fetch: jev })
  const out = await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT } as never)
  const folded = out.messages?.flatMap(m => m.toolResults ?? []).find(r => r.tool_use_id === 'big')?.text ?? ''
  expect(folded).not.toContain(KEPT_MARK)
  expect(folded.includes('\n')).toBe(false)
  await settle(() => records(io.writes, 'fold-blocks').length > 0)
  expect(records(io.writes, 'fold-blocks')[0]?.decision).toBe('would-keep')
})

test('fold blocks active: when Jev fails, the fold is a pointer alone', { options: { foldBlocks: 'active' } }, async ($, on) => {
  setup(on, { transcript: TRANSCRIPT, env: KEY_ENV, isTimerStopped: true, fetch: () => ({ status: 500, ok: false, headers: {}, text: '' }) })
  const out = await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT } as never)
  const folded = out.messages?.flatMap(m => m.toolResults ?? []).find(r => r.tool_use_id === 'big')?.text ?? ''
  expect(folded.startsWith(FOLD_MARK)).toBe(true)
  expect(folded).not.toContain(KEPT_MARK)
})

test('fold blocks off: no tool output reaches Jev', { options: { foldJev: 'shadow' } }, async ($, on) => {
  const io = setup(on, { transcript: TRANSCRIPT, env: KEY_ENV, fetch: jev })
  await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT } as never)
  await drain()
  expect(sent(io)).not.toContain('line 12 ')
  expect(HOME.length > 0).toBe(true)
})

test('fold blocks active: past the time budget the fold goes ahead as pointers alone', { options: { foldBlocks: 'active', foldBlocksBudgetMs: 3000 } }, async ($, on) => {
  // Jev never answers; the budget's timer does.
  const io = setup(on, { transcript: TRANSCRIPT, env: KEY_ENV, fetch: () => new Promise<HttpResponse>(() => undefined) })
  const out = await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT } as never)
  expect(io.sleeps).toContain(3000)
  const folded = out.messages?.flatMap(m => m.toolResults ?? []).find(r => r.tool_use_id === 'big')?.text ?? ''
  expect(folded.startsWith(FOLD_MARK)).toBe(true)
  expect(folded).not.toContain(KEPT_MARK)
})

test('active: local and private-network addresses are never fetched', { options: { webRead: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: jev })
  for (const url of ['http://localhost:8080/x', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://10.1.2.3/', 'http://192.168.0.1/', 'http://[::1]/', 'http://intranet/', 'http://127.1/', 'http://0177.0.0.1/', 'http://0x7f.0.0.1/', 'http://[0:0:0:0:0:0:0:1]/']) {
    const out = await $.tool.call({ tool: 'mcp__context-harness__web_read', url, question: 'q' } as never)
    expect(String(out.result)).toContain('private-network address')
  }
  expect(io.pageFetches.length).toBe(0)
})

test('shadow: a WebFetch of a signed link is not fetched a second time', { options: { webRead: 'shadow' } }, async ($, on) => {
  const signed = `${URL}?token=ghp_${'a'.repeat(36)}`
  const io = setup(on, { env: KEY_ENV, fetch: jev, pages: { [signed]: PAGE } })
  await $.tool.call({ tool: 'WebFetch', url: signed, prompt: 'q' } as never)
  await drain()
  expect(io.pageFetches.length).toBe(0)
})

test('the call cap holds while a page is judged many requests at once', { options: { webRead: 'active', webReadCap: 5 } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: jev, pages: { [URL]: PAGE } })
  await $.tool.call({ tool: 'mcp__context-harness__web_read', url: URL, question: 'what does 421 mean?' } as never)
  expect(io.fetches.length).toBe(5)
})

test('fold blocks active: a judgment that ends past the budget is recorded late and changes nothing', { options: { foldBlocks: 'active', foldBlocksBudgetMs: 3000 } }, async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => (release = resolve))
  const io = setup(on, { transcript: TRANSCRIPT, env: KEY_ENV, fetch: async body => (await gate, jev(body)) })
  const out = await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT } as never)
  const folded = out.messages?.flatMap(m => m.toolResults ?? []).find(r => r.tool_use_id === 'big')?.text ?? ''
  expect(folded).not.toContain(KEPT_MARK)
  release()
  await settle(() => records(io.writes, 'fold-blocks').length > 0)
  expect(records(io.writes, 'fold-blocks')[0]?.decision).toBe('late')
  // Windows already on their way finish; no second-stage request starts after the budget.
  expect(io.fetches.some(f => 'rel' in (f.body.questions as object))).toBe(false)
})

test('public hosts are not taken for private ones', () => {
  for (const url of ['https://10.example.com/', 'https://docs.python.org/3/', 'https://172.32.0.1/', 'https://[2606:4700::1111]/']) expect(isPrivateHost(url)).toBe(false)
})
