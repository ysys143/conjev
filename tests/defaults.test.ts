// As installed: every Jev setting at its manifest default. A key in every
// source must still send nothing and record no judgment, whichever hook runs.
import type { SessionMessage } from 'claude-code'
import { expect, test, type TestBody } from 'claude-code/testing'
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
  expect(report.text).toContain('conjev: stop off, tool off, tool jev off, instructions off, fold off, instruction filter off')
  // The fragment was not attached: instructions are off.
  expect(io.submitted[0]?.context).toBe(undefined)
  // Folding needs no key and is on by default.
  expect(io.writes.some(w => w.path.includes('/archive/'))).toBe(true)
})

test('a shared folder under the home directory overrides this profile, and its key is used', async ($, on) => {
  const io = setup(on, {
    env: KEY_ENV,
    files: {
      [`${HOME}/.conjev/config.json`]: '{"foldAtPercent": 5}',
      [`${HOME}/.conjev/key`]: 'ts_shared_key\n',
    },
  })
  await $.session.start(START)
  const report = JSON.parse(String((await $.tool.call({ tool: 'mcp__conjev__policy_report' })).result)) as { current: { settings: { foldAtPercent: number } } }

  // The fold policy came from the shared file, not this profile's defaults.
  expect(report.current.settings.foldAtPercent).toBe(5)
})

test('without a shared folder nothing changes: each profile keeps its own settings', async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  await $.session.start(START)
  const report = JSON.parse(String((await $.tool.call({ tool: 'mcp__conjev__policy_report' })).result)) as { current: { settings: { foldAtPercent: number } } }

  expect(report.current.settings.foldAtPercent).toBe(60)
})

// The command is a Markdown file now, not a `command.run` hook: its body is the
// prompt the model runs, which is what lets the agent ask and act instead of
// printing a string. The hook could only answer; it could not start a turn.
import { INSTALL_COMMAND_BODY, INSTALL_COMMAND_DESCRIPTION, KEY_CHECK } from '../hooks/install-command'

const COMMAND = INSTALL_COMMAND_BODY

test('the install command is a prompt the model runs, not a string it prints', () => {
  // The body is what the model receives, so it addresses the agent and asks the
  // person a question. `scripts/build-command.ts` writes the Markdown file from
  // this text; the tests hold the text, and --check holds the two together.
  expect(COMMAND).toContain('Ask one plain question')
  expect(INSTALL_COMMAND_DESCRIPTION).toContain('Jev key')

  // It asks before it acts, and it never asks for the key itself.
  expect(COMMAND).toContain('do you already have a TypeSafe key')
  expect(COMMAND).toContain('Never ask them to paste the key to you')
  expect(COMMAND).toContain('should rotate it')

  // The ways to place one, including the one the agent runs itself.
  expect(COMMAND).toContain('https://console.typesafe.ai/home')
  expect(COMMAND).toContain('claude plugin configure conjev@conjev')
  expect(COMMAND).toContain('$HOME/.conjev/key')
  // Placed without the value ever reaching the agent's context, from wherever
  // the person says they keep it.
  expect(COMMAND).toContain('Ask one question: where do they keep it?')
  expect(COMMAND).toContain('chmod 600')
  expect(COMMAND).toContain('test -s')

  // And what to check afterwards.
  expect(COMMAND).toContain('/conjev:onboard')
  expect(COMMAND).toContain(KEY_CHECK)
})

test('the setup asks one thing at a time and waits', () => {
  // A first reply that held the key question, every way to place a key and the
  // consent text at once read as a form, not a conversation.
  expect(COMMAND).toContain('## Pace: one step, one question, then wait')
  expect(COMMAND).toContain('ends with at most one question; then stop and wait')
  expect(COMMAND).toContain("Never put a later step's material into an earlier reply")
  expect(COMMAND).toContain('offer only the way below that\n  fits, not the list')
  expect(COMMAND).toContain('Only after they have answered, in the closing\nreply')
  expect(COMMAND).not.toContain('Offer these ways and let them pick')
})

test('the command speaks to someone who has never heard of the key', () => {
  // The person meets Jev, TypeSafe and ~/.conjev/key here first: the
  // reply says what they are for before it reports anything missing.
  expect(COMMAND).toContain('it is your source, not your script')
  expect(COMMAND).toContain('Do not open with a file path, a missing file')
  expect(COMMAND).toContain('do not list the places the\n  plugin looked')
  expect(COMMAND).toContain('The first time you name a file or a setting, say what it is')
  expect(COMMAND).toContain("Answer in the person's language")
  // One concept, the README's: one rule, judged by Jev at every point, a
  // reduced mode on rules without a key. Facts kept apart from how to speak,
  // so the model explains rather than recites.
  expect(COMMAND).toContain('These are facts for you, not text to read out')
  expect(COMMAND).toContain('**The one rule.** The original stays in the archive')
  expect(COMMAND).toContain('**Where that judgment is made.**')
  expect(COMMAND).toContain('a reduced mode in which the originals are still kept')
  expect(COMMAND).toContain('Describe one\n  system, not a list of features')
  expect(COMMAND).toContain('Do not open with a definition')
  for (const split of ['is folding and Jev together', 'Jev half', 'gates set to auto', 'checks Jev makes']) expect(COMMAND).not.toContain(split)
})

test('the command never tells the agent to read or print a key, or where one person keeps theirs', () => {
  const forbidden = [/cat\s+\S*apikey\.env/, /echo\s+\$TYPESAFE/, /printenv/]
  for (const pattern of forbidden) expect(COMMAND).not.toMatch(pattern)
  // No one machine's layout: the agent asks, and looks nowhere it was not told.
  for (const local of ['oh-my-zsh', 'apikey.env', '/Users/', 'zsh -c']) expect(COMMAND).not.toContain(local)
  expect(COMMAND).toContain('Do not look for the key in files or settings the person has not named')
})

// Where the key is, only the plugin knows; it says so when the command expands,
// so the model reads it beside the body instead of guessing or probing files.
const EXPAND = { expansion_type: 'slash_command', command_name: 'conjev:onboard', command_args: '', prompt: '/conjev:onboard' } as const
const expand = async ($: Parameters<TestBody>[0], command = EXPAND): Promise<string> =>
  ((await $.classic.UserPromptExpansion(command as never)).additionalContext ?? []).join('\n')

test('the command arrives with where the plugin found the key, never the key', async ($, on) => {
  setup(on, { env: KEY_ENV })
  await $.session.start(START)
  const note = await expand($)

  expect(note).toContain(`${KEY_CHECK} found, in TYPESAFE_API_KEY in the environment`)
  expect(note).not.toContain(KEY_ENV.TYPESAFE_API_KEY)
})

test("the profile's secure setting is named as such", { options: { apiKey: 'tk-config' } }, async ($, on) => {
  setup(on)
  await $.session.start(START)
  const note = await expand($)

  expect(note).toContain(`${KEY_CHECK} found, in this Claude Code profile's secure plugin setting`)
  expect(note).not.toContain('tk-config')
})

test('no key: the note names every place looked; a key placed later is seen on the next run, and used', { options: { stopGate: 'shadow' } }, async ($, on) => {
  const io = setup(on, { isTimerStopped: true })
  await $.session.start(START)
  const before = await expand($)
  expect(before).toContain(`${KEY_CHECK} none found`)
  for (const place of ['~/.conjev/key', 'secure plugin setting', '.env', 'TYPESAFE_API_KEY']) expect(before).toContain(place)

  // The person places the key in the shared file; the session goes on.
  io.files[`${HOME}/.conjev/key`] = 'ts_placed\n'
  const after = await expand($)
  expect(after).toContain(`${KEY_CHECK} found, in ~/.conjev/key`)
  expect(after).not.toContain('ts_placed')

  // The gate that had no key now sends with this one, without a new session.
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Next, I will refactor the cache.' } as never)
  await drain()
  expect(io.fetches[0]?.headers.authorization).toBe('Bearer ts_placed')
})

test('other commands expand untouched', async ($, on) => {
  setup(on, { env: KEY_ENV })
  await $.session.start(START)

  expect(await expand($, { ...EXPAND, command_name: 'jev-report', prompt: '/jev-report' } as never)).toBe('')
})
