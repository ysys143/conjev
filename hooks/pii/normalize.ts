// SPDX-FileCopyrightText: 2026 The maskingtape Authors
// SPDX-License-Identifier: Apache-2.0
// Translated to TypeScript from maskingtape at commit 2802949 (normalize.py), with modifications.

// Before detection the input's spelling is tidied, and tidied positions map back to the
// original (#490). Full-width digits, zero-width spaces inside numbers, minus signs or
// en-dashes between groups, combining strokes over digits and decomposed Hangul all hide a
// number from the rules, so detection also runs on the tidied text. The original is unchanged.
//   - dash-like characters (en/em dash, U+2212, ㅡ typed as a dash, ...) -> '-'
//   - wide spaces (NBSP, ideographic space, the Hangul filler U+3164, ...) -> ' '
//   - full-width ASCII -> ASCII, non-ASCII decimal digits -> ASCII digits
//   - invisible characters and Latin or symbol combining marks -> removed
//   - decomposed Hangul -> composed syllables (NFC)
// Not NFKC as a whole: ① and ² would become digits and ㈜ (주), adding false positives.
// A middle dot between digits ("010·1234·5678") is not changed here; a separate reading with
// hyphens is made instead (hyphenated, #636).

import type { Detection } from './overlaps'
import { digitValue, Re } from './regex'

const DASHES = '‐‑‒–—―−﹘﹣－ㅡ⁃˗ー─'
const SPACES = '\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\u2800\u3164\uffa0'
// Removed: invisible format characters, variation selectors, tag characters, and the Latin
// and symbol combining marks. Combining characters of other scripts (except jamo) stay.
const DROP =
  '\u00ad\u061c\u115f\u1160\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u2064' +
  '\u2066-\u206f\ufe00-\ufe0f\ufeff' +
  '\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f' +
  '\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}'
const JAMO = 'ᄀ-ᇿꥠ-\ua97fힰ-\ud7ff'
// Dot look-alikes read as hyphens between digits (#636, #639): the middle dot and the
// characters the eye cannot tell from it. Only between digits, with at most one space.
const DIGIT_DOTS =
  '··ㆍ‧' +
  '・･•∙⋅․﹒⦁●¸˙' +
  'ᆞ◦。⸱ꞏ°'
const DIGIT_DOT_RE = new Re('(?:(?<=[0-9])|(?<=[0-9][ \\t]))[' + DIGIT_DOTS + '](?=[ \\t]?[0-9])')

// One character for one character. (?![0-9])\d is a non-ASCII decimal digit.
const SAME_LENGTH_RE = new Re('[' + DASHES + SPACES + '！-～]|' + '(?![0-9])\\d')
const DROP_RE = new Re('[' + DROP + ']')
// Whether the input needs a tidy that changes its length (removal, jamo composition).
const NEEDS_MAP_RE = new Re('[' + DROP + JAMO + ']')
// Whether the letters themselves change (jamo composed, Latin combining marks removed).
const LETTERS_CHANGE_RE = new Re('[' + JAMO + '\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\ufe20-\ufe2f]')

const isAscii = (text: string): boolean => !/[^\x00-\x7f]/.test(text)

/** The tidied form of one character; '' for one that is removed. */
function replaceOne(char: string): string {
  if (isAscii(char) || (char >= '가' && char <= '힣')) return char
  if (DROP_RE.match(char)) return ''
  if (!SAME_LENGTH_RE.match(char)) return char
  if (DASHES.includes(char)) return '-'
  const code = char.codePointAt(0)!
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCodePoint(code - 0xfee0)
  const digit = digitValue(code)
  if (digit !== undefined) return String(digit)
  return ' '
}

/** Whether the character belongs with the one before it (medial or final jamo, a removed character). */
function continuesCluster(char: string): boolean {
  const code = char.codePointAt(0)!
  return (code >= 0x1160 && code <= 0x11ff) || (code >= 0xd7b0 && code <= 0xd7ff) || DROP_RE.match(char) !== null
}

/**
 * The text detection runs on, and the map back to the original.
 * starts[i] and ends[i] are the original span text[i] came from; both are undefined when
 * positions are the original's. hyphenated is text with dot look-alikes between digits read
 * as hyphens (#636), the same length as text.
 */
export type NormalizedText = {
  original: string
  text: string
  starts?: readonly number[]
  ends?: readonly number[]
  lettersChanged: boolean
  hyphenated?: string | undefined
}

/** A detection on the tidied text, moved back onto the original. */
export function restore(prepared: NormalizedText, d: Detection): Detection {
  const [s, e] = toOriginal(prepared, d.start, d.end)
  return { ...d, start: s, end: e, text: prepared.original.slice(s, e) }
}

function toOriginal(prepared: NormalizedText, s: number, e: number): [number, number] {
  const { starts, ends } = prepared
  if (starts === undefined || ends === undefined) return [s, e]
  if (s >= e) {
    const position = s < starts.length ? starts[s]! : prepared.original.length
    return [position, position]
  }
  return [starts[s]!, ends[e - 1]!]
}

/** The tidy that changes one character for one, so positions stay. */
const sameLength = (text: string): string => SAME_LENGTH_RE.sub(text, m => replaceOne(m[0]))

/** The tidied text with dot look-alikes between digits as hyphens (#636); undefined when there are none. */
function hyphenateDigitDots(text: string): string | undefined {
  let count = 0
  const out = DIGIT_DOT_RE.sub(text, () => {
    count++
    return '-'
  })
  return count > 0 ? out : undefined
}

/** The text tidied for detection, with the map back to original positions. */
export function normalize(text: string): NormalizedText {
  if (isAscii(text)) return { original: text, text, lettersChanged: false }
  if (!NEEDS_MAP_RE.search(text)) {
    const cleaned = sameLength(text)
    return { original: text, text: cleaned, lettersChanged: false, hyphenated: hyphenateDigitDots(cleaned) }
  }
  return normalizeWithMap(text)
}

// The tidy that changes length. Only the characters to remove or compose are grouped with the
// one before them; the cluster's output maps to the cluster's original span, so a restored span
// never covers less of the original. The plain stretches between map one to one, in bulk.
// Text here is one code unit per code point (see pipeline.ts), so string indices are Python's.
function normalizeWithMap(text: string): NormalizedText {
  const pieces: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  const addPlain = (a: number, b: number): void => {
    pieces.push(sameLength(text.slice(a, b)))
    for (let k = a; k < b; k++) {
      starts.push(k)
      ends.push(k + 1)
    }
  }

  const n = text.length
  let done = 0
  for (const m of NEEDS_MAP_RE.finditer(text)) {
    const k = m.index
    if (k < done) continue // already in the cluster before
    // A character that continues the one before starts its cluster there
    const i = k > done && continuesCluster(text[k]!) ? k - 1 : k
    addPlain(done, i)
    let j = i + 1
    while (j < n && continuesCluster(text[j]!)) j++
    let piece = [...text.slice(i, j)].map(replaceOne).join('')
    if (piece.length > 1) piece = piece.normalize('NFC')
    pieces.push(piece)
    for (let c = 0; c < piece.length; c++) {
      starts.push(i)
      ends.push(j)
    }
    done = j
  }
  addPlain(done, n)
  const cleaned = pieces.join('')
  return {
    original: text,
    text: cleaned,
    starts,
    ends,
    lettersChanged: LETTERS_CHANGE_RE.search(text) !== null,
    hyphenated: hyphenateDigitDots(cleaned),
  }
}
