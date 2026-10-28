// As installed: every Jev setting at its manifest default. A key in every
// source must still send nothing and record no judgment, whichever hook runs.
import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { HOME, KEY_ENV, drain, prompt, setup } from './kit'

const call = (id: string, tool: string, input: Record<string, unknown>): SessionMessage => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] })
const answer = (id: string, text: string): SessionMessage => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError: false }] })
const BIG = 'x\n'.repeat(1500)
const FOLDABLE: SessionMessage[] = [
  prompt('Look at the parser'),
  call('a', 'Read', { file_path: '/proj/a.ts' }),
  answer('a', BIG),
  call('b', 'Bash', { command: 'npm test' }),
  answer('b', BIG),
  prompt('next'),
  prompt('Publish the release and write a report'),
]
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
const START = { cwd: '/proj', surface: 'terminal', isInteractive: true } as never

// Only the key is set; every mode is the manifest's.
test('defaults: a key in every source, every hook run, nothing sent and no judgment recorded', { options: { apiKey: 'tk-config' } }, async ($, on) => {
  const io = setup(on, {
    transcript: FOLDABLE,
    env: KEY_ENV,
    dotenv: 'TYPESAFE_API_KEY=tk-dotenv\n',
    messages: FOLDABLE,
    percent: 70,
    files: { '/home/me/.agents/fragments/prose.md': '---\nwhen: The person asks for prose.\nkeywords: report\n---\nWrite plainly.\n' },
  })
  await $.session.start(START)
  await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: { name: 'default', isKeepingCodingInstructions: true }, traits: [] } as never)
  await $.prompt.submit(typed('Publish the release and write a report'))
  await $.tool.call({ tool: 'Read', file_path: '/proj/.env' })
  await $.tool.call({ tool: 'Bash', command: 'printenv' })
  await $.tool.call({ tool: 'Read', file_path: '/proj/src/app.ts' })
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Next, I will refactor the cache.' } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.session.compact({ trigger: 'manual', messages: FOLDABLE } as never)
  await $.classic.PostCompact({ trigger: 'manual', compact_summary: 'x' } as never)
  await $.classic.SessionStart({ source: 'compact' } as never)
  const files = [{ path: '/home/me/.agents/AGENTS.md', kind: 'user', content: '## 문체\n\nLead with the result.\n' }, { path: '/proj/AGENTS.md', kind: 'project', content: '## 문체\n\nLead with the result.\n' }]
  await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'rendered' }], instructionFiles: files } as never)
  const report = await $.command.run({ command: 'jev-report', args: '' } as never)
  await drain()

  expect(io.fetches.length).toBe(0)
  // No gate recorded anything. The compaction's own record is not a judgment:
  // it says what the fold did, and folding is on with no key at all.
  expect(io.writes.filter(w => w.path.includes('/records/') && !w.path.includes('/compact/'))).toEqual([])
  // The instruction files load as they are, the duplicate included.
  expect(io.loaded[0]).toEqual(files)
  // The modes the engine filled in from the manifest.
  expect(report.text).toContain('context-harness: stop off, tool off, tool jev off, instructions off, fold off, instruction filter off')
  // The fragment was not attached: instructions are off.
  expect(io.submitted[0]?.context).toBe(undefined)
  // Folding needs no key and is on by default.
  expect(io.writes.some(w => w.path.includes('/archive/'))).toBe(true)
})

test('a shared folder under the home directory overrides this profile, and its key is used', async ($, on) => {
  const io = setup(on, {
    env: KEY_ENV,
    files: {
      [`${HOME}/.context-harness/config.json`]: '{"foldAtPercent": 5}',
      [`${HOME}/.context-harness/key`]: 'ts_shared_key\n',
    },
  })
  await $.session.start(START)
  const report = JSON.parse(String((await $.tool.call({ tool: 'mcp__context-harness__policy_report' })).result)) as { current: { settings: { foldAtPercent: number } } }

  // The fold policy came from the shared file, not this profile's defaults.
  expect(report.current.settings.foldAtPercent).toBe(5)
})

test('without a shared folder nothing changes: each profile keeps its own settings', async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  await $.session.start(START)
  const report = JSON.parse(String((await $.tool.call({ tool: 'mcp__context-harness__policy_report' })).result)) as { current: { settings: { foldAtPercent: number } } }

  expect(report.current.settings.foldAtPercent).toBe(60)
})

test('with no key, /install says where to get one and where to put it', async ($, on) => {
  const io = setup(on, {})
  await $.session.start(START)
  const { text } = (await $.command.run({ command: 'install' })) as { text: string }

  // Where a key comes from, and where to put one to share it.
  expect(text).toContain('Key: none found')
  expect(text).toContain('console.typesafe.ai/home')
  expect(text).toContain('/.context-harness/key')
  expect(io.fetches.length).toBe(0)
})

test('/install names what each gate sends, and what is scrubbed first', async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  await $.session.start(START)
  const { text } = (await $.command.run({ command: 'install' })) as { text: string }

  expect(text).toContain('/.context-harness/key')
  // Each gate is listed with its mode and what it sends.
  expect(text).toContain('stop')
  expect(text).toContain('instruction filter')
  // And it says what is scrubbed before anything leaves.
  expect(text).toContain('Korean personal information')
  // The key itself is never printed, and nothing is sent by the command.
  expect(text).not.toContain('tk-env')
  expect(io.fetches.length).toBe(0)
})

test('/install says the key was found, and from where, without printing it', { options: { apiKey: 'tk-config' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  await $.session.start(START)
  const { text } = (await $.command.run({ command: 'install' })) as { text: string }

  expect(text).toContain('Key: found, from config')
  expect(text).not.toContain('tk-config')
  expect(io.fetches.length).toBe(0)
})
