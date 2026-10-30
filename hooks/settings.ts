// The judgment layer's settings: the plugin's userConfig fields beside the
// fold policy's (those are read by settingsFrom in fold.ts).

export type Mode = 'off' | 'shadow' | 'active'

/** The Jev gates: those that `auto` and the `jev` switch apply to. The tool gate's floor is a rule, not one of them. */
export const JEV_GATES = ['stopGate', 'toolJev', 'instructions', 'foldJev', 'instructionFilter', 'webRead', 'foldBlocks', 'browserRoute'] as const
export type JevGate = (typeof JEV_GATES)[number]

/**
 * What `auto` needs to become `active`: a key, the `jev` switch on, and the
 * person's recorded consent. Unknown until the session can look (register has
 * no `$`), and then everything is false, so `auto` starts as `off`.
 */
export type AutoFacts = { hasKey: boolean; isConsented: boolean }

export type HarnessSettings = {
  stopGate: Mode
  toolGate: Mode
  stopThreshold: number
  timeoutMs: number
  stopCap: number
  toolJev: Mode
  toolThreshold: number
  toolCap: number
  providerTrust: 'auto' | 'external'
  trustedProxies: string[]
  apiKey: unknown
  instructions: Mode
  fragmentsDir: string
  instructionThreshold: number
  instructionCap: number
  foldJev: Mode
  foldThreshold: number
  foldCap: number
  instructionFilter: Mode
  webRead: Mode
  webReadCap: number
  webTimeoutMs: number
  foldBlocks: Mode
  foldBlocksCap: number
  foldBlocksResults: number
  foldBlocksBudgetMs: number
  browserRoute: Mode
  browserThreshold: number
  browserCap: number
  browserBlocked: string
  browserCdp: string
  imageMaxPx: number
  /** The switch over every Jev gate: off sends nothing to Jev, whatever a gate says. */
  jev: 'on' | 'off'
  /**
   * The switch over the fold, off by default: off leaves every compaction to
   * the engine's own summary, untouched, and starts none early. The Jev gates
   * outside the fold run as their modes say; fold relevance and kept blocks
   * have nothing to judge. A field run over a long autonomous task scored the
   * engine's summary with the gates above the fold with them (docs/experiment).
   */
  fold: 'on' | 'off'
  /** The gates set to `auto`, before they were resolved: what /jev-report shows as auto. */
  auto: JevGate[]
}

const modeOf = (value: unknown): Mode => (value === 'shadow' || value === 'active' ? value : 'off')
const numberOf = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

/**
 * A Jev gate's mode: `auto` is `active` once a key is there, the switch is on
 * and the person has consented, and `off` until then. An explicit `off`,
 * `shadow` or `active` stands as written.
 */
export function gateMode(value: unknown, jev: 'on' | 'off', facts: AutoFacts): Mode {
  if (value !== 'auto') return modeOf(value)

  return jev === 'on' && facts.hasKey && facts.isConsented ? 'active' : 'off'
}

export function harnessSettingsFrom(options: Readonly<Record<string, unknown>>, facts: AutoFacts = { hasKey: false, isConsented: false }): HarnessSettings {
  const jev = options.jev === 'off' ? 'off' : 'on'
  const gate = (value: unknown): Mode => gateMode(value, jev, facts)

  return {
    jev,
    fold: options.fold === 'on' ? 'on' : 'off',
    auto: JEV_GATES.filter(name => options[name] === 'auto'),
    stopGate: gate(options.stopGate),
    toolGate: modeOf(options.toolGate),
    stopThreshold: numberOf(options.stopThreshold, 0.7, 0, 1),
    timeoutMs: numberOf(options.timeoutMs, 2000, 200, 8000),
    stopCap: numberOf(options.stopCap, 200, 0, 10_000),
    toolJev: gate(options.toolJev),
    toolThreshold: numberOf(options.toolThreshold, 0.8, 0, 1),
    toolCap: numberOf(options.toolCap, 300, 0, 10_000),
    providerTrust: options.providerTrust === 'external' ? 'external' : 'auto',
    trustedProxies:
      typeof options.trustedProxies === 'string'
        ? options.trustedProxies
            .split(',')
            .map(s => s.trim().toLowerCase())
            .filter(Boolean)
        : [],
    apiKey: options.apiKey,
    instructions: gate(options.instructions),
    fragmentsDir: typeof options.fragmentsDir === 'string' && options.fragmentsDir.trim() !== '' ? options.fragmentsDir : '~/.agents/fragments',
    instructionThreshold: numberOf(options.instructionThreshold, 0.95, 0, 1),
    instructionCap: numberOf(options.instructionCap, 200, 0, 10_000),
    foldJev: gate(options.foldJev),
    foldThreshold: numberOf(options.foldThreshold, 0.3, 0, 1),
    foldCap: numberOf(options.foldCap, 20, 0, 1000),
    instructionFilter: gate(options.instructionFilter),
    webRead: gate(options.webRead),
    webReadCap: numberOf(options.webReadCap, 600, 0, 100_000),
    webTimeoutMs: numberOf(options.webTimeoutMs, 10_000, 1000, 60_000),
    foldBlocks: gate(options.foldBlocks),
    foldBlocksCap: numberOf(options.foldBlocksCap, 300, 0, 100_000),
    foldBlocksResults: numberOf(options.foldBlocksResults, 4, 1, 24),
    foldBlocksBudgetMs: numberOf(options.foldBlocksBudgetMs, 10_000, 1000, 60_000),
    browserRoute: gate(options.browserRoute),
    browserThreshold: numberOf(options.browserThreshold, 0.9, 0, 1),
    browserCap: numberOf(options.browserCap, 200, 0, 10_000),
    imageMaxPx: numberOf(options.imageMaxPx, 0, 0, 4096),
    browserBlocked: typeof options.browserBlocked === 'string' ? options.browserBlocked : '',
    browserCdp: typeof options.browserCdp === 'string' ? options.browserCdp : '',
  }
}

/** Whether a setting can send anything to Jev; only then is a key looked up. */
export function usesJev(settings: HarnessSettings): boolean {
  return (
    settings.stopGate !== 'off' ||
    settings.toolJev !== 'off' ||
    settings.instructions !== 'off' ||
    settings.foldJev !== 'off' ||
    settings.instructionFilter !== 'off' ||
    settings.webRead !== 'off' ||
    settings.foldBlocks !== 'off' ||
    settings.browserRoute !== 'off'
  )
}
