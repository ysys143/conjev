import { expect, test } from 'claude-code/testing'
import { HOME, prompt, setup } from './kit'

const SELECTED = '/private/tmp/ch-research/run-a/state'
const ROOT = `${SELECTED}/.local/state/context-harness`
const PERSONAL = `${HOME}/.local/state/context-harness`
const archived = { id: 'old', tool: 'Read', input: { file_path: '/proj/old' }, text: 'personal original', isError: false }
const old = [prompt('read'), { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: '/proj/a' } }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'x\n'.repeat(2000), isError: false }] }, prompt('next'), prompt('last')]

test('research storage: startup cleanup, archives, and read_coordinate use only the selected state home', async ($, on) => {
  const io = setup(on, { env: { CONTEXT_HARNESS_STATE_HOME: SELECTED }, files: {
    [`${ROOT}/records/prior/stop/a.json`]: '{}',
    [`${PERSONAL}/records/personal/stop/a.json`]: '{}',
    [`${PERSONAL}/archive/sess-1/old.json`]: JSON.stringify(archived),
    [`${HOME}/.claude-context-fold/sess-1/old.json`]: JSON.stringify(archived),
  } })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect(io.runs.every(argv => argv.join(' ').includes(`${ROOT}/records`))).toBe(true)
  expect(io.runs.some(argv => argv.join(' ').includes(PERSONAL))).toBe(false)
  await $.session.compact({ trigger: 'manual', messages: old } as never)
  expect(io.writes.some(w => w.path === `${ROOT}/archive/sess-1/a.json`)).toBe(true)
  expect(io.writes.every(w => !w.path.startsWith(PERSONAL))).toBe(true)
  const current = await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'a', limit: 2 })
  expect(JSON.stringify(current)).toContain('x\\nx')
  const previous = await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'old' })
  expect(JSON.stringify(previous)).not.toContain('personal original')
})

test('research storage: tool protection follows the selected archive', { options: { toolGate: 'active', providerTrust: 'external' } }, async ($, on) => {
  setup(on, { env: { CONTEXT_HARNESS_STATE_HOME: SELECTED } })
  expect((await $.tool.call({ tool: 'Read', file_path: `${ROOT}/archive/other/a.json` })).deny).toContain('folded originals')
  expect((await $.tool.call({ tool: 'Write', file_path: `${ROOT}/archive/other/a.json`, content: 'changed' })).deny).toContain('context-harness files')
})

test('research storage: an invalid override cannot fall back to personal storage', async ($, on) => {
  const io = setup(on, { env: { CONTEXT_HARNESS_STATE_HOME: '/tmp/../personal' }, files: { [`${PERSONAL}/records/personal/stop/a.json`]: '{}' } })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  await $.session.compact({ trigger: 'manual', messages: old } as never)
  expect(io.runs).toEqual([])
  expect(io.writes).toEqual([])
})
