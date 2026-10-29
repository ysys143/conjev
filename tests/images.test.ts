// What a fold does to an image or other media in the message it would rebuild.
//
// The rows the compaction hands the plugin (SessionMessage) have no field for
// media. A message handed back with its handle is the engine's own copy,
// whole; one without is built from its role, text and tool blocks
// (claude-code.d.ts, SessionCompacted.messages). engineAssembles plays that
// engine: it keeps the handled copy and builds the rest from the rows only.
import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { HOME, apiOf, prompt, setup, smallRounds, type ApiMessage } from './kit'

type Block = ApiMessage['content'][number]

const BIG = 'L'.repeat(3000)
const PNG: Block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
// A PDF page, the other shape the engine hands back as a block of its own. It
// leaves the same way an image does when the message is rebuilt, so the fold
// must treat it the same.
const PDF: Block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } }
const ARCHIVE = `${HOME}/.conjev/state/archive/sess-1`
const hasImage = (message: unknown): boolean => JSON.stringify(message).includes('"type":"image"')
const hasMedia = (message: unknown): boolean => {
  const json = JSON.stringify(message)

  return json.includes('"type":"image"') || json.includes('"type":"document"')
}

const engineAssembles = (handed: readonly SessionMessage[], copies: ReadonlyMap<string, ApiMessage>): ApiMessage[] =>
  handed.map(m => (m.handle !== undefined && copies.has(m.handle) ? copies.get(m.handle)! : apiOf(m)))

const useOf = (id: string, tool: string, input: Record<string, unknown>) => ({ tool_use_id: id, tool, input })
const resultOf = (id: string, content: Block[]): Block => ({ type: 'tool_result', tool_use_id: id, content })

// An old Read that folds, so the compaction hands back the folded transcript
// rather than the engine's summary; then the message under test, and ten small
// rounds of work after it, so it is old enough for the policy to fold.
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
const WORK: [SessionMessage, ApiMessage][] = smallRounds(10).map((row, i) => [{ ...row, handle: `r${i}` }, apiOf(row)])
const TAIL: [SessionMessage, ApiMessage][] = ['and the test', 'and the diff'].map((text, i) => [
  { ...prompt(text), handle: `p${i + 1}` },
  { role: 'user', content: [{ type: 'text', text }] },
])

/** The rows handed to the compaction, the api view, and the engine's copies by handle. */
const conversation = (middle: [SessionMessage, ApiMessage][]) => {
  const pairs = [...OLD_READ, [{ ...prompt(LOOK), handle: 'p0' }, { role: 'user', content: [{ type: 'text', text: LOOK }] }] as [SessionMessage, ApiMessage], ...middle, ...WORK, ...TAIL]

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

// The old Read is eleven model turns back and the message under test ten:
// 'Checked.' and the first small round that follows it are one response, so
// one turn. A window of eleven folds the one and keeps the other.
test('control: the same message inside the recent window stays whole and keeps the PNG', { options: { keepRecentTurns: 11 } }, async ($, on) => {
  const { messages, api, copies } = conversation(LOG_AND_PNG)
  setup(on, { api })
  const handed = await compact($, messages)

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

test('a large text result beside a Read of a PDF page is not folded either', async ($, on) => {
  const { messages, api, copies } = conversation([
    [
      { role: 'assistant', text: '', toolUses: [useOf('toolu_doc', 'Bash', { command: 'cat build.log' }), useOf('toolu_pdf', 'Read', { file_path: '/proj/spec.pdf' })], handle: 'a1' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_doc', name: 'Bash', input: {} }, { type: 'tool_use', id: 'toolu_pdf', name: 'Read', input: {} }] },
    ],
    [
      {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [
          { tool_use_id: 'toolu_doc', text: BIG, isError: false },
          { tool_use_id: 'toolu_pdf', text: '', isError: false },
        ],
        handle: 'u1',
      },
      { role: 'user', content: [resultOf('toolu_doc', [{ type: 'text', text: BIG }]), resultOf('toolu_pdf', [PDF])] },
    ],
    [{ role: 'assistant', text: 'Checked.', toolUses: [], handle: 'a2' }, { role: 'assistant', content: [{ type: 'text', text: 'Checked.' }] }],
  ])
  const io = setup(on, { api })
  const handed = await compact($, messages)

  expect(handed[5]!.handle).toBe('u1')
  expect(hasMedia(engineAssembles(handed, copies)[5])).toBe(true)
  expect(io.writes.some(w => w.path === `${ARCHIVE}/toolu_doc.json`)).toBe(false)
})

test('a result holding text and a document is not folded', async ($, on) => {
  const { messages, api, copies } = conversation([
    [
      { role: 'assistant', text: '', toolUses: [useOf('toolu_spec', 'Read', { file_path: '/proj/spec.pdf' })], handle: 'a1' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_spec', name: 'Read', input: {} }] },
    ],
    [
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_spec', text: BIG, isError: false }], handle: 'u1' },
      { role: 'user', content: [resultOf('toolu_spec', [{ type: 'text', text: BIG }, PDF])] },
    ],
    [{ role: 'assistant', text: 'Checked.', toolUses: [], handle: 'a2' }, { role: 'assistant', content: [{ type: 'text', text: 'Checked.' }] }],
  ])
  const io = setup(on, { api })
  const handed = await compact($, messages)

  expect(handed[5]!.handle).toBe('u1')
  expect(hasMedia(engineAssembles(handed, copies)[5])).toBe(true)
  expect(io.writes.some(w => w.path === `${ARCHIVE}/toolu_spec.json`)).toBe(false)
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

  expect(handed.some(m => m.toolResults?.some(r => r.text.startsWith('[folded ')))).toBe(false)
  expect(handed[0]!.text).toBe('summary')
  // Only the conversation the summary replaced is kept, and pointed to (E2).
  expect(handed.slice(1).map(m => m.text.split('\n')[1]?.startsWith('[folded conversation'))).toEqual([true])
  expect(io.writes.filter(w => w.path.startsWith(`${ARCHIVE}/`)).every(w => w.path.includes('/conversation-'))).toBe(true)
})

test('a message the api view does not hold is left whole', async ($, on) => {
  const { messages, api } = conversation([])
  setup(on, { api: api.filter(m => !m.content.some(b => b.type === 'tool_result')) })
  const handed = await compact($, messages)

  expect(handed.some(m => m.toolResults?.some(r => r.text.startsWith('[folded ')))).toBe(false)
})
