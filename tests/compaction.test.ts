// The merge: the fold and its judgment in one compaction hook, one storage
// root, one status line, and the gate in front of read_coordinate.
import type { HttpResponse, SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { DEFAULT_SETTINGS, foldTranscript, makePolicy, turnsAgoOf } from '../hooks/fold'
import { cleanupArgs, dirsBetween } from '../hooks/storage'
import { HOME, KEY_ENV, drain, prompt, records, settle, setup } from './kit'
import { FOLD_ARMED_KEY } from '../hooks/register'

const call = (id: string, tool: string, input: Record<string, unknown>): SessionMessage => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] })
const answer = (id: string, text: string, isError = false): SessionMessage => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError }] })

const ROOT = `${HOME}/.context-harness/state`
const ARCHIVE = `${ROOT}/archive/sess-1`

// Jev answers every question it is asked, the same way.
const everyQuestion = (body: Record<string, unknown>): HttpResponse => ({
  status: 200,
  ok: true,
  headers: {},
  text: JSON.stringify({
    model: 'jev-1.14.0',
    answers: Object.fromEntries(
      Object.keys(body.questions as object).map(name => [name, { type: 'choice', choice: 'done', confidence: 0.9, probabilities: { needed: 0.3, done: 0.7 } }]),
    ),
    usage: { input_tokens: 400, output_tokens: 40 },
  }),
})

const archivedIds = (writes: readonly { path: string }[]): Set<string> =>
  new Set(writes.filter(w => w.path.startsWith(`${ARCHIVE}/`)).map(w => w.path.slice(ARCHIVE.length + 1, -'.json'.length)))

// Sixty results of growing size whose text and an unshown input field carry a
// marker, an error under keepErrorsUnder, an injected reminder, a /command and
// a result one prompt old.
const MARK = 'CANARY-7f3a'
const BUSY: SessionMessage[] = [prompt('Refactor the parser')]
for (let i = 0; i < 60; i++) {
  BUSY.push(call(`t${i}`, i % 2 ? 'Read' : 'Bash', i % 2 ? { file_path: `/proj/src/f${i}.ts` } : { command: `cat /proj/src/f${i}.ts`, description: MARK }))
  BUSY.push(answer(`t${i}`, `${MARK}\n${'y'.repeat(400 + i * 37)}`))
}
BUSY.push(call('err', 'Bash', { command: 'npm test' }), answer('err', 'E'.repeat(1500), true))
BUSY.push(prompt('<system-reminder>context</system-reminder>'), prompt('/cmd arg'))
BUSY.push(call('late', 'Read', { file_path: '/proj/late.ts' }), answer('late', 'z'.repeat(900)))
BUSY.push(prompt('Now fix the parser test'))

const NON_DEFAULT = { keepRecentTurns: 1, minFoldChars: 500, foldJev: 'shadow' }

test('every fold record states what the fold did, under a policy that is not the default', { options: NON_DEFAULT }, async ($, on) => {
  const io = setup(on, { transcript: BUSY, env: KEY_ENV, fetch: everyQuestion })
  await $.session.compact({ trigger: 'manual', messages: BUSY } as never)
  await settle(() => records(io.writes, 'fold').length >= 48)
  await drain()

  const archived = archivedIds(io.writes)
  const rows = records(io.writes, 'fold')
  // The 48 largest of the 59 results at or above minFoldChars.
  expect(rows.length).toBe(48)
  for (const row of rows) {
    expect(row.heuristic).toBe(archived.has(String(row.joinKey)))
    // The judgment's own reading of the policy agrees with what was archived.
    expect((row.facts as Record<string, string>).policyFolds).toBe(String(archived.has(String(row.joinKey))))
  }
  const byId = new Map(rows.map(row => [String(row.joinKey), row]))
  // An error under keepErrorsUnder is not folded, so the judgment is not asked
  // about it either: no row for it.
  expect(byId.get('err')).toBe(undefined)
  expect(archived.has('err')).toBe(false)
  expect(byId.get('late')?.heuristic).toBe(true)
  // Every age is the fold's count, the reminder and the /command included.
  const ages = turnsAgoOf(BUSY)
  for (const row of rows) {
    const at = BUSY.findIndex(m => m.toolResults?.[0]?.tool_use_id === row.joinKey)
    expect((row.facts as Record<string, string>).turnsAgo).toBe(String(ages[at]))
  }
  // The 900-character result folds under keepRecentTurns 1, and its age is the
  // fold's count: the prompt that follows it.
  expect((byId.get('late')?.facts as Record<string, string>).turnsAgo).toBe('1')
})

test('canary: no tool output and no unshown input reaches Jev', { options: NON_DEFAULT }, async ($, on) => {
  const io = setup(on, { transcript: BUSY, env: KEY_ENV, fetch: everyQuestion })
  await $.session.compact({ trigger: 'manual', messages: BUSY } as never)
  await settle(() => records(io.writes, 'fold').length >= 48)

  expect(io.fetches.length).toBe(2)
  for (const fetch of io.fetches) expect(JSON.stringify(fetch.body)).not.toContain(MARK)
  // The request is the person's last prompt, not the reminder or the /command.
  expect(io.fetches[0]?.body.state).toEqual({ current_request: 'Now fix the parser test' })
})

test('the fold judgment scrubs the request before it cuts it', { options: NON_DEFAULT }, async ($, on) => {
  // The person's last prompt carries a phone number starting at 393, so a cut
  // at 400 lands inside the label scrubbing leaves. Cutting first would send
  // part of the number.
  const ask = `${'가 나 '.repeat(200).slice(0, 393)}010-1234-5678`
  const io = setup(on, { transcript: [...BUSY, prompt(ask)], env: KEY_ENV, fetch: everyQuestion })
  await $.session.compact({ trigger: 'manual', messages: [...BUSY, prompt(ask)] } as never)
  await settle(() => records(io.writes, 'fold').length >= 48)

  const state = io.fetches[0]?.body.state as Record<string, string> | undefined
  expect(state?.current_request).not.toContain('010')
  expect((state?.current_request ?? '').length).toBeLessThanOrEqual(400)
})

test('the fold judgment scrubs a tool call line before it cuts it', { options: NON_DEFAULT }, async ($, on) => {
  // A Grep whose pattern starts a phone number at 110: the call line is cut at
  // 120, so a cut before the scrub would leave part of the number. Grep is
  // used because a path key would be shown instead, and a path is scrubbed as
  // a path, not as free text.
  const input = { pattern: `${'p'.repeat(110)} 010-1234-5678` }
  const messages = [prompt('Refactor'), call('t0', 'Grep', input), answer('t0', 'y'.repeat(2000)), prompt('next'), prompt('and next')]
  const io = setup(on, { transcript: messages, env: KEY_ENV, fetch: everyQuestion })
  await $.session.compact({ trigger: 'manual', messages } as never)
  await settle(() => records(io.writes, 'fold').length > 0)

  const bodies = io.fetches.map(f => JSON.stringify(f.body))
  for (const body of bodies) {
    expect(body).not.toContain('1234')
    expect(body).not.toContain('5678')
  }
  expect(bodies.join()).toContain('Grep')
})

test('the fold judgment reads the same api view as the fold: a result beside media is not judged', { options: NON_DEFAULT }, async ($, on) => {
  // The message holding t0 also holds a screenshot result. The fold leaves that
  // message whole, so the judgment must not ask about t0 either.
  const withShot = [
    prompt('Refactor the parser'),
    call('t0', 'Read', { file_path: '/proj/src/f0.ts' }),
    { ...answer('t0', `${MARK}\n${'y'.repeat(2000)}`), toolResults: [{ tool_use_id: 't0', text: 'y'.repeat(2000), isError: false }, { tool_use_id: 't1', text: '', isError: false }] },
    call('t1', 'mcp__browser__screenshot', { url: 'https://example.test' }),
    prompt('next'),
    prompt('and next'),
  ] as SessionMessage[]
  const api = withShot.map(m => ({
    role: m.role,
    content: [
      ...(m.toolResults ?? []).map(r => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.tool_use_id === 't1' ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] : [{ type: 'text', text: r.text }] })),
      ...(m.text === '' ? [] : [{ type: 'text', text: m.text }]),
      ...m.toolUses.map(u => ({ type: 'tool_use', id: u.tool_use_id, name: u.tool, input: u.input })),
    ],
  }))
  const io = setup(on, { transcript: withShot, api, messages: withShot, env: KEY_ENV, fetch: everyQuestion })
  await $.session.compact({ trigger: 'manual', messages: withShot } as never)
  await settle(() => records(io.writes, 'fold').length > 0)

  const judged = records(io.writes, 'fold').map(r => String(r.joinKey))
  expect(judged).not.toContain('t0')
  expect(judged).not.toContain('t1')
})

const BIG = 'x\n'.repeat(1500)
const RECENT: SessionMessage[] = [prompt('Look at a.ts'), call('a', 'Read', { file_path: '/proj/a.ts' }), answer('a', BIG)]
const OLD: SessionMessage[] = [...RECENT, prompt('next'), prompt('and next')]

test('nothing folded: the engine summarizes, and nothing is judged either', { options: { foldJev: 'shadow' } }, async ($, on) => {
  const io = setup(on, { transcript: RECENT, env: KEY_ENV, fetch: everyQuestion })
  const result = await $.session.compact({ trigger: 'manual', messages: RECENT } as never)
  expect(JSON.stringify(result)).toContain('summary')
  await drain()
  // The one result is too recent for the policy to fold, so the judgment is not
  // asked about it: a result the fold leaves whole is not judged.
  expect(records(io.writes, 'fold')).toEqual([])
  expect(archivedIds(io.writes).size).toBe(0)
})

test('a skipped compaction with nothing to fold records nothing and counts nothing', { options: { foldJev: 'shadow' } }, async ($, on) => {
  const io = setup(on, { transcript: RECENT, env: KEY_ENV, fetch: everyQuestion, compactBelow: 'skip' })
  expect((await $.session.compact({ trigger: 'manual', messages: RECENT } as never)).skip).toBe('skipped below')
  await drain()
  expect(records(io.writes, 'fold').length).toBe(0)
  expect(io.appended.length).toBe(0)
})

test('folded but still too large, then skipped: nothing recorded and nothing counted', { options: { foldJev: 'shadow' } }, async ($, on) => {
  // The folded transcript still fills the window, so the engine is asked to summarize it, and skips.
  const io = setup(on, { transcript: OLD, env: KEY_ENV, fetch: everyQuestion, compactBelow: 'skip', window: 10 })
  expect((await $.session.compact({ trigger: 'manual', messages: OLD } as never)).skip).toBe('skipped below')
  await drain()
  expect(records(io.writes, 'fold').length).toBe(0)
  expect(io.statuses.some(text => text.includes('folded'))).toBe(false)
  expect(io.appended.length).toBe(0)
})

test('status: with Jev off it reads exactly as it did; with a gate on, both parts stay', async ($, on) => {
  const io = setup(on, { transcript: OLD })
  const { savedChars } = foldTranscript(OLD, makePolicy(DEFAULT_SETTINGS))
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  expect(io.statuses.at(-1)).toBe(`folded 1 · −${Math.round(savedChars / 1000)}k chars`)
})

test('status keeps the fold part when the judgment layer updates it', { options: { stopGate: 'shadow' } }, async ($, on) => {
  const io = setup(on, { transcript: OLD, env: KEY_ENV, fetch: () => ({ status: 500, ok: false, headers: {}, text: '' }) })
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Fixed it.' } as never)
  await settle(() => records(io.writes, 'stop').length > 0)
  const last = io.statuses.at(-1) ?? ''
  expect(last.startsWith('folded 1 · ')).toBe(true)
  expect(last).toContain(' | jev · stop shadow 0 judged, 1 failed')
})

test('after a fold the model is pointed back at what was folded', async ($, on) => {
  const io = setup(on, { transcript: OLD })
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  await settle(() => io.appended.length > 0)
  expect(io.appended[0]).toContain('[context-harness] This conversation was just compacted; 1 tool results were folded')
})

const kept = (text: string, input: Record<string, unknown> = { file_path: '/proj/a.ts' }) => JSON.stringify({ id: 'toolu_x', tool: 'Read', input, text, isError: false })

test('read_coordinate reads this plugin archive first, then the one from before the rename', async ($, on) => {
  setup(on, {
    files: {
      [`${ARCHIVE}/toolu_x.json`]: kept('new'),
      [`${HOME}/.claude-context-fold/sess-1/toolu_x.json`]: kept('old'),
      [`${HOME}/.claude-context-fold/sess-1/toolu_y.json`]: kept('legacy only'),
    },
  })
  expect(String((await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_x' })).result)).toContain('\nnew')
  expect(String((await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_y' })).result)).toContain('\nlegacy only')
})

const SECRET_KEPT = { files: { [`${ARCHIVE}/toolu_x.json`]: kept('API_KEY=abc', { file_path: '/proj/.env' }) } }

test('read_coordinate, external session with the gate active: a folded secret file stays folded', { options: { toolGate: 'active', providerTrust: 'external' } }, async ($, on) => {
  const io = setup(on, SECRET_KEPT)
  const result = await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_x' })
  expect(result.isError).toBe(true)
  expect(String(result.result)).toContain('env file')
  await settle(() => records(io.writes, 'tool').length > 0)
  expect(records(io.writes, 'tool')[0]?.decision).toBe('deny')
})

test('read_coordinate, the gate in shadow: returned, and recorded as it would be refused', { options: { toolGate: 'shadow', providerTrust: 'external' } }, async ($, on) => {
  const io = setup(on, SECRET_KEPT)
  expect(String((await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_x' })).result)).toContain('API_KEY=abc')
  await settle(() => records(io.writes, 'tool').length > 0)
  expect(records(io.writes, 'tool')[0]?.decision).toBe('would-deny')
})

test('read_coordinate, first-party session: returned', { options: { toolGate: 'active' } }, async ($, on) => {
  setup(on, SECRET_KEPT)
  expect(String((await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_x' })).result)).toContain('API_KEY=abc')
})

test('cleanup names the records folder alone, and nothing else gets a command', () => {
  expect(cleanupArgs(`${ROOT}/records`)).toEqual([
    ['find', `${ROOT}/records`, '-type', 'f', '-name', '*.json', '-mtime', '+14', '-not', '-path', `${ROOT}/records/labels/*`, '-delete'],
    ['find', `${ROOT}/records`, '-mindepth', '1', '-type', 'd', '-empty', '-delete'],
  ])
  expect(cleanupArgs(ROOT)).toEqual([])
  expect(cleanupArgs(`${ROOT}/archive`)).toEqual([])
  expect(cleanupArgs(`${HOME}/.claude-context-fold`)).toEqual([])
  expect(dirsBetween(ROOT, `${ROOT}/archive/s`)).toEqual([ROOT, `${ROOT}/archive`, `${ROOT}/archive/s`])
  expect(dirsBetween(ROOT, '/tmp/x')).toEqual([])
})

const START = { cwd: '/proj', surface: 'terminal', isInteractive: true } as never

test('the session start runs exactly that cleanup', async ($, on) => {
  const io = setup(on, { files: { [`${ROOT}/records/sess-0/stop/a.json`]: '{}', [`${ARCHIVE}/toolu_x.json`]: '{}' } })
  await $.session.start(START)
  expect(io.runs).toEqual(cleanupArgs(`${ROOT}/records`))
})

test('the session start runs no cleanup without a records folder', async ($, on) => {
  const io = setup(on, { files: { [`${ARCHIVE}/toolu_x.json`]: '{}' } })
  await $.session.start(START)
  expect(io.runs).toEqual([])
})

test('folders are made private before the first file is written in them', async ($, on) => {
  const io = setup(on, { transcript: OLD })
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  expect(io.disk.slice(0, 3)).toEqual(['run mkdir', 'run chmod', `write ${ARCHIVE}/a.json`])
  expect(io.runs[1]).toEqual(['chmod', '700', ROOT, `${ROOT}/archive`, ARCHIVE])
})

test('without HOME nothing is written: the engine summarizes instead of folding', async ($, on) => {
  const io = setup(on, { transcript: OLD, env: { HOME: '' } })
  const result = await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  expect(JSON.stringify(result)).toContain('summary')
  expect(io.writes).toEqual([])
  expect(io.logs.some(line => line.includes('summarizing instead'))).toBe(true)
})

test('set_policy changes the fold policy only, never a gate, a Jev mode or the key', async ($, on) => {
  const io = setup(on)
  const set = await $.tool.call({ tool: 'mcp__context-harness__set_policy', stopGate: 'active', foldJev: 'shadow', toolGate: 'off', apiKey: 'x' })
  expect(set.result).toBe('No policy value was given.')
  expect(io.configured).toEqual([])
})

test('the agent may not write into the archives, this one or the one before the rename', { options: { toolGate: 'active' } }, async ($, on) => {
  setup(on)
  expect((await $.tool.call({ tool: 'Write', file_path: `${ARCHIVE}/toolu_x.json`, content: '{}' })).deny).toContain('context-harness files')
  expect((await $.tool.call({ tool: 'Bash', command: `echo x > ${HOME}/.claude-context-fold/sess-1/toolu_x.json` })).deny).toContain('context-harness files')
})

const EXTERNAL_ACTIVE = { options: { toolGate: 'active', providerTrust: 'external' } }

test('external session: the archives cannot be read past read_coordinate either', EXTERNAL_ACTIVE, async ($, on) => {
  setup(on)
  expect((await $.tool.call({ tool: 'Read', file_path: `${ARCHIVE}/toolu_x.json` })).deny).toContain('folded originals')
  expect((await $.tool.call({ tool: 'Bash', command: `grep -r API_KEY ${HOME}/.claude-context-fold` })).deny).toContain('folded originals')
  expect((await $.tool.call({ tool: 'Read', file_path: '/proj/src/app.ts' })).deny).toBe(undefined)
})

test('first-party session: the archives can be read', { options: { toolGate: 'active' } }, async ($, on) => {
  setup(on)
  expect((await $.tool.call({ tool: 'Read', file_path: `${ARCHIVE}/toolu_x.json` })).deny).toBe(undefined)
})

test('read_coordinate judges a folded path by what it leads to as well', EXTERNAL_ACTIVE, async ($, on) => {
  setup(on, {
    files: { [`${ARCHIVE}/toolu_x.json`]: kept('aws_secret_access_key = x', { file_path: '/proj/creds' }) },
    realPaths: { '/proj/creds': `${HOME}/.aws/credentials` },
  })
  const result = await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_x' })
  expect(result.isError).toBe(true)
  expect(String(result.result)).toContain('cloud credentials')
})

test('a folder that cannot be made private gets nothing written: the engine summarizes', async ($, on) => {
  const io = setup(on, { transcript: OLD, failRun: 'chmod' })
  const result = await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  expect(JSON.stringify(result)).toContain('summary')
  expect(io.writes).toEqual([])
})

test('without HOME the idle boundary starts no /compact', async ($, on) => {
  const io = setup(on, { env: { HOME: '' }, messages: OLD, percent: 90 })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await drain()
  expect(io.commands).toEqual([])
})

test('with HOME the idle boundary does start one', async ($, on) => {
  const io = setup(on, { messages: OLD, percent: 90 })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle(() => io.commands.length > 0)
  expect(io.commands).toEqual(['compact'])
})

test('without HOME the session still starts its judgment layer', { options: { stopGate: 'shadow' } }, async ($, on) => {
  const io = setup(on, { env: { HOME: '' } })
  await $.session.start(START)
  expect(io.statuses).toContain('jev: no key')
  expect(io.logs.filter(line => line.includes('did not start') || line.includes('old records'))).toEqual([])
})

test('a failure after the fold keeps the fold', { options: { episodeDir: '/proj/sessions' } }, async ($, on) => {
  // The episode folder exists but cannot be listed.
  const io = setup(on, { transcript: OLD, files: { '/proj/sessions/2026-10-22.md': 'x' }, failList: '/proj/sessions' })
  const result = await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  expect(JSON.stringify(result)).toContain('[folded Read')
  expect(io.logs.some(line => line.includes('after the compaction'))).toBe(true)
})

test('an archive that could not be written still leaves the note that follows a compaction', { options: { phaseFile: '/proj/PHASE.md' } }, async ($, on) => {
  const io = setup(on, { transcript: OLD, failWrite: '/archive/', files: { '/proj/PHASE.md': 'now' } })
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  await settle(() => io.appended.length > 0)
  expect(io.appended[0]).toContain('[context-harness] This conversation was just compacted.')
})

test('status: nothing on screen while the gates are on but have recorded nothing', { options: { stopGate: 'shadow', foldJev: 'shadow' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  await $.session.start(START)
  expect(io.statuses).toEqual([])
})

test('status: a gate that recorded something shows the line', { options: { toolGate: 'active', providerTrust: 'external' } }, async ($, on) => {
  const io = setup(on)
  await $.session.start(START)
  expect(io.statuses).toEqual([])
  await $.tool.call({ tool: 'Read', file_path: '/proj/.env' })
  expect(io.statuses.at(-1)).toBe('jev · tool active 1 hits')
})

test('a crowded window is partly summarized: the engine gets the old part, the recent stays whole', { options: { foldJev: 'shadow' } }, async ($, on) => {
  // A tiny window makes the folded transcript look crowded.
  const io = setup(on, { transcript: OLD, env: KEY_ENV, fetch: everyQuestion, window: 10 })
  const out = await $.session.compact({ trigger: 'manual', messages: OLD } as never)

  // The engine was handed everything before OLD's last prompt, not the whole.
  expect(io.summarizedOver.length).toBe(1)
  const handed = io.summarizedOver[0]!
  expect(handed.length).toBeLessThan(OLD.length)
  // What came back: the summary, then the plugin's list of the folded originals,
  // then the recent messages as they stood.
  const messages = out.messages ?? []
  expect(messages[0]?.text).toBe('summary')
  expect(messages[1]?.text).toContain('[context-harness]')
  expect(messages[1]?.text).toContain(String.raw`read_coordinate("a")`)
  expect(messages.at(-1)?.text).toBe('and next')
})

test('an uncrowded fold leaves the transcript whole; no summary runs', { options: { foldJev: 'shadow' } }, async ($, on) => {
  const io = setup(on, { transcript: OLD, env: KEY_ENV, fetch: everyQuestion })
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)

  expect(io.summarizedOver.length).toBe(0)
})

test('a summary never swallows what the person said: their prompts come back whole', { options: { foldJev: 'shadow' } }, async ($, on) => {
  // A tiny window makes the folded transcript look crowded, so the summary
  // runs. The middle prompt is older than the recent window.
  const io = setup(on, { transcript: OLD, env: KEY_ENV, fetch: everyQuestion, window: 10 })
  const out = await $.session.compact({ trigger: 'manual', messages: OLD } as never)

  // What the engine was handed holds no message the person wrote.
  const handed = io.summarizedOver[0] ?? []
  expect(handed).not.toContain('Look at a.ts')
  expect(handed).not.toContain('next')
  // Their words are in the result, before the recent window.
  const texts = (out.messages ?? []).map(m => m.text)
  expect(texts).toContain('Look at a.ts')
  expect(texts).toContain('next')
  expect(texts.indexOf('Look at a.ts')).toBeLessThan(texts.indexOf('and next'))
})

test('a stale status board holds the summary back: the fold still lands', { options: { foldJev: 'shadow', phaseFile: '/proj/PHASE.md' } }, async ($, on) => {
  // PHASE.md was last written before the session started, so it is due. The
  // fold goes ahead either way; only the summary waits for the board.
  const io = setup(on, { transcript: OLD, env: KEY_ENV, fetch: everyQuestion, window: 10, files: { '/proj/PHASE.md': '# PHASE\n' }, mtimes: { '/proj/PHASE.md': 1000 }, startedAt: 2000 })
  const out = await $.session.compact({ trigger: 'manual', messages: OLD } as never)

  expect(io.summarizedOver.length).toBe(0)
  expect(io.appended.some(text => text.includes('PHASE.md'))).toBe(true)
  expect(out.messages?.some(m => m.toolResults?.some(r => r.text.startsWith('[folded ')))).toBe(true)
})

test('a current status board lets the summary run', { options: { foldJev: 'shadow', phaseFile: '/proj/PHASE.md' } }, async ($, on) => {
  // Written after the session started, so nothing is due.
  const io = setup(on, { transcript: OLD, env: KEY_ENV, fetch: everyQuestion, window: 10, files: { '/proj/PHASE.md': '# PHASE\n' }, mtimes: { '/proj/PHASE.md': 3000 }, startedAt: 2000 })
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)

  expect(io.summarizedOver.length).toBe(1)
})

test('the automatic fold records the moment it began waiting, so its own check has something to compare', async ($, on) => {
  const io = setup(on, { messages: OLD, percent: 90 })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle(() => io.commands.length > 0)

  // The armed moment is in the store: the fold's own timer reads it to decide
  // whether the person wrote first. Without this write there is nothing for
  // that check to compare against, and it would always stand down.
  expect(io.store.has(FOLD_ARMED_KEY)).toBe(true)
  expect(typeof io.store.get(FOLD_ARMED_KEY)).toBe('number')
})

test('a prompt records when it arrived, so the fold can tell it came first', async ($, on) => {
  const io = setup(on, { messages: OLD, percent: 90 })
  await $.prompt.submit({ text: 'hold on', wait: false, turnId: 't3', origin: { kind: 'composer' as const } } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't4', reason: 'answer' })
  await drain()

  // The prompt was recorded, so the fold armed after it sees a later time and
  // stands down instead of compacting over the person's turn.
  expect(io.store.get(FOLD_ARMED_KEY)).toBeGreaterThan(0)
})

test('a compaction records its trigger, its wait and what it saved', async ($, on) => {
  const io = setup(on, { transcript: OLD, env: KEY_ENV, fetch: everyQuestion, window: 10 })
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  await drain()

  const [row] = records(io.writes, 'compact')
  expect(row).toBeDefined()
  const facts = row?.facts as Record<string, string>
  expect(facts.trigger).toBe('manual')
  expect(Number(facts.messagesBefore)).toBe(OLD.length)
  // Whether a summary ran is what the person's wait turned into.
  expect(row?.decision).toBe('summarized')
})

test('a fold-only compaction is recorded as such, with no summary behind it', async ($, on) => {
  const io = setup(on, { transcript: OLD, env: KEY_ENV, fetch: everyQuestion })
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  await drain()

  const [row] = records(io.writes, 'compact')
  expect(row?.decision).toBe('folded')
  expect((row?.facts as Record<string, string>).trigger).toBe('manual')
})

test('the status line says a summary is running, and stops saying it after', async ($, on) => {
  const io = setup(on, { transcript: OLD, env: KEY_ENV, fetch: everyQuestion, window: 10 })
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  await drain()

  // The line was shown while the summary ran: the one wait that lasts seconds.
  expect(io.statuses.some(text => text.includes('summarizing'))).toBe(true)
  // And it is gone once the summary returned.
  expect(io.statuses.at(-1) ?? '').not.toContain('summarizing')
})

test('a fold with no summary behind it never says it is summarizing', async ($, on) => {
  const io = setup(on, { transcript: OLD, env: KEY_ENV, fetch: everyQuestion })
  await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  await drain()

  expect(io.statuses.some(text => text.includes('summarizing'))).toBe(false)
})

const GIT_UNPUSHED = '# branch.oid abc\n# branch.head work\n# branch.ab +3 -0\n1 M. N... 100644 100644 100644 aaa bbb src/app.ts\n? new.ts\n'

test('a note before a fold names what the board left out: unpushed work', { options: { phaseFile: '/proj/PHASE.md' } }, async ($, on) => {
  const io = setup(on, {
    messages: OLD,
    percent: 90,
    files: { '/proj/PHASE.md': '# PHASE\n\n## Now\nwork\n' },
    mtimes: { '/proj/PHASE.md': 1000 },
    startedAt: 2000,
    gitStatus: GIT_UNPUSHED,
  })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle(() => io.appended.length > 0)

  const note = io.appended.join('\n')
  expect(note).toContain('3 commit(s) not pushed')
  expect(note).toContain('2 file(s) with uncommitted changes')
  expect(note).toContain('work')
  // The board has no Handoff section, and the note says so rather than assuming.
  // The note is recorded as JSON, so its quotes arrive escaped.
  expect(note).toContain('no \\"Handoff\\" section')
})

test('a board whose Handoff section covers the tree draws no remark', { options: { phaseFile: '/proj/PHASE.md' } }, async ($, on) => {
  const io = setup(on, {
    messages: OLD,
    percent: 90,
    files: { '/proj/PHASE.md': '# PHASE\n\n## Now\nwork\n\n## Handoff\n- Commits: 3 local, not pushed\n' },
    mtimes: { '/proj/PHASE.md': 1000 },
    startedAt: 2000,
    gitStatus: GIT_UNPUSHED,
  })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle(() => io.appended.length > 0)

  const note = io.appended.join('\n')
  // The section exists, so the note points at it rather than reporting a gap.
  expect(note).toContain('should say so')
  expect(note).not.toContain('no "Handoff" section')
})

test('a clean, pushed tree draws no remark at all', { options: { phaseFile: '/proj/PHASE.md' } }, async ($, on) => {
  const io = setup(on, {
    messages: OLD,
    percent: 90,
    files: { '/proj/PHASE.md': '# PHASE\n\n## Handoff\n- Commits: 0 local\n' },
    mtimes: { '/proj/PHASE.md': 1000 },
    startedAt: 2000,
    gitStatus: '# branch.oid abc\n# branch.head work\n# branch.ab +0 -0\n',
  })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle(() => io.appended.length > 0)

  const note = io.appended.join('\n')
  expect(note).toContain('PHASE.md')
  expect(note).not.toContain('not pushed')
  expect(note).not.toContain('Handoff')
})

test('a project with no status board: the offer is made once, and a refusal is remembered', async ($, on) => {
  // No PHASE.md and a phaseFile setting, so the offer applies. The dialog is
  // refused here, which is what a run with nobody to ask looks like.
  const io = setup(on, { messages: OLD, percent: 90, phaseFile: '/proj/PHASE.md' })
  await $.prompt.submit({ text: 'hello', wait: false, turnId: 't1', origin: { kind: 'composer' as const } } as never)
  await drain()

  // A question nobody could answer is not consent: nothing was accepted.
  expect(io.store.get('board-offer')).toBe(undefined)
  expect(io.appended.some(text => text.includes('status board'))).toBe(false)
})

test('three hours of silence about the status board counts as a yes', async ($, on) => {
  const io = setup(on, { messages: OLD, percent: 90, phaseFile: '/proj/PHASE.md' })
  // The offer went up just over three hours ago and was never answered; the
  // session that asked it has ended, which is why this is read from the store.
  io.store.set('board-offer-asked-at', 1_700_000_000_000 - 3 * 60 * 60 * 1000)
  await $.prompt.submit({ text: 'hello', wait: false, turnId: 't1', origin: { kind: 'composer' as const } } as never)
  await drain()

  // The model is told to create the board, and the answer is not asked again.
  expect(io.appended.some(text => text.includes('Create PHASE.md now'))).toBe(true)
  expect(io.store.get('board-offer')).toBe('accepted')
})

test('the offer stands down once the board exists', async ($, on) => {
  const io = setup(on, { messages: OLD, percent: 90, phaseFile: '/proj/PHASE.md', files: { '/proj/PHASE.md': '# PHASE\n' } })
  await $.prompt.submit({ text: 'hello', wait: false, turnId: 't1', origin: { kind: 'composer' as const } } as never)
  await drain()

  expect(io.store.get('board-offer')).toBe(undefined)
  expect(io.appended.some(text => text.includes('status board'))).toBe(false)
})

test('an empty phaseFile setting turns the offer off', async ($, on) => {
  const io = setup(on, { messages: OLD, percent: 90, phaseFile: '' })
  await $.prompt.submit({ text: 'hello', wait: false, turnId: 't1', origin: { kind: 'composer' as const } } as never)
  await drain()

  expect(io.store.get('board-offer')).toBe(undefined)
})

// Jev answers noul questions with a high score: every passage is relevant.
const allRelevant = (body: Record<string, unknown>): HttpResponse => ({
  status: 200,
  ok: true,
  headers: {},
  text: JSON.stringify({
    model: 'jev-1.14.0',
    answers: Object.fromEntries(Object.keys(body.questions as object).map(name => [name, { type: 'noul', noul: 0.95 }])),
    usage: { input_tokens: 400, output_tokens: 40 },
  }),
})

// Jev keeps the passages that name a failure and drops the rest, so the answer
// leaves lines out and has to say which.
const onlyFailures = (body: Record<string, unknown>): HttpResponse => {
  const state = body.state as Record<string, unknown> | undefined
  // The first request lists the candidates and the second judges each one, so
  // the first is answered high to keep them all and the second only for the
  // passage that names a failure.
  const isJudgingOne = typeof state?.passage === 'string'
  const score = isJudgingOne ? (String(state?.passage).includes('FAIL') ? 0.95 : 0.05) : 0.95

  return {
    status: 200,
    ok: true,
    headers: {},
    text: JSON.stringify({
      model: 'jev-1.14.0',
      answers: Object.fromEntries(Object.keys(body.questions as object).map(name => [name, { type: 'noul', noul: score }])),
      usage: { input_tokens: 400, output_tokens: 40 },
    }),
  }
}


const LONG_KEPT = Array.from({ length: 200 }, (_, i) => `line ${i + 1} of the server log ${i === 99 ? 'FAIL here' : 'with some words in it'}`).join('\n')

test('read_coordinate with a query keeps the passages and names the lines it left out', { options: { foldBlocks: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: onlyFailures, files: { [`${ARCHIVE}/toolu_x.json`]: kept(LONG_KEPT, { file_path: '/proj/server.log' }) } })
  const result = await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_x', query: 'where does it fail' })
  const text = String(result.result)

  // Only the passage holding the failure came back, and the answer says which
  // lines it did not: the model can read them next, or ask for the whole thing.
  expect(text).toContain('FAIL here')
  expect(text).toMatch(/Left out: lines \d+(-\d+)?/)
  expect(text.split('\n').length).toBeLessThan(150)
  expect(text).toContain('pass full for the whole original')
  // What Jev saw carried the query, and the file path was not in what it read.
  const sent = JSON.stringify(io.fetches.map(f => f.body))
  expect(sent).toContain('where does it fail')
  expect(sent).not.toContain('/proj/server.log\"}')
  await settle(() => records(io.writes, 'tool').length >= 0)
  expect(io.fetches.length).toBeGreaterThan(0)
})

test('read_coordinate with a query but no key returns the whole original', async ($, on) => {
  const io = setup(on, { files: { [`${ARCHIVE}/toolu_x.json`]: kept(LONG_KEPT, { file_path: '/proj/server.log' }) } })
  const result = await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_x', query: 'where does it fail' })

  // A fragment nothing could have chosen would only hide what is there.
  expect(String(result.result)).toContain('line 1 of the server log')
  expect(String(result.result)).not.toContain('passages')
  expect(io.fetches.length).toBe(0)
})

test('read_coordinate with full returns the whole original even with a query', { options: { foldBlocks: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV, fetch: allRelevant, files: { [`${ARCHIVE}/toolu_x.json`]: kept(LONG_KEPT, { file_path: '/proj/server.log' }) } })
  const result = await $.tool.call({ tool: 'mcp__context-harness__read_coordinate', id: 'toolu_x', query: 'where does it fail', full: true })

  expect(String(result.result)).toContain('line 1 of the server log')
  expect(io.fetches.length).toBe(0)
})

const neededAt = (p: number) => (body: Record<string, unknown>): HttpResponse => ({
  status: 200,
  ok: true,
  headers: {},
  text: JSON.stringify({
    model: 'jev-1.14.0',
    answers: Object.fromEntries(Object.keys(body.questions as object).map(name => [name, { type: 'choice', choice: p >= 0.5 ? 'needed' : 'done', confidence: 0.9, probabilities: { needed: p, done: 1 - p } }])),
    usage: { input_tokens: 400, output_tokens: 40 },
  }),
})
const folded = (out: { messages?: readonly SessionMessage[] }): boolean => (out.messages ?? []).some(m => m.toolResults?.some(r => r.text.startsWith('[folded ')))

test('fold relevance active: a result Jev says is still needed stays whole', { options: { foldJev: 'active' } }, async ($, on) => {
  const io = setup(on, { transcript: OLD, env: KEY_ENV, fetch: neededAt(0.9) })
  const out = await $.session.compact({ trigger: 'manual', messages: OLD } as never)

  expect(io.fetches.length).toBeGreaterThan(0)
  expect(folded(out)).toBe(false)
  expect(records(io.writes, 'fold')[0]?.decision).toBe('keep')
})

test('fold relevance active: a result Jev says is done with is folded', { options: { foldJev: 'active' } }, async ($, on) => {
  const io = setup(on, { transcript: OLD, env: KEY_ENV, fetch: neededAt(0.05) })
  const out = await $.session.compact({ trigger: 'manual', messages: OLD } as never)

  expect(folded(out)).toBe(true)
  expect(records(io.writes, 'fold')[0]?.decision).toBe('fold')
})

test('fold relevance active: a finished result still inside the recent window is folded', { options: { foldJev: 'active', keepRecentTurns: 5 } }, async ($, on) => {
  // keepRecentTurns 5 keeps everything for the rule; Jev says the read is done with.
  const io = setup(on, { transcript: OLD, env: KEY_ENV, fetch: neededAt(0.05) })
  const out = await $.session.compact({ trigger: 'manual', messages: OLD } as never)

  expect(folded(out)).toBe(true)
  expect(io.fetches.length).toBeGreaterThan(0)
})

test('fold relevance active: an automatic compaction asks Jev nothing, so nobody waits', { options: { foldJev: 'active' } }, async ($, on) => {
  const io = setup(on, { transcript: OLD, env: KEY_ENV, fetch: neededAt(0.9) })
  const out = await $.session.compact({ trigger: 'plugin', messages: OLD } as never)

  expect(io.fetches.length).toBe(0)
  // The rule alone decided, and it folds the old read.
  expect(folded(out)).toBe(true)
})

test('one question in two steps: a result kept whole is not asked about again, block by block', { options: { foldJev: 'active', foldBlocks: 'active' } }, async ($, on) => {
  // Jev says the read is still needed, so it stays whole; the block judgment
  // works only inside what was folded, so it has nothing to ask.
  const io = setup(on, { transcript: OLD, env: KEY_ENV, fetch: neededAt(0.9), isTimerStopped: true })
  const out = await $.session.compact({ trigger: 'manual', messages: OLD } as never)
  await drain()

  expect(folded(out)).toBe(false)
  expect(records(io.writes, 'fold').length).toBeGreaterThan(0)
  expect(records(io.writes, 'fold-blocks')).toEqual([])
})
