import { expect, test } from 'claude-code/testing'
import { OFFER_TIMEOUT_MS, boardHasHandoff, boardOfferStep, handoffGap } from '../hooks/repostate'
test('probe', async () => {
  expect(boardHasHandoff('## Handoff\n- x')).toBe(true)
  expect(boardHasHandoff('## Now\nx')).toBe(false)
  expect(handoffGap({ branch: 'main', ahead: 3, dirty: 1 }, true)).toContain('3 commit(s) not pushed')
  expect(handoffGap({ branch: 'main', ahead: 0, dirty: 0 }, true)).toBe(undefined)
  expect(handoffGap({ branch: 'b', ahead: 1, dirty: 0 }, false)).toContain('no "Handoff" section')
  expect(handoffGap(undefined, true)).toBe(undefined)
})

test('an offer to create the status board: ask, wait, then accept the silence', () => {
  const now = 1_000_000_000_000
  // Nobody asked yet.
  expect(boardOfferStep(undefined, undefined, now)).toBe('ask')
  // Asked a moment ago: wait for them.
  expect(boardOfferStep(undefined, now - 1000, now)).toBe('wait')
  // Asked just under three hours ago: still waiting.
  expect(boardOfferStep(undefined, now - OFFER_TIMEOUT_MS + 1, now)).toBe('wait')
  // Three hours with no answer counts as a yes, by their instruction.
  expect(boardOfferStep(undefined, now - OFFER_TIMEOUT_MS, now)).toBe('accept')
  // A settled answer is never asked again.
  expect(boardOfferStep('declined', now - OFFER_TIMEOUT_MS * 2, now)).toBe('leave')
  expect(boardOfferStep('accepted', now - OFFER_TIMEOUT_MS * 2, now)).toBe('leave')
  // Nobody heard the question, so silence is not consent.
  expect(boardOfferStep(undefined, undefined, now)).toBe('ask')
})
