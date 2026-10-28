// One status line per plugin: the fold's part and the judgment layer's part,
// each worded as it was when they were separate plugins, joined by " | ".
import type { EngineInterface } from 'claude-code'
import type { HarnessSettings } from './settings'
import { usesJev } from './settings'
import { runtime, type Counts } from './state'

/** While the engine's summary runs: the one wait that lasts seconds. */
export function summarizingStatus(isSummarizing: boolean | undefined): string | undefined {
  return isSummarizing === true ? 'summarizing the older turns…' : undefined
}

/** The fold's part; undefined before the first fold. */
export function foldStatus(folded: { results: number; savedChars: number }): string | undefined {
  return folded.results === 0 ? undefined : `folded ${folded.results} · −${Math.round(folded.savedChars / 1000)}k chars`
}

/**
 * The judgment layer's part; undefined until a gate has recorded something.
 * Claude Code draws a plugin's status with a warning mark, so a line that
 * only says the gates are on would look like a fault from the first prompt.
 * A missing key is a fault, and shows at once.
 */
export function jevStatus(
  settings: HarnessSettings,
  counts: Counts,
  hasNoKey: boolean,
  filtered = 0,
): string | undefined {
  const isJev = usesJev(settings)
  if (!isJev && settings.toolGate === 'off') return undefined
  if (isJev && hasNoKey) return 'jev: no key'
  const recorded = counts.judged + counts.failed + counts.floor + counts.toolJudged + counts.attached + counts.foldJudged + counts.webRead + counts.foldBlocks + counts.browserRouted
  if (recorded === 0 && filtered === 0) return undefined
  // One total, not a part per gate: with every Jev gate on by default, a part
  // each ran past the width of a terminal. Per-gate counts are /jev-report's.
  // What is not the default still shows: a gate held in shadow, and failures.
  const judged = counts.judged + counts.toolJudged + counts.attached + counts.foldJudged + counts.webRead + counts.foldBlocks + counts.browserRouted
  const parts = [`jev ${judged}${counts.failed ? `, ${counts.failed} failed` : ''}`]
  if (counts.floor > 0) parts.push(`floor ${counts.floor} hit${counts.floor === 1 ? '' : 's'}`)
  if (filtered > 0) parts.push(`−${Math.round(filtered / 100) / 10}k dup`)
  const shadowed = SHADOW_NAMES.filter(([key]) => settings[key] === 'shadow').map(([, name]) => name)
  if (shadowed.length > 0) parts.push(`shadow: ${shadowed.join(', ')}`)

  return parts.join(' · ')
}

/** The short name each Jev gate goes by when it is held in shadow. */
const SHADOW_NAMES: readonly (readonly [keyof HarnessSettings, string])[] = [
  ['stopGate', 'stop'],
  ['toolGate', 'tool'],
  ['toolJev', 'tool jev'],
  ['instructions', 'instr'],
  ['foldJev', 'fold'],
  ['webRead', 'web'],
  ['foldBlocks', 'blocks'],
  ['browserRoute', 'browser'],
  ['instructionFilter', 'filter'],
]

export function statusLine(parts: readonly (string | undefined)[]): string | undefined {
  const shown = parts.filter((part): part is string => part !== undefined)

  return shown.length === 0 ? undefined : shown.join(' | ')
}

export function showStatus($: EngineInterface): void {
  const settings = runtime.settings
  const line = statusLine([
    summarizingStatus(runtime.isSummarizing),
    foldStatus(runtime.folded),
    settings === undefined ? undefined : jevStatus(settings, runtime.counts, runtime.key === null, runtime.filter?.droppedChars),
  ])
  if (line !== undefined) $.ui.status(line)
}
