// SPDX-FileCopyrightText: 2026 The maskingtape Authors
// SPDX-License-Identifier: Apache-2.0
// Translated to TypeScript from maskingtape at commit 2802949 (detectors/financial/account.py), with modifications.

// Bank account numbers: no checksum and a different shape per bank (2-4 groups, 10-14 digits),
// so the shape alone would take order and serial numbers. A number counts only with context:
//  - "은행", "뱅크" or an account word ("계좌", "입금", "이체", ...) within 15 characters
//  - a bank name that is no other word ("신한", "농협", "관악신협", "새마을금고", ...) within 15
//    characters (#472)
//  - a bank name that is also an everyday word ("우리", "하나", "국민", ...) right before the
//    number or in parentheses after it (#472)
// Confidence 0.6. Groups split by hyphens are matched by one regex; groups split by spaces or
// dots are found by one linear pass over the digit groups (#474).

import type { Detection } from './overlaps'
import { escape, pyInt, Re } from './regex'

// Two to four hyphenated groups or 10-14 digits run together. A digit, or a letter or digit
// past a hyphen, on either side makes it part of a longer code ("ORD-2000-0816-7063"). A hyphen
// after a Hangul word does not ("입금계좌-110-...", #493). Only the last group may be one digit
// (#472: 새마을금고 9002-1234-5678-1, the old 신협 12345-67-12345-1). The 10-14 count is checked in detect.
const ACCOUNT_RE = new Re('(?<!\\d)(?<![A-Za-z0-9]-)(?:\\d{2,7}(?:-\\d{2,7}){0,2}-\\d{1,7}|\\d{10,14})(?!\\d)(?!-[A-Za-z0-9])')

// Words that make a nearby number an account: they seldom occur inside unrelated words.
const ALL_CUES = ['계좌', '입금', '이체', '예금주', '예금', '출금', '송금', '은행', '뱅크', '통장']

const CUE_WINDOW = 15

// 1) Bank names no other word shares: anywhere in the window, unless a Hangul syllable is right
//    before ("혁신협의회", "특수협약", "갱신한").
const BANK_NAMES_NEARBY = ['신한', '카뱅', '케뱅', 'SC제일']
// 1-1) Local cooperatives named after a place ("안성농협", "관악신협"): also after Hangul, when the
//      word ends right after the name ("영농협동", "건축협회" stay out).
const BANK_NAMES_LOCAL = ['농협', '축협', '수협', '신협']
// 1-2) Long names that fit inside no other word, taken anywhere ("화곡새마을금고에서").
const BANK_NAMES_LONG = ['새마을금고', '산림조합']
// "신" is also the prefix "new", making "신협약", "신한류"...: these syllables after the name rule it out.
const NOT_BANK_AFTER: Record<string, readonly string[]> = {
  신한: ['국', '류', '옥', '일'],
  신협: ['약', '정', '력', '상', '업', '의체'],
}
// The search runs this far past the window so a name at its edge is judged by what follows.
const LOOKAHEAD_SLACK = Math.max(...Object.values(NOT_BANK_AFTER).flatMap(tails => tails.map(t => t.length)))

// 2) Names shared with everyday words: only right before the number (up to four spaces, colons,
//    brackets, slashes, hyphens) or in parentheses after it. #472 measured 4 of 5 false
//    positives otherwise ("우리 가게 주문번호 2026-0925-1234").
const BANK_NAMES_ADJACENT = ['우리', '하나', '국민', '기업', '산업', '씨티', '우체국', '토스', '카카오', '새마을', '부산', '경남', '광주', '전북', '제주', '대구']
const BANK_NAMES_ADJACENT_LATIN = ['KB', 'NH', 'IBK', 'KDB']

/** The names as alternatives, longest first; a name in NOT_BANK_AFTER matches only without those syllables after. */
function alternation(names: readonly string[]): string {
  return [...names]
    .sort((a, b) => b.length - a.length)
    .map(name => escape(name) + (name in NOT_BANK_AFTER ? '(?!' + NOT_BANK_AFTER[name]!.join('|') + ')' : ''))
    .join('|')
}

// Hangul names need no Hangul before ("하나하나"); Latin names no letter or digit ("512KB").
const BANK_NEARBY_RE = new Re(
  '(?<![가-힣])(?:' +
    alternation([...BANK_NAMES_NEARBY, ...BANK_NAMES_LOCAL]) +
    ')' +
    '|(?<=[가-힣])(?:' +
    alternation(BANK_NAMES_LOCAL) +
    ')(?![가-힣])' +
    '|(?:' +
    alternation(BANK_NAMES_LONG) +
    ')',
)
const BANK_ADJACENT = '(?:(?<![가-힣])(?:' + alternation(BANK_NAMES_ADJACENT) + ')' + '|(?<![A-Za-z0-9])(?:' + alternation(BANK_NAMES_ADJACENT_LATIN) + '))'
// Right before: no line break ("하나\n6123-..." is a list line). \Z, not $: $ also matches before a final newline.
const BANK_BEFORE_RE = new Re(BANK_ADJACENT + '[ \\t\\u00a0:：()\\[\\]/-]{0,4}\\Z')
// In parentheses after: "1002-123-456789 (우리)". Not without them ("... 하나 더 주세요").
const BANK_AFTER_RE = new Re('[ \\t\\u00a0]{0,3}[(\\[][ \\t\\u00a0]{0,3}' + BANK_ADJACENT + '[ \\t\\u00a0]{0,3}[)\\]]')
// How far back a name before the number is looked for: the longest name and four characters between
const BANK_BEFORE_REACH = Math.max(...[...BANK_NAMES_ADJACENT, ...BANK_NAMES_ADJACENT_LATIN].map(n => n.length)) + 4

/**
 * Whether a bank name is context for text[start:end] (#472). Only fixed windows are searched;
 * lookbehinds see before pos, so "혁|신협" at the left edge is still ruled out. The right side
 * reads LOOKAHEAD_SLACK further, but the name itself must end inside the window.
 */
function hasBankNameCue(text: string, start: number, end: number): boolean {
  const limit = end + CUE_WINDOW
  for (const m of BANK_NEARBY_RE.finditer(text, Math.max(0, start - CUE_WINDOW), limit + LOOKAHEAD_SLACK)) {
    if (m.index + m[0].length <= limit) return true
  }
  if (BANK_BEFORE_RE.search(text, Math.max(0, start - BANK_BEFORE_REACH), start)) return true
  return BANK_AFTER_RE.match(text, end) !== null
}

/** Whether an account word or a bank name is context for text[start:end]; both notations use it. */
function hasAccountContext(text: string, start: number, end: number): boolean {
  const context = text.slice(Math.max(0, start - CUE_WINDOW), end + CUE_WINDOW)
  return ALL_CUES.some(cue => context.includes(cue)) || hasBankNameCue(text, start, end)
}

// Groups split by spaces or dots (#474), found by one pass over the digit groups that builds
// chains joined by separators: a bounded regex cut accounts off past its bound, an unbounded one
// was quadratic. Separators: 1-3 spaces (space, tab, NBSP, ideographic space), a dot with up
// to two spaces around, a hyphen with spaces around ("110 - 123 - 456789"). Not: line breaks,
// commas (amounts "1,234,567,890원"), a hyphen without spaces (the hyphen regex's share).
const SPACE_CHARS = ' \t' + '\u00a0' + '\u3000'
const FULLWIDTH_DOT = '．'
const WS = '[' + escape(SPACE_CHARS) + ']'
const DOTS = '[.' + FULLWIDTH_DOT + ']'
const SEPARATOR_RE = new Re(WS + '{1,3}|' + WS + '{0,2}' + DOTS + WS + '{0,2}|' + WS + '{1,2}-' + WS + '{1,2}')
const MAX_SEPARATOR_LEN = 5 // the longest separator above; longer gaps are not tried
const DIGIT_GROUP_RE = new Re('\\d+')
const MAX_GROUP_DIGITS = 7 // the most digits in one account group (the 7-digit last group of 카카오뱅크)
const NON_DIGITS = new Re('\\D')

type Kind = 'dash' | 'dot' | 'space'

/** The kind of separator the gap between groups is, or undefined when it is none. */
function separatorKind(gap: string): Kind | undefined {
  if (gap.length > MAX_SEPARATOR_LEN || !SEPARATOR_RE.fullmatch(gap)) return undefined
  if (gap.includes('-')) return 'dash'
  if (gap.includes('.') || gap.includes(FULLWIDTH_DOT)) return 'dot'
  return 'space'
}

/**
 * Whether the window starts with a date (4-2-2 digits reading as year 1900-2099, month, day:
 * "입금 일시 2026 09 28 14 30") or is a dotted IPv4 address ("192.168.100.200").
 */
function looksLikeDateOrIp(text: string, window: readonly (readonly [number, number])[], kind: Kind): boolean {
  const nums = window.map(([s, e]) => text.slice(s, e))
  if (nums.length >= 3 && nums[0]!.length === 4 && nums[1]!.length === 2 && nums[2]!.length === 2) {
    const [year, month, day] = nums.slice(0, 3).map(pyInt) as [number, number, number]
    if (year >= 1900 && year <= 2099 && month >= 1 && month <= 12 && day >= 1 && day <= 31) return true
  }
  return kind === 'dot' && nums.length === 4 && nums.every(n => n.length <= 3 && pyInt(n) <= 255)
}

/**
 * Every window of the chain that can be an account: 2-4 consecutive groups, one separator kind,
 * every group but the last two digits or more, 10-14 digits in all. Dot and spaced-hyphen windows
 * need three groups (two are usually a sentence end or a decimal point). All windows are kept and
 * merged in detect: choosing one left the back of an account showing.
 * kinds[t] is the separator between chain[t] and chain[t + 1].
 */
function chainWindows(text: string, chain: readonly (readonly [number, number])[], kinds: readonly Kind[]): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < chain.length; i++) {
    const minGroups = i + 1 < chain.length && kinds[i] === 'space' ? 2 : 3
    let total = chain[i]![1] - chain[i]![0]
    for (let j = i + 1; j < Math.min(i + 4, chain.length); j++) {
      if (kinds[j - 1] !== kinds[i] || chain[j - 1]![1] - chain[j - 1]![0] < 2) break // the separator changed, or an inner group has one digit
      total += chain[j]![1] - chain[j]![0]
      if (total > 14) break
      const window = chain.slice(i, j + 1)
      if (total >= 10 && window.length >= minGroups && !looksLikeDateOrIp(text, window, kinds[i]!)) out.push([chain[i]![0], chain[j]![1]])
    }
  }
  return out
}

/**
 * Every candidate window split by spaces or dots (#474), as (window start, window end, chain
 * start, chain end): a chain is one line of numbers and shares its context. A chain breaks at a
 * gap that is no separator, at a group over seven digits, and at a group hyphenated to another
 * number (that is the hyphen regex's; joined, a phone number and a business number became one).
 */
function separatedWindows(text: string): [number, number, number, number][] {
  const groups = [...DIGIT_GROUP_RE.finditer(text)].map(m => [m.index, m.index + m[0].length] as const)
  const windows: [number, number, number, number][] = []
  let chain: (readonly [number, number])[] = []
  let kinds: Kind[] = []
  const closeChain = (): void => {
    if (chain.length === 0) return
    const [s0, e0] = [chain[0]![0], chain.at(-1)![1]]
    for (const [s, e] of chainWindows(text, chain, kinds)) windows.push([s, e, s0, e0])
  }

  groups.forEach(([start, end], idx) => {
    const joinedBefore = idx > 0 && groups[idx - 1]![1] === start - 1 && text[start - 1] === '-'
    const joinedAfter = idx + 1 < groups.length && groups[idx + 1]![0] === end + 1 && text[end] === '-'
    if (joinedBefore || joinedAfter || end - start > MAX_GROUP_DIGITS) {
      closeChain()
      chain = []
      kinds = []
      return
    }
    if (chain.length > 0) {
      const kind = separatorKind(text.slice(chain.at(-1)![1], start))
      if (kind === undefined) {
        closeChain()
        chain = []
        kinds = []
      } else {
        kinds.push(kind)
      }
    }
    chain.push([start, end])
  })
  closeChain()
  return windows
}

const detection = (text: string, start: number, end: number): Detection => ({ kind: 'account', start, end, text: text.slice(start, end), confidence: 0.6 })

export function detectAccount(text: string): Detection[] {
  const found: Detection[] = []
  for (const m of ACCOUNT_RE.finditer(text)) {
    const digits = NON_DIGITS.sub(m[0], '')
    if (!(digits.length >= 10 && digits.length <= 14)) continue // outside the account digit range
    if (!hasAccountContext(text, m.index, m.index + m[0].length)) continue // no account word, no bank name
    found.push(detection(text, m.index, m.index + m[0].length))
  }

  // Spaced and dotted forms (#474) are added; the hyphen detection above is untouched. A window
  // needs context around itself or its chain (checked once per chain); overlapping windows merge.
  const chainContext = new Map<string, boolean>()
  const kept: [number, number][] = []
  for (const [start, end, chainStart, chainEnd] of separatedWindows(text)) {
    if (!hasAccountContext(text, start, end)) {
      const chain = `${chainStart}:${chainEnd}`
      if (!chainContext.has(chain)) chainContext.set(chain, hasAccountContext(text, chainStart, chainEnd))
      if (!chainContext.get(chain)) continue
    }
    kept.push([start, end])
  }
  kept.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: [number, number][] = []
  for (const [start, end] of kept) {
    const last = merged.at(-1)
    if (last !== undefined && start < last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  found.push(...merged.map(([start, end]) => detection(text, start, end)))

  return found.sort((a, b) => a.start - b.start)
}
