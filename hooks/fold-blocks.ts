// Fold with kept blocks: at a compaction, the largest results the fold takes
// out are split into blocks, and Jev judges which blocks the current request
// still needs. Active keeps those blocks verbatim under the pointer; shadow
// records what it would have kept. The original stays in the archive either
// way, so a block judged wrongly is one read_coordinate away.
import type { EngineInterface, SessionMessage } from 'claude-code'
import { parseText } from './blocks'
import type { Archived } from './fold'
import { currentRequest } from './fold-judge'
import { keyFor } from './jev-call'
import { DEFAULT_RELEVANCE, selectRelevant, type Relevance } from './relevance'
import { REQUEST_CHARS, clip, scrub } from './scrub'
import { newId, runtime, settingsOf } from './state'
import { showStatus } from './status'
import type { ShadowRecord } from './report'
import { homeOf, writeRecord } from './storage'
import { jevAsker } from './web-flow'

export const FOLD_BLOCKS_POINT = 'fold-blocks'

export const KEPT_MARK = '[kept from the original, verbatim; the rest is in read_coordinate]'

/** Kept blocks are worth their room only when they are well under the original. */
export function isWorthKeeping(rel: Relevance, originalChars: number): boolean {
  return rel.status === 'filtered' && rel.text.length <= originalChars * 0.5
}

/** The pointer, then the blocks kept. It still starts with the fold mark, so a later fold leaves it. */
export function keptResult(pointer: string, kept: string): string {
  return `${pointer}\n${KEPT_MARK}\n${kept}`
}

/**
 * Judges the largest of `archived` against the person's last prompt, all at
 * once, for at most the budget. A judgment still running then is dropped.
 */
export async function judgeBlocks($: EngineInterface, messages: readonly SessionMessage[], archived: readonly Archived[], mode: 'shadow' | 'active'): Promise<Map<string, Relevance>> {
  const settings = settingsOf()
  const decided = new Map<string, Relevance>()
  const key = await keyFor($)
  const request = currentRequest(messages)
  const home = await homeOf($)
  if (key === undefined || request === undefined || home === undefined) return decided
  const sessionId = await $.session.id()
  // Scrubbed first, then bounded: a cut before the scrub could leave part
  // of a value the scrub would have replaced.
  const query = clip(scrub(request, home), REQUEST_CHARS)
  const chosen = [...archived].filter(item => !item.isError).sort((a, b) => b.text.length - a.text.length).slice(0, settings.foldBlocksResults)
  const ask = jevAsker($, { sessionId, point: FOLD_BLOCKS_POINT, cap: settings.foldBlocksCap }, key.key, settings.webTimeoutMs)
  // Past the budget, or with the setting turned off, no further request goes out.
  let isOver = false
  const isStopped = (): boolean => isOver || settingsOf().foldBlocks === 'off'

  const one = async (item: Archived): Promise<void> => {
    const t0 = await $.clock.now()
    const rel = await selectRelevant(parseText(item.text), query, ask, text => scrub(text, home), DEFAULT_RELEVANCE, isStopped)
    // A judgment that ends after the compaction went ahead changed nothing.
    const isLate = isOver
    if (!isLate) decided.set(item.id, rel)
    runtime.counts.foldBlocks++
    await writeRecord($, {
      id: newId(t0),
      ts: new Date(t0).toISOString(),
      sessionId,
      joinKey: item.id,
      point: FOLD_BLOCKS_POINT,
      mode,
      // The result's text went to Jev, scrubbed; records keep only how much of it.
      sent: { current_request: scrub(query, home), blocks: rel.blocksTotal, resultChars: item.text.length },
      usage: { input_tokens: rel.inputTokens, output_tokens: 0 },
      error: rel.error as ShadowRecord['error'],
      jevMs: (await $.clock.now()) - t0,
      hookMs: 0,
      decision: isLate ? 'late' : !isWorthKeeping(rel, item.text.length) ? 'pointer' : mode === 'active' ? 'keep' : 'would-keep',
      facts: {
        tool: item.tool,
        status: rel.status,
        docTokens: String(rel.docTokens),
        outTokens: String(rel.outTokens),
        blocksTotal: String(rel.blocksTotal),
        blocksKept: String(rel.blocksKept),
        requests: String(rel.requests),
        failed: String(rel.failed),
      },
    }).catch(() => undefined)
  }

  const all = Promise.all(chosen.map(item => one(item).catch(() => undefined)))
  // Active holds the compaction, so it waits only so long; shadow holds nothing.
  if (mode === 'active') await Promise.race([all, $.clock.sleep(settings.foldBlocksBudgetMs)])
  else await all
  isOver = true
  showStatus($)

  return new Map(decided)
}

/** The folded transcript with kept blocks under the pointers they belong to, and the characters added. */
export function withKeptBlocks(messages: readonly SessionMessage[], archived: readonly Archived[], decided: ReadonlyMap<string, Relevance>): { messages: SessionMessage[]; addedChars: number } {
  const sizes = new Map(archived.map(item => [item.id, item.text.length]))
  let addedChars = 0
  const out = messages.map((message): SessionMessage => {
    const results = message.toolResults ?? []
    let isChanged = false
    const next = results.map(result => {
      const rel = decided.get(result.tool_use_id)
      const size = sizes.get(result.tool_use_id)
      if (rel === undefined || size === undefined || !isWorthKeeping(rel, size)) return result
      isChanged = true
      const text = keptResult(result.text, rel.text)
      addedChars += text.length - result.text.length

      return { ...result, text }
    })

    return isChanged ? { ...message, toolResults: next } : message
  })

  return { messages: out, addedChars }
}
