// SPDX-FileCopyrightText: 2026 The maskingtape Authors
// SPDX-License-Identifier: Apache-2.0
// Translated to TypeScript from maskingtape at commit 2802949 (pipeline.py, detectors/__init__.py), with
// modifications: positions are reported in UTF-16 units, and only the rule detectors exist.

// Detect, merge overlaps, then mask or label. Inputs whose spelling changes when tidied
// (full-width digits, zero-width spaces, dash variants, decomposed jamo) are searched both as
// written and tidied, and the results combined (#490); dot look-alikes between digits read as
// hyphens are searched once more (#636). Results are only ever added, so tidying never covers less.

import { detectAccount } from './account'
import { detectAddress } from './address'
import { detectBirthDate } from './birthdate'
import { detectBusinessRegistration } from './business-registration'
import { detectCard } from './creditcard'
import { detectDriverLicense } from './driver-license'
import { detectEmail } from './email'
import { label } from './label'
import { mask } from './mask'
import { detectName } from './name'
import { normalize, restore } from './normalize'
import { resolveOverlaps, type Detection } from './overlaps'
import { detectPassport } from './passport'
import { detectPhone } from './phone'
import { digitValue } from './regex'
import { detectRrn } from './rrn'

export type { Detection } from './overlaps'

/** The rule detectors, in the order maskingtape runs them (default_detectors). */
const DETECTORS: readonly ((text: string) => Detection[])[] = [
  detectRrn,
  detectPassport,
  detectDriverLicense,
  detectPhone,
  detectEmail,
  detectAddress,
  detectCard,
  detectAccount,
  detectBusinessRegistration,
  detectName,
  detectBirthDate,
]

/**
 * The input as the detectors see it. Python counts code points, JavaScript UTF-16 units, and
 * the detectors count characters (windows, lengths, masks). So p holds one code unit per code
 * point: each astral character is replaced by a BMP stand-in every pattern treats alike (a
 * removable invisible stays one, a digit stays a digit of the same value, anything else becomes
 * U+E000, which no pattern names). chars holds the original code points, for the output.
 */
export type CodePoints = { p: string; chars: readonly string[] }

const ASTRAL_DROP = (code: number): boolean => (code >= 0x1bca0 && code <= 0x1bca3) || (code >= 0x1d173 && code <= 0x1d17a) || (code >= 0xe0000 && code <= 0xe0fff)

function codePointsOf(text: string): CodePoints & { u16: number[] } {
  const chars: string[] = []
  const u16: number[] = [0]
  let p = ''
  let offset = 0
  for (const char of text) {
    chars.push(char)
    offset += char.length
    u16.push(offset)
    if (char.length === 1) {
      p += char
      continue
    }
    const code = char.codePointAt(0)!
    const digit = digitValue(code)
    p += ASTRAL_DROP(code) ? '\u200b' : digit !== undefined ? String.fromCharCode(0x660 + digit) : '\ue000'
  }
  return { p, chars, u16 }
}

/** Detections in code point positions of p (Pipeline.scan). */
function scanPoints(text: string): Detection[] {
  const prepared = normalize(text)
  const found: Detection[] = []
  for (const detect of DETECTORS) {
    found.push(...detect(text))
    if (prepared.text !== text) found.push(...detect(prepared.text).map(d => restore(prepared, d)))
    if (prepared.hyphenated !== undefined) found.push(...detect(prepared.hyphenated).map(d => restore(prepared, d)))
  }
  return resolveOverlaps(found, text)
}

export type Strategy = 'mask' | 'label'

export type AnonymizeResult = {
  /** The text with each detection masked or labelled. */
  text: string
  /** What was found; start and end are UTF-16 positions in the input (JavaScript string indices). */
  detections: Detection[]
}

/** Detects personal information and masks it ('*' per character) or labels it ("[전화번호]"). */
export function anonymize(text: string, strategy: Strategy = 'mask'): AnonymizeResult {
  const points = codePointsOf(text)
  const found = scanPoints(points.p)
  const out = strategy === 'label' ? label(points, found) : mask(points, found)
  const detections = found.map(d => ({ ...d, start: points.u16[d.start]!, end: points.u16[d.end]!, text: points.chars.slice(d.start, d.end).join('') }))
  return { text: out, detections }
}
