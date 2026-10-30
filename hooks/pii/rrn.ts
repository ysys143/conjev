// SPDX-FileCopyrightText: 2026 The maskingtape Authors
// SPDX-License-Identifier: Apache-2.0
// Translated to TypeScript from maskingtape at commit 2802949 (detectors/identity/rrn.py), with modifications.

// Resident registration numbers (foreigner numbers too): a regex for "6 digits - 7 digits",
// then the front must be a real date, then the checksum sets the confidence.
//  - The front may carry the century ("19800101-1234567", #508) or be a date written with dots,
//    hyphens, slashes or Korean ("1980.01.01", "1980년 1월 1일", #529, #638).
//  - With all seven back digits the separator is loose (slashes, underscores, middle dots and
//    their look-alikes, #529, #631). A masked or partial back ("800101-1******", "800101-1",
//    #528) takes only one hyphen-like separator: looser, "작성일 240101 3건" would match.
//  - Checksum right: 1.0; wrong or not computable: 0.85. Numbers issued after October 2020
//    are random, so a wrong checksum does not reject.

import type { Detection } from './overlaps'
import { isDate, pyInt, Re, type Match } from './regex'

// Characters used to mask the back: asterisk, X, filled and hollow circles, square, hash (#528)
const MASK_CHAR = '[*Xx●○■#]'

const FRONT_PLAIN = '(?:19|20)?(?P<front>\\d{6})'
// A dated front (#529, #638): "1980.1.1", "80.01.01", "1980/01/01", "1980년 1월 1일", and the
// spaced "1980. 1. 1." of official documents (#637). The final dot belongs to the separator.
const FRONT_DATED = '(?P<front_dated>(?:\\d{4}|\\d{2})' + '(?:[./\\-] ?\\d{1,2}[./\\-] ?\\d{1,2}|년\\s?\\d{1,2}월\\s?\\d{1,2}일))'

// The loose separator before seven real digits, up to four characters (bounded, no ReDoS).
// The dot look-alikes are written as code points: they are hard to tell apart by eye (#631).
const DOT_LIKE = '・･•∙⋅․﹒⦁●¸˙'
const BACK_SEP = '[-.\\s–—/_,:·ㆍ‧~|' + DOT_LIKE + ']{0,4}'
const BACK = '(?P<back>[1-8]\\d{6})'

// The narrow separator before a masked or partial back: one hyphen-like character.
const BACK_PARTIAL_SEP = '[ \\t]?[-–—‐－][ \\t]?'
// Part of the back written and the rest masked ("19800101-1234***", #637).
const BACK_PARTIAL_BODY = '[1-8]\\d{0,6}(?:' + MASK_CHAR + '{0,6})?'
const BACK_PARTIAL = '(?P<back_partial>' + BACK_PARTIAL_BODY + ')'

// One letter right after the seven digits ("800101-1234560A", #640), unless more letters or
// digits follow: then it is part of a longer code.
const TRAILING_LETTER = '(?:[A-Za-z](?![A-Za-z\\d]|-[A-Za-z\\d]))?'
/** What the birth date detector looks for after a date: this detector's first branch, character for character. */
export const RRN_BACK_AHEAD =
  '(?:' + BACK_SEP + '[1-8]\\d{6}' + TRAILING_LETTER + '|' + BACK_PARTIAL_SEP + BACK_PARTIAL_BODY + ')(?![\\dA-Za-z])'

// One space inside the seven back digits ("800101 - 1234 567", #637), taken only after a label.
// The branches split so the digits around the space add up to exactly seven.
const BACK_SPACED =
  '(?P<back_spaced>[1-8](?:' +
  Array.from({ length: 6 }, (_, k) => `\\d{${k}} \\d{${6 - k}}`).join('|') +
  '))'
const RRN_FRONT = '(?<!\\d)(?:' + FRONT_PLAIN + '|' + FRONT_DATED + ')'
const RRN_RE = new Re(
  RRN_FRONT + '(?:' + BACK_SEP + BACK + TRAILING_LETTER + '|' + BACK_SEP + BACK_SPACED + '|' + BACK_PARTIAL_SEP + BACK_PARTIAL + ')' + '(?![\\dA-Za-z])',
)
// When the spaced branch had no label, the same place is matched again without it, so the
// shape it caught before ("800101-1 234567" as "800101-1") is not lost.
const RRN_NO_SPACED_RE = new Re(RRN_FRONT + '(?:' + BACK_SEP + BACK + TRAILING_LETTER + '|' + BACK_PARTIAL_SEP + BACK_PARTIAL + ')' + '(?![\\dA-Za-z])')

const WEIGHTS = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5]
const NUMBERS = new Re('\\d+')
const MASK_CHAR_RE = new Re(MASK_CHAR)

/**
 * Whether the six-digit front is a real date in the 1900s or the 2000s. The sex digit does not
 * pick one century: the birth date detector hands such dates here and checks both, and a
 * narrower check here would drop "000229 1234567" in both detectors (#508).
 */
function validBirthdate(front: string): boolean {
  for (const century of [1900, 2000]) if (isDate(century + pyInt(front.slice(0, 2)), pyInt(front.slice(2, 4)), pyInt(front.slice(4, 6)))) return true
  return false
}

/** Whether a dated front is a real date (#529, #638); a two-digit year passes in either century. */
function validDatedFront(frontDated: string): boolean {
  const [yearText, month, day] = [...NUMBERS.finditer(frontDated)].map(m => m[0]) as [string, string, string]
  const years = yearText.length === 4 ? [pyInt(yearText)] : [1900 + pyInt(yearText), 2000 + pyInt(yearText)]
  return years.some(year => isDate(year, pyInt(month), pyInt(day)))
}

const RRN_LABEL_RE = new Re('주민|생년월일|출생|생일')
const RRN_LABEL_WINDOW = 20

/**
 * Whether a partly written back is taken (#637): masked, or the sex digit alone. Two to six
 * plain digits need a resident-number or birth-date label before: "ORD-20250408-2110" and
 * "240101-1234" are common order and tracking numbers.
 */
function partialBackOk(text: string, m: Match, back: string): boolean {
  if (MASK_CHAR_RE.search(back) || back.length === 1) return true
  return hasRrnLabel(text, m)
}

/** Whether a resident-number or birth-date label is within 20 characters before the number. */
function hasRrnLabel(text: string, m: Match): boolean {
  return RRN_LABEL_RE.search(text, Math.max(0, m.index - RRN_LABEL_WINDOW), m.index) !== null
}

/** The six digits (YYMMDD) the checksum uses; a dated front gives the last two of its year. */
function checksumFront(front: string | undefined, frontDated: string | undefined): string {
  if (front !== undefined) return front
  const [yearText, month, day] = [...NUMBERS.finditer(frontDated!)].map(m => m[0]) as [string, string, string]
  const pad = (n: number): string => String(n).padStart(2, '0')
  return yearText.slice(-2) + pad(pyInt(month)) + pad(pyInt(day))
}

/** Whether the last of the 13 digits is the check digit. */
function checksumOk(digits: string): boolean {
  const ds = [...digits]
  const total = WEIGHTS.reduce((sum, w, i) => sum + pyInt(ds[i]!) * w, 0)
  return (11 - (total % 11)) % 10 === pyInt(ds[12]!)
}

const isDigits = (text: string): boolean => NUMBERS.fullmatch(text) !== null

export function detectRrn(text: string): Detection[] {
  const found: Detection[] = []
  for (let m of RRN_RE.finditer(text)) {
    let spacedRe = true
    if (m.groups!.back_spaced !== undefined && !hasRrnLabel(text, m)) {
      const again = RRN_NO_SPACED_RE.match(text, m.index)
      if (again === null) continue
      m = again
      spacedRe = false
    }
    const { front, front_dated: frontDated } = m.groups!
    let back = m.groups!.back
    if (spacedRe && m.groups!.back_spaced !== undefined) {
      back = m.groups!.back_spaced.replaceAll(' ', '')
    } else if (back === undefined) {
      back = m.groups!.back_partial!
      if (!partialBackOk(text, m, back)) continue
    }
    if (front !== undefined) {
      if (!validBirthdate(front)) continue
    } else if (!validDatedFront(frontDated!)) {
      continue
    }
    const confidence = back.length === 7 && isDigits(back) ? (checksumOk(checksumFront(front, frontDated) + back) ? 1.0 : 0.85) : 0.85
    found.push({ kind: 'rrn', start: m.index, end: m.index + m[0].length, text: m[0], confidence })
  }
  return found
}
