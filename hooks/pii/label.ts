// SPDX-FileCopyrightText: 2026 The maskingtape Authors
// SPDX-License-Identifier: Apache-2.0
// Translated to TypeScript from maskingtape 0.4.0 (anonymizers/label.py), with modifications.

// The label strategy: each span becomes its kind's label, so what was there stays known, which
// suits text going to a language model. "연락처 010-1234-5678" -> "연락처 [전화번호]".
// numbered gives each distinct value a number ([전화번호1], [전화번호2]); the same value keeps one.

import { resolveOverlaps, type Detection } from './overlaps'
import type { CodePoints } from './pipeline'

export const DEFAULT_LABELS: Readonly<Record<string, string>> = {
  rrn: '주민등록번호',
  phone: '전화번호',
  email: '이메일',
  name: '이름',
  address: '주소',
  card: '카드번호',
  account: '계좌번호',
  biz_reg: '사업자등록번호',
  passport: '여권번호',
  birth_date: '생년월일',
  driver_license: '운전면허',
}

/**
 * Replaces each span with [label]. A kind without a label uses its own name. Numbers count per
 * kind in order of appearance. Overlaps are merged first: replaced as they are, positions shift
 * and some of the original stays (#494).
 */
export function label(text: CodePoints, detections: readonly Detection[], labels: Readonly<Record<string, string>> = {}, numbered = false): string {
  const names = { ...DEFAULT_LABELS, ...labels }
  const resolved = resolveOverlaps(detections, text.p).sort((a, b) => a.start - b.start)
  const numbers = new Map<string, number>()
  const perKind = new Map<string, number>()
  if (numbered) {
    for (const d of resolved) {
      const key = `${d.kind}\u0000${d.text}`
      if (numbers.has(key)) continue
      const n = (perKind.get(d.kind) ?? 0) + 1
      perKind.set(d.kind, n)
      numbers.set(key, n)
    }
  }
  let out = ''
  let last = 0
  for (const d of resolved) {
    const name = names[d.kind] ?? d.kind
    out += text.chars.slice(last, d.start).join('') + `[${numbered ? `${name}${numbers.get(`${d.kind}\u0000${d.text}`)}` : name}]`
    last = d.end
  }
  return out + text.chars.slice(last).join('')
}
