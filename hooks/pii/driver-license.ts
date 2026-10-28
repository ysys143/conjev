// SPDX-FileCopyrightText: 2026 The maskingtape Authors
// SPDX-License-Identifier: Apache-2.0
// Translated to TypeScript from maskingtape at commit 2802949 (detectors/identity/driver_license.py), with modifications.

// Driver's licence numbers: twelve digits (region 2, year 2, serial 6, check and issue 2),
// split by hyphens, spaces or nothing. The region code must be a real one (11-26, 28). The check
// digit algorithm is not public, so the confidence is 0.85.
// Source: the Microsoft Purview definition of the Korean driver's licence number entity.

import type { Detection } from './overlaps'
import { Re } from './regex'

const REGION = '(?:1[1-9]|2[0-6]|28)'

// A digit or hyphen on either side makes it part of a longer number (card, account).
const DL_RE = new Re('(?<![\\d-])' + REGION + '[- ]?\\d{2}[- ]?\\d{6}[- ]?\\d{2}(?![\\d-])')

// The old form led by a region name (#594, "경기 98-800924-64"): until 2014-06-01 licences
// printed the region's short name. Only the fifteen names in use at the switch are taken.
// Source: 도로교통공단 "운전면허번호 지역표기 변경 안내" (from 2014-06-01).
const REGION_NAMES = ['서울', '부산', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주', '대구', '인천', '대전', '울산']

// After the name comes "YY-NNNNNN-NN" with fixed hyphens: a phone number's 3-4-4 groups cannot
// hold six digits in the middle, so they fall away. A name inside a longer word is not a name.
const DL_NAMED_RE = new Re('(?<![가-힣])(?:' + REGION_NAMES.join('|') + ')(?![가-힣])[ ]{0,2}\\d{2}-\\d{6}-\\d{2}(?!\\d)')

export function detectDriverLicense(text: string): Detection[] {
  const found = [...DL_RE.finditer(text), ...DL_NAMED_RE.finditer(text)].map(m => ({
    kind: 'driver_license',
    start: m.index,
    end: m.index + m[0].length,
    text: m[0],
    confidence: 0.85,
  }))
  return found.sort((a, b) => a.start - b.start)
}
