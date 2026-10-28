// SPDX-FileCopyrightText: 2026 The maskingtape Authors
// SPDX-License-Identifier: Apache-2.0
// Translated to TypeScript from maskingtape at commit 2802949 (detectors/personal/birthdate.py), with modifications.

// Birth dates: only a date next to a label ("생년월일", "생일", "출생일" before it, or "생",
// "태어", "생일" after it); a bare date is an ordinary date. The date must exist. Only the date
// is covered; the label is not personal information.

import type { Detection } from './overlaps'
import { isDate, pyInt, Re } from './regex'
import { RRN_BACK_AHEAD } from './rrn'

// Longest first, so "출생년월일" is not cut into "출생" + "년월일"; "출생", "생년" alone too (#493).
const ANCHOR = '(?:출생년월일|생년월일|출생일|생일|출생|생년)'

// "1999년 7월 21일", "99년 7월 21일" (#493), "1999-07-21" with -, ., / (and the spaced "1999. 7. 21."),
// "19990721" and "990721" run together (#493), "99.07.21". Four-digit years go first. Six digits,
// and eight starting 19 or 20, are not taken when a resident number's back follows (rrn.ts's
// RRN_BACK_AHEAD, #631): "800101 1234567" is the front of one, and taking it as a birth date
// leaks the back seven digits.
const DATE =
  '(?:\\d{4}\\s?년\\s?\\d{1,2}\\s?월\\s?\\d{1,2}\\s?일' +
  '|\\d{2}\\s?년\\s?\\d{1,2}\\s?월\\s?\\d{1,2}\\s?일' +
  '|\\d{4}\\s{0,2}[-./]\\s{0,2}\\d{1,2}\\s{0,2}[-./]\\s{0,2}\\d{1,2}(?:\\.(?!\\d))?' +
  '|(?:19|20)\\d{6}(?!' +
  RRN_BACK_AHEAD +
  ')' +
  '|(?!19|20)\\d{8}(?!-?\\d)' +
  '|\\d{2}[-./]\\d{1,2}[-./]\\d{1,2}(?!\\d)' +
  '|\\d{6}(?!\\d|' +
  RRN_BACK_AHEAD +
  '))'

// Between label and date: up to three parenthesised notes without digits (#508, #529), a colon,
// a table bar, spaces, a particle. Every repetition is bounded: two adjacent unbounded runs of
// spaces backtracked catastrophically.
const BIRTHDATE_RE = new Re(ANCHOR + '(?:\\s{0,3}\\([^()\\d]{1,15}\\)){0,3}[\\s:|]{0,10}(?:은|는|이|가)?\\s{0,5}(?P<date>' + DATE + ')', { indices: true })

// A cue after the date (#592): "1992년 10월 31일생입니다", "2019년 4월 23일에 태어났어요",
// "1995년 6월 21일이 제 생일이에요". "생" needs one of these endings and no Hangul after, or
// "생산", "생활" would count.
const TRAILING_CUE =
  '(?:생(?:이에요|이었|이고|이야|이다|이네요|이죠|입니다|으로)?(?![가-힣])' +
  '|에\\s{0,2}태어' +
  '|(?:이|가)?\\s{0,2}(?:제\\s{0,2})?생일' +
  // After "출생" only these endings, then no Hangul: "출생률", "출생신고" are words (#658, #726).
  '|\\s?출생(?:입니다|이었|이라|이며|이고|이다|으로|자|인|[은는이가을를의에도만])?(?![가-힣]))'

const BIRTHDATE_TRAILING_RE = new Re('(?P<date>' + DATE + ')' + TRAILING_CUE, { indices: true })
const NUMBERS = new Re('\\d+')

/** Whether the date (three numbers, or six or eight digits run together) exists. */
function validDate(dateText: string): boolean {
  let nums = [...NUMBERS.finditer(dateText)].map(m => m[0])
  if (nums.length === 1 && (nums[0]!.length === 6 || nums[0]!.length === 8)) {
    // Run together: day and month come off the end, the year is what is left
    const compact = nums[0]!
    nums = [compact.slice(0, -4), compact.slice(-4, -2), compact.slice(-2)]
  }
  if (nums.length !== 3) return false
  const [year, month, day] = nums.map(pyInt) as [number, number, number]
  // A two-digit year passes if the date exists in either century; only 29 February depends on it.
  const candidates = nums[0]!.length === 4 ? [year] : [1900 + year, 2000 + year]
  return candidates.some(y => isDate(y, month, day))
}

export function detectBirthDate(text: string): Detection[] {
  const found: Detection[] = []
  const seen = new Set<string>()
  for (const pattern of [BIRTHDATE_RE, BIRTHDATE_TRAILING_RE]) {
    for (const m of pattern.finditer(text)) {
      const dateText = m.groups!.date!
      const [s, e] = m.indices!.groups!.date!
      const key = `${s}:${e}`
      if (seen.has(key) || !validDate(dateText)) continue
      seen.add(key)
      found.push({ kind: 'birth_date', start: s, end: e, text: dateText, confidence: 0.9 })
    }
  }
  return found.sort((a, b) => a.start - b.start)
}
