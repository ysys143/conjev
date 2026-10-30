// SPDX-FileCopyrightText: 2026 The maskingtape Authors
// SPDX-License-Identifier: Apache-2.0
// Translated to TypeScript from maskingtape at commit 2802949 (detectors/identity/passport.py), with modifications.

// Korean passport numbers: a type letter (M/S/R/O/D) and eight digits (old), or a letter,
// three digits, a letter and four digits (new). Issued in capitals but often copied in lower
// case, so case is ignored. There is no checksum: "여권" within 15 characters before gives 0.9,
// the shape alone 0.6. A longer alphanumeric run around it is part of something else.

import type { Detection } from './overlaps'
import { Re, type Match } from './regex'

// Python's IGNORECASE also lets [A-Z] match U+0130 and U+0131, which JavaScript's i flag does not.
const I = 'İı'
const PASSPORT_RE = new Re(`(?<![A-Za-z0-9${I}])[MSROD](?:\\d{8}|\\d{3}[A-Z${I}]\\d{4})(?![A-Za-z0-9${I}])`, { flags: 'i' })

// A space or hyphen after the type letter ("M 12345678", "M-12345678", #493). Sizes and
// document codes share this shape ("S 12345678", "D-20260928"), so it needs the cue.
const PASSPORT_SPACED_RE = new Re(`(?<![A-Za-z0-9${I}])[MSROD][ -](?:\\d{8}|\\d{3}[A-Z${I}]\\d{4})(?![A-Za-z0-9${I}])`, { flags: 'i' })

const CONTEXT_WINDOW = 15

/** Whether "여권" is within 15 characters before the candidate. */
const hasCue = (text: string, start: number): boolean => text.slice(Math.max(0, start - CONTEXT_WINDOW), start).includes('여권')

export function detectPassport(text: string): Detection[] {
  const spaced = [...PASSPORT_SPACED_RE.finditer(text)].filter(m => hasCue(text, m.index))
  const matches: Match[] = [...PASSPORT_RE.finditer(text), ...spaced].sort((a, b) => a.index - b.index)
  return matches.map(m => ({ kind: 'passport', start: m.index, end: m.index + m[0].length, text: m[0], confidence: hasCue(text, m.index) ? 0.9 : 0.6 }))
}
