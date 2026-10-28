import type { EngineInterface, Register } from 'claude-code'
import { DEFAULT_SETTINGS, SETTING_KEYS, dueBeforeFold, dueNote, foldTranscript, makePolicy, messageViewOf, partialCut, pointerMessage, reportFor, settingsFrom, sliceLines, splitForSummary, stillIdle, transcriptChars, type MessageView, type PolicySettings } from './fold'
import { routeBrowser } from './browser-flow'
import { BROWSER_BLOCK, BROWSER_POINT } from './browser-route'
import { FOLD_BLOCKS_POINT, judgeBlocks, withKeptBlocks } from './fold-blocks'
import { parseText } from './blocks'
import { FOLD_POINT, judgedPolicy } from './fold-judge'
import { afterCompaction, anchorsOf, askNeeded, judgeFold, note, since, type Continuity } from './fold-flow'
import { askConditions, attachedNow, forgetAttached, fragmentsDirOf, loadFragments, pendingOf, recordFragments, rememberWouldAttach, wouldAttach } from './fragment-flow'
import { INSTRUCTIONS_POINT, attachedNames, decideFragments, fragmentBlock, keywordHit, pinnedSection } from './instructions'
import { probabilityOf, type JevResult } from './jev'
import { errorOf, judge, keyFor, resolveKey, trustFor } from './jev-call'
import { CONSENT_TEXT, INSTALL_COMMAND_NAME, keyNote, onboardingMessage } from './install-command'
import { blockReport, compactReport, filterReport, pointReport, type ShadowRecord } from './report'
import { chunksOf, exactDuplicates, normalized, supersededOmc, withoutChunks, type DocFile } from './instruction-docs'
import { judgeDeferred, omcVersionsOf, recordFilter, recordToolUse, stateKeyOf } from './filter-flow'
import { clip, scrub } from './scrub'
import { harnessSettingsFrom, usesJev, type HarnessSettings } from './settings'
import { newId, retuneRuntime, runtime, startRuntime } from './state'
import { OFFER_TIMEOUT_MS, boardHasHandoff, boardOfferStep, handoffGap, offerAccepted, repoStateOf, type BoardOffer } from './repostate'
import { imageToRead } from './image-size'
import { SHARED_CONFIG, SHARED_CONSENT, SHARED_KEY, SHARED_ONBOARDING, readShared, sharedDirOf, writeSharedRecord, type Shared } from './shared'
import { DEFAULT_RELEVANCE, omittedRanges, selectRelevant } from './relevance'
import { showStatus } from './status'
import { PARAGRAPH_CHARS, STOP_MESSAGE, STOP_POINT, STOP_QUESTION, announcesByRule, lastParagraph, stopSkipReason } from './stop-gate'
import { cleanupRecords, homeOf, legacyArchiveRoot, readArchived, readRecords, stateRoot, writeArchive, writeLabel, writeRecord } from './storage'
import { judgeTool } from './tool-flow'
import { WEB_POINT, WEB_TOOL_DESCRIPTION, jevAsker, readWeb, shadowWebFetch } from './web-flow'
import {
  TOOL_POINT,
  archivedReason,
  callPaths,
  canWrite,
  denyMessage,
  isUnder,
  normalizePath,
  pathCandidates,
  pathFieldValues,
  restrictedReason,
  secretDumpReason,
  selfProtectReason,
  type FloorVerdict,
} from './tool-gate'

// Folded and still above this share of the window: the engine summarizes the
// folded transcript too.
const SUMMARIZE_ABOVE_SHARE = 0.6
const CHARS_PER_TOKEN = 4
const READ_LIMIT = 400

/** How much of a read_coordinate query goes to Jev; the rest is dropped, not summarized. */
const QUERY_CHARS = 400
// How many idle boundaries a fold waits for the status board and the episode
// log to be brought up to date before it goes ahead anyway.
const MAX_DEFERRALS = 2

// How long the automatic fold waits for the person to type before it takes the
// moment: long enough to read the answer, short enough to run while they are away.
const FOLD_IDLE_MS = 30_000

/** One record per compaction: its trigger, its wait, and what it did or did not save. */
export const COMPACT_POINT = 'compact'

/** Where the offer to create the status board stands, across sessions. */
const OFFER_KEY = 'board-offer'
const OFFER_ASKED_KEY = 'board-offer-asked-at'

/** Where the armed automatic fold records the moment it began waiting. */
export const FOLD_ARMED_KEY = 'fold-armed-at'

const SETTINGS_SCHEMA = {
  type: 'object',
  properties: {
    keepRecentTurns: { type: 'number', description: 'Results from this many most recent turns are never folded' },
    minFoldChars: { type: 'number', description: 'Fold only results of at least this many characters' },
    keepErrorsUnder: { type: 'number', description: 'Keep error results shorter than this many characters' },
    keepTools: { type: 'array', items: { type: 'string' }, description: 'Tools whose results are never folded' },
    foldAtPercent: { type: 'number', description: 'Fold by itself once the context window is this full; 0 is off' },
    minSavedPercent: { type: 'number', description: 'Fold by itself only when it removes at least this share' },
    intentFile: { type: 'string', description: "The agent's reading of the person's intent; empty is none" },
    phaseFile: { type: 'string', description: 'The status board the person reads; empty is none' },
    episodeDir: { type: 'string', description: 'The folder of dated episode logs; empty is none' },
  },
}

/**
 * What the status board's Handoff section should have said about the tree, or
 * undefined when there is nothing to report. A top-level declaration on
 * purpose: a hooks module may pass `$` only to one of these, or to a function
 * it imports from a file of its own.
 */
async function handoffLine($: EngineInterface, phaseFile: string): Promise<string | undefined> {
  const state = await repoStateOf($)
  if (state === undefined) return undefined
  let board: string | undefined
  if (phaseFile !== '' && (await $.fs.exists(phaseFile))) {
    try {
      board = await $.fs.read(phaseFile)
    } catch {
      board = undefined
    }
  }

  return handoffGap(state, boardHasHandoff(board))
}

/**
 * Offers to create the status board when a project has none, and counts three
 * hours of silence as a yes (the person's own instruction). Returns what to
 * tell the model, or undefined when there is nothing to say.
 *
 * The offer is remembered in `$.store`, which outlives a session: a question
 * left open when the process ends is still open when the next one starts, so
 * the three hours keep counting rather than starting over.
 */
async function boardOffer($: EngineInterface, phaseFile: string): Promise<string | undefined> {
  // A board that exists settles the question; so does an empty setting, which
  // says the project does not keep one.
  if (phaseFile === '' || (await $.fs.exists(phaseFile))) return undefined
  const [state, askedRaw] = await Promise.all([$.store.get(OFFER_KEY), $.store.get(OFFER_ASKED_KEY)])
  const askedAt = typeof askedRaw === 'number' ? askedRaw : undefined
  const step = boardOfferStep(state as BoardOffer | undefined, askedAt, await $.clock.now())
  if (step === 'leave' || step === 'wait') return undefined

  if (step === 'accept') {
    await $.store.set(OFFER_KEY, 'accepted')
    await $.store.delete(OFFER_ASKED_KEY)

    return 'The status board was never created, and the offer to make one went unanswered for three hours; that silence counts as a yes. Create PHASE.md now, in the form the context-harness:project-state skill gives, and fill its Handoff section from the repository.'
  }

  // The moment the question went up is written before it is asked, so a
  // session that ends with the dialog still open does not restart the count.
  await $.store.set(OFFER_ASKED_KEY, await $.clock.now())
  // Nobody to ask is not a yes: a `-p` run refuses the dialog, and the offer
  // stays open rather than becoming consent.
  let answer: string
  try {
    answer = await $.ui.ask('This project has no PHASE.md. Create it?', {
      options: ['Create it', 'Not now'],
      header: 'Status board',
    })
  } catch {
    return undefined
  }
  const wanted = offerAccepted(answer)
  await $.store.set(OFFER_KEY, wanted ? 'accepted' : 'declined')
  await $.store.delete(OFFER_ASKED_KEY)

  return wanted
    ? 'The person agreed to a status board. Create PHASE.md now, in the form the context-harness:project-state skill gives, and fill its Handoff section from the repository.'
    : undefined
}

/**
 * The settings as they stand now: the shared folder over this profile's own
 * (`/config`), and every `auto` gate resolved against the key and the recorded
 * consent. Read afresh at session start, when a shared file changes, and when
 * the person places a key or answers /jev-consent.
 */
async function sharedState(
  $: EngineInterface,
  options: Readonly<Record<string, unknown>>,
): Promise<{ gates: HarnessSettings; policy: PolicySettings; shared: Shared; key: { key: string; source: string } | undefined }> {
  const shared = await readShared($, await homeOf($))
  // The shared file wins over /config: one file tunes every profile.
  const merged = { ...options, ...shared.settings }
  const key = shared.key === undefined ? await resolveKey($, merged.apiKey) : { key: shared.key, source: 'shared' }
  const gates = harnessSettingsFrom(merged, { hasKey: key !== undefined, isConsented: shared.consent === true })

  return { gates, policy: settingsFrom(merged), shared, key }
}

export const register: Register = (on, options) => {
  let policySettings = settingsFrom(options)
  let policy = makePolicy(policySettings)
  let settings = harnessSettingsFrom(options)
  startRuntime(settings, policySettings)
  let isOn = usesJev(settings) || settings.toolGate !== 'off'
  // Every hook below reads `settings` and `policy` when it runs, so replacing
  // them here is what a changed shared file or a new consent takes effect by.
  const apply = (next: Awaited<ReturnType<typeof sharedState>>): void => {
    settings = next.gates
    policySettings = next.policy
    policy = makePolicy(policySettings)
    isOn = usesJev(settings) || settings.toolGate !== 'off'
    retuneRuntime(settings, policySettings)
    runtime.key = next.key ?? null
  }
  const { counts } = runtime
  let isFoldScheduled = false
  const state: Continuity = { deferrals: 0, isJustCompacted: false }

  on('session.start', async ($, e, next) => {
    // The shared folder comes first, then whatever this profile's settings say:
    // a person with several profiles tunes one file rather than each of them.
    // Read here rather than at register time, where there is no `$` to read with.
    try {
      apply(await sharedState($, options))
    } catch (error) {
      $.ui.log(`${$.plugin.name}: the shared settings could not be read (${String(error)})`)
    }
    // Each half starts on its own, so one that fails leaves the other working.
    try {
      await $.tool.register({
        name: 'read_coordinate',
        description:
          'Return the original text of a tool result that was folded into a line like ' +
          '[folded Read · src/a.ts · 412 lines — read_coordinate("toolu_…")]. ' +
          'Pass that id. offset (1-based line) and limit (lines, default 400) select a part. ' +
          'Add query instead when you want only the parts that bear on one question: the answer keeps the ' +
          'passages that matter and names the line ranges it left out, so you can read them next. ' +
          'Set full to true for the whole original when query would leave out something you need.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The id inside read_coordinate("…") of the folded line' },
            offset: { type: 'number', description: 'First line to return, 1-based' },
            limit: { type: 'number', description: 'How many lines to return' },
            query: { type: 'string', description: 'What you need from it; keeps only the passages that bear on this' },
            full: { type: 'boolean', description: 'Return the whole original, ignoring query' },
          },
          required: ['id'],
        },
        isDeferred: false,
      })
      await $.tool.register({
        name: 'policy_report',
        description:
          "Measure this session's tool results and what context-harness's fold policy would fold now. " +
          'With no input it reports the current policy; give any policy values to dry-run a candidate beside it. ' +
          'Used by the tune-policy skill.',
        inputSchema: SETTINGS_SCHEMA,
      })
      await $.tool.register({
        name: 'set_policy',
        description:
          "Set context-harness's fold policy values in the person's Claude Code settings, the same as /config. " +
          'Give only the values to change. Call it only after the person agreed to the values.',
        inputSchema: SETTINGS_SCHEMA,
      })
      if (settings.webRead === 'active') {
        await $.tool.register({
          name: 'web_read',
          description: WEB_TOOL_DESCRIPTION,
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'The page to read (http or https)' },
              question: { type: 'string', description: 'What to find on the page: the question, every sub-question, or keywords' },
            },
            required: ['url', 'question'],
          },
          isDeferred: false,
        })
      }
    } catch (error) {
      $.ui.log(`${$.plugin.name}: could not register its tools (${String(error)})`)
    }
    try {
      await $.command.register({ name: 'jev-report', description: 'context-harness: what the gates recorded and how Jev agreed with the rules' })
      await $.command.register({ name: 'jev-mark', description: 'context-harness: label a record, /jev-mark <id> y|n', argumentHint: '<id> y|n' })
      await $.command.register({ name: 'jev-consent', description: 'context-harness: allow or refuse sending to Jev, /jev-consent yes|no|later', argumentHint: 'yes|no|later' })
      // Registered, not only answered: without this call the name never reaches
      // the slash list. `/install` alone is a built-in name and stays the
      // engine's, which is why this one carries the plugin's name.

      if (settings.instructions !== 'off') await loadFragments($)
      if (isOn) {
        await keyFor($)
        showStatus($)
      }
    } catch (error) {
      $.ui.log(`${$.plugin.name}: the judgment layer did not start (${String(error)})`)
    }
    try {
      await cleanupRecords($)
    } catch (error) {
      $.ui.log(`${$.plugin.name}: could not drop old records (${String(error)})`)
    }

    return next(e)
  })

  // The instruction files the engine is about to load: chunks loaded twice
  // leave in active; Jev's reading of the rest is recorded, never applied.
  on('prompt.context', async ($, e, next) => {
    const mode = settings.instructionFilter
    const files = e.instructionFiles
    if (mode === 'off' || files === undefined) return next(e)
    const t0 = await $.clock.now()
    const docs = files.filter(file => file.kind !== 'memory') as unknown as DocFile[]
    const chunks = chunksOf(docs)
    const drops = new Map([...exactDuplicates(chunks), ...supersededOmc(chunks, await omcVersionsOf($, docs))])
    const droppedChars = chunks.filter(c => drops.has(c.id)).reduce((sum, c) => sum + normalized(c.text).length, 0)
    runtime.filter = { stateKey: stateKeyOf(chunks), chunks, drops, droppedChars, deferred: runtime.filter?.deferred ?? [] }
    const passed = mode === 'active' && drops.size > 0 ? withoutChunks(files as unknown as DocFile[], chunks, drops, await homeOf($)) : undefined
    const hookMs = (await $.clock.now()) - t0
    // Judged and recorded after the request has gone.
    void recordFilter($, chunks, drops, mode, t0, hookMs).catch(() => undefined)
    if (passed !== undefined) $.ui.toast(`context-harness: left out ${drops.size} instruction chunks loaded twice (${droppedChars} chars)`)
    showStatus($)

    return passed === undefined ? next(e) : next({ ...e, instructionFiles: passed as unknown as typeof files })
  }).catch((_, e, next) => next(e))

  // E1, pinned fragments: one stable section at the end of the system prompt.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (settings.instructions !== 'active') return composed
    const text = pinnedSection((await loadFragments($)).list)
    if (text === undefined) return composed

    return { ...composed, sections: [...composed.sections, { id: 'context-harness:pinned', text, scope: 'session' as const }] }
  }).catch((_, e, next) => next(e))

  // E1, conditional fragments: appended to the prompt that first meets their
  // condition, and again only once the conversation no longer carries them.
  on('prompt.submit', async ($, e, nextBelow) => {
    // The person is here: an automatic fold waiting for a quiet moment will see
    // this and stand down, so their request is never queued behind a summary.
    if (!e.isMeta && e.command === undefined) state.promptedAt = await $.clock.now()
    // A project with no status board is offered one, once, and silence for
    // three hours is taken as a yes. The model is told what to do about it.
    if (!e.isMeta && e.command === undefined) {
      try {
        const offer = await boardOffer($, policySettings.phaseFile)
        if (offer !== undefined) await note($, `[context-harness] ${offer}`)
      } catch (error) {
        $.ui.log(`${$.plugin.name}: the status board offer was skipped (${String(error)})`)
      }
    }
    // Browser routing first: a prompt that needs a browser operated gets the tool to use, once
    // while the conversation carries it. Whatever the fragments below decide, the block rides along.
    const origin0 = e.origin
    const isPersons0 =
      origin0 !== undefined &&
      (origin0.kind === 'composer' || origin0.kind === 'bridge' || origin0.kind === 'sdk' || (origin0.kind === 'plugin' && origin0.asUser === true))
    let browserBlock: string | undefined
    if (settings.browserRoute !== 'off' && e.command === undefined && !e.isMeta && isPersons0) {
      try {
        const carried = settings.browserRoute === 'active' && attachedNames(await $.session.messages({ as: 'api' })).has(BROWSER_BLOCK)
        browserBlock = await routeBrowser($, e.text, e.turnId, carried)
      } catch (error) {
        $.ui.log(`${$.plugin.name}: browser routing skipped (${String(error)})`)
      }
    }
    const next: typeof nextBelow = Object.assign(
      (ev: typeof e) => nextBelow(browserBlock === undefined ? ev : { ...ev, context: [...(ev.context ?? []), browserBlock] }),
      nextBelow,
    )
    if (settings.instructionFilter !== 'off') {
      const text = e.command !== undefined ? `/${e.command.name} ${e.command.args ?? ''}` : e.text
      void judgeDeferred($, text, e.origin?.kind ?? 'unknown', e.turnId).catch(() => undefined)
    }
    const mode = settings.instructions
    // The person's own prompts only: typed, remote, headless, or a plugin's sent as the person's words.
    const origin = e.origin
    const isPersons =
      origin !== undefined &&
      (origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk' || (origin.kind === 'plugin' && origin.asUser === true))
    if (mode === 'off' || e.command !== undefined || e.isMeta || !isPersons) return next(e)
    const t0 = await $.clock.now()
    const { list } = await loadFragments($)
    const conditional = list.filter(fragment => !fragment.pin)
    if (conditional.length === 0) return next(e)
    const sessionId = await $.session.id()
    // Active counts the blocks the next request carries, and those attached to
    // prompts still queued; shadow, which attaches nothing, remembers.
    const pending = pendingOf(sessionId)
    let done: Set<string>
    if (mode === 'active') {
      const shown = await attachedNow($)
      for (const name of pending) if (shown.has(name)) pending.delete(name)
      done = new Set([...shown, ...pending])
    } else {
      done = await wouldAttach($, sessionId)
    }
    const candidates = conditional.filter(fragment => !done.has(fragment.name))
    if (candidates.length === 0) return next(e)

    const rule = new Map(candidates.map(fragment => [fragment.name, keywordHit(e.text, fragment.keywords)]))
    const key = await keyFor($)
    const sent = key === undefined ? null : { request: clip(scrub(e.text, await homeOf($)), 600) }
    // Active asks Jev only where no keyword decided; shadow asks for every candidate, to compare.
    const toAsk = mode === 'active' ? candidates.filter(fragment => rule.get(fragment.name) !== true) : candidates

    const finish = async (asked: { result?: JevResult; probabilities: Map<string, number> }, hookMs: number) => {
      const decisions = decideFragments(candidates, rule, asked.probabilities, settings.instructionThreshold)
      const chosen = decisions.filter(d => d.attach).map(d => d.name)
      if (mode === 'shadow' && chosen.length > 0) await rememberWouldAttach($, sessionId, [...done, ...chosen])
      if (mode === 'active') for (const name of chosen) pending.add(name)
      runtime.counts.attached += chosen.length
      // A record that cannot be written does not stop the fragment.
      void recordFragments($, { sessionId, joinKey: e.turnId, mode, t0, hookMs }, decisions, sent, asked.result).catch(() => undefined)
      showStatus($)

      return chosen
    }

    if (mode === 'shadow') {
      const result = await next(e)
      const hookMs = (await $.clock.now()) - t0
      void (async () => finish(key && sent ? await askConditions($, sessionId, key.key, sent, toAsk) : { probabilities: new Map() }, hookMs))().catch(() => undefined)

      return result
    }
    const asked = key && sent ? await askConditions($, sessionId, key.key, sent, toAsk) : { probabilities: new Map<string, number>() }
    const chosen = await finish(asked, (await $.clock.now()) - t0)
    const blocks = list.filter(fragment => chosen.includes(fragment.name)).map(fragmentBlock)

    return blocks.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...blocks] })
  }).catch((_, e, next) => next(e))

  // A cleared conversation carries no fragment. A summarized one is handled
  // where the compaction is answered, below.
  on('classic.SessionStart', async ($, e, next) => {
    const below = await next(e)
    if (e.agent_id !== undefined) return below
    if (settings.instructions !== 'off' && e.source === 'clear') await forgetAttached($, await $.session.id())
    const home = await homeOf($)
    if (home === undefined) return below
    const dir = sharedDirOf(home)
    // B4: the shared files are watched, so a change made in another profile
    // or an editor reaches this session (classic.FileChanged, below).
    const watched = { ...below, watchPaths: [...(below.watchPaths ?? []), ...[SHARED_CONFIG, SHARED_KEY, SHARED_CONSENT].map(name => `${dir}/${name}`)] }
    if (e.source !== 'startup') return watched
    // The first run: no key or no answer about consent, and the setup neither
    // finished nor declined. The setup starts by itself, as the first turn.
    //
    // initialUserMessage, not additionalContext: additionalContext only rides
    // along with the next request, so the model would say nothing until the
    // person wrote first, and someone who has never heard of the plugin has no
    // reason to. initialUserMessage is sent as the session's first prompt, which
    // starts a model turn, so the setup runs as /install-context-harness would.
    const { shared, key } = await sharedState($, options)
    if (shared.onboarding !== undefined || (key !== undefined && shared.consent !== undefined)) return watched

    return { ...watched, initialUserMessage: onboardingMessage(key?.source as Parameters<typeof keyNote>[0]) }
  }).catch((_, e, next) => next(e))

  // A shared file changed during the session: read them again, so a gate, a
  // fold value, a key or a consent takes effect without a new session.
  on('classic.FileChanged', async ($, e, next) => {
    const below = await next(e)
    const home = await homeOf($)
    if (home === undefined || !e.file_path.startsWith(`${sharedDirOf(home)}/`)) return below
    apply(await sharedState($, options))
    showStatus($)

    return below
  }).catch((_, e, next) => next(e))

  // The fold, and beside it the shadow judgment of what it folded.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)

    const sessionId = await $.session.id()
    // What a compaction costs the person is wall-clock time, and what it buys
    // is fewer tokens. Both are recorded, by trigger: only then can a later
    // look say whether a summary was worth the wait it caused.
    const startedAt = await $.clock.now()
    const recordCompaction = async (isSummarized: boolean, before?: number, after?: number): Promise<void> => {
      await writeRecord($, {
        id: newId(startedAt),
        ts: new Date(startedAt).toISOString(),
        sessionId,
        point: COMPACT_POINT,
        mode: 'active',
        sent: null,
        hookMs: (await $.clock.now()) - startedAt,
        decision: isSummarized ? 'summarized' : 'folded',
        facts: {
          trigger: e.trigger,
          messagesBefore: String(e.messages.length),
          ...(before === undefined ? {} : { tokensBefore: String(before) }),
          ...(after === undefined ? {} : { tokensAfter: String(after) }),
        },
      }).catch(() => undefined)
    }
    // Nothing in the types promises the api view here; without it no message
    // can be shown free of media, so nothing folds and the engine summarizes.
    const view = await $.session.messages({ as: 'api' }).then(messageViewOf, () => new Map() as MessageView)
    // What follows a compaction that stands. A failure here leaves the
    // compaction as it is: the hook's .catch would otherwise summarize the
    // unfolded transcript.
    const after = async (folded: number, archivedIds: readonly string[], isSummarized: boolean): Promise<void> => {
      try {
        if (isSummarized) await forgetAttached($, sessionId)
        await afterCompaction($, policySettings, state, folded)
      } catch (error) {
        $.ui.log(`${$.plugin.name}: after the compaction (${String(error)})`)
      }
      if (settings.foldJev === 'shadow') void judgeFold($, e.messages, new Set(archivedIds), view).catch(() => undefined)
    }

    // Fold relevance, active: Jev decides which results are still needed before
    // the fold, so the fold keeps those and takes the finished ones, recent or
    // not. Only when a person asked for the compaction: on the automatic path
    // the wait would land on them as they finish reading an answer.
    let foldPolicy = policy
    if (settings.foldJev === 'active' && e.trigger === 'manual') {
      try {
        foldPolicy = judgedPolicy(policySettings, await askNeeded($, e.messages, view), settings.foldThreshold)
      } catch (error) {
        $.ui.log(`${$.plugin.name}: fold relevance skipped (${String(error)})`)
      }
    }
    const outcome = foldTranscript(e.messages, foldPolicy, view)
    if (outcome.archived.length === 0) {
      const summarized = await next(e)
      if (summarized.skip === undefined) {
        await recordCompaction(true, summarized.tokensBefore, summarized.tokensAfter)
        await after(0, [], true)
      }

      return summarized
    }

    try {
      await writeArchive($, sessionId, outcome.archived)
    } catch (error) {
      $.ui.log(`${$.plugin.name}: could not keep folded results, summarizing instead (${String(error)})`)
      const summarized = await next(e)
      if (summarized.skip === undefined) {
        await recordCompaction(true)
        await after(0, [], true)
      }

      return summarized
    }

    // Blocks of the largest folded results that the current request still needs.
    if (settings.foldBlocks === 'active') {
      try {
        const decided = await judgeBlocks($, e.messages, outcome.archived, 'active')
        const kept = withKeptBlocks(outcome.messages, outcome.archived, decided)
        outcome.messages = kept.messages
        outcome.savedChars -= kept.addedChars
      } catch (error) {
        $.ui.log(`${$.plugin.name}: kept no blocks (${String(error)})`)
      }
    } else if (settings.foldBlocks === 'shadow') {
      void judgeBlocks($, e.messages, outcome.archived, 'shadow').catch(() => undefined)
    }

    // A partial summary: the engine summarizes what is older than the recent
    // window, and the recent messages — folded where the policy says so — are
    // carried over as they stand. This is what clears the old assistant turns,
    // tool inputs and reasoning blocks a fold alone leaves behind. It runs only
    // when the fold left enough behind that the window is still crowded.
    const { context } = await $.session.usage()
    const kept = partialCut(outcome.messages, policySettings.keepRecentTurns)
    const isCrowded = transcriptChars(outcome.messages) > context.window * SUMMARIZE_ABOVE_SHARE * CHARS_PER_TOKEN
    const cut = kept > 0 && isCrowded ? kept : 0
    // A summary replaces what the person said with the agent's reading of it,
    // and the canonical files are where that reading lives. So before a summary
    // runs they are asked to be current: an agent that cannot yet say what the
    // person wants has nothing to put in their words' place. The fold itself
    // goes ahead either way — only the summary waits.
    const due = cut > 0 ? dueBeforeFold(await anchorsOf($, policySettings), await since($, state)) : []
    const isDeferred = due.length > 0 && state.deferrals < MAX_DEFERRALS
    if (isDeferred) {
      state.deferrals++
      await note($, dueNote(due, await handoffLine($, policySettings.phaseFile)))
    }

    const split = cut > 0 && !isDeferred ? splitForSummary(outcome.messages, cut) : undefined
    // A summary is the one step here that lasts seconds: say so while it runs.
    runtime.isSummarizing = split !== undefined
    if (runtime.isSummarizing) showStatus($)
    let below
    try {
      below = split !== undefined ? await next({ ...e, messages: split.older }) : undefined
    } finally {
      runtime.isSummarizing = false
    }
    // A summary the engine refused leaves the conversation as it is: the
    // compaction does not stand, so nothing is recorded or counted.
    if (below !== undefined && below.skip !== undefined) return below
    const isSummarized = below !== undefined
    // A summary carries none of the folded ids it replaced, so the plugin puts
    // them back itself: the model keeps a way to reach every original. The
    // person's own prompts come back the same way — a summary would have
    // replaced the only copy of what they said.
    const messages = isSummarized && split !== undefined
      ? [...below.messages, pointerMessage(outcome.archived), ...split.keptPrompts, ...outcome.messages.slice(cut)]
      : outcome.messages
    runtime.folded.results += outcome.archived.length
    runtime.folded.savedChars += outcome.savedChars
    showStatus($)
    await recordCompaction(isSummarized, below?.tokensBefore, below?.tokensAfter)
    await after(
      outcome.archived.length,
      outcome.archived.map(item => item.id),
      isSummarized,
    )

    return { messages }
  }).catch((_, e, next) => next(e))

  // The idle boundary: the turn has ended and the person has not written yet.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || isFoldScheduled || policySettings.foldAtPercent === 0) return done
    if (state.isJustCompacted) {
      state.isJustCompacted = false

      return done
    }

    // Without HOME nothing can be kept, so a fold would only be a summary.
    if ((await homeOf($)) === undefined) return done
    const { context } = await $.session.usage()
    if ((context.percent ?? 0) < policySettings.foldAtPercent) return done

    // A fold is worth a compaction (one full prompt-cache miss) only when it
    // removes enough of the transcript.
    const messages = await $.session.messages()
    const before = transcriptChars(messages)
    const view = await $.session.messages({ as: 'api' }).then(messageViewOf, () => new Map() as MessageView)
    const { savedChars } = foldTranscript(messages, policy, view)
    if (before === 0 || (savedChars / before) * 100 < policySettings.minSavedPercent) return done

    // What this stretch of work produced goes to the canonical files before
    // its details leave the window: the agent writes them, this only asks.
    const due = dueBeforeFold(await anchorsOf($, policySettings), await since($, state))
    if (due.length > 0 && state.deferrals < MAX_DEFERRALS) {
      state.deferrals++
      await note($, dueNote(due, await handoffLine($, policySettings.phaseFile)))

      return done
    }

    isFoldScheduled = true
    // The fold runs a compaction, and a compaction can run the engine's
    // summary: seconds, at the moment the person finishes reading an answer.
    // So it waits for a quiet moment, and stands down if they type first —
    // their request is never queued behind a summary.
    const at = await $.clock.now()
    await $.store.set(FOLD_ARMED_KEY, at)
    // Where the timer's own check can find the moment it was armed: the value
    // is written to the store rather than held in a closure, so a test can see
    // that the fold is armed and what it will compare against.
    $.clock.after(FOLD_IDLE_MS, () => {
      // A prompt that arrived while this waited took the moment back.
      const holds = stillIdle(state.promptedAt, at)
      if (!holds) {
        isFoldScheduled = false

        return
      }
      state.promptedAt = undefined
      // /compact as the person would type it: a compaction this plugin starts
      // with $.session.compact() skips this plugin's own session.compact hook,
      // so it would summarize instead of fold. Queued until the session is idle.
      void $.command
        .run({ command: 'compact' })
        .catch(() => undefined)
        .finally(() => {
          isFoldScheduled = false
        })
    })

    return done
  })

  on('command.run', { command: 'jev-report' }, async $ => {
    const { records, labels } = await readRecords($, 20_000)
    const key = await keyFor($)
    const trust = await trustFor($)
    const fragments = settings.instructions === 'off' ? undefined : await loadFragments($)
    const header = [
      `context-harness: stop ${settings.stopGate}, tool ${settings.toolGate}, tool jev ${settings.toolJev}, instructions ${settings.instructions}, fold ${settings.foldJev}, instruction filter ${settings.instructionFilter}, web ${settings.webRead}, fold blocks ${settings.foldBlocks}, browser ${settings.browserRoute}`,
      `key ${key ? `from ${key.source}` : 'none'}, provider ${trust.trust} (${trust.why})`,
      ...(fragments
        ? [`fragments: ${fragments.list.length} in ${fragments.dir} (#${fragments.hash.slice(0, 6)})${fragments.problems.length ? `; skipped: ${fragments.problems.join('; ')}` : ''}`]
        : []),
      `${records.length} records, ${labels.size} labels`,
    ]
    const reports = [
      pointReport(STOP_POINT, records, labels, settings.stopThreshold),
      pointReport(TOOL_POINT, records, labels, settings.toolThreshold),
      pointReport(INSTRUCTIONS_POINT, records, labels, settings.instructionThreshold),
      pointReport(FOLD_POINT, records, labels, 0.5),
      ...(records.some(r => r.point === BROWSER_POINT) ? [pointReport(BROWSER_POINT, records, labels, settings.browserThreshold)] : []),
      ...(settings.instructionFilter === 'off' && !records.some(r => r.point === 'instr-filter') ? [] : [filterReport(records)]),
      ...[WEB_POINT, FOLD_BLOCKS_POINT].filter(point => records.some(r => r.point === point)).map(point => blockReport(point, records)),
      compactReport(records),
    ].filter((part): part is string => part !== undefined)

    return { text: [...header, ...reports].join('\n\n') }
  })

  // C2: the person's answer, typed by them; the model cannot give it for them.
  on('command.run', { command: 'jev-consent' }, async ($, e) => {
    const answer = e.args.trim().toLowerCase()
    const home = await homeOf($)
    if (answer === '' || home === undefined) {
      const { shared } = await sharedState($, options)
      const now = shared.consent === undefined ? 'not answered yet' : shared.consent ? 'allowed' : 'refused'

      return { text: `context-harness: sending to Jev is ${now}.\n\n${CONSENT_TEXT}\n\nUsage: /jev-consent yes|no|later` }
    }
    if (answer !== 'yes' && answer !== 'no' && answer !== 'later') return { text: 'Usage: /jev-consent yes|no|later' }
    const at = new Date(await $.clock.now()).toISOString()
    if (answer !== 'later') await writeSharedRecord($, home, SHARED_CONSENT, { consent: answer === 'yes', at })
    await writeSharedRecord($, home, SHARED_ONBOARDING, { state: answer === 'yes' ? 'done' : 'declined', at })
    apply(await sharedState($, options))
    showStatus($)
    if (answer === 'later') return { text: 'context-harness: the setup will not start by itself again. Run /install-context-harness when you want it.' }

    return {
      text:
        answer === 'yes'
          ? `context-harness: sending to Jev is allowed. Gates set to auto are ${settings.auto.length > 0 && runtime.key ? 'on now' : 'on once a key is in place'}. /jev-consent no takes it back.`
          : 'context-harness: sending to Jev is refused. Gates set to auto stay off, and folding runs by rule. /jev-consent yes changes it.',
    }
  })

  on('command.run', { command: 'jev-mark' }, async ($, e) => {
    const [id, value] = e.args.trim().split(/\s+/)
    if (id === undefined || !/^[a-z0-9]{4,20}$/.test(id) || (value !== 'y' && value !== 'n')) return { text: 'Usage: /jev-mark <id> y|n' }
    await writeLabel($, id, value === 'y', new Date(await $.clock.now()).toISOString())

    return { text: `Labeled ${id} as ${value === 'y' ? 'positive' : 'negative'}.` }
  })

  // /install-context-harness is a Markdown command, so the model writes the
  // answer. What only the plugin knows is where it finds a key; that rides along
  // as a note when the command expands. It looks afresh each time, so running the
  // command again after placing a key sees it, and the gates use it from then on.
  on('classic.UserPromptExpansion', async ($, e, next) => {
    const below = await next(e)
    if (e.expansion_type !== 'slash_command' || e.command_name.replace(/^.*:/, '') !== INSTALL_COMMAND_NAME) return below
    const next0 = await sharedState($, options)
    // A key placed since the session started turns its `auto` gates on now.
    apply(next0)
    const found = next0.key as { key: string; source: Parameters<typeof keyNote>[0] } | undefined

    return { ...below, additionalContext: [...(below.additionalContext ?? []), keyNote(found?.source)] }
  }).catch((_, e, next) => next(e))
  // E5: a turn that ends by announcing work. Settings Stop hooks run first.
  on('classic.Stop', async ($, e, next) => {
    const below = await next(e)
    const mode = settings.stopGate
    if (mode === 'off' || below.block !== undefined) return below

    const t0 = await $.clock.now()
    const paragraph = lastParagraph(e.last_assistant_message)
    const skipped = stopSkipReason({
      stopHookActive: e.stop_hook_active,
      permissionMode: e.permission_mode,
      backgroundTasks: e.background_tasks?.length ?? 0,
      scheduledTasks: e.session_crons?.length ?? 0,
      agentId: e.agent_id,
      paragraph,
    })
    const base = { id: newId(t0), ts: new Date(t0).toISOString(), sessionId: e.session_id, joinKey: e.prompt_id, point: STOP_POINT, mode }
    if (skipped !== undefined) {
      void writeRecord($, { ...base, skipped, sent: null, hookMs: (await $.clock.now()) - t0 }).catch(() => undefined)

      return below
    }

    const heuristic = announcesByRule(paragraph)
    const key = await keyFor($)
    if (key === undefined) {
      void writeRecord($, { ...base, heuristic, sent: null, error: 'no-key', hookMs: (await $.clock.now()) - t0 }).catch(() => undefined)
      showStatus($)

      return below
    }

    // Scrubbed first, then bounded to its end.
    // Scrubbed first, then bounded to its end.
    const sent = { last_paragraph: clip(scrub(paragraph, await homeOf($)), PARAGRAPH_CHARS, 'tail') }
    const run = async (hookMs: number): Promise<number | undefined> => {
      const result = await judge($, { sessionId: e.session_id, point: STOP_POINT, cap: settings.stopCap }, key.key, sent, { stop: STOP_QUESTION }, settings.timeoutMs)
      const probability = result.ok ? probabilityOf(result.answers.stop!, 'announce') : undefined
      const isFlagged = probability !== undefined && probability >= settings.stopThreshold
      if (result.ok) counts.judged++
      else counts.failed++
      await writeRecord($, {
        ...base,
        heuristic,
        sent,
        jev: probability,
        usage: result.ok ? result.usage : undefined,
        error: errorOf(result),
        jevMs: result.ms,
        hookMs,
        decision: isFlagged ? (mode === 'active' ? 'continue' : 'would-continue') : 'stop',
      })
      showStatus($)

      return probability
    }

    if (mode === 'shadow') {
      // Judged after the hook returns: the turn ends without waiting for Jev.
      const hookMs = (await $.clock.now()) - t0
      void run(hookMs).catch(() => undefined)

      return below
    }
    const probability = await run((await $.clock.now()) - t0)

    return probability !== undefined && probability >= settings.stopThreshold ? { ...below, block: STOP_MESSAGE } : below
  }).catch((_, e, next) => next(e))

  // E2: the floor (restricted paths and secret-printing commands, no Jev)
  // and, for what it lets through in an external session, Jev's judgment.
  // Registered before the plugin's own tools, so it sees their calls too.
  on('tool.call', async ($, e, next) => {
    if (settings.instructionFilter !== 'off') void recordToolUse($, String(e.tool), e as unknown as Record<string, unknown>, e.tool_use_id).catch(() => undefined)
    const mode = settings.toolGate
    const jevMode = settings.toolJev
    if (mode === 'off' && jevMode === 'off') return next(e)

    const t0 = await $.clock.now()
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const command = tool === 'Bash' && typeof input.command === 'string' ? input.command : undefined
    const home = (await homeOf($)) ?? '/'
    const cwd = await $.session.cwd()
    const candidates = [...new Set([...pathFieldValues(input), ...(command === undefined ? [] : pathCandidates(command))])].slice(0, 40)
    const protectedRoots = [
      $.plugin.root,
      stateRoot(home),
      legacyArchiveRoot(home),
      ...(settings.instructions === 'off' ? [] : [await fragmentsDirOf($)]),
    ].filter(root => root !== '')
    // Folded originals hold whatever the tools returned, secrets included.
    const archiveRoots = [`${stateRoot(home)}/archive`, legacyArchiveRoot(home)]
    const isWriting = canWrite(tool, command)

    let verdict: FloorVerdict | undefined
    for (const candidate of candidates) {
      const lexical = normalizePath(candidate, home, cwd)
      let real = lexical
      try {
        real = (await $.fs.stat(lexical, { resolve: true })).realPath ?? lexical
      } catch {
        // A path that does not exist yet is judged by its spelling.
      }
      for (const path of new Set([lexical, real])) {
        const self = isWriting ? selfProtectReason(path, protectedRoots) : undefined
        const restricted = restrictedReason(path, home) ?? (isUnder(path, archiveRoots) ? 'folded originals' : undefined)
        // A link names both what was asked for and what it leads to.
        const shown = (path === lexical ? lexical : `${lexical} -> ${real}`).split(home).join('~')
        if (self !== undefined) verdict = { kind: 'self', reason: self, path: shown }
        else if (restricted !== undefined) verdict ??= { kind: 'restricted', reason: restricted, path: shown }
      }
      if (verdict?.kind === 'self') break
    }
    const dump = command === undefined ? undefined : secretDumpReason(command)
    if (verdict === undefined && dump !== undefined) verdict = { kind: 'secret-dump', reason: dump }
    // A call the floor names never goes to Jev, whatever the floor's own mode.
    if (verdict === undefined) return judgeTool($, e, next, { tool, command, candidates, home, cwd, t0 })
    if (mode === 'off') return next(e)

    const trust = await trustFor($)
    const isRefused = verdict.kind === 'self' || trust.trust === 'external'
    counts.floor++
    const record: ShadowRecord = {
      id: newId(t0),
      ts: new Date(t0).toISOString(),
      sessionId: await $.session.id(),
      joinKey: e.tool_use_id,
      point: TOOL_POINT,
      mode,
      sent: null,
      hookMs: (await $.clock.now()) - t0,
      decision: isRefused ? (mode === 'active' ? 'deny' : 'would-deny') : 'allow',
      facts: { tool, kind: verdict.kind, reason: verdict.reason, trust: trust.trust, why: trust.why },
    }
    void writeRecord($, record).catch(() => undefined)
    showStatus($)
    if (mode === 'active' && isRefused) return { deny: denyMessage(verdict, trust.trust) }

    return next(e)
  }).catch((_, e, next) =>
    // The floor fails closed when active: a guard that broke refuses rather than lets through.
    next.called || settings.toolGate !== 'active' ? next(e) : { deny: 'context-harness: the tool guard failed, so this call was refused.' },
  )

  // A Read of a large image reads a smaller copy instead. An image is not
  // folded and not summarized away while it is recent, so its size is paid for
  // on every request until the session ends; this is where it can be cut.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (settings.imageMaxPx <= 0) return next(e)
    const input = e as unknown as { file_path?: unknown }
    const filePath = typeof input.file_path === 'string' ? input.file_path : ''
    if (filePath === '') return next(e)
    const home = await homeOf($)
    if (home === undefined) return next(e)
    const smaller = await imageToRead($, filePath, settings.imageMaxPx, stateRoot(home))
    if (smaller === undefined) return next(e)
    $.ui.log(`${$.plugin.name}: read ${smaller} instead of ${filePath} (over ${settings.imageMaxPx}px)`)

    return next({ ...e, file_path: smaller })
  }).catch((_, e, next) => next(e))

  on('tool.call', { tool: 'mcp__context-harness__read_coordinate' }, async ($, e) => {
    const input = e as unknown as { id?: unknown; offset?: unknown; limit?: unknown; query?: unknown; full?: unknown }
    const id = typeof input.id === 'string' ? input.id : ''
    const item = await readArchived($, await $.session.id(), id)

    // A plugin tool's result reaches the model as its content: a string here.
    if (item === undefined) return { isError: true, result: `No folded result is kept under "${id}".` }

    // A folded original goes through the gate as the call that made it would have.
    if (settings.toolGate !== 'off') {
      const trust = await trustFor($)
      let reason: string | undefined
      if (trust.trust === 'external') {
        const home = (await homeOf($)) ?? '/'
        const cwd = await $.session.cwd()
        // A path that still exists is judged by what it leads to as well.
        const real: string[] = []
        for (const path of callPaths(item.input, home, cwd)) {
          try {
            const resolved = (await $.fs.stat(path, { resolve: true })).realPath
            if (resolved !== undefined) real.push(resolved)
          } catch {
            // Gone since: judged by its spelling.
          }
        }
        reason = archivedReason(item.input, home, cwd, real)
      }
      if (reason !== undefined) {
        const t0 = await $.clock.now()
        counts.floor++
        void writeRecord($, {
          id: newId(t0),
          ts: new Date(t0).toISOString(),
          sessionId: await $.session.id(),
          joinKey: id,
          point: TOOL_POINT,
          mode: settings.toolGate,
          sent: null,
          hookMs: 0,
          decision: settings.toolGate === 'active' ? 'deny' : 'would-deny',
          facts: { tool: 'read_coordinate', kind: 'archived', reason, trust: trust.trust, why: trust.why },
        }).catch(() => undefined)
        showStatus($)
        if (settings.toolGate === 'active') return { isError: true, result: denyMessage({ kind: 'restricted', reason }, trust.trust) }
      }
    }

    // A judgment needs a key. Without one the whole original comes back: a
    // partial answer nothing could choose would only hide what is there.
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    const key = input.full === true || query === '' ? undefined : await keyFor($)
    if (key !== undefined && key !== null) {
      const home = (await homeOf($)) ?? '/'
      const sessionId = await $.session.id()
      const ask = jevAsker($, { sessionId, point: FOLD_BLOCKS_POINT, cap: settings.foldBlocksCap }, key.key, settings.webTimeoutMs)
      const rel = await selectRelevant(parseText(item.text), clip(query, QUERY_CHARS), ask, text => scrub(text, home), DEFAULT_RELEVANCE, () => settings.foldBlocks === 'off')
      if (rel.status === 'filtered' && rel.text !== '') {
        const left = omittedRanges(item.text, rel.text)
        const ranges = left.map(r => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`)).join(', ')
        const head = `${item.tool} ${JSON.stringify(item.input)} — ${rel.blocksKept} of ${rel.blocksTotal} passages, of ${item.text.split('\n').length} lines`
        const tail = left.length === 0 ? '' : `\n\nLeft out: lines ${ranges}. Read them with offset and limit, or pass full for the whole original.`

        return { isReadOnly: true, result: `${head}\n${rel.text}${tail}` }
      }
      // passthrough, no_match, jev_error: the original is what helps, not a fragment.
    }

    const offset = typeof input.offset === 'number' ? input.offset : 1
    const limit = typeof input.limit === 'number' ? input.limit : READ_LIMIT
    const part = sliceLines(item.text, offset, limit)
    const head = `${item.tool} ${JSON.stringify(item.input)} — lines ${part.from}-${part.to} of ${part.total}`

    return { isReadOnly: true, result: `${head}\n${part.body}` }
  }).catch($ => ({ isError: true, result: `${$.plugin.name}: could not read the folded result.` }))

  on('tool.call', { tool: 'mcp__context-harness__web_read' }, async ($, e) => {
    const input = e as unknown as { url?: unknown; question?: unknown }
    const url = typeof input.url === 'string' ? input.url.trim() : ''
    const question = typeof input.question === 'string' ? input.question.trim() : ''
    if (url === '' || question === '') return { isError: true, result: 'web_read needs a url and a question.' }
    const answer = await readWeb($, url, question, e.tool_use_id)

    return answer.isError ? { isError: true, result: answer.text } : { isReadOnly: true, result: answer.text }
  }).catch($ => ({ isError: true, result: `${$.plugin.name}: web_read failed; use WebFetch instead.` }))

  // Shadow: what web_read would have returned, measured after WebFetch answered.
  on('tool.call', { tool: 'WebFetch' }, async ($, e, next) => {
    const result = await next(e)
    if (settings.webRead !== 'shadow' || 'deny' in result) return result
    try {
      const answer = result.result as { result?: unknown } | string | undefined
      const text = typeof answer === 'string' ? answer : answer?.result
      const chars = typeof text === 'string' ? text.length : 0
      void shadowWebFetch($, e.url, e.prompt, e.tool_use_id, chars).catch(() => undefined)
    } catch {
      // A measurement that cannot start leaves WebFetch's answer as it is.
    }

    return result
  }).catch((_, e, next) => next(e))

  on('tool.call', { tool: 'mcp__context-harness__policy_report' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const messages = await $.session.messages()
    // The dry run must fold what a real compaction would, so it reads the same
    // api view: without it a message holding media looks foldable here.
    const view = await $.session.messages({ as: 'api' }).then(messageViewOf, () => new Map() as MessageView)
    const hasCandidate = SETTING_KEYS.some(key => input[key] !== undefined)
    const candidate = settingsFrom(input, policySettings)
    const report = {
      current: { settings: policySettings, ...reportFor(messages, policySettings, view) },
      ...(hasCandidate ? { candidate: { settings: candidate, folds: reportFor(messages, candidate, view).folds } } : {}),
      anchors: await anchorsOf($, policySettings),
      defaults: DEFAULT_SETTINGS,
    }

    return { isReadOnly: true, result: JSON.stringify(report, null, 2) }
  }).catch($ => ({ isError: true, result: `${$.plugin.name}: could not measure this session.` }))

  // Only the fold policy's own values: never a gate, a Jev mode or the key.
  on('tool.call', { tool: 'mcp__context-harness__set_policy' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const wanted = settingsFrom(input, policySettings)
    const lines: string[] = []

    for (const key of SETTING_KEYS) {
      if (input[key] === undefined) continue
      const value: PolicySettings[typeof key] = wanted[key]
      const stored = Array.isArray(value) ? value.join(',') : value
      const set = await $.config.set({ key: `${$.plugin.name}.${key}`, value: stored })
      lines.push(set.deny === undefined ? `${key} = ${JSON.stringify(stored)}` : `${key} refused: ${set.deny}`)
    }

    return { result: lines.length === 0 ? 'No policy value was given.' : lines.join('\n') }
  }).catch($ => ({ isError: true, result: `${$.plugin.name}: could not set the policy.` }))
}
