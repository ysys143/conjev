// SPDX-FileCopyrightText: 2026 The maskingtape Authors
// SPDX-License-Identifier: Apache-2.0
// Translated to TypeScript from maskingtape at commit 2802949 (anonymizers/mask.py), with modifications.

// The mask strategy: each span becomes as many mask characters as it has characters.

import { normalize } from './normalize'
import { resolveOverlaps, type Detection } from './overlaps'
import type { CodePoints } from './pipeline'

/**
 * Masks each span, keeping its first keepHead characters but never more than half, so a short
 * value (a two-syllable name) is never shown whole (#169). Overlaps are merged first: keeping a
 * head per span would show the head of a later one (#520).
 */
export function mask(text: CodePoints, detections: readonly Detection[], maskChar = '*', keepHead = 0): string {
  const resolved = resolveOverlaps(detections, text.p).sort((a, b) => a.start - b.start)
  let out = ''
  let last = 0
  for (const d of resolved) {
    const keep = keptLength(text.p.slice(d.start, d.end), keepHead)
    out += text.chars.slice(last, d.start + keep).join('') + maskChar.repeat(d.end - d.start - keep)
    last = d.end
  }
  return out + text.chars.slice(last).join('')
}

/**
 * How many characters to keep at the span's start. At least half is always masked, counted in
 * the tidy's character clusters (#490): a zero-width space or decomposed jamo add code points.
 */
function keptLength(segment: string, keepHead: number): number {
  if (keepHead <= 0) return 0
  const prepared = normalize(segment)
  if (prepared.starts === undefined) return Math.min(keepHead, Math.floor(segment.length / 2))
  const units = [...new Set(prepared.starts)].sort((a, b) => a - b) // where each cluster starts
  const count = Math.min(keepHead, Math.floor(units.length / 2))
  if (count === 0) return 0
  return count < units.length ? units[count]! : segment.length
}
