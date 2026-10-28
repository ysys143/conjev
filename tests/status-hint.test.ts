// The status is drawn at the end of the prompt's hint, not as a plugin status
// line: Claude Code marks every plugin status line with a warning sign.
import { expect, test } from 'claude-code/testing'
import { KEY_ENV, setup } from './kit'

const hint = (surface: 'terminal' | 'desktop') =>
  ({ component: 'PromptHint', surface, requestId: 'hint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } }) as never
const textOf = (drawn: unknown): string => JSON.stringify(drawn)

const STOP = { stop_hook_active: false, last_assistant_message: 'Next, I will refactor the cache.' } as never

test('the status rides after the hint, never as a status line', { options: { toolGate: 'active' } }, async ($, on) => {
  const io = setup(on, { env: KEY_ENV })
  // Nothing recorded yet: the hint is the engine's alone.
  expect(textOf(await $.ui.render(hint('terminal')))).not.toContain('conjev')

  await $.tool.call({ tool: 'Read', file_path: '/proj/.env' })
  await $.classic.Stop(STOP)

  // The terminal draws it as the dim tail after the engine's own line.
  expect(textOf(await $.ui.render(hint('terminal')))).toContain('conjev: jev 0 · floor 1 hit')
  // A surface that draws no tail gets it in the hint itself.
  expect(textOf(await $.ui.render(hint('desktop')))).toContain('? for shortcuts · conjev: jev 0 · floor 1 hit')
  // And never with the warning-marked status line.
  expect(io.warned).toEqual([])
})
