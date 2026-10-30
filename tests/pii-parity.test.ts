// The TypeScript port of maskingtape against the Python original: every row
// of the golden set must give the same detections and the same masked text.
import { expect, test } from 'claude-code/testing'
import { anonymize } from '../hooks/pii/pipeline'
import { GOLDEN } from './pii-golden'

test('the port matches maskingtape 2802949 on all 2,614 golden rows', () => {
  const mismatched: string[] = []
  for (const [id, text, detections, masked] of GOLDEN) {
    const got = anonymize(text, 'mask')
    const spans = got.detections.map(d => `${d.kind}@${d.start}-${d.end}`).sort()
    const want = detections.map(([kind, start, end]) => `${kind}@${start}-${end}`).sort()
    if (got.text !== masked || spans.join() !== want.join()) mismatched.push(id)
  }
  expect(GOLDEN.length).toBe(2614)
  expect(mismatched).toEqual([])
})
