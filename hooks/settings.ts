// The judgment layer's settings: the plugin's userConfig fields beside the
// fold policy's (those are read by settingsFrom in fold.ts).

export type Mode = 'off' | 'shadow' | 'active'

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
  foldJev: 'off' | 'shadow'
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
}

const modeOf = (value: unknown): Mode => (value === 'shadow' || value === 'active' ? value : 'off')
const numberOf = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

export function harnessSettingsFrom(options: Readonly<Record<string, unknown>>): HarnessSettings {
  return {
    stopGate: modeOf(options.stopGate),
    toolGate: modeOf(options.toolGate),
    stopThreshold: numberOf(options.stopThreshold, 0.7, 0, 1),
    timeoutMs: numberOf(options.timeoutMs, 2000, 200, 8000),
    stopCap: numberOf(options.stopCap, 200, 0, 10_000),
    toolJev: modeOf(options.toolJev),
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
    instructions: modeOf(options.instructions),
    fragmentsDir: typeof options.fragmentsDir === 'string' && options.fragmentsDir.trim() !== '' ? options.fragmentsDir : '~/.agents/fragments',
    instructionThreshold: numberOf(options.instructionThreshold, 0.95, 0, 1),
    instructionCap: numberOf(options.instructionCap, 200, 0, 10_000),
    foldJev: options.foldJev === 'shadow' ? 'shadow' : 'off',
    foldCap: numberOf(options.foldCap, 20, 0, 1000),
    instructionFilter: modeOf(options.instructionFilter),
    webRead: modeOf(options.webRead),
    webReadCap: numberOf(options.webReadCap, 600, 0, 100_000),
    webTimeoutMs: numberOf(options.webTimeoutMs, 10_000, 1000, 60_000),
    foldBlocks: modeOf(options.foldBlocks),
    foldBlocksCap: numberOf(options.foldBlocksCap, 300, 0, 100_000),
    foldBlocksResults: numberOf(options.foldBlocksResults, 4, 1, 24),
    foldBlocksBudgetMs: numberOf(options.foldBlocksBudgetMs, 10_000, 1000, 60_000),
    browserRoute: modeOf(options.browserRoute),
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
