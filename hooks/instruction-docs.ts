// The instruction files Claude Code loads (CLAUDE.md, AGENTS.md and their
// imports), as chunks: what is byte-for-byte loaded twice, and what Jev would
// keep, defer or drop. Only the byte-for-byte part ever changes what loads.
import type { JevQuestion } from './jev'
import { shortHash } from './tool-gate'

export const FILTER_POINT = 'instr-filter'
export const DEFER_POINT = 'instr-defer'
export const TOOL_USE_POINT = 'instr-tool'

export type DocKind = 'managed' | 'user' | 'project' | 'local' | 'memory'
export type DocFile = { path: string; kind: DocKind; content: string; parent?: string }

export type Chunk = {
  /** ASCII, stable while the file, the heading path and the text stay the same. */
  id: string
  file: string
  kind: DocKind
  /** Headings from the outermost down, a tag block as `<name>`. */
  headingPath: string[]
  /** Offsets into the file's content. */
  start: number
  end: number
  text: string
  /** A heading with nothing under it, or only `@` imports: never dropped or judged. */
  isTrivial: boolean
}

// Files this plugin may change: never the organization's, never the auto-memory index.
const CHANGEABLE: ReadonlySet<DocKind> = new Set(['user', 'project', 'local'])
const LONG_SECTION = 800

const HEADING = /^(#{1,6})\s+\S/
const FENCE = /^\s*(```|~~~)/
const TAG_OPEN = /^<([a-z][a-z0-9_-]*)>\s*$/
const TOP_BULLET = /^(?:[-*+]|\d+\.)\s/

export const normalized = (text: string): string => text.replace(/\s+/g, ' ').trim()

function isTrivialText(text: string): boolean {
  const body = text
    .split('\n')
    .filter(line => !HEADING.test(line) && !/^\s*@\S+\s*$/.test(line))
    .join(' ')
    .replace(/\s+/g, '')

  return body.length < 20
}

type Section = { headingPath: string[]; start: number; end: number; isTag: boolean }

/** Sections split at headings and at tag blocks whose tags each sit alone on a line, never inside a code fence. */
function sectionsOf(content: string): Section[] {
  const lines = content.split('\n')
  const offsets: number[] = []
  let at = 0
  for (const line of lines) {
    offsets.push(at)
    at += line.length + 1
  }

  const sections: Section[] = []
  const stack: { level: number; title: string }[] = []
  let current: Section = { headingPath: ['(preamble)'], start: 0, end: 0, isTag: false }
  let isFenced = false

  const close = (end: number): void => {
    current.end = end
    if (content.slice(current.start, current.end).trim() !== '') sections.push(current)
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (FENCE.test(line)) isFenced = !isFenced
    if (isFenced) continue

    const heading = HEADING.exec(line)
    if (heading) {
      close(offsets[i]!)
      const level = heading[1]!.length
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop()
      stack.push({ level, title: line.trim() })
      current = { headingPath: stack.map(s => s.title), start: offsets[i]!, end: 0, isTag: false }
      continue
    }

    const tag = TAG_OPEN.exec(line)
    if (tag) {
      const closing = `</${tag[1]}>`
      let j = i + 1
      while (j < lines.length && lines[j]!.trim() !== closing) j++
      if (j < lines.length) {
        close(offsets[i]!)
        const end = (offsets[j] ?? content.length) + lines[j]!.length + 1
        sections.push({ headingPath: [...stack.map(s => s.title), `<${tag[1]}>`], start: offsets[i]!, end: Math.min(end, content.length), isTag: true })
        current = { headingPath: stack.length > 0 ? stack.map(s => s.title) : ['(preamble)'], start: Math.min(end, content.length), end: 0, isTag: false }
        i = j
      }
    }
  }
  close(content.length)

  return sections
}

/** A long section split into its lead and groups of top-level bullets, each group at most LONG_SECTION characters. */
function piecesOf(content: string, section: Section): { start: number; end: number }[] {
  const text = content.slice(section.start, section.end)
  if (section.isTag || text.length <= LONG_SECTION) return [{ start: section.start, end: section.end }]

  const starts: number[] = [0]
  let at = 0
  let isFenced = false
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) isFenced = !isFenced
    if (!isFenced && at > 0 && TOP_BULLET.test(line)) starts.push(at)
    at += line.length + 1
  }
  const raw = starts.map((s, i) => ({ start: s, end: starts[i + 1] ?? text.length }))

  const merged: { start: number; end: number }[] = []
  for (const piece of raw) {
    const last = merged[merged.length - 1]
    if (last !== undefined && piece.end - last.start <= LONG_SECTION) last.end = piece.end
    else merged.push({ ...piece })
  }

  return merged.map(p => ({ start: section.start + p.start, end: section.start + p.end }))
}

export function chunksOf(files: readonly DocFile[]): Chunk[] {
  const chunks: Chunk[] = []
  for (const file of files) {
    for (const section of sectionsOf(file.content)) {
      const pieces = piecesOf(file.content, section)
      pieces.forEach((piece, n) => {
        const text = file.content.slice(piece.start, piece.end)
        if (text.trim() === '') return
        const headingPath = pieces.length > 1 ? [...section.headingPath.slice(0, -1), `${section.headingPath.at(-1)} (${n + 1}/${pieces.length})`] : section.headingPath
        chunks.push({
          id: `doc-${shortHash(`${file.path}\n${headingPath.join(' > ')}\n${normalized(text)}`)}`,
          file: file.path,
          kind: file.kind,
          headingPath,
          start: piece.start,
          end: piece.end,
          text,
          isTrivial: isTrivialText(text),
        })
      })
    }
  }

  return chunks
}

/** Chunks loaded twice, byte for byte once whitespace is set aside: each later copy and the earlier one it repeats. */
export function exactDuplicates(chunks: readonly Chunk[]): Map<string, Chunk> {
  const first = new Map<string, Chunk>()
  const drops = new Map<string, Chunk>()
  for (const chunk of chunks) {
    if (chunk.isTrivial) continue
    const key = normalized(chunk.text)
    const kept = first.get(key)
    if (kept === undefined) first.set(key, chunk)
    else if (CHANGEABLE.has(chunk.kind)) drops.set(chunk.id, kept)
  }

  return drops
}

const OMC_HEADING = /^# oh-my-claudecode\b/

export const isOmcChunk = (chunk: Chunk): boolean => OMC_HEADING.test(chunk.headingPath[0] ?? '')

/** The `OMC:VERSION:x.y.z` a file on disk declares; comments are stripped from what the engine hands over. */
export function omcVersionOf(diskText: string): string | undefined {
  return /OMC:VERSION:(\d+(?:\.\d+)*)/.exec(diskText)?.[1]
}

const compareVersions = (a: string, b: string): number => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }

  return 0
}

/**
 * When two files carry the OMC block at different versions, every OMC chunk
 * of the older copy, paired with a chunk of the newest copy that stays.
 */
export function supersededOmc(chunks: readonly Chunk[], versions: ReadonlyMap<string, string>): Map<string, Chunk> {
  const omc = chunks.filter(isOmcChunk)
  const files = [...new Set(omc.map(c => c.file))].filter(f => versions.has(f))
  if (files.length < 2) return new Map()
  const newest = files.reduce((best, f) => (compareVersions(versions.get(f)!, versions.get(best)!) > 0 ? f : best))
  const keeper = omc.find(c => c.file === newest)
  const drops = new Map<string, Chunk>()
  if (keeper === undefined) return drops
  for (const chunk of omc) {
    if (chunk.file !== newest && CHANGEABLE.has(chunk.kind) && compareVersions(versions.get(chunk.file) ?? '0', versions.get(newest)!) < 0) drops.set(chunk.id, keeper)
  }

  return drops
}

const label = (chunk: Chunk): string => chunk.headingPath.at(-1) ?? '(preamble)'

const tilde = (path: string, home: string | undefined): string => (home !== undefined && path.startsWith(home) ? `~${path.slice(home.length)}` : path)

/**
 * The files with the dropped chunks left out. Each run of dropped chunks
 * leaves one line saying what went and where it is kept, so the model knows.
 */
export function withoutChunks<F extends DocFile>(files: readonly F[], chunks: readonly Chunk[], drops: ReadonlyMap<string, Chunk>, home?: string): F[] {
  return files.map(file => {
    const dropped = chunks.filter(c => c.file === file.path && drops.has(c.id)).sort((a, b) => a.start - b.start)
    if (dropped.length === 0 || !CHANGEABLE.has(file.kind)) return file

    const runs: Chunk[][] = []
    for (const chunk of dropped) {
      const run = runs[runs.length - 1]
      const last = run?.[run.length - 1]
      if (run !== undefined && last !== undefined && file.content.slice(last.end, chunk.start).trim() === '') run.push(chunk)
      else runs.push([chunk])
    }

    let out = ''
    let at = 0
    for (const run of runs) {
      const keptIn = [...new Set(run.map(c => tilde(drops.get(c.id)!.file, home)))].join(', ')
      const names = run.slice(0, 3).map(c => `"${label(c).replace(/^#+\s*/, '')}"`)
      const more = run.length > 3 ? ` and ${run.length - 3} more` : ''
      out += file.content.slice(at, run[0]!.start)
      out += `[conjev: left out ${names.join(', ')}${more}, loaded from ${keptIn}]\n\n`
      at = run[run.length - 1]!.end
    }
    out += file.content.slice(at)

    return { ...file, content: out }
  })
}

// Rules that stay in view whatever Jev says: who the person is, the language,
// what needs approval, how questions are answered, and the rules a single
// action can break for good (shell, git, keys, browser). Also anything its
// author marked as deliberate repetition, and the OMC block, which OMC owns.
const ALWAYS_KEPT: readonly RegExp[] = [
  /정체성|identity/i,
  /언어|language/i,
  /자율 실행|승인|autonom|approv/i,
  /질문에는 먼저|answer.*question/i,
  /셸|shell/i,
  /\bgit\b/i,
  /api 키|api key|credential|secret|키 값/i,
  /브라우저|browser/i,
  /중복|강조/,
  /^# oh-my-claudecode\b/,
]

export function isAlwaysKept(chunk: Chunk): boolean {
  return chunk.headingPath.some(h => ALWAYS_KEPT.some(p => p.test(h)))
}

const ORCA = /orca/i

export type WouldApply = { decision: 'drop' | 'defer' | 'keep'; reason: string }

/** What the plugin would do with a chunk given Jev's probabilities; recorded, not applied. */
export function wouldApply(
  chunk: Chunk,
  judged: { covered?: number; conditional?: number },
  context: { inOrca: boolean; threshold: number },
): WouldApply {
  if (chunk.isTrivial) return { decision: 'keep', reason: 'trivial' }
  if (isAlwaysKept(chunk)) return { decision: 'keep', reason: 'always kept' }
  if (chunk.headingPath.some(h => ORCA.test(h))) {
    return context.inOrca ? { decision: 'keep', reason: 'Orca session' } : { decision: 'defer', reason: 'not in an Orca session' }
  }
  if ((judged.conditional ?? 0) >= context.threshold) return { decision: 'defer', reason: `conditional ${judged.conditional!.toFixed(2)}` }
  if ((judged.covered ?? 0) >= context.threshold) {
    // Earlier chunks are of the same tier or a broader one; a project or local
    // rule is never dropped for a user-wide one that says the same.
    return chunk.kind === 'user'
      ? { decision: 'drop', reason: `covered ${judged.covered!.toFixed(2)}` }
      : { decision: 'keep', reason: `covered ${judged.covered!.toFixed(2)}, but ${chunk.kind} tier` }
  }

  return { decision: 'keep', reason: judged.conditional === undefined && judged.covered === undefined ? 'not judged' : 'judged needed' }
}

export const SCOPE_QUESTION_VERSION = 'scope-1'
export const COVER_QUESTION_VERSION = 'cover-1'

/** The chunks as one numbered list, the state both questions are asked against. */
export function numberedState(chunks: readonly Chunk[], scrubbed: (text: string) => string): Record<string, unknown> {
  return {
    instructions: chunks.map((chunk, i) => `#${i + 1} [${chunk.kind}] ${chunk.headingPath.join(' > ')}\n${scrubbed(chunk.text)}`).join('\n\n'),
  }
}

export function scopeQuestion(n: number): JevQuestion {
  return {
    type: 'choice',
    instructions: `Is the instruction in chunk #${n} needed for nearly every request an agent works on, or only for some kinds of work?`,
    criteria: { always: 'Needed for nearly every request.', conditional: 'Needed only for some kinds of work.' },
  }
}

export function coverQuestion(n: number): JevQuestion {
  return {
    type: 'choice',
    instructions: `Is every instruction in chunk #${n} already stated in the chunks numbered below #${n}?`,
    criteria: {
      covered: 'Every instruction in it is already stated in earlier chunks.',
      partly: 'Some of it is stated earlier, some is not.',
      new: 'It states instructions the earlier chunks do not.',
    },
  }
}

/** A rough token count: Hangul and other non-ASCII text cost about one token per character. */
export function tokenEstimate(text: string): number {
  let ascii = 0
  let other = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++
    else other++
  }

  return Math.ceil(ascii / 4 + other)
}

export type Signature = 'browser' | 'web' | 'orca' | 'llm'

/** The kind of work a chunk is about, when a tool use can tell it happened. */
export function signatureOfChunk(chunk: Chunk): Signature | undefined {
  const path = chunk.headingPath.join(' ')
  if (/브라우저|browser/i.test(path)) return 'browser'
  if (/웹 페이지|web page|fetch/i.test(path)) return 'web'
  if (ORCA.test(path)) return 'orca'
  if (/LLM/.test(path)) return 'llm'

  return undefined
}

/** The kind of work a tool call shows, if any. */
export function signatureOfTool(tool: string, input: Readonly<Record<string, unknown>>): Signature | undefined {
  const command = typeof input.command === 'string' ? input.command : ''
  const skill = typeof input.skill === 'string' ? input.skill : ''
  if (/browser|chrome|playwright/i.test(tool) || /agent-browser|ego-browser|\bego\b/.test(command) || /browser/i.test(skill)) return 'browser'
  if (tool === 'WebFetch' || /r\.jina\.ai|\bcurl\s+-?\S*\s*https?:/.test(command)) return 'web'
  if (/(^|[\s;&|])orca\s/.test(command) || /orca/i.test(skill)) return 'orca'
  if (/\bclaude\s+-p\b|\bcodex\s+exec\b/.test(command)) return 'llm'

  return undefined
}
