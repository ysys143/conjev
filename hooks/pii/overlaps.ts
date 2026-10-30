// SPDX-FileCopyrightText: 2026 The maskingtape Authors
// SPDX-License-Identifier: Apache-2.0
// Translated to TypeScript from maskingtape at commit 2802949 (types.py, overlaps.py), with modifications.

/**
 * One piece of personal information found in the text.
 * start and end are slice positions in the text the detector was given; text is that slice.
 */
export type Detection = {
  kind: string
  start: number
  end: number
  text: string
  confidence: number
}

/**
 * Overlapping detections are merged, never dropped: covering less is a leak, covering more
 * is the safe failure. The union is covered and the kind follows the higher confidence.
 * Dropping overlaps once let an address swallow the front of a following resident number and
 * hide the number (confidence 1.0), so its back half was left showing.
 */
export function resolveOverlaps(detections: readonly Detection[], text: string): Detection[] {
  const ordered = [...detections].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || b.confidence - a.confidence)
  const result: Detection[] = []
  for (const d of ordered) {
    const previous = result.at(-1)
    if (previous === undefined || d.start >= previous.end) {
      result.push(d)
      continue
    }
    if (d.end <= previous.end) {
      // Contained: keep the wider span, and report the more confident kind so a resident
      // number inside an address is reported as one (#172).
      if (d.confidence > previous.confidence) result[result.length - 1] = { ...previous, kind: d.kind, confidence: d.confidence }
      continue
    }
    // Partly overlapping: the union, with the kind of the more confident one
    const winner = d.confidence > previous.confidence ? d : previous
    result[result.length - 1] = { ...winner, start: previous.start, end: d.end, text: text.slice(previous.start, d.end) }
  }
  return result
}
