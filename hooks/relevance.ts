// Which blocks of a document answer a question, asked of Jev in two stages.
// Ported from jevfetch's scoring.py and pipeline.py (a2sys-ai/jevfetch@167fe8f,
// MIT): its questions, criteria and thresholds are kept as they are, so its
// measurements are the reference for this port.
//
// Stage 1 asks one request per window of blocks, one yes/no question per
// block. Stage 2 asks again for each candidate alone, with the text around it.
// A block passes if it answers any part of the query, because agents often
// pass several questions or a list of keywords at once.
import { heading, mergeFragments, plain, render, tokenCount, type Block } from './blocks'
import type { JevQuestion, JevUsage } from './jev'

export const QUESTION =
  '`query` may contain several topics or sub-questions, possibly as a list of keywords. ' +
  'Does {passage} state information that answers at least one of them, such as a value, limit, ' +
  'date, deadline, rule, condition, exception, or behavior?'
export const CRITERIA = {
  true:
    '`passage` states part of the answer to at least one topic or sub-question in `query`, ' +
    'or a condition, exception, price, or scope that qualifies such an answer.',
  false: '`passage` is about something else, or only names a topic from `query` without stating anything about it.',
}
const CONTEXT_NOTE =
  '`context_before` and `context_after` are the neighbouring text on the page. They are shown only to ' +
  'resolve what `passage` refers to; judge the information in `passage` itself.'
const CONTEXT_CHARS = 400
const WINDOW_ITEMS = 120
const ITEM_OVERHEAD_TOKENS = 20

export type RelevanceConfig = {
  candidateThreshold: number
  keepThreshold: number
  neighborThreshold: number
  passthroughTokens: number
  minOutputTokens: number
  windowTokens: number
  concurrency: number
}

export const DEFAULT_RELEVANCE: RelevanceConfig = {
  candidateThreshold: 0.6,
  keepThreshold: 0.8,
  neighborThreshold: 0.6,
  passthroughTokens: 2000,
  minOutputTokens: 300,
  windowTokens: 3000,
  concurrency: 16,
}

/** One Jev request: noul answers by question name, or why it failed. */
export type Ask = (state: Record<string, unknown>, questions: Record<string, JevQuestion>) => Promise<{ answers: Record<string, number>; usage?: JevUsage } | { error: string }>

export type RelevanceStatus = 'filtered' | 'passthrough' | 'no_match' | 'empty' | 'jev_error'

export type Relevance = {
  status: RelevanceStatus
  text: string
  docTokens: number
  outTokens: number
  blocksTotal: number
  blocksKept: number
  requests: number
  failed: number
  inputTokens: number
  /** The last failed request's reason. */
  error?: string
  /** Stopped before every request went out. */
  isStopped: boolean
}

const noul = (instructions: string, criteria: { true: string; false: string }): JevQuestion => ({ type: 'noul', instructions, criteria })

const jevText = (b: Block, prepare: (text: string) => string): string => prepare(b.kind === 'pre' ? b.text : plain(b.text))

export function windows(blocks: readonly Block[], maxTokens: number): Block[][] {
  const out: Block[][] = []
  let cur: Block[] = []
  let n = 0
  for (const b of blocks) {
    const t = tokenCount(b.kind === 'pre' ? b.text : plain(b.text)) + ITEM_OVERHEAD_TOKENS
    if (cur.length && (n + t > maxTokens || cur.length >= WINDOW_ITEMS)) {
      out.push(cur)
      cur = []
      n = 0
    }
    cur.push(b)
    n += t
  }
  if (cur.length) out.push(cur)

  return out
}

export function stage1Questions(win: readonly Block[]): Record<string, JevQuestion> {
  const criteria = { true: CRITERIA.true.replaceAll('`passage`', 'The passage'), false: CRITERIA.false.replaceAll('`passage`', 'The passage') }

  return Object.fromEntries(win.map((b, k) => [`p${b.id}`, noul(QUESTION.replace('{passage}', `passage \`passages[${k}]\` (id p${b.id})`), criteria)]))
}

export const STAGE2_QUESTION: JevQuestion = noul(`${QUESTION.replace('{passage}', '`passage`')} ${CONTEXT_NOTE}`, CRITERIA)

/** Blocks kept: stage 2 above the keep line, their close neighbours, the first block, then the best until the body is long enough. */
export function chooseBlocks(blocks: readonly Block[], stage1: ReadonlyMap<number, number>, stage2: ReadonlyMap<number, number>, cfg: RelevanceConfig): Set<number> {
  const byId = new Map(blocks.map(b => [b.id, b]))
  const keep = new Set([...stage2].filter(([, v]) => v >= cfg.keepThreshold).map(([i]) => i))
  for (const i of [...keep]) {
    for (const j of [i - 1, i + 1]) {
      const near = byId.get(j)
      if (near !== undefined && heading(near) === heading(byId.get(i)!) && (stage2.get(j) ?? 0) >= cfg.neighborThreshold) keep.add(j)
    }
  }
  const first = blocks[0]?.id
  if (first !== undefined) keep.add(first)
  const byScore = (scores: ReadonlyMap<number, number>, ids: number[]): number[] => ids.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
  const ranked = [...byScore(stage2, [...stage2.keys()]), ...byScore(stage1, [...stage1.keys()].filter(i => !stage2.has(i)))]
  let body = [...keep].filter(i => i !== first).reduce((sum, i) => sum + tokenCount(byId.get(i)!.text), 0)
  for (const i of ranked) {
    if (body >= cfg.minOutputTokens) break
    if (!keep.has(i)) {
      keep.add(i)
      body += tokenCount(byId.get(i)!.text)
    }
  }

  return keep
}

/** Runs `tasks` with at most `limit` at once; once `isStopped` holds, no further task starts. */
async function pool<T>(tasks: readonly (() => Promise<T>)[], limit: number, isStopped: () => boolean): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < tasks.length && !isStopped()) {
      const i = next++
      results[i] = await tasks[i]!()
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker))

  return results
}

/**
 * The blocks of `parsed` relevant to `query`. `prepare` is applied to every
 * text that leaves for Jev (scrubbing); the kept blocks are returned as they
 * were. A request that fails leaves its blocks unscored; when every request
 * fails the status is `jev_error`. Once `isStopped` holds, no request goes
 * out, and the judgment ends with what it has.
 */
export async function selectRelevant(
  parsed: readonly Block[],
  query: string,
  ask: Ask,
  prepare: (text: string) => string,
  cfg: RelevanceConfig = DEFAULT_RELEVANCE,
  isStopped: () => boolean = () => false,
): Promise<Relevance> {
  const whole = render(parsed)
  const docTokens = tokenCount(whole)
  const base = { docTokens, requests: 0, failed: 0, inputTokens: 0, isStopped: false }
  if (parsed.length === 0) return { ...base, status: 'empty', text: '', outTokens: 0, blocksTotal: 0, blocksKept: 0 }
  if (docTokens <= cfg.passthroughTokens) return { ...base, status: 'passthrough', text: whole, outTokens: docTokens, blocksTotal: parsed.length, blocksKept: parsed.length }

  const blocks = mergeFragments(parsed)
  const q = prepare(query)
  const stats: { requests: number; failed: number; inputTokens: number; error?: string } = { requests: 0, failed: 0, inputTokens: 0 }
  const at = new Map(blocks.map((b, i) => [b.id, i]))
  const call = async (state: Record<string, unknown>, questions: Record<string, JevQuestion>): Promise<Record<string, number> | undefined> => {
    if (isStopped()) return undefined
    stats.requests++
    const answer = await ask(state, questions)
    if ('error' in answer) {
      stats.failed++
      stats.error = answer.error
      return undefined
    }
    stats.inputTokens += answer.usage?.input_tokens ?? 0

    return answer.answers
  }
  const stage1 = new Map<number, number>()
  const stage2 = new Map<number, number>()
  const rescore = (b: Block): (() => Promise<void>) => async () => {
    const i = at.get(b.id)!
    const before = i > 0 ? jevText(blocks[i - 1]!, prepare).slice(-CONTEXT_CHARS) : ''
    const after = i + 1 < blocks.length ? jevText(blocks[i + 1]!, prepare).slice(0, CONTEXT_CHARS) : ''
    const answer = await call({ query: q, section: prepare(heading(b)), passage: jevText(b, prepare), context_before: before, context_after: after }, { rel: STAGE2_QUESTION })
    const v = answer?.rel
    if (v !== undefined) stage2.set(b.id, v)
  }
  // A window's candidates go to stage 2 as soon as that window is scored.
  const windowTask = (win: Block[]): (() => Promise<void>) => async () => {
    const passages = win.map(b => ({ id: `p${b.id}`, section: prepare(heading(b)), text: jevText(b, prepare) }))
    const answer = await call({ query: q, passages }, stage1Questions(win))
    if (answer === undefined) return
    for (const b of win) {
      const v = answer[`p${b.id}`]
      if (v !== undefined) stage1.set(b.id, v)
    }
    const candidates = win.filter(b => (stage1.get(b.id) ?? 0) >= cfg.candidateThreshold)
    await pool(candidates.map(rescore), cfg.concurrency, isStopped)
  }
  await pool(windows(blocks, cfg.windowTokens).map(windowTask), cfg.concurrency, isStopped)

  const done = { ...base, ...stats, blocksTotal: blocks.length, isStopped: isStopped() }
  if (stats.requests > 0 && stats.failed === stats.requests) return { ...done, status: 'jev_error', text: render(blocks, new Set([blocks[0]!.id])), outTokens: 0, blocksKept: 1 }
  const keep = chooseBlocks(blocks, stage1, stage2, cfg)
  // A kept table row goes out with its table's header row.
  const tables = new Set(blocks.filter(b => keep.has(b.id) && b.table).map(b => b.table))
  for (const b of blocks) if (b.head && tables.has(b.table)) keep.add(b.id)
  const text = render(blocks, keep)
  const status: RelevanceStatus = [...stage2.values()].some(v => v >= cfg.keepThreshold) ? 'filtered' : 'no_match'

  return { ...done, status, text, outTokens: tokenCount(text), blocksKept: keep.size }
}
