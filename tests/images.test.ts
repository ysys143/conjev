// What a fold does to an image or other media in the message it would rebuild.
//
// The rows the compaction hands the plugin (SessionMessage) have no field for
// media. A message handed back with its handle is the engine's own copy,
// whole; one without is built from its role, text and tool blocks
// (claude-code.d.ts, SessionCompacted.messages). engineAssembles plays that
// engine: it keeps the handled copy and builds the rest from the rows only.
import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { HOME, apiOf, prompt, setup, type ApiMessage } from './kit'

type Block = ApiMessage['content'][number]

const BIG = 'L'.repeat(3000)
const PNG: Block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
const ARCHIVE = `${HOME}/.local/state/context-harness/archive/sess-1`
const hasImage = (message: unknown): boolean => JSON.stringify(message).includes('"type":"image"')

const engineAssembles = (handed: readonly SessionMessage[], copies: ReadonlyMap<string, ApiMessage>): ApiMessage[] =>
  handed.map(m => (m.handle !== undefined && copies.has(m.handle) ? copies.get(m.handle)! : apiOf(m)))

const useOf = (id: string, tool: string, input: Record<string, unknown>) => ({ tool_use_id: id, tool, input })
const resultOf = (id: string, content: Block[]): Block => ({ type: 'tool_result', tool_use_id: id, content })

// An old Read that folds, so the compaction hands back the folded transcript
// rather than the engine's summary; then the message under test, two turns old.
const OLD_READ: [SessionMessage, ApiMessage][] = [
  [{ ...prompt('Read the old file'), handle: 'q0' }, { role: 'user', content: [{ type: 'text', text: 'Read the old file' }] }],
  [
    { role: 'assistant', text: '', toolUses: [useOf('toolu_old', 'Read', { file_path: '/proj/old.ts' })], handle: 'q1' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_old', name: 'Read', input: { file_path: '/proj/old.ts' } }] },
  ],
  [
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_old', text: BIG, isError: false }], handle: 'q2' },
    { role: 'user', content: [resultOf('toolu_old', [{ type: 'text', text: BIG }])] },
  ],
]
const LOOK = 'Look at the screen and the build log'
const TAIL: [SessionMessage, ApiMessage][] = ['and the test', 'and the diff'].map((text, i) => [
  { ...prompt(text), handle: `p${i + 1}` },
  { role: 'user', content: [{ type: 'text', text }] },
])

/** The rows handed to the compaction, the api view, and the engine's copies by handle. */
const conversation = (middle: [SessionMessage, ApiMessage][]) => {
  const pairs = [...OLD_READ, [{ ...prompt(LOOK), handle: 'p0' }, { role: 'user', content: [{ type: 'text', text: LOOK }] }] as [SessionMessage, ApiMessage], ...middle, ...TAIL]

  return {
    messages: pairs.map(([row]) => row),
    api: pairs.map(([, copy]) => copy),
    copies: new Map(pairs.map(([row, copy]) => [row.handle!, copy])),
  }
}

const compact = async ($: Parameters<Parameters<typeof test>[1]>[0], messages: SessionMessage[]) =>
  ((await $.session.compact({ trigger: 'manual', messages } as never)) as { messages: SessionMessage[] }).messages

const LOG_AND_PNG: [SessionMessage, ApiMessage][] = [
  [
    { role: 'assistant', text: '', toolUses: [useOf('toolu_log', 'Bash', { command: 'cat build.log' }), useOf('toolu_png', 'Read', { file_path: '/proj/shot.png' })], handle: 'a1' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_log', name: 'Bash', input: {} }, { type: 'tool_use', id: 'toolu_png', name: 'Read', input: {} }] },
  ],
  [
    {
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [
        { tool_use_id: 'toolu_log', text: BIG, isError: false },
        { tool_use_id: 'toolu_png', text: '', isError: false },
      ],
      handle: 'u1',
    },
    { role: 'user', content: [resultOf('toolu_log', [{ type: 'text', text: BIG }]), resultOf('toolu_png', [PNG])] },
  ],
  [{ role: 'assistant', text: 'Checked.', toolUses: [], handle: 'a2' }, { role: 'assistant', content: [{ type: 'text', text: 'Checked.' }] }],
]

test('a large text result beside a Read of a PNG is not folded: the message keeps its handle and the PNG', async ($, on) => {
  const { messages, api, copies } = conversation(LOG_AND_PNG)
  const io = setup(on, { api })
  const handed = await compact($, messages)

  expect(handed[2]!.toolResults?.[0]?.text.startsWith('[folded ')).toBe(true)
  expect(handed[5]!.handle).toBe('u1')
  expect(handed[5]!.toolResults?.[0]?.text).toBe(BIG)
  expect(hasImage(engineAssembles(handed, copies)[5])).toBe(true)
  expect(io.writes.some(w => w.path === `${ARCHIVE}/toolu_log.json`)).toBe(false)
})

test('control: the same message one turn old stays whole and keeps the PNG', async ($, on) => {
  const { messages, api, copies } = conversation(LOG_AND_PNG)
  setup(on, { api: api.slice(0, -1) })
  const handed = await compact($, messages.slice(0, -1))

  expect(handed[2]!.toolResults?.[0]?.text.startsWith('[folded ')).toBe(true)
  expect(handed[5]!.handle).toBe('u1')
  expect(hasImage(engineAssembles(handed, copies)[5])).toBe(true)
})

test('an image the person pasted beside a large result keeps the message whole', async ($, on) => {
  const ASK = 'Here is the screenshot. What is off?'
  const { messages, api, copies } = conversation([
    [
      { role: 'assistant', text: '', toolUses: [useOf('toolu_big', 'Bash', { command: 'cat build.log' })], handle: 'a1' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_big', name: 'Bash', input: {} }] },
    ],
    [
      { role: 'user', text: ASK, toolUses: [], toolResults: [{ tool_use_id: 'toolu_big', text: BIG, isError: false }], handle: 'u1' },
      { role: 'user', content: [resultOf('toolu_big', [{ type: 'text', text: BIG }]), { type: 'text', text: ASK }, PNG] },
    ],
    [{ role: 'assistant', text: 'Checked.', toolUses: [], handle: 'a2' }, { role: 'assistant', content: [{ type: 'text', text: 'Checked.' }] }],
  ])
  setup(on, { api })
  const handed = await compact($, messages)

  expect(handed[5]!.handle).toBe('u1')
  const built = engineAssembles(handed, copies)[5]!
  expect(built.content.some(b => b.type === 'text' && b.text === ASK)).toBe(true)
  expect(hasImage(built)).toBe(true)
})

test('a result holding text and an image is not folded, so nothing of it leaves for the archive', async ($, on) => {
  const { messages, api, copies } = conversation([
    [
      { role: 'assistant', text: '', toolUses: [useOf('toolu_shot', 'mcp__browser__screenshot', { url: 'https://example.test' })], handle: 'a1' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_shot', name: 'mcp__browser__screenshot', input: {} }] },
    ],
    [
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_shot', text: BIG, isError: false }], handle: 'u1' },
      { role: 'user', content: [resultOf('toolu_shot', [{ type: 'text', text: BIG }, PNG])] },
    ],
    [{ role: 'assistant', text: 'Checked.', toolUses: [], handle: 'a2' }, { role: 'assistant', content: [{ type: 'text', text: 'Checked.' }] }],
  ])
  const io = setup(on, { api })
  const handed = await compact($, messages)

  expect(handed[5]!.handle).toBe('u1')
  expect(hasImage(engineAssembles(handed, copies)[5])).toBe(true)
  expect(io.writes.some(w => w.path === `${ARCHIVE}/toolu_shot.json`)).toBe(false)
})

test('a folded message keeps the top-level text blocks its row lacks', async ($, on) => {
  const REMINDER = '<system-reminder>The file changed.</system-reminder>'
  const { messages, api } = conversation([
    [
      { role: 'assistant', text: '', toolUses: [useOf('toolu_big', 'Bash', { command: 'cat build.log' })], handle: 'a1' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_big', name: 'Bash', input: {} }] },
    ],
    [
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_big', text: BIG, isError: false }], handle: 'u1' },
      { role: 'user', content: [resultOf('toolu_big', [{ type: 'text', text: BIG }]), { type: 'text', text: REMINDER }] },
    ],
  ])
  setup(on, { api })
  const handed = await compact($, messages)

  expect(handed[5]!.toolResults?.[0]?.text.startsWith('[folded ')).toBe(true)
  expect(handed[5]!.text).toBe(REMINDER)
})

test('without the api view no message can be shown free of media, so nothing folds and the engine summarizes', async ($, on) => {
  const { messages } = conversation([])
  const io = setup(on, { apiFails: true })
  const handed = await compact($, messages)

  expect(JSON.stringify(handed)).not.toContain('[folded ')
  expect(handed.map(m => m.text)).toEqual(['summary'])
  expect(io.writes.some(w => w.path.startsWith(`${ARCHIVE}/`))).toBe(false)
})

test('a message the api view does not hold is left whole', async ($, on) => {
  const { messages, api } = conversation([])
  setup(on, { api: api.filter(m => !m.content.some(b => b.type === 'tool_result')) })
  const handed = await compact($, messages)

  expect(JSON.stringify(handed)).not.toContain('[folded ')
})
