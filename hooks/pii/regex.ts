// SPDX-FileCopyrightText: 2026 The maskingtape Authors
// SPDX-License-Identifier: Apache-2.0
// Support code for the TypeScript translation of maskingtape 0.4.0 (with modifications):
// Python's re and str behaviour, rebuilt on JavaScript so the detectors read as their originals.

// Python's \s and str.isspace (the same set): JavaScript's \s lacks U+001C..001F and U+0085,
// and has U+FEFF, which Python does not.
export const WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const WS_SET = new RegExp(`^[${WS}]$`, 'u')

// Python's \d: every Unicode Nd digit, as of Unicode 15.1 (Python 3.13). Bun's own \p{Nd}
// is newer and knows more digits, so the runs are written out. Each run is whole sets of 0..9.
const ND_RUNS: readonly (readonly [number, number])[] = (
  '30-39,660-669,6f0-6f9,7c0-7c9,966-96f,9e6-9ef,a66-a6f,ae6-aef,b66-b6f,be6-bef,c66-c6f,ce6-cef,' +
  'd66-d6f,de6-def,e50-e59,ed0-ed9,f20-f29,1040-1049,1090-1099,17e0-17e9,1810-1819,1946-194f,' +
  '19d0-19d9,1a80-1a89,1a90-1a99,1b50-1b59,1bb0-1bb9,1c40-1c49,1c50-1c59,a620-a629,a8d0-a8d9,' +
  'a900-a909,a9d0-a9d9,a9f0-a9f9,aa50-aa59,abf0-abf9,ff10-ff19,104a0-104a9,10d30-10d39,11066-1106f,' +
  '110f0-110f9,11136-1113f,111d0-111d9,112f0-112f9,11450-11459,114d0-114d9,11650-11659,116c0-116c9,' +
  '11730-11739,118e0-118e9,11950-11959,11c50-11c59,11d50-11d59,11da0-11da9,11f50-11f59,16a60-16a69,' +
  '16ac0-16ac9,16b50-16b59,1d7ce-1d7ff,1e140-1e149,1e2f0-1e2f9,1e4f0-1e4f9,1e950-1e959,1fbf0-1fbf9'
)
  .split(',')
  .map(run => {
    const [a, b] = run.split('-').map(hex => parseInt(hex, 16)) as [number, number]
    return [a, b] as const
  })
export const ND = ND_RUNS.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join('')

/** The decimal value of an Nd code point (unicodedata.decimal), or undefined for any other. */
export function digitValue(code: number): number | undefined {
  for (const [a, b] of ND_RUNS) if (code >= a && code <= b) return (code - a) % 10
  return undefined
}

export const isSpace = (char: string): boolean => WS_SET.test(char)

/** str.strip() and str.rstrip() with no argument: Python's whitespace. */
const STRIP = new RegExp(`^[${WS}]+|[${WS}]+$`, 'gu')
const RSTRIP = new RegExp(`[${WS}]+$`, 'u')
export const strip = (text: string): string => text.replace(STRIP, '')
export const rstrip = (text: string): string => text.replace(RSTRIP, '')

/** int() of a run of Nd digits, ASCII or not. */
export function pyInt(digits: string): number {
  let value = 0
  for (const char of digits) value = value * 10 + digitValue(char.codePointAt(0)!)!
  return value
}

/** Whether datetime.date(year, month, day) exists. */
export function isDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
  return day <= days
}

const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g

/** str.splitlines(keepends=True). */
export function splitLines(text: string): string[] {
  const lines: string[] = []
  let start = 0
  for (const m of text.matchAll(LINE_BREAK)) {
    lines.push(text.slice(start, m.index + m[0].length))
    start = m.index + m[0].length
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

/** str.startswith with a tuple of prefixes. */
export const startsWithAny = (text: string, prefixes: readonly string[], pos = 0): boolean => prefixes.some(p => text.startsWith(p, pos))

// Python regex source in, JavaScript (u flag) source out. Only what the detectors use:
// (?P<name>, (?P=name), \d \D \s \S with Python's sets, \Z, Python's $, \U escapes, and
// escapes of plain characters that the u flag refuses.
const SYNTAX = new Set('^$\\.*+?()[]{}|/')

export function py(source: string): string {
  let out = ''
  let inClass = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (c === '\\') {
      const e = source[++i]!
      if (e === 'd') out += inClass ? ND : `[${ND}]`
      else if (e === 's') out += inClass ? WS : `[${WS}]`
      else if (e === 'D' && !inClass) out += `[^${ND}]`
      else if (e === 'S' && !inClass) out += `[^${WS}]`
      else if (e === 'Z' && !inClass) out += '$'
      else if (e === 'U') {
        out += `\\u{${source.slice(i + 1, i + 9)}}`
        i += 8
      } else if (e === '\t') out += '\\t'
      else if ('bBwWA'.includes(e) || (inClass && 'DS'.includes(e))) throw new Error(`untranslated \\${e}`)
      else if (/[0-9A-Za-z]/.test(e) || SYNTAX.has(e) || (inClass && e === '-')) out += `\\${e}`
      else out += e
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      out += c
      continue
    }
    if (c === '[') {
      inClass = true
      out += c
      if (source[i + 1] === '^') out += source[++i]
      continue
    }
    if (source.startsWith('(?P<', i)) {
      out += '(?<'
      i += 3
    } else if (source.startsWith('(?P=', i)) {
      const close = source.indexOf(')', i)
      out += `\\k<${source.slice(i + 4, close)}>`
      i = close
    } else if (source.startsWith('(?(', i)) {
      throw new Error('conditional groups have no JavaScript form')
    } else if (c === '$') {
      // Without MULTILINE, Python's $ also matches before a final newline.
      out += '(?=\\n?$)'
    } else {
      out += c
    }
  }
  return out
}

export type Match = RegExpExecArray

export const start = (m: Match, group?: string): number => (group === undefined ? m.index : m.indices!.groups![group]![0])
export const end = (m: Match, group?: string): number => (group === undefined ? m.index + m[0].length : m.indices!.groups![group]![1])
/** m.span(group) for a group that took part; [-1, -1] otherwise. */
export const span = (m: Match, group: string): [number, number] => {
  const at = m.indices!.groups![group]
  return at === undefined ? [-1, -1] : [at[0], at[1]]
}

/** A compiled pattern with Python's search/match/fullmatch/finditer/sub, positions and all. */
export class Re {
  readonly js: string
  private readonly global: RegExp
  private readonly sticky: RegExp
  private whole?: RegExp

  /** source is Python syntax; flags adds to u ('i' for IGNORECASE); indices keeps group positions. */
  constructor(source: string, options: { flags?: string; indices?: boolean } = {}) {
    this.js = py(source)
    const flags = `u${options.flags ?? ''}${options.indices ? 'd' : ''}`
    this.global = new RegExp(this.js, `g${flags}`)
    this.sticky = new RegExp(this.js, `y${flags}`)
  }

  // Python's endpos hides what follows it: lookaheads and $ see the cut. Lookbehinds still see
  // before pos, as in Python.
  private run(re: RegExp, text: string, pos: number, endpos: number): Match | null {
    const cut = endpos < text.length ? text.slice(0, Math.max(0, endpos)) : text
    if (pos > cut.length) return null
    re.lastIndex = pos
    return re.exec(cut)
  }

  search(text: string, pos = 0, endpos = text.length): Match | null {
    return this.run(this.global, text, pos, endpos)
  }

  match(text: string, pos = 0, endpos = text.length): Match | null {
    return this.run(this.sticky, text, pos, endpos)
  }

  fullmatch(text: string, pos = 0, endpos = text.length): Match | null {
    this.whole ??= new RegExp(`(?:${this.js})$`, this.sticky.flags)
    return this.run(this.whole, text, pos, endpos)
  }

  *finditer(text: string, pos = 0, endpos = text.length): Generator<Match> {
    let at = pos
    for (;;) {
      const m = this.search(text, at, endpos)
      if (m === null) return
      yield m
      at = m[0].length === 0 ? m.index + 1 : m.index + m[0].length
    }
  }

  /** Every match, each search starting one character after the last match began. */
  *searchEveryStart(text: string): Generator<Match> {
    let at = 0
    for (;;) {
      const m = this.search(text, at)
      if (m === null) return
      yield m
      at = m.index + 1
    }
  }

  sub(text: string, replace: string | ((m: Match) => string)): string {
    const fn = typeof replace === 'string' ? () => replace : replace
    let out = ''
    let last = 0
    for (const m of this.finditer(text)) {
      out += text.slice(last, m.index) + fn(m)
      last = m.index + m[0].length
    }
    return out + text.slice(last)
  }
}

/** re.escape: a backslash before each character Python 3.13 escapes. */
export const escape = (text: string): string => text.replace(/[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/g, c => `\\${c}`)
