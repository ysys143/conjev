// B2: the records and folded originals live under ~/.conjev/state,
// beside the shared settings. The old root is moved there once, and while both
// exist the old one is still read.
import { expect, test } from 'claude-code/testing'
import { cleanupArgs } from '../hooks/storage'
import { HOME, setup } from './kit'

const NEW = `${HOME}/.conjev/state`
const OLD = `${HOME}/.local/state/context-harness`
const START = { cwd: '/proj', surface: 'terminal', isInteractive: true } as never
const ARCHIVED = JSON.stringify({ id: 'toolu_old', tool: 'Read', input: { file_path: '/proj/a.ts' }, text: 'line one\nline two', isError: false })

test('a session start moves the old state root to the new one, private', async ($, on) => {
  const io = setup(on, { files: { [`${OLD}/archive/s/x.json`]: '{}' } })
  await $.session.start(START)

  expect(io.runs).toContainEqual(['mv', OLD, NEW])
  expect(io.runs).toContainEqual(['chmod', '700', `${HOME}/.conjev`])
  expect(io.runs).toContainEqual(['chmod', '700', NEW])
  // The move comes before anything else touches the roots.
  expect(io.runs.findIndex(r => r[0] === 'mv')).toBeLessThan(io.runs.findIndex(r => r[0] === 'find') === -1 ? Infinity : io.runs.findIndex(r => r[0] === 'find'))
})

test('when the new root exists already, what it lacks is merged in and what both hold is left', async ($, on) => {
  // A session on the old code may write the old root after the move.
  const io = setup(on, { files: { [`${OLD}/archive/s/x.json`]: 'old x', [`${OLD}/archive/s/y.json`]: 'old y', [`${NEW}/archive/s/y.json`]: 'new y' } })
  await $.session.start(START)
  expect(io.runs.some(r => r[0] === 'mv' && r[1] === OLD)).toBe(false)
  expect(io.files[`${NEW}/archive/s/x.json`]).toBe('old x')
  expect(io.files[`${NEW}/archive/s/y.json`]).toBe('new y')
  expect(io.files[`${OLD}/archive/s/y.json`]).toBe('old y')
})

test('nothing moves on a fresh install', async ($, on) => {
  const io = setup(on)
  await $.session.start(START)
  expect(io.runs.some(r => r[0] === 'mv')).toBe(false)
})

test('new folds and records are written under ~/.conjev/state', { options: { stopGate: 'shadow' } }, async ($, on) => {
  const io = setup(on, { env: { TYPESAFE_API_KEY: 'k' } })
  await $.session.start(START)
  await $.command.run({ command: 'jev-mark', args: 'abcd y' } as never)

  expect(io.writes.map(w => w.path)).toEqual([`${NEW}/records/labels/labels/abcd.json`])
})

test('a folded original left in the old root is still read', async ($, on) => {
  setup(on, { files: { [`${OLD}/archive/sess-1/toolu_old.json`]: ARCHIVED, [`${NEW}/archive/other/x.json`]: '{}' } })
  await $.session.start(START)
  const result = await $.tool.call({ tool: 'mcp__conjev__read_coordinate', id: 'toolu_old', full: true } as never)

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
  expect(cleanupArgs(`${HOME}/.conjev/records`)).toEqual([])
})

test('the agent cannot write into either root, or read folded originals in either', { options: { toolGate: 'active', providerTrust: 'external' } }, async ($, on) => {
  setup(on)
  for (const root of [NEW, OLD]) {
    expect((await $.tool.call({ tool: 'Bash', command: `echo x > ${root}/a.json` })).deny).toContain('conjev files')
    expect((await $.tool.call({ tool: 'Read', file_path: `${root}/archive/s/a.json` })).deny).toBeDefined()
  }
})

// The plugin was called context-harness; its folder was ~/.context-harness.
// The rename moves the whole folder once, so a person who set it up keeps the
// key, the two answers and the state, and is not asked again.
const PREVIOUS = `${HOME}/.context-harness`
const SHARED = `${HOME}/.conjev`
const EXPAND = { expansion_type: 'slash_command', command_name: 'conjev:onboard', command_args: '', prompt: '/conjev:onboard' } as never

test('the folder from before the rename becomes ~/.conjev, key and answers with it', async ($, on) => {
  const io = setup(on, {
    files: {
      [`${PREVIOUS}/key`]: 'ts_old\n',
      [`${PREVIOUS}/consent.json`]: '{"consent":true,"at":"t"}\n',
      [`${PREVIOUS}/onboarding.json`]: '{"state":"done","at":"t"}\n',
      [`${PREVIOUS}/state/archive/s/x.json`]: '{}',
    },
  })
  await $.session.start(START)

  expect(io.runs).toContainEqual(['chmod', '700', SHARED])
  // The move comes before the session reads the folder: with the key and the
  // consent found, the gates left at auto are on from the start.
  const report = await $.command.run({ command: 'jev-report', args: '' } as never)
  expect(report.text).toContain('stop active')
  // The key is found where it now is.
  const note = ((await $.classic.UserPromptExpansion(EXPAND)).additionalContext ?? []).join('\n')
  expect(note).toContain('found, in ~/.conjev/key')
  expect(note).not.toContain('ts_old')
  // And the setup, finished before the rename, does not start again.
  expect((await $.classic.SessionStart({ source: 'startup' } as never)).initialUserMessage).toBe(undefined)
  expect(Object.keys(io.files).some(path => path.startsWith(`${PREVIOUS}/`))).toBe(false)
})

test('a ~/.conjev that holds only state still gets the key and the answers', async ($, on) => {
  // What happened: a session between releases made ~/.conjev/state first, and
  // a move that waited for ~/.conjev to be missing never brought the key over.
  const io = setup(on, {
    files: {
      [`${PREVIOUS}/key`]: 'ts_old\n',
      [`${PREVIOUS}/consent.json`]: '{"consent":true,"at":"t"}\n',
      [`${PREVIOUS}/onboarding.json`]: '{"state":"done","at":"t"}\n',
      [`${PREVIOUS}/state/records/a/stop/1.json`]: '{}',
      [`${SHARED}/state/records/b/stop/1.json`]: '{}',
    },
  })
  await $.session.start(START)

  expect(io.files[`${SHARED}/key`]).toBe('ts_old\n')
  expect(io.files[`${SHARED}/consent.json`]).toContain('"consent":true')
  // The engine puts the plugin's name before a log line; the line does not repeat it.
  expect(io.logs).toContain('moved ~/.context-harness to ~/.conjev')
  expect(io.logs.filter(line => line.startsWith('conjev:'))).toEqual([])
  expect(io.files[`${SHARED}/state/records/a/stop/1.json`]).toBe('{}')
  expect(io.files[`${SHARED}/state/records/b/stop/1.json`]).toBe('{}')
  const report = await $.command.run({ command: 'jev-report', args: '' } as never)
  expect(report.text).toContain('stop active')
})

test('a key already in ~/.conjev is kept; the old one is left where it is', async ($, on) => {
  const io = setup(on, { files: { [`${PREVIOUS}/key`]: 'ts_old\n', [`${SHARED}/key`]: 'ts_new\n' } })
  await $.session.start(START)
  expect(io.files[`${SHARED}/key`]).toBe('ts_new\n')
  expect(io.files[`${PREVIOUS}/key`]).toBe('ts_old\n')
})

// What happened: copies left in the old folder because the new one held the
// same file kept the old folder alive, and "moved" was logged at every start
// although nothing moved.
test('a copy with the same contents is removed from the old folder; nothing moved, nothing logged', async ($, on) => {
  const io = setup(on, {
    files: {
      [`${PREVIOUS}/state/records/a/stop/1.json`]: '{"same":1}',
      [`${SHARED}/state/records/a/stop/1.json`]: '{"same":1}',
      [`${PREVIOUS}/state/records/a/stop/2.json`]: '{"old":2}',
      [`${SHARED}/state/records/a/stop/2.json`]: '{"new":2}',
      [`${SHARED}/key`]: 'k\n',
    },
  })
  await $.session.start(START)

  // The duplicate is gone; the one that differs stays for the person to look at.
  expect(`${PREVIOUS}/state/records/a/stop/1.json` in io.files).toBe(false)
  expect(io.files[`${PREVIOUS}/state/records/a/stop/2.json`]).toBe('{"old":2}')
  expect(io.files[`${SHARED}/state/records/a/stop/2.json`]).toBe('{"new":2}')
  // Nothing moved, so nothing is said.
  expect(io.logs.filter(line => line.startsWith('moved'))).toEqual([])
})
