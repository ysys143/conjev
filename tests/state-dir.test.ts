// B2: the records and folded originals live under ~/.context-harness/state,
// beside the shared settings. The old root is moved there once, and while both
// exist the old one is still read.
import { expect, test } from 'claude-code/testing'
import { cleanupArgs } from '../hooks/storage'
import { HOME, setup } from './kit'

const NEW = `${HOME}/.context-harness/state`
const OLD = `${HOME}/.local/state/context-harness`
const START = { cwd: '/proj', surface: 'terminal', isInteractive: true } as never
const ARCHIVED = JSON.stringify({ id: 'toolu_old', tool: 'Read', input: { file_path: '/proj/a.ts' }, text: 'line one\nline two', isError: false })

test('a session start moves the old state root to the new one, private', async ($, on) => {
  const io = setup(on, { files: { [`${OLD}/archive/s/x.json`]: '{}' } })
  await $.session.start(START)

  expect(io.runs).toContainEqual(['mv', OLD, NEW])
  expect(io.runs).toContainEqual(['chmod', '700', `${HOME}/.context-harness`])
  expect(io.runs).toContainEqual(['chmod', '700', NEW])
  // The move comes before anything else touches the roots.
  expect(io.runs.findIndex(r => r[0] === 'mv')).toBeLessThan(io.runs.findIndex(r => r[0] === 'find') === -1 ? Infinity : io.runs.findIndex(r => r[0] === 'find'))
})

test('nothing moves when the new root exists already, or the old one does not', async ($, on) => {
  const io = setup(on, { files: { [`${OLD}/archive/s/x.json`]: '{}', [`${NEW}/archive/s/y.json`]: '{}' } })
  await $.session.start(START)
  expect(io.runs.some(r => r[0] === 'mv')).toBe(false)
})

test('nothing moves on a fresh install', async ($, on) => {
  const io = setup(on)
  await $.session.start(START)
  expect(io.runs.some(r => r[0] === 'mv')).toBe(false)
})

test('new folds and records are written under ~/.context-harness/state', { options: { stopGate: 'shadow' } }, async ($, on) => {
  const io = setup(on, { env: { TYPESAFE_API_KEY: 'k' } })
  await $.session.start(START)
  await $.command.run({ command: 'jev-mark', args: 'abcd y' } as never)

  expect(io.writes.map(w => w.path)).toEqual([`${NEW}/records/labels/labels/abcd.json`])
})

test('a folded original left in the old root is still read', async ($, on) => {
  setup(on, { files: { [`${OLD}/archive/sess-1/toolu_old.json`]: ARCHIVED, [`${NEW}/archive/other/x.json`]: '{}' } })
  await $.session.start(START)
  const result = await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_old', full: true } as never)

  expect(String(result.result)).toContain('line two')
})

test('records and labels left in the old root are still reported', async ($, on) => {
  const record = JSON.stringify({ id: 'r1', ts: '2026-10-01T00:00:00.000Z', sessionId: 's', point: 'stop', mode: 'shadow', sent: null, hookMs: 1 })
  setup(on, {
    files: {
      [`${OLD}/records/s/stop/r1.json`]: record,
      [`${OLD}/records/labels/labels/r1.json`]: JSON.stringify({ id: 'r1', label: true, ts: 'x' }),
      [`${NEW}/records/s2/stop/r2.json`]: record.replace('r1', 'r2'),
    },
  })
  await $.session.start(START)
  const report = String((await $.command.run({ command: 'jev-report', args: '' } as never)).text)

  expect(report).toContain('2 records, 1 labels')
})

test('old records are cleaned under both roots, and only there', () => {
  expect(cleanupArgs(`${NEW}/records`)[0]?.[1]).toBe(`${NEW}/records`)
  expect(cleanupArgs(`${OLD}/records`)[0]?.[1]).toBe(`${OLD}/records`)
  expect(cleanupArgs(`${HOME}/.context-harness/records`)).toEqual([])
})

test('the agent cannot write into either root, or read folded originals in either', { options: { toolGate: 'active', providerTrust: 'external' } }, async ($, on) => {
  setup(on)
  for (const root of [NEW, OLD]) {
    expect((await $.tool.call({ tool: 'Bash', command: `echo x > ${root}/a.json` })).deny).toContain('context-harness files')
    expect((await $.tool.call({ tool: 'Read', file_path: `${root}/archive/s/a.json` })).deny).toBeDefined()
  }
})
