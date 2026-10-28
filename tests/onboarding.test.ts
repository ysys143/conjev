// Installed with a key and the person's consent, fold and Jev run by default:
// every Jev gate is `auto`, which is active only with a key, `jev: on` and a
// recorded consent. The first run starts the setup by itself, once.
import type { HttpResponse } from 'claude-code'
import { expect, test, type TestBody } from 'claude-code/testing'
import { CONSENT_TEXT, INSTALL_COMMAND_BODY, KEY_CHECK, ONBOARDING_MARK } from '../hooks/install-command'
import { HOME, KEY_ENV, drain, setup, type On, type Setup } from './kit'

const ANNOUNCE: HttpResponse = {
  status: 200,
  ok: true,
  headers: {},
  text: JSON.stringify({
    model: 'jev-1.14.0',
    answers: { stop: { type: 'choice', choice: 'announce', confidence: 0.98, probabilities: { announce: 0.99, report: 0.01 } } },
    usage: { input_tokens: 373, output_tokens: 31 },
  }),
}
const SHARED = `${HOME}/.conjev`
const CONSENTED = { [`${SHARED}/consent.json`]: '{"consent":true,"at":"2026-10-28T00:00:00.000Z"}\n' }
const START = { cwd: '/proj', surface: 'terminal', isInteractive: true } as never
const STOP = { stop_hook_active: false, last_assistant_message: 'Next, I will refactor the cache.' } as never
const on$ = (on: On, s: Setup = {}) => setup(on, { fetch: () => ANNOUNCE, ...s })
type Engine = Parameters<TestBody>[0]
const header = async ($: Engine): Promise<string> => String((await $.command.run({ command: 'jev-report', args: '' } as never)).text).split('\n')[0]!
const consent = async ($: Engine, answer: string): Promise<string> => String((await $.command.run({ command: 'jev-consent', args: answer } as never)).text)

// A2: the manifest default is auto for every Jev gate.
test('auto: a key, jev on and a recorded consent make every Jev gate active; the tool floor stays off', async ($, on) => {
  const io = on$(on, { env: KEY_ENV, files: CONSENTED })
  await $.session.start(START)

  expect(await header($)).toBe(
    'conjev: stop active, tool off, tool jev active, instructions active, fold active, instruction filter active, web active, fold blocks active, browser active',
  )
  const result = await $.classic.Stop(STOP)
  expect(result.block).toBeDefined()
  expect(io.fetches.length).toBe(1)
  // The floor is a rule, not Jev: auto does not touch it.
  expect(await $.tool.call({ tool: 'Read', file_path: '/proj/.env' })).toEqual({ result: 'ok' })
})

test('auto without consent is off, key or no key', async ($, on) => {
  const io = on$(on, { env: KEY_ENV })
  await $.session.start(START)
  await $.classic.Stop(STOP)
  await drain()

  expect(await header($)).toContain('stop off, tool off, tool jev off, instructions off, fold off')
  expect(io.fetches.length).toBe(0)
})

test('auto with a refused consent is off', async ($, on) => {
  const io = on$(on, { env: KEY_ENV, files: { [`${SHARED}/consent.json`]: '{"consent":false}' } })
  await $.session.start(START)
  await $.classic.Stop(STOP)
  await drain()

  expect(io.fetches.length).toBe(0)
})

test('auto with consent but no key is off', async ($, on) => {
  const io = on$(on, { files: CONSENTED })
  await $.session.start(START)

  expect(await header($)).toContain('stop off')
  expect(io.fetches.length).toBe(0)
})

test('an explicit mode stands over auto', { options: { stopGate: 'shadow' } }, async ($, on) => {
  const io = on$(on, { env: KEY_ENV, files: CONSENTED })
  await $.session.start(START)
  const result = await $.classic.Stop(STOP)

  expect(await header($)).toContain('stop shadow')
  expect(result.block).toBe(undefined)
  await drain()
  expect(io.fetches.length).toBe(1)
})

// The switch: jev off sends nothing from any gate, even one set active by hand.
test('jev off: no gate sends anything, whatever its mode', { options: { stopGate: 'active', jev: 'off' } }, async ($, on) => {
  const io = on$(on, { env: KEY_ENV, files: CONSENTED })
  await $.session.start(START)
  const result = await $.classic.Stop(STOP)
  await drain()

  expect(result.block).toBe(undefined)
  expect(io.fetches.length).toBe(0)
  expect(await header($)).toContain('fold off')
})

test('jev off in the shared file turns every auto gate off', async ($, on) => {
  const io = on$(on, { env: KEY_ENV, files: { ...CONSENTED, [`${SHARED}/config.json`]: '{"jev":"off"}' } })
  await $.session.start(START)
  await $.classic.Stop(STOP)
  await drain()

  expect(io.fetches.length).toBe(0)
  expect(await header($)).toContain('stop off')
})

// C2: the person answers by typing /jev-consent; the answer is kept in the shared folder.
test('/jev-consent yes records consent where every profile reads it, and turns auto on in this session', async ($, on) => {
  const io = on$(on, { env: KEY_ENV })
  await $.session.start(START)
  expect(await header($)).toContain('stop off')

  expect(await consent($, 'yes')).toContain('allowed')
  const written = io.writes.filter(w => w.path.startsWith(`${SHARED}/`))
  expect(written.map(w => w.path)).toEqual([`${SHARED}/consent.json`, `${SHARED}/onboarding.json`])
  expect(JSON.parse(written[0]!.text).consent).toBe(true)
  expect(JSON.parse(written[1]!.text).state).toBe('done')
  // The folder is made private before the record goes in.
  expect(io.runs).toContainEqual(['chmod', '700', SHARED])

  expect(await header($)).toContain('stop active')
  expect((await $.classic.Stop(STOP)).block).toBeDefined()
})

test('/jev-consent no records the refusal and turns auto off again', async ($, on) => {
  const io = on$(on, { env: KEY_ENV, files: CONSENTED })
  await $.session.start(START)
  expect(await header($)).toContain('stop active')

  expect(await consent($, 'no')).toContain('refused')
  expect(JSON.parse(io.writes.find(w => w.path === `${SHARED}/consent.json`)!.text).consent).toBe(false)
  expect(await header($)).toContain('stop off')
})

test('/jev-consent with no answer says what is sent and changes nothing', async ($, on) => {
  const io = on$(on, { env: KEY_ENV })
  await $.session.start(START)
  const text = await consent($, '')

  expect(text).toContain('not answered yet')
  expect(text).toContain(CONSENT_TEXT)
  expect(io.writes.filter(w => w.path.startsWith(`${SHARED}/`))).toEqual([])
})

test('what consent sends is said plainly: parts of the original, personal information masked, a limit', () => {
  expect(CONSENT_TEXT).toContain('Parts of the original text are included')
  expect(CONSENT_TEXT).toContain('Korean personal information')
  expect(CONSENT_TEXT).toContain('cut to a fixed length')
  expect(CONSENT_TEXT).toContain('jev: off')
})

// The first run: the setup starts as the session's first prompt.
const firstRun = async ($: Engine, source = 'startup') => $.classic.SessionStart({ source } as never)

test('first run: no key and no record, the setup starts by itself with what the plugin found', async ($, on) => {
  on$(on)
  await $.session.start(START)
  const result = await firstRun($)

  expect(result.initialUserMessage).toContain(ONBOARDING_MARK)
  expect(result.initialUserMessage).toContain(`${KEY_CHECK} none found`)
  // The same body /conjev:onboard runs, consent step included.
  expect(result.initialUserMessage).toContain('## 5. Consent')
  expect(result.initialUserMessage).toContain('/jev-consent yes')
  expect(result.initialUserMessage).not.toContain('$ARGUMENTS')
})

test('first run: a key without a consent record still starts the setup, and never shows the key', async ($, on) => {
  on$(on, { env: KEY_ENV })
  await $.session.start(START)
  const message = (await firstRun($)).initialUserMessage

  expect(message).toContain(`${KEY_CHECK} found`)
  expect(message).not.toContain(KEY_ENV.TYPESAFE_API_KEY)
})

test('a key and a consent record: nothing starts', async ($, on) => {
  on$(on, { env: KEY_ENV, files: CONSENTED })
  await $.session.start(START)

  expect((await firstRun($)).initialUserMessage).toBe(undefined)
})

test('a finished or declined setup is not offered again', async ($, on) => {
  on$(on, { files: { [`${SHARED}/onboarding.json`]: '{"state":"declined"}' } })
  await $.session.start(START)

  expect((await firstRun($)).initialUserMessage).toBe(undefined)
})

test('/jev-consent later ends the setup without an answer about consent', async ($, on) => {
  const io = on$(on)
  await $.session.start(START)
  expect(await consent($, 'later')).toContain('will not start by itself again')

  expect(io.writes.map(w => w.path)).toEqual([`${SHARED}/onboarding.json`])
  expect((await firstRun($)).initialUserMessage).toBe(undefined)
})

test('only a new session starts the setup: a resume, a clear or a compaction does not', async ($, on) => {
  on$(on)
  await $.session.start(START)
  for (const source of ['resume', 'clear', 'compact']) expect((await firstRun($, source)).initialUserMessage).toBe(undefined)
})

test('the command body carries the consent step', () => {
  expect(INSTALL_COMMAND_BODY).toContain('## 5. Consent')
  expect(INSTALL_COMMAND_BODY).toContain(CONSENT_TEXT)
  expect(INSTALL_COMMAND_BODY).toContain('you cannot answer for them')
  for (const answer of ['/jev-consent yes', '/jev-consent no', '/jev-consent later']) expect(INSTALL_COMMAND_BODY).toContain(answer)
})

test('a key placed during the session turns the consented auto gates on when the command runs again', async ($, on) => {
  const io = on$(on, { files: CONSENTED })
  await $.session.start(START)
  expect(await header($)).toContain('stop off')

  io.files[`${SHARED}/key`] = 'ts_placed\n'
  await $.classic.UserPromptExpansion({ expansion_type: 'slash_command', command_name: 'conjev:onboard', command_args: '', prompt: '/x' } as never)
  expect(await header($)).toContain('stop active')
  await $.classic.Stop(STOP)
  expect(io.fetches[0]?.headers.authorization).toBe('Bearer ts_placed')
})

// B3: the shared file wins over /config, the fold policy included.
test('the shared file wins over this profile: a gate set active in /config is off when the shared file says so', { options: { stopGate: 'active' } }, async ($, on) => {
  const io = on$(on, { env: KEY_ENV, files: { [`${SHARED}/config.json`]: '{"stopGate":"off"}' } })
  await $.session.start(START)
  const result = await $.classic.Stop(STOP)

  expect(result.block).toBe(undefined)
  expect(io.fetches.length).toBe(0)
})

test('the shared fold policy is the one the fold uses, not only the one it reports', { options: { minFoldChars: 1000 } }, async ($, on) => {
  const big = 'x\n'.repeat(1500)
  const messages = [
    { role: 'user' as const, text: 'look', toolUses: [] },
    { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: '/proj/a.ts' } }] },
    { role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: big, isError: false }] },
    { role: 'user' as const, text: 'one', toolUses: [] },
    { role: 'user' as const, text: 'two', toolUses: [] },
    { role: 'user' as const, text: 'three', toolUses: [] },
  ]
  const io = on$(on, { transcript: messages, files: { [`${SHARED}/config.json`]: '{"minFoldChars": 100000}' } })
  await $.session.start(START)
  await $.session.compact({ trigger: 'manual', messages } as never)

  // The shared minimum is above the result's size: nothing is folded.
  expect(io.writes.some(w => w.path.includes('/archive/') && !w.path.includes('/conversation-'))).toBe(false)
})

// B4: the shared files are watched, and a change reaches the running session.
test('the shared files are watched from the session start', async ($, on) => {
  on$(on, { files: { [`${SHARED}/onboarding.json`]: '{"state":"done"}' } })
  await $.session.start(START)
  const { watchPaths } = await firstRun($, 'resume')

  expect(watchPaths).toEqual([`${SHARED}/config.json`, `${SHARED}/key`, `${SHARED}/consent.json`])
})

test('a changed shared file takes effect in the running session', async ($, on) => {
  const io = on$(on)
  await $.session.start(START)
  const policy = async () => (JSON.parse(String((await $.tool.call({ tool: 'mcp__conjev__policy_report' })).result)) as { current: { settings: { foldAtPercent: number } } }).current.settings.foldAtPercent
  expect(await policy()).toBe(60)

  io.files[`${SHARED}/config.json`] = '{"foldAtPercent": 7}'
  await $.classic.FileChanged({ file_path: `${SHARED}/config.json`, event: 'change' } as never)
  expect(await policy()).toBe(7)

  // A file outside the shared folder is not the plugin's business.
  io.files[`${SHARED}/config.json`] = '{"foldAtPercent": 9}'
  await $.classic.FileChanged({ file_path: '/proj/config.json', event: 'change' } as never)
  expect(await policy()).toBe(7)
})
