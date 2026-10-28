// SPDX-FileCopyrightText: 2026 The maskingtape Authors
// SPDX-License-Identifier: Apache-2.0
// Translated to TypeScript from maskingtape at commit 2802949 (detectors/financial/creditcard.py), with modifications.

// Card numbers: the group shapes real cards are written in (4-4-4-4, Amex 4-6-5, or 13-19
// digits run together), then the Luhn check. Passing gives 0.95: a checksum can pass by chance.
//  - Starting with a group of four keeps an unrelated number before the card from being
//    swallowed and the real card skipped, and leaves 6-7 resident numbers to their detector.
//  - Two cards in a row (#510): the back of one and the front of the next can pass Luhn and be
//    found first, so every search resumes one character after the last match began.

import type { Detection } from './overlaps'
import { pyInt, Re, type Match } from './regex'

// One separator repeated (backreference \1), up to three characters for "4111 - 1111". No
// newline, so numbers on different lines are not joined. Each shape is searched separately
// (#493): as alternatives the 19-digit shape swallowed "16-digit card + 3 digits" and lost it.
const CARD_SHAPES = [
  '\\d{4}([ .-]{1,3})\\d{4}\\1\\d{4}\\1\\d{1,4}', // 4-4-4-4 (Visa, MC: 16 digits)
  '\\d{4}([ .-]{1,3})\\d{6}\\1\\d{5}', // 4-6-5 (Amex, 15 digits)
  '\\d{13,19}', // 13-19 digits run together
  '\\d{4}([ .-]{1,3})\\d{4}\\1\\d{4}\\1\\d{4}\\1\\d{1,3}', // 4-4-4-4-3 (17-19 digits, #493)
  '\\d{4}([ .-]{1,3})\\d{6}\\1\\d{4}', // 4-6-4 (Diners, 14 digits, #493)
]
const CARD_RES = CARD_SHAPES.map(shape => new Re('(?<!\\d)(?:' + shape + ')(?!\\d)'))
// Hyphens and spaces mixed ("4111-1111 1111-1111", #493). Year lists share the shape, so a
// card cue must be near.
const MIXED_CARD_RE = new Re('(?<!\\d)\\d{4}[ -]{1,3}\\d{4}[ -]{1,3}\\d{4}[ -]{1,3}\\d{4}(?!\\d)')
// "카드" covers credit and check cards; "신용" or "체크" alone would take "신용등급" and "체크리스트".
const CARD_CUE_RE = new Re('카드|card|결제', { flags: 'i' })
const CARD_CUE_WINDOW = 15
// A card label right before the number takes it even when Luhn fails (#607), at 0.6. Between
// label and number: a colon, one line break, an opening parenthesis; never a blank line (#657).
const CARD_LABEL_BEFORE_RE = new Re('(?:신용카드|체크카드|법인카드|카드 ?번호)[ \\t]{0,3}[:：]?[ \\t]{0,3}(?:\\r?\\n)?[ \\t]{0,3}[(（]?[ \\t]{0,3}\\Z')
const CARD_LABEL_WINDOW = 20
const LABELED_CONFIDENCE = 0.6
// A mixed shape right after a card already found, with only separators between, inherits its
// context (#510). Anything else between means it is not one list.
const ADJACENT_GAP_RE = new Re('[ ,/]{1,3}')
// When inheriting only: four year-like groups (19xx, 20xx) are a year list, not a card.
const YEAR_LIST_RE = new Re('(?:19|20)\\d\\d(?:[ -]{1,3}(?:19|20)\\d\\d){3}')
const NON_DIGITS = new Re('\\D')

/** The Luhn check. */
function luhnOk(digits: string): boolean {
  let total = 0
  ;[...digits].reverse().forEach((char, index) => {
    let value = pyInt(char)
    if (index % 2 === 1) {
      value *= 2
      if (value > 9) value -= 9
    }
    total += value
  })
  return total % 10 === 0
}

/** Whether a card label is right before the number (#607). */
const hasCardLabel = (text: string, m: Match): boolean => CARD_LABEL_BEFORE_RE.search(text, Math.max(0, m.index - CARD_LABEL_WINDOW), m.index) !== null

/** Whether a mixed shape is in card context: a cue within 15 characters before, or right after a card found. */
function hasCardContext(text: string, m: Match, found: readonly Detection[]): boolean {
  const start = m.index
  if (CARD_CUE_RE.search(text, Math.max(0, start - CARD_CUE_WINDOW), start)) return true
  if (YEAR_LIST_RE.fullmatch(m[0])) return false
  return found.some(d => d.end <= start && ADJACENT_GAP_RE.fullmatch(text, d.end, start) !== null)
}

export function detectCard(text: string): Detection[] {
  const found: Detection[] = []
  const seen = new Set<string>()
  // (match, mixed shape?). The mixed shape's context is checked in the loop: inheriting needs
  // the cards accepted so far.
  const matches: [Match, boolean][] = [
    ...CARD_RES.flatMap(regex => [...regex.searchEveryStart(text)].map(m => [m, false] as [Match, boolean])),
    ...[...MIXED_CARD_RE.searchEveryStart(text)].map(m => [m, true] as [Match, boolean]),
  ]
  matches.sort(([a], [b]) => a.index - b.index || a[0].length - b[0].length)
  for (const [m, mixed] of matches) {
    const digits = NON_DIGITS.sub(m[0], '')
    const key = `${m.index}:${m.index + m[0].length}`
    if (!(digits.length >= 13 && digits.length <= 19) || seen.has(key)) continue
    let confidence: number
    if (luhnOk(digits)) {
      if (mixed && !hasCardContext(text, m, found)) continue
      confidence = 0.95
    } else if (hasCardLabel(text, m)) {
      confidence = LABELED_CONFIDENCE
    } else {
      continue
    }
    seen.add(key)
    found.push({ kind: 'card', start: m.index, end: m.index + m[0].length, text: m[0], confidence })
  }
  return found
}
