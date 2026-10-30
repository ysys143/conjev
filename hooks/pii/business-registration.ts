// SPDX-FileCopyrightText: 2026 The maskingtape Authors
// SPDX-License-Identifier: Apache-2.0
// Translated to TypeScript from maskingtape at commit 2802949 (detectors/business/business_registration.py), with modifications.

// Business registration numbers, XXX-XX-XXXXX. Every one carries the National Tax Service check
// digit, so the checksum decides: right is 1.0, wrong is dropped unless "사업자등록번호" or
// "사업자번호" is right before it (0.6, #607: a number copied with one digit wrong is still covered).

import type { Detection } from './overlaps'
import { pyInt, Re, type Match } from './regex'

const BRN_RE = new Re('(?<!\\d)(\\d{3})-(\\d{2})-(\\d{5})(?!\\d)')
// The label right before the number; "사업자 번호" spaced too. Between label and number as for cards (#657).
const BRN_LABEL_BEFORE_RE = new Re('(?:사업자 ?(?:등록 ?)?번호)[ \\t]{0,3}[:：]?[ \\t]{0,3}(?:\\r?\\n)?[ \\t]{0,3}[(（]?[ \\t]{0,3}\\Z')
const BRN_LABEL_WINDOW = 20
const LABELED_CONFIDENCE = 0.6

const WEIGHTS = [1, 3, 7, 1, 3, 7, 1, 3, 5]

/** Whether the tenth digit checks: the weighted sum plus the tens of digit 9 times 5. */
function checksumOk(digits: string): boolean {
  const ds = [...digits].map(pyInt)
  let total = WEIGHTS.reduce((sum, w, i) => sum + ds[i]! * w, 0)
  total += Math.floor((ds[8]! * 5) / 10)
  return (10 - (total % 10)) % 10 === ds[9]
}

/** Whether the business registration label is right before the number (#607). */
const hasBusinessLabel = (text: string, m: Match): boolean => BRN_LABEL_BEFORE_RE.search(text, Math.max(0, m.index - BRN_LABEL_WINDOW), m.index) !== null

export function detectBusinessRegistration(text: string): Detection[] {
  const found: Detection[] = []
  for (const m of BRN_RE.finditer(text)) {
    let confidence: number
    if (checksumOk(m[1]! + m[2]! + m[3]!)) confidence = 1.0
    else if (hasBusinessLabel(text, m)) confidence = LABELED_CONFIDENCE
    else continue // a 3-2-5 number without the checksum or the label is not one
    found.push({ kind: 'biz_reg', start: m.index, end: m.index + m[0].length, text: m[0], confidence })
  }
  return found
}
