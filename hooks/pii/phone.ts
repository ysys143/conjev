// SPDX-FileCopyrightText: 2026 The maskingtape Authors
// SPDX-License-Identifier: Apache-2.0
// Translated to TypeScript from maskingtape at commit 2802949 (detectors/contact/phone.py), with modifications.

// Phone numbers: mobile (010/011/016/017/018/019, +82 allowed), landline area codes, internet
// phones (070) and personal numbers (050X). With a separator the confidence is higher.
// A parenthesised prefix ("(010) 1234-5678") needs its closing parenthesis: without that check
// a year "(2024) 1234-5678" reads as a number.

import type { Detection } from './overlaps'
import { Re } from './regex'

// Between groups: hyphen, dot, space, en and em dash, up to three ("010 - 1234 - 5678").
const SEP = '[-.\\s–—]{0,3}'

const MOBILE_PREFIX = '(?:\\+82[-.\\s]?0?|0)1[016789]'
// Seoul 02, three-digit area codes, internet phone 070, personal numbers 050 and 0502-0508
const AREA = '(?:2|3[1-3]|4[1-4]|5[1-5]|6[1-4]|70|50\\d?)'
const LANDLINE_PREFIX = '0' + AREA

const TAIL = SEP + '\\d{3,4}' + SEP + '\\d{4}(?!\\d)'

// Python writes the closing parenthesis as the conditional (\()?PREFIX(?(1)\)); JavaScript has
// no conditional groups, so the two cases are alternatives, tried in the same order.
const parenthesised = (prefix: string): string => '(?<!\\d)(?:\\(' + prefix + '\\)|' + prefix + ')' + TAIL
const MOBILE_RE = new Re(parenthesised(MOBILE_PREFIX))
const LANDLINE_RE = new Re(parenthesised(LANDLINE_PREFIX))

// Shapes the two above miss (#493), found separately: widening one regex let a new shape start
// earlier and half swallow the tail, so finditer skipped the real number.
//  - a closing parenthesis without the opening one: "02)555-1234", "010) 1234-5678"
//  - international forms: "+82 (0)10-1234-5678", a landline without its 0 "+82-2-555-1234"
//  - only the country code parenthesised: "(+82) 10-1234-5678"
//  - +82 with the area code's 0 kept: "+820212345678"
const EXTRA_MOBILE_RE = new Re(
  '(?<![\\d(])' + MOBILE_PREFIX + '\\)' + TAIL + '|(?<!\\d)\\+82[-.\\s]?\\(0\\)\\s?1[016789]' + TAIL + '|(?<!\\d)\\(\\+82\\)[-.\\s]?1[016789]' + TAIL,
)
const EXTRA_LANDLINE_RE = new Re(
  '(?<![\\d(])' + LANDLINE_PREFIX + '\\)' + TAIL + '|(?<!\\d)\\+82[-.\\s]?(?:\\(0\\)\\s?)?' + AREA + '\\)?' + TAIL + '|(?<!\\d)\\+82[-.\\s]?0' + AREA + TAIL,
)

/** Whether a hyphen, dot or space is in it; tabs and dashes count as separators to the regex only. */
const hasSeparator = (matched: string): boolean => ['-', '.', ' '].some(sep => matched.includes(sep))

export function detectPhone(text: string): Detection[] {
  const found: Detection[] = []
  // (regex, confidence with a separator, confidence for bare digits)
  for (const [regex, withSep, bare] of [
    [MOBILE_RE, 1.0, 0.9],
    [LANDLINE_RE, 0.95, 0.8],
    [EXTRA_MOBILE_RE, 1.0, 0.9],
    [EXTRA_LANDLINE_RE, 0.95, 0.8],
  ] as const) {
    for (const m of regex.finditer(text)) {
      found.push({ kind: 'phone', start: m.index, end: m.index + m[0].length, text: m[0], confidence: hasSeparator(m[0]) ? withSep : bare })
    }
  }
  return found
}
