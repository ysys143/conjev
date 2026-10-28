import { expect, test } from 'claude-code/testing'
import { boardHasHandoff, handoffGap } from '../hooks/repostate'
test('probe', async () => {
  expect(boardHasHandoff('## Handoff\n- x')).toBe(true)
  expect(boardHasHandoff('## Now\nx')).toBe(false)
  expect(handoffGap({ branch: 'main', ahead: 3, dirty: 1 }, true)).toContain('3 commit(s) not pushed')
  expect(handoffGap({ branch: 'main', ahead: 0, dirty: 0 }, true)).toBe(undefined)
  expect(handoffGap({ branch: 'b', ahead: 1, dirty: 0 }, false)).toContain('no "Handoff" section')
  expect(handoffGap(undefined, true)).toBe(undefined)
})
