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
  fragments: { list: readonly unknown[]; hash: string } | undefined,
  filtered = 0,
): string | undefined {
  const isJev = usesJev(settings)
  if (!isJev && settings.toolGate === 'off') return undefined
  if (isJev && hasNoKey) return 'jev: no key'
  const recorded = counts.judged + counts.failed + counts.floor + counts.toolJudged + counts.attached + counts.foldJudged + counts.webRead + counts.foldBlocks + counts.browserRouted
  if (recorded === 0 && filtered === 0) return undefined
  const parts = ['jev']
  if (settings.stopGate !== 'off') parts.push(`stop ${settings.stopGate} ${counts.judged} judged${counts.failed ? `, ${counts.failed} failed` : ''}`)
  if (settings.toolGate !== 'off') parts.push(`tool ${settings.toolGate} ${counts.floor} hits`)
  if (settings.toolJev !== 'off') parts.push(`tool jev ${settings.toolJev} ${counts.toolJudged} judged`)
  if (settings.instructions !== 'off') {
    parts.push(`instr ${settings.instructions} ${fragments ? `${fragments.list.length} #${fragments.hash.slice(0, 6)}` : '-'}, ${counts.attached} attached`)
  }
  if (settings.foldJev !== 'off') parts.push(`fold ${settings.foldJev} ${counts.foldJudged} judged`)
  if (settings.webRead !== 'off') parts.push(`web ${settings.webRead} ${counts.webRead} read`)
  if (settings.foldBlocks !== 'off') parts.push(`fold blocks ${settings.foldBlocks} ${counts.foldBlocks} judged`)
  if (settings.browserRoute !== 'off') parts.push(`browser ${settings.browserRoute} ${counts.browserRouted} judged`)
  if (settings.instructionFilter !== 'off') parts.push(`instr filter ${settings.instructionFilter}${filtered ? ` −${Math.round(filtered / 100) / 10}k dup` : ''}`)

  return parts.join(' · ')
}

export function statusLine(parts: readonly (string | undefined)[]): string | undefined {
  const shown = parts.filter((part): part is string => part !== undefined)

  return shown.length === 0 ? undefined : shown.join(' | ')
}

export function showStatus($: EngineInterface): void {
  const settings = runtime.settings
  const line = statusLine([
    summarizingStatus(runtime.isSummarizing),
    foldStatus(runtime.folded),
    settings === undefined ? undefined : jevStatus(settings, runtime.counts, runtime.key === null, runtime.fragments, runtime.filter?.droppedChars),
  ])
  if (line !== undefined) $.ui.status(line)
}
