import { expect, test } from 'claude-code/testing'
import type { Register } from 'claude-code'

const STOP = { stop_hook_active: false, last_assistant_message: 'I will finish it.' }
const JEV = 'https://api.typesafe.ai/v1/systemone'
const COMMAND = { command: 'probe-jev', args: '', origin: { kind: 'sdk' as const },
  presentation: { isFullscreen: false, columns: 80 } }
const caller = {
  name: 'jev-fixture',
  register(on: Parameters<Register>[0]) {
    on('command.run', { command: 'probe-jev' }, async $ => {
      try {
        const response = await $.http.fetch('https://api.typesafe.ai/v1/systemone', {
          method: 'POST', headers: { authorization: 'Bearer fixture-private' },
          body: JSON.stringify({ model: 'jev-latest', state: 'fixture', questions: {} }),
        })
        return { text: String(response.ok) }
      } catch { return { text: 'refused' } }
    })
  },
}

test('instruction inventory observes the delivered files without rewriting context', async ($, on) => {
  const files = [{ path: '/fixture/CLAUDE.md', kind: 'project' as const, content: 'fixture inventory marker' }]
  const blocks = [{ name: 'claudeMd', text: 'fixture inventory marker' }]
  const recorded: Record<string, unknown>[] = []
  on('env.get', () => ({ value: 'http://127.0.0.1:12345' }))
  on('http.fetch', (_, e) => {
    recorded.push(JSON.parse(e.init!.body!))
    return { value: { ok: true, status: 200, headers: {}, text: '{}' } }
  })
  on('prompt.context', (_, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))
  const result = await $.prompt.context({ blocks, instructionFiles: files })
  expect(result.instructionFiles).toEqual(files)
  expect(result.blocks).toEqual(blocks)
  expect(recorded[0]?.files).toEqual(files)
})

test('the observer snapshots before the underlying decision and preserves its block', async ($, on) => {
  const order: string[] = []
  const payloads: Record<string, unknown>[] = []
  let now = 0
  on('env.get', () => ({ value: 'http://127.0.0.1:12345' }))
  on('clock.now', () => ({ value: ++now }))
  on('session.messages', () => ({ value: [] }))
  on('http.fetch', (_, e) => {
    const path = e.url.split(':12345')[1]!
    order.push(path)
    payloads.push(JSON.parse(e.init!.body!))
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ candidate_id: 'c1' }) } }
  })
  on('classic.Stop', () => { order.push('underlying'); return { block: 'original block' } })
  const result = await $.classic.Stop(STOP)
  expect(result).toEqual({ block: 'original block' })
  expect(order).toEqual(['/candidate', 'underlying', '/decision'])
  expect(payloads[1]?.result).toEqual(result)
  expect(payloads[1]?.pre_observer_ms).toBe(1)
})

test('failed evidence collection neither changes a result nor repeats the underlying hook', async ($, on) => {
  let calls = 0
  on('env.get', () => ({ value: 'http://127.0.0.1:12345' }))
  on('clock.now', () => ({ value: 1 }))
  on('session.messages', () => ({ value: [] }))
  on('http.fetch', () => ({ value: { ok: false, status: 500, headers: {}, text: '{}' } }))
  on('classic.Stop', () => { calls++; return {} })
  expect(await $.classic.Stop(STOP)).toEqual({})
  expect(calls).toBe(1)
})

test('a Jev request is reserved before forwarding, unchanged, without logging credentials', { plugins: [caller] }, async ($, on) => {
  const order: string[] = []
  const evaluator: string[] = []
  const request = { model: 'jev-latest', state: 'fixture', questions: {} }
  const body = JSON.stringify(request)
  on('env.get', () => ({ value: 'http://127.0.0.1:12345' }))
  on('http.fetch', (_, e) => {
    if (e.url === JEV) {
      order.push('vendor')
      expect(e.init?.body).toBe(body)
      expect(e.init?.headers?.authorization).toBe('Bearer fixture-private')
      return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ model: 'fixture-model', usage: { input_tokens: 3, output_tokens: 1 } }) } }
    }
    const path = e.url.split(':12345')[1]!
    order.push(path)
    evaluator.push(e.init!.body!)
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ call_id: 'j1' }) } }
  })
  expect((await $.command.run(COMMAND)).text).toBe('true')
  expect(order).toEqual(['/reserve', 'vendor', '/settle'])
  expect(evaluator.join('')).not.toContain('fixture-private')
})

test('a failed reservation refuses the paid call before it reaches the service', { plugins: [caller] }, async ($, on) => {
  let vendor = 0
  let reservations = 0
  on('env.get', () => ({ value: 'http://127.0.0.1:12345' }))
  on('http.fetch', (_, e) => {
    if (e.url === JEV) vendor++
    if (e.url.endsWith('/reserve')) reservations++
    return { value: { ok: false, status: 422, headers: {}, text: '{}' } }
  })
  expect((await $.command.run(COMMAND)).text).toBe('refused')
  expect(reservations).toBe(1)
  expect(vendor).toBe(0)
})
