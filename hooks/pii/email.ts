// SPDX-FileCopyrightText: 2026 The maskingtape Authors
// SPDX-License-Identifier: Apache-2.0
// Translated to TypeScript from maskingtape at commit 2802949 (detectors/contact/email.py), with modifications.

// Email addresses. The local part takes Hangul (RFC 6531, #400); the domain stays Latin, or
// "회의@3층" and "가격@10000원" would all be addresses. Known limit: Hangul written right before
// the address is swallowed ("담당자는홍길동@example.com"), which covers more, not less.
// Every repetition is bounded (RFC 5321 limits): unbounded, a long run without "@" took
// quadratic time.

import type { Detection } from './overlaps'
import { Re } from './regex'

const EMAIL_RE = new Re(
  '[A-Za-z0-9._%+\\-가-힣]{1,64}' +
    '@' +
    '(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.){1,8}' + // domain labels, up to 63 characters each
    '[A-Za-z]{2,63}', // top-level domain
)

export function detectEmail(text: string): Detection[] {
  return [...EMAIL_RE.finditer(text)].map(m => ({ kind: 'email', start: m.index, end: m.index + m[0].length, text: m[0], confidence: 1.0 }))
}
