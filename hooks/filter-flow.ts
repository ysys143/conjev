// The instruction filter at work: what the engine is about to load, judged in
// the background, recorded, and measured against the work that follows.
import type { EngineInterface } from 'claude-code'
import { conditionQuestion } from './instructions'
import {
  COVER_QUESTION_VERSION,
  DEFER_POINT,
  FILTER_POINT,
  SCOPE_QUESTION_VERSION,
  TOOL_USE_POINT,
  coverQuestion,
  isAlwaysKept,
  normalized,
  numberedState,
  omcVersionOf,
  scopeQuestion,
  signatureOfChunk,
  signatureOfTool,
  tokenEstimate,
  wouldApply,
  type Chunk,
  type DocFile,
} from './instruction-docs'
import { probabilityOf } from './jev'
import { errorOf, judge, keyFor } from './jev-call'
import { scrub } from './scrub'
import { newId, runtime, settingsOf } from './state'
import { showStatus } from './status'
import { homeOf, writeRecord } from './storage'
import { shortHash } from './tool-gate'

// Jev answers these in the background, so a slower answer is still kept.
const BACKGROUND_TIMEOUT_MS = 15_000
// Below the 32k per-question limit, with room for the question itself.
const MAX_STATE_TOKENS = 28_000
const THRESHOLD = 0.95

/** The OMC version each file declares on disk, where the engine's copy has its comments stripped. */
export async function omcVersionsOf($: EngineInterface, files: readonly DocFile[]): Promise<Map<string, string>> {
  const versions = new Map<string, string>()
  for (const file of files) {
    try {
      if (!(await $.fs.exists(file.path))) continue
      const version = omcVersionOf(await $.fs.read(file.path))
      if (version !== undefined) versions.set(file.path, version)
    } catch {
      // A file that cannot be read keeps no version.
    }
  }

  return versions
}

/** Whether the session runs inside Orca: its variables, or a folder under ~/orca. */
export async function inOrcaOf($: EngineInterface): Promise<boolean> {
  if ((await $.env.get('ORCA_CLI_COMMAND')) !== undefined || (await $.env.get('ORCA_DEV_REPO_ROOT')) !== undefined) return true
  const home = await homeOf($)
  const cwd = await $.session.cwd()

  return home !== undefined && cwd.startsWith(`${home}/orca/`)
}

const tilde = (path: string, home: string | undefined): string => (home !== undefined && path.startsWith(home) ? `~${path.slice(home.length)}` : path)

/** Scrubbing for instruction text: the usual, plus the home folder as Claude Code spells it in project folder names and the account name. */
export function scrubInstruction(text: string, home: string | undefined): string {
  let out = scrub(text, home)
  if (home !== undefined) {
    const dashed = home.replace(/[/.]/g, '-')
    out = out.split(dashed).join('~')
    const user = home.split('/').filter(Boolean).at(-1)
    if (user !== undefined && user.length >= 3) out = out.split(user).join('<user>')
  }

  return out
}

type Judged = { scope: Record<string, number>; covered: Record<string, number> }

/** One record per Jev call: the scrubbed state it carried, kept beside the per-chunk records. */
async function recordSent($: EngineInterface, stateKey: string, question: string, sent: Record<string, unknown>, result: import('./jev').JevResult): Promise<void> {
  const t0 = await $.clock.now()
  await writeRecord($, {
    id: newId(t0),
    ts: new Date(t0).toISOString(),
    sessionId: await $.session.id(),
    joinKey: stateKey,
    point: FILTER_POINT,
    mode: settingsOf().instructionFilter === 'active' ? 'active' : 'shadow',
    sent,
    usage: result.ok ? result.usage : undefined,
    error: errorOf(result),
    jevMs: result.ms,
    hookMs: 0,
    decision: 'sent',
    facts: { batch: question, state: stateKey },
  })
}

/** The key Jev's answers are kept under: the chunks as they stand, and the questions asked. */
export function stateKeyOf(chunks: readonly Chunk[]): string {
  return `ifilter:${SCOPE_QUESTION_VERSION}:${COVER_QUESTION_VERSION}:${shortHash(chunks.map(c => c.id).join(','))}`
}

/**
 * Jev's two readings of every chunk, asked once per set of instruction files
 * and kept in the store: is it needed for nearly every request, and is it
 * already said by the chunks before it. Never waits on the request path.
 */
async function judgeChunks($: EngineInterface, chunks: readonly Chunk[], context: { inOrca: boolean }): Promise<Judged | { error: string }> {
  const key = await keyFor($)
  if (key === undefined) return { error: 'no-key' }
  const home = await homeOf($)
  const sessionId = await $.session.id()
  const settings = settingsOf()
  const scrubbed = (text: string): string => scrubInstruction(text, home)

  const judgeable = (chunk: Chunk): boolean => !chunk.isTrivial && !isAlwaysKept(chunk) && !/orca/i.test(chunk.headingPath.join(' '))

  // First: which chunks are needed only for some work.
  const scopeState = numberedState(chunks, scrubbed)
  if (tokenEstimate(String(scopeState.instructions)) > MAX_STATE_TOKENS) return { error: 'too-large' }
  const scopeAsked = chunks.map((chunk, i) => ({ chunk, n: i + 1 })).filter(({ chunk }) => judgeable(chunk))
  const scope: Record<string, number> = {}
  if (scopeAsked.length > 0) {
    const questions = Object.fromEntries(scopeAsked.map(({ n }) => [`s${n}`, scopeQuestion(n)]))
    const result = await judge($, { sessionId, point: FILTER_POINT, cap: settings.instructionCap }, key.key, scopeState, questions, BACKGROUND_TIMEOUT_MS)
    await recordSent($, stateKeyOf(chunks), SCOPE_QUESTION_VERSION, scopeState, result)
    if (!result.ok) return { error: errorOf(result) ?? 'failed' }
    for (const { chunk, n } of scopeAsked) {
      const answer = result.answers[`s${n}`]
      const p = answer === undefined ? undefined : probabilityOf(answer, 'conditional')
      if (p !== undefined) scope[chunk.id] = p
    }
  }

  // Then: what is already said, among the chunks that would stay in view.
  const staying = chunks.filter(chunk => wouldApply(chunk, { conditional: scope[chunk.id] }, { inOrca: context.inOrca, threshold: THRESHOLD }).decision !== 'defer')
  const coverState = numberedState(staying, scrubbed)
  const coverAsked = staying.map((chunk, i) => ({ chunk, n: i + 1 })).filter(({ chunk, n }) => n > 1 && chunk.kind === 'user' && judgeable(chunk))
  const covered: Record<string, number> = {}
  if (coverAsked.length > 0) {
    const questions = Object.fromEntries(coverAsked.map(({ n }) => [`c${n}`, coverQuestion(n)]))
    const result = await judge($, { sessionId, point: FILTER_POINT, cap: settings.instructionCap }, key.key, coverState, questions, BACKGROUND_TIMEOUT_MS)
    await recordSent($, stateKeyOf(chunks), COVER_QUESTION_VERSION, coverState, result)
    if (!result.ok) return { error: errorOf(result) ?? 'failed' }
    for (const { chunk, n } of coverAsked) {
      const answer = result.answers[`c${n}`]
      const p = answer === undefined ? undefined : probabilityOf(answer, 'covered')
      if (p !== undefined) covered[chunk.id] = p
    }
  }

  return { scope, covered }
}

/**
 * Records what the filter did and what it would do: one record per chunk.
 * Called after the engine's request has gone; Jev is asked only when the
 * store holds no answer for this set of files.
 */
export async function recordFilter(
  $: EngineInterface,
  chunks: readonly Chunk[],
  drops: ReadonlyMap<string, Chunk>,
  mode: 'shadow' | 'active',
  t0: number,
  hookMs: number,
): Promise<void> {
  const home = await homeOf($)
  const sessionId = await $.session.id()
  const inOrca = await inOrcaOf($)
  const stateKey = stateKeyOf(chunks)
  const usesJev = (await keyFor($)) !== undefined

  let judged: Judged | undefined
  let error: string | undefined
  const stored = await $.store.get(stateKey)
  if (stored !== undefined && typeof stored === 'object') judged = stored as Judged
  else if (usesJev) {
    const fresh = await judgeChunks($, chunks, { inOrca })
    if ('error' in fresh) error = fresh.error
    else {
      judged = fresh
      await $.store.set(stateKey, fresh)
    }
  } else error = 'no-key'

  const deferred: Chunk[] = []
  for (const chunk of chunks) {
    const kept = drops.get(chunk.id)
    const would = kept
      ? { decision: 'drop' as const, reason: `loaded twice; kept in ${tilde(kept.file, home)}` }
      : wouldApply(chunk, { conditional: judged?.scope[chunk.id], covered: judged?.covered[chunk.id] }, { inOrca, threshold: THRESHOLD })
    if (!kept && would.decision === 'defer') deferred.push(chunk)
    await writeRecord($, {
      id: newId(t0),
      ts: new Date(t0).toISOString(),
      sessionId,
      joinKey: chunk.id,
      point: FILTER_POINT,
      mode,
      heuristic: kept !== undefined,
      sent: null,
      jev: judged?.covered[chunk.id] ?? judged?.scope[chunk.id],
      hookMs,
      decision: kept ? (mode === 'active' ? 'drop' : 'would-drop') : `would-${would.decision}`,
      facts: {
        state: stateKey,
        file: tilde(chunk.file, home),
        kind: chunk.kind,
        heading: chunk.headingPath.join(' > '),
        chars: String(normalized(chunk.text).length),
        conditional: judged?.scope[chunk.id]?.toFixed(2) ?? '-',
        covered: judged?.covered[chunk.id]?.toFixed(2) ?? '-',
        reason: would.reason,
        signature: signatureOfChunk(chunk) ?? '-',
        jev: kept ? '-' : (error ?? 'ok'),
      },
    })
  }
  if (runtime.filter !== undefined && runtime.filter.stateKey === stateKey) runtime.filter.deferred = deferred
  showStatus($)
}

/**
 * For the chunks Jev would defer: would this request have attached each one?
 * Asked for every origin, a command by its name and arguments, so the record
 * shows whether deferring would have kept a rule away from the work it
 * governs. Recorded only; nothing is attached.
 */
export async function judgeDeferred($: EngineInterface, text: string, origin: string, joinKey: string | undefined): Promise<void> {
  const deferred = runtime.filter?.deferred ?? []
  if (deferred.length === 0 || text.trim() === '') return
  const key = await keyFor($)
  if (key === undefined) return
  const home = await homeOf($)
  const sessionId = await $.session.id()
  const settings = settingsOf()
  const t0 = await $.clock.now()
  const sent = { request: scrubInstruction(text, home).slice(0, 600) }
  const questions = Object.fromEntries(deferred.map((chunk, i) => [`d${i}`, conditionQuestion(`The request calls for this instruction: ${scrubInstruction(chunk.text, home).slice(0, 1200)}`)]))
  const result = await judge($, { sessionId, point: DEFER_POINT, cap: settings.instructionCap }, key.key, sent, questions, BACKGROUND_TIMEOUT_MS)
  for (const [i, chunk] of deferred.entries()) {
    const answer = result.ok ? result.answers[`d${i}`] : undefined
    const p = answer === undefined ? undefined : probabilityOf(answer, 'applies')
    await writeRecord($, {
      id: newId(t0),
      ts: new Date(t0).toISOString(),
      sessionId,
      joinKey,
      point: DEFER_POINT,
      mode: settings.instructionFilter === 'active' ? 'active' : 'shadow',
      sent,
      jev: p,
      usage: result.ok && i === 0 ? result.usage : undefined,
      error: errorOf(result),
      jevMs: result.ms,
      hookMs: 0,
      decision: p !== undefined && p >= THRESHOLD ? 'would-attach' : 'skip',
      facts: { chunk: chunk.id, heading: chunk.headingPath.join(' > '), signature: signatureOfChunk(chunk) ?? '-', origin },
    })
  }
}

/** A tool use that shows the kind of work a deferred chunk is about. Nothing is sent. */
export async function recordToolUse($: EngineInterface, tool: string, input: Readonly<Record<string, unknown>>, joinKey: string | undefined): Promise<void> {
  const signature = signatureOfTool(tool, input)
  if (signature === undefined) return
  const t0 = await $.clock.now()
  await writeRecord($, {
    id: newId(t0),
    ts: new Date(t0).toISOString(),
    sessionId: await $.session.id(),
    joinKey,
    point: TOOL_USE_POINT,
    mode: settingsOf().instructionFilter === 'active' ? 'active' : 'shadow',
    sent: null,
    hookMs: 0,
    facts: { signature, tool },
  })
}
