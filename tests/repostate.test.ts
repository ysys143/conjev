import { expect, test } from 'claude-code/testing'
import { OFFER_TIMEOUT_MS, boardHasHandoff, boardOfferStep, handoffGap, offerAccepted } from '../hooks/repostate'
import { keyFromShared, settingsFromShared, sharedDirOf } from '../hooks/shared'
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

test('the answer to the offer is read by the word the person used, not by an exact match', () => {
  // The engine returns the label they picked, or whatever they typed under
  // "Other": both may be worded differently from the label.
  expect(offerAccepted('Create it')).toBe(true)
  expect(offerAccepted('create one')).toBe(true)
  expect(offerAccepted('Yes, please create it')).toBe(true)
  expect(offerAccepted('Not now')).toBe(false)
  expect(offerAccepted('no')).toBe(false)
  expect(offerAccepted('')).toBe(false)
})

test('a settled offer is never asked again, in this session or the next', () => {
  const now = 1_000_000_000_000
  // Both settled answers hold, however long ago they were given.
  expect(boardOfferStep('accepted', undefined, now)).toBe('leave')
  expect(boardOfferStep('declined', undefined, now)).toBe('leave')
  // And a settled answer outranks the timeout that would otherwise accept.
  expect(boardOfferStep('declined', now - OFFER_TIMEOUT_MS * 2, now)).toBe('leave')
})

test('the shared folder reads as settings and as a key, and a broken file is nothing', () => {
  // The config file holds the same values the plugin's own settings do.
  expect(settingsFromShared('{"foldAtPercent": 40}')).toEqual({ foldAtPercent: 40 })
  // A file that is not an object, or not JSON at all, is nothing rather than a throw.
  expect(settingsFromShared('[]')).toEqual({})
  expect(settingsFromShared('not json')).toEqual({})
  expect(settingsFromShared(undefined)).toEqual({})
  // The whole key file is the key: an editor's trailing newline is the only thing dropped.
  expect(keyFromShared('ts_live_abc\n')).toBe('ts_live_abc')
  expect(keyFromShared('  spaced  ')).toBe('spaced')
  expect(keyFromShared('\n')).toBe(undefined)
  expect(keyFromShared(undefined)).toBe(undefined)
  expect(sharedDirOf('/home/me')).toBe('/home/me/.conjev')
})
