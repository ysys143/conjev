// Reading a web page for a question: the page is fetched, split into blocks,
// and only the blocks Jev judges to answer the question go to the model,
// quoted verbatim; the whole page is archived for read_coordinate. Shadow
// measures the same on the model's own WebFetch calls and changes nothing.
import type { EngineInterface } from 'claude-code'
import { parseDocument, render, type Block } from './blocks'
import { probabilityOf, type JevQuestion } from './jev'
import { errorOf, judge, keyFor } from './jev-call'
import { DEFAULT_RELEVANCE, selectRelevant, type Ask, type Relevance } from './relevance'
import { clip, scrub } from './scrub'
import { newId, runtime, settingsOf } from './state'
import { showStatus } from './status'
import type { ShadowRecord } from './report'
import { homeOf, writeArchive, writeRecord } from './storage'

export const WEB_POINT = 'web'

export const WEB_TOOL_DESCRIPTION =
  'Read a web page for a question: returns only the passages of the page that answer it, quoted verbatim ' +
  "with their heading paths ('##' lines), and an id for read_coordinate that returns the whole page. " +
  'Use it in place of WebFetch to look up a fact, value, rule or behaviour on a page, above all a long one ' +
  '(specs, API references, long articles). Put every sub-question in `question`.'

const STATUS_NOTE: Record<Relevance['status'], string> = {
  filtered: "blocks are quoted from the page; '##' lines are the page's heading path",
  passthrough: 'the page is short, so it is returned whole',
  no_match: 'no block clearly answers the question; the best candidates are shown',
  empty: 'the page has no readable text',
  jev_error: 'the relevance judgment did not answer; only the first block is shown, read the whole page with read_coordinate',
}

const READABLE = /^(?:text\/|application\/(?:json|xml|xhtml\+xml|ld\+json|javascript)|$)/
// A page past this is read only this far; the specs this is for run under 1 MB.
export const MAX_PAGE_CHARS = 4_000_000

/**
 * A host on this machine or a private network: never fetched, so nothing from
 * it reaches Jev. The host is read as the URL parser reads it, so 127.1,
 * 0177.0.0.1, 0x7f.0.0.1 and [0:0:0:0:0:0:0:1] are the loopback they are. A
 * public name that resolves to a private address, or a redirect to one, is not
 * caught here: the host fetches and follows redirects itself.
 */
export function isPrivateHost(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return true
  }
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  if (host.startsWith('[')) return /^\[(?:::1?\]|f[cd]|fe[89ab]|::ffff:(?:7f|a[0-9a-f]{0,2}:|c0a8|a9fe|ac1[0-9a-f]))/.test(host)
  const ip = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (ip === null) return !host.includes('.')
  const [a, b] = [Number(ip[1]), Number(ip[2])]

  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

/** Jev, one request at a time, within a point's budget. */
export function jevAsker($: EngineInterface, budget: { sessionId: string; point: string; cap: number }, key: string, timeoutMs: number): Ask {
  return async (state: Record<string, unknown>, questions: Record<string, JevQuestion>) => {
    const result = await judge($, budget, key, state, questions, timeoutMs)
    if (!result.ok) return { error: errorOf(result) ?? 'failed' }
    const answers: Record<string, number> = {}
    for (const [name, answer] of Object.entries(result.answers)) {
      const p = probabilityOf(answer)
      if (p !== undefined) answers[name] = p
    }

    return { answers, usage: result.usage }
  }
}

export type WebPage = { ok: true; blocks: Block[] } | { ok: false; error: string }

export async function fetchPage($: EngineInterface, url: string): Promise<WebPage> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'only http and https URLs can be read' }
  if (isPrivateHost(url)) return { ok: false, error: 'a local or private-network address is not read' }
  let response
  try {
    response = await $.http.fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; context-harness web_read)', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' } })
  } catch (error) {
    return { ok: false, error: `the request failed (${String(error).slice(0, 200)})` }
  }
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
  const type = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
  if (!READABLE.test(type)) return { ok: false, error: `${type} is not a page this tool reads` }

  return { ok: true, blocks: parseDocument(response.text.slice(0, MAX_PAGE_CHARS), url, type) }
}

/** The model-facing answer, in jevfetch's layout. */
export function webAnswer(url: string, rel: Relevance, archiveId: string | undefined): string {
  return [
    `# web_read: ${url}`,
    `# status: ${rel.status} (${STATUS_NOTE[rel.status]})`,
    `# ${rel.blocksKept}/${rel.blocksTotal} blocks, about ${rel.outTokens} of ${rel.docTokens} tokens`,
    ...(archiveId === undefined ? [] : [`# whole page: read_coordinate("${archiveId}")`]),
    rel.text,
  ].join('\n')
}

type Measured = { rel: Relevance; ms: number }

/** Fetches and selects; the record is written whatever happens after the fetch. */
async function measure($: EngineInterface, url: string, question: string, mode: 'shadow' | 'active', joinKey: string, extra: Record<string, string>): Promise<{ measured?: Measured; page: WebPage; archiveId?: string }> {
  const settings = settingsOf()
  const sessionId = await $.session.id()
  const key = await keyFor($)
  const home = await homeOf($)
  const t0 = await $.clock.now()
  const page = await fetchPage($, url)
  const base = { id: newId(t0), ts: new Date(t0).toISOString(), sessionId, joinKey, point: WEB_POINT, mode, hookMs: 0 }
  const sent = { query: clip(scrub(question, home), 600), url: scrub(url, home) }
  if (!page.ok) {
    await writeRecord($, { ...base, sent: null, skipped: page.error, facts: { url: sent.url, ...extra } })
    return { page }
  }
  if (key === undefined) {
    await writeRecord($, { ...base, sent: null, error: 'no-key', facts: { url: sent.url, ...extra } })
    return { page }
  }
  const ask = jevAsker($, { sessionId, point: WEB_POINT, cap: settings.webReadCap }, key.key, settings.webTimeoutMs)
  // Turning the setting off stops a page still being judged.
  const rel = await selectRelevant(page.blocks, question, ask, text => scrub(text, home), DEFAULT_RELEVANCE, () => settingsOf().webRead === 'off')
  const ms = (await $.clock.now()) - t0
  let archiveId: string | undefined
  if (mode === 'active' && rel.status !== 'passthrough' && rel.status !== 'empty') {
    archiveId = `web-${base.id}`
    try {
      await writeArchive($, sessionId, [{ id: archiveId, tool: 'web_read', input: { url, question }, text: render(page.blocks), isError: false }])
    } catch {
      archiveId = undefined
    }
  }
  runtime.counts.webRead++
  await writeRecord($, {
    ...base,
    // The page's text went to Jev too; records keep only how much of it.
    sent: { ...sent, blocks: rel.blocksTotal, pageTokens: rel.docTokens },
    usage: { input_tokens: rel.inputTokens, output_tokens: 0 },
    error: rel.error as ShadowRecord['error'],
    jevMs: ms,
    decision: rel.status,
    facts: {
      url: sent.url,
      status: rel.status,
      docTokens: String(rel.docTokens),
      outTokens: String(rel.outTokens),
      blocksTotal: String(rel.blocksTotal),
      blocksKept: String(rel.blocksKept),
      requests: String(rel.requests),
      failed: String(rel.failed),
      ...extra,
    },
  })
  showStatus($)

  return { measured: { rel, ms }, page, archiveId }
}

/** web_read, as the model calls it. */
export async function readWeb($: EngineInterface, url: string, question: string, toolUseId: string): Promise<{ text: string; isError: boolean }> {
  if ((await keyFor($)) === undefined) return { text: 'web_read needs a TypeSafe key (context-harness settings); use WebFetch instead.', isError: true }
  const { measured, page, archiveId } = await measure($, url, question, 'active', toolUseId, {})
  if (!page.ok) return { text: `# web_read: ${url}\n# status: fetch_error (${page.error})`, isError: true }
  if (measured === undefined) return { text: 'web_read could not judge the page; use WebFetch instead.', isError: true }

  return { text: webAnswer(url, measured.rel, archiveId), isError: false }
}

/**
 * Shadow: what web_read would have returned for a WebFetch call, recorded
 * beside the size of WebFetch's answer. A URL carrying something secret-shaped
 * (a signed or one-time link) is not fetched a second time.
 */
export async function shadowWebFetch($: EngineInterface, url: string, prompt: string, toolUseId: string, webFetchChars: number): Promise<void> {
  if (scrub(url) !== url) return
  await measure($, url, prompt, 'shadow', toolUseId, { webFetchChars: String(webFetchChars) })
}
