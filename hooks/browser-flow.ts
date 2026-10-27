// Browser routing at prompt.submit: keywords first, then Jev; the guidance
// block is attached in active, recorded in shadow. What is installed is looked
// up once per process.
import type { EngineInterface } from 'claude-code'
import { BROWSER_KEYWORDS, BROWSER_POINT, BROWSER_QUESTION, chooseBrowser, detectBrowsers, parseBlocked, routeBlock, type Detected } from './browser-route'
import { keywordHit } from './instructions'
import { probabilityOf } from './jev'
import { errorOf, judge, keyFor } from './jev-call'
import { clip, scrub } from './scrub'
import { newId, runtime, settingsOf } from './state'
import { showStatus } from './status'
import { homeOf, writeRecord } from './storage'

const RECOMMEND_EVERY_MS = 14 * 24 * 60 * 60 * 1000

export async function browsersOf($: EngineInterface): Promise<Detected> {
  if (runtime.browsers !== undefined) return runtime.browsers
  const settings = settingsOf()
  runtime.browsers = await detectBrowsers($, parseBlocked(settings.browserBlocked), settings.browserCdp)

  return runtime.browsers
}

/** Whether this request needs a browser operated: a keyword decides, else Jev at the threshold. */
async function needsBrowser($: EngineInterface, text: string, sessionId: string): Promise<{ needs: boolean; rule: boolean; jev?: number; error?: string; sent: Record<string, unknown> | null; usage?: { input_tokens: number; output_tokens: number }; ms?: number }> {
  const settings = settingsOf()
  const rule = keywordHit(text, BROWSER_KEYWORDS)
  if (rule) return { needs: true, rule, sent: null }
  const key = await keyFor($)
  if (key === undefined) return { needs: false, rule, error: 'no-key', sent: null }
  const sent = { request: clip(scrub(text, await homeOf($)), 600) }
  const result = await judge($, { sessionId, point: BROWSER_POINT, cap: settings.browserCap }, key.key, sent, { browser: BROWSER_QUESTION }, settings.timeoutMs)
  const p = result.ok ? probabilityOf(result.answers.browser!, 'operate') : undefined

  return { needs: p !== undefined && p >= settings.browserThreshold, rule, jev: p, error: errorOf(result), sent, usage: result.ok ? result.usage : undefined, ms: result.ms }
}

/**
 * The block to attach to this prompt, if any. Shadow judges and records but
 * attaches nothing; active attaches the block once while the conversation
 * does not carry it already.
 */
export async function routeBrowser($: EngineInterface, text: string, turnId: string | undefined, alreadyAttached: boolean): Promise<string | undefined> {
  const settings = settingsOf()
  const mode = settings.browserRoute
  if (mode === 'off' || text.trim() === '') return undefined
  const t0 = await $.clock.now()
  const sessionId = await $.session.id()
  const decided = await needsBrowser($, text, sessionId)
  const detected = await browsersOf($)
  const chosen = decided.needs ? (chooseBrowser(detected) ?? 'none') : '-'
  const attach = mode === 'active' && decided.needs && !alreadyAttached
  runtime.counts.browserRouted++
  void writeRecord($, {
    id: newId(t0),
    ts: new Date(t0).toISOString(),
    sessionId,
    joinKey: turnId,
    point: BROWSER_POINT,
    mode,
    heuristic: decided.rule,
    sent: decided.sent,
    jev: decided.jev,
    usage: decided.usage,
    error: decided.error as never,
    jevMs: decided.ms,
    hookMs: (await $.clock.now()) - t0,
    decision: decided.needs ? (mode === 'active' ? (attach ? 'attach' : 'already-attached') : 'would-attach') : 'read',
    facts: { chosen, available: detected.available.join(',') || '-', blocked: detected.blocked.join(',') || '-' },
  }).catch(() => undefined)
  showStatus($)
  if (decided.needs && chosen === 'none' && mode === 'active') await recommend($)

  return attach ? routeBlock(detected) : undefined
}

/** A missing browser tool is the person's to install: told at most once in 14 days. */
async function recommend($: EngineInterface): Promise<void> {
  const last = await $.store.get('browser-recommended-at')
  const now = await $.clock.now()
  if (typeof last === 'number' && now - last < RECOMMEND_EVERY_MS) return
  await $.store.set('browser-recommended-at', now)
  $.ui.toast('context-harness: this request needs a browser and none is installed. ego lite (https://lite.ego.app/) provides the ego-browser command.')
}

