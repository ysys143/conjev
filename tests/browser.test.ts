// Browser routing: which tool, how the model is told, and when Jev is asked.
import type { HttpResponse } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { BROWSER_BLOCK, chooseBrowser, parseBlocked, routeBlock, type Detected } from '../hooks/browser-route'
import { HOME, KEY_ENV, records, settle, setup } from './kit'

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
const operate = (p: number) => (): HttpResponse => ({
  status: 200,
  ok: true,
  headers: {},
  text: JSON.stringify({
    model: 'jev-1.14.0',
    answers: { browser: { type: 'choice', choice: p >= 0.5 ? 'operate' : 'read', confidence: 0.9, probabilities: { operate: p, read: 1 - p } } },
    usage: { input_tokens: 400, output_tokens: 1 },
  }),
})
const lastContext = (io: { submitted: { context?: readonly string[] }[] }): string => (io.submitted.at(-1)?.context ?? []).join('\n')

test('the order of preference: ego, Aside, agent-browser, Playwright, then a named CDP tool', () => {
  const all: Detected = { available: ['ego', 'aside', 'agent-browser', 'playwright', 'cdp'], blocked: [], cdp: 'chrome-devtools MCP' }
  expect(chooseBrowser(all)).toBe('ego')
  expect(chooseBrowser({ ...all, available: ['playwright', 'aside', 'cdp'] })).toBe('aside')
  expect(chooseBrowser({ ...all, available: ['playwright', 'agent-browser'] })).toBe('agent-browser')
  expect(chooseBrowser({ ...all, available: ['cdp', 'playwright'] })).toBe('playwright')
  expect(chooseBrowser({ ...all, available: ['cdp'] })).toBe('cdp')
  expect(chooseBrowser({ ...all, available: [] })).toBe(undefined)
  expect(parseBlocked(' Playwright, cdp, unknown ,ego')).toEqual(['playwright', 'cdp', 'ego'])
})

test('the block names the tool, the others in order, and the blocked ones never to use', () => {
  const block = routeBlock({ available: ['aside', 'playwright'], blocked: ['ego'], cdp: '' })
  expect(block.startsWith(`<instruction name="${BROWSER_BLOCK}" source="context-harness">`)).toBe(true)
  expect(block).toContain('Use Aside.')
  expect(block).toContain('Never print or serialize')
  expect(block).toContain('Also installed, in order of preference: Playwright')
  expect(block).toContain('Never use ego-browser')
  const cdp = routeBlock({ available: ['cdp'], blocked: [], cdp: 'the chrome-devtools MCP tools' })
  expect(cdp).toContain('Use the chrome-devtools MCP tools.')
  const none = routeBlock({ available: [], blocked: ['playwright'], cdp: '' })
  expect(none).toContain('no browser tool this plugin knows is available')
  expect(none).toContain('https://lite.ego.app/')
  expect(none).toContain('blocked by settings: Playwright')
})

test('off: nothing is judged, attached or sent', async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: operate(0.99) })
  await $.prompt.submit(typed('Log in to the dashboard and click export'))
  expect(lastContext(io)).not.toContain(BROWSER_BLOCK)
  expect(io.fetches.length).toBe(0)
  expect(records(io.writes, 'browser-route').length).toBe(0)
})

test('active: a keyword decides without Jev, and the block names ego first', { options: { browserRoute: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: operate(0.01) })
  await $.prompt.submit(typed('쿠팡에 로그인해서 장바구니를 비워줘'))
  expect(lastContext(io)).toContain('Use ego-browser.')
  expect(lastContext(io)).toContain('ego-browser skill')
  expect(io.fetches.length).toBe(0)
  await settle(() => records(io.writes, 'browser-route').length > 0)
  expect(records(io.writes, 'browser-route')[0]?.decision).toBe('attach')
})

test('active: without a keyword Jev decides at the threshold, and the prompt goes to it scrubbed', { options: { browserRoute: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: operate(0.95) })
  await $.prompt.submit(typed('Go through the vendor portal and download every invoice from March, my email is a@b.co'))
  expect(lastContext(io)).toContain(BROWSER_BLOCK)
  expect(io.fetches.length).toBe(1)
  expect(JSON.stringify(io.fetches[0]?.body)).not.toContain('a@b.co')
})

test('active: a request to read a page is not routed', { options: { browserRoute: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: operate(0.2) })
  await $.prompt.submit(typed('What does RFC 9110 say about status 421?'))
  expect(lastContext(io)).not.toContain(BROWSER_BLOCK)
  await settle(() => records(io.writes, 'browser-route').length > 0)
  expect(records(io.writes, 'browser-route')[0]?.decision).toBe('read')
})

test('active: once the conversation carries the block, it is not attached again', { options: { browserRoute: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: operate(0.01) })
  await $.prompt.submit(typed('Click the export button on the dashboard'))
  await $.prompt.submit(typed('Now click import too'))
  const attached = io.submitted.filter(s => (s.context ?? []).some(c => c.includes(BROWSER_BLOCK)))
  expect(attached.length).toBe(1)
})

test('shadow: judged and recorded, nothing attached', { options: { browserRoute: 'shadow' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: operate(0.01) })
  await $.prompt.submit(typed('Take a screenshot of the pricing page'))
  expect(lastContext(io)).not.toContain(BROWSER_BLOCK)
  await settle(() => records(io.writes, 'browser-route').length > 0)
  const [record] = records(io.writes, 'browser-route')
  expect(record?.decision).toBe('would-attach')
  expect((record?.facts as Record<string, string>).chosen).toBe('ego')
})

test('a prompt long enough to be cut is scrubbed before the cut, so no value reaches Jev in part', { options: { browserRoute: 'shadow' } }, async ($, on) => {
  // No keyword, so Jev is asked; the phone number starts at 590, so a cut at
  // 600 lands inside the label scrubbing leaves behind.
  const io = setup(on, { env: KEY_ENV, fetch: operate(0.01) })
  await $.prompt.submit(typed(`${'가 나 '.repeat(200).slice(0, 590)}010-1234-5678`))
  await settle(() => records(io.writes, 'browser-route').length > 0)

  const request = (io.fetches[0]?.body.state as Record<string, string> | undefined)?.request ?? ''
  expect(request).not.toContain('010')
  expect(request.length).toBeLessThanOrEqual(600)
})

test('a blocked tool is passed over for the next one installed', { options: { browserRoute: 'active', browserBlocked: 'ego,aside' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: operate(0.01) })
  await $.prompt.submit(typed('Click through the signup form'))
  expect(lastContext(io)).toContain('Use agent-browser.')
  expect(lastContext(io)).toContain('Never use ego-browser, Aside')
})

test('with no CLI on PATH, a common install folder still counts', { options: { browserRoute: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: operate(0.01), failRun: 'which', files: { [`${HOME}/.local/bin/agent-browser`]: '' } })
  await $.prompt.submit(typed('Click the login button'))
  expect(lastContext(io)).toContain('Use agent-browser.')
})

test('nothing installed: the model is told, and the person once in 14 days', { options: { browserRoute: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: operate(0.01), failRun: 'which' })
  await $.prompt.submit(typed('Click the login button'))
  expect(lastContext(io)).toContain('no browser tool this plugin knows is available')
  await $.prompt.submit(typed('/clear-ish: click the other button'))
  expect(io.toasts.filter(t => t.includes('lite.ego.app')).length).toBe(1)
})
