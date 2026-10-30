import { expect } from 'claude-code/testing'
import { test } from './folding'
import { HOME, prompt, setup } from './kit'
import { stateRoot, oldStateRoot } from '../hooks/storage'

const SELECTED = '/private/tmp/ch-research/run-a/state'
const ROOT = stateRoot(SELECTED)
const PERSONAL = stateRoot(HOME)
const archived = { id: 'old', tool: 'Read', input: { file_path: '/proj/old' }, text: 'personal original', isError: false }
const old = [prompt('read'), { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: '/proj/a' } }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'x\n'.repeat(2000), isError: false }] }, prompt('next'), prompt('last')]

test('research storage: startup cleanup, archives, and read_coordinate use only the selected state home', { options: { keepRecentTurns: 0 } }, async ($, on) => {
  const io = setup(on, { transcript: old, env: { CONTEXT_HARNESS_STATE_HOME: SELECTED }, files: {
    [`${ROOT}/records/prior/stop/a.json`]: '{}',
    [`${PERSONAL}/records/personal/stop/a.json`]: '{}',
    [`${PERSONAL}/archive/sess-1/old.json`]: JSON.stringify(archived),
    [`${oldStateRoot(HOME)}/archive/sess-1/old.json`]: JSON.stringify(archived),
    [`${HOME}/.claude-context-fold/sess-1/old.json`]: JSON.stringify(archived),
  } })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  const cleanup = io.runs.filter(argv => argv[0] === 'find')
  expect(cleanup.length).toBe(2)
  expect(cleanup.every(argv => argv.join(' ').includes(`${ROOT}/records`))).toBe(true)
  expect(io.runs.some(argv => argv.join(' ').includes(PERSONAL))).toBe(false)
  await $.session.compact({ trigger: 'manual', messages: old } as never)
  expect(io.writes.some(w => w.path === `${ROOT}/archive/sess-1/a.json`)).toBe(true)
  expect(io.writes.every(w => !w.path.startsWith(PERSONAL))).toBe(true)
  const current = await $.tool.call({ tool: 'mcp__conjev__read_coordinate', id: 'a', limit: 2 })
  expect(JSON.stringify(current)).toContain('x\\nx')
  const previous = await $.tool.call({ tool: 'mcp__conjev__read_coordinate', id: 'old' })
  expect(JSON.stringify(previous)).not.toContain('personal original')
})

test('research storage: tool protection follows the selected archive', { options: { toolGate: 'active', providerTrust: 'external' } }, async ($, on) => {
  setup(on, { env: { CONTEXT_HARNESS_STATE_HOME: SELECTED } })
  expect((await $.tool.call({ tool: 'Read', file_path: `${ROOT}/archive/other/a.json` })).deny).toContain('folded originals')
  expect((await $.tool.call({ tool: 'Write', file_path: `${ROOT}/archive/other/a.json`, content: 'changed' })).deny).toContain('conjev files')
})

test('research storage: an invalid override cannot fall back to personal storage', async ($, on) => {
  const io = setup(on, { env: { CONTEXT_HARNESS_STATE_HOME: '/tmp/../personal' }, files: { [`${PERSONAL}/records/personal/stop/a.json`]: '{}' } })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  await $.session.compact({ trigger: 'manual', messages: old } as never)
  expect(io.runs).toEqual([])
  expect(io.writes).toEqual([])
})


test('research storage: reports never read personal or pre-rename judgment records', async ($, on) => {
  const row = (id: string) => JSON.stringify({ id, ts: '2026-10-01T00:00:00.000Z', sessionId: 'run', point: 'stop', mode: 'shadow', sent: null, hookMs: 1 })
  setup(on, { env: { CONTEXT_HARNESS_STATE_HOME: SELECTED }, files: {
    [`${ROOT}/records/run/stop/selected.json`]: row('selected'),
    [`${PERSONAL}/records/run/stop/personal.json`]: row('personal'),
    [`${oldStateRoot(SELECTED)}/records/run/stop/old.json`]: row('old'),
    [`${oldStateRoot(HOME)}/records/run/stop/old-personal.json`]: row('old-personal'),
  } })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  const report = String((await $.command.run({ command: 'jev-report', args: '' } as never)).text)
  expect(report).toContain('1 records, 0 labels')
})
