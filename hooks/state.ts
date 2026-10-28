// What the module keeps between hooks. Per process: a reload (a changed
// setting) starts it over, which costs a mkdir, a lookup and the counters.
import type { PolicySettings } from './fold'
import type { Detected } from './browser-route'
import type { Chunk } from './instruction-docs'
import type { Fragment } from './instructions'
import type { HarnessSettings } from './settings'
import type { Trust } from './tool-gate'

export type Counts = { judged: number; failed: number; floor: number; toolJudged: number; attached: number; foldJudged: number; webRead: number; foldBlocks: number; browserRouted: number }

export const runtime: {
  settings?: HarnessSettings
  policy?: PolicySettings
  counts: Counts
  /** What the fold removed in this process: results and characters. */
  folded: { results: number; savedChars: number }
  key?: { key: string; source: string } | null
  trust?: { trust: Trust; why: string }
  fragments?: { list: Fragment[]; hash: string; dir: string; problems: string[] }
  /** Per session, fragments attached here that the conversation may not show yet. */
  pending: Map<string, Set<string>>
  /** The instruction files as last loaded: their chunks, what left them, and what Jev would defer. */
  filter?: { stateKey: string; chunks: Chunk[]; drops: Map<string, Chunk>; droppedChars: number; deferred: Chunk[] }
  /** The browser tools found installed, once per process. */
  browsers?: Detected
  /**
   * Set while the engine's summary runs, and cleared after. A summary is the
   * one thing here that takes seconds, and the person is owed a sign that the
   * wait is the plugin's and not their own doing.
   */
  isSummarizing?: boolean
  /** The line drawn after the prompt's hint; kept until a newer one replaces it. */
  statusLine?: string
} = { counts: { judged: 0, failed: 0, floor: 0, toolJudged: 0, attached: 0, foldJudged: 0, webRead: 0, foldBlocks: 0, browserRouted: 0 }, folded: { results: 0, savedChars: 0 }, pending: new Map() }

// Folders already made private in this process.
export const madeDirs = new Set<string>()

// Tool targets already judged in this process: one Jev call per target and session.
export const toolVerdicts = new Map<string, { risk: number; choice: string }>()

let sequence = 0

export function newId(now: number): string {
  return `${Math.floor(now).toString(36)}${(sequence++ % 1296).toString(36).padStart(2, '0')}`
}

export function startRuntime(settings: HarnessSettings, policy: PolicySettings): void {
  runtime.settings = settings
  runtime.policy = policy
  runtime.key = undefined
  runtime.trust = undefined
  runtime.fragments = undefined
  runtime.counts = { judged: 0, failed: 0, floor: 0, toolJudged: 0, attached: 0, foldJudged: 0, webRead: 0, foldBlocks: 0, browserRouted: 0 }
  runtime.browsers = undefined
  runtime.folded = { results: 0, savedChars: 0 }
  runtime.filter = undefined
  runtime.statusLine = undefined
}

/**
 * Replaces the settings and policy, leaving the counters, the fold's tally and
 * the key alone. Used where settings arrive after the runtime is up: the shared
 * folder is read at session start, and starting the runtime over there would
 * wipe what the session has already done.
 */
export function retuneRuntime(settings: HarnessSettings, policy: PolicySettings): void {
  runtime.settings = settings
  runtime.policy = policy
}

export function settingsOf(): HarnessSettings {
  if (runtime.settings === undefined) throw new Error('conjev: settings read before register')

  return runtime.settings
}
