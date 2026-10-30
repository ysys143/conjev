// Shadow records and what /jev-report computes from them.
import type { JevFailure, JevUsage } from './jev'

export type ShadowRecord = {
  id: string
  ts: string
  sessionId: string
  /** prompt_id for a stop, tool_use_id for a tool call: joins a record to its transcript. */
  joinKey?: string
  point: string
  mode: 'shadow' | 'active'
  /** Not judged, and why. */
  skipped?: string
  /** The rule's verdict: for stop, whether the paragraph announces work. */
  heuristic?: boolean
  /** Exactly what was sent to Jev, scrubbed; null when nothing was sent. */
  sent: Record<string, unknown> | null
  /** Jev's probability for the positive class, when it answered. */
  jev?: number
  usage?: JevUsage
  error?: JevFailure | `http ${number}`
  jevMs?: number
  /** Time the hook itself held the event, not counting what ran beneath it. */
  hookMs: number
  /** What the gate did or would have done. */
  decision?: string
  /** Facts the decision rested on (trust, reason). */
  facts?: Record<string, string>
}

export type Label = { id: string; label: boolean; ts: string }

export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)

  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

export type Confusion = { both: number; ruleOnly: number; jevOnly: number; neither: number }

export function confusion(pairs: readonly { rule: boolean; jev: boolean }[]): Confusion {
  const c: Confusion = { both: 0, ruleOnly: 0, jevOnly: 0, neither: 0 }
  for (const { rule, jev } of pairs) {
    if (rule && jev) c.both++
    else if (rule) c.ruleOnly++
    else if (jev) c.jevOnly++
    else c.neither++
  }

  return c
}

/** Cohen's kappa of two yes/no raters; undefined when it cannot be computed. */
export function kappa(c: Confusion): number | undefined {
  const n = c.both + c.ruleOnly + c.jevOnly + c.neither
  if (n === 0) return undefined
  const observed = (c.both + c.neither) / n
  const ruleYes = (c.both + c.ruleOnly) / n
  const jevYes = (c.both + c.jevOnly) / n
  const expected = ruleYes * jevYes + (1 - ruleYes) * (1 - jevYes)

  return expected === 1 ? undefined : (observed - expected) / (1 - expected)
}

export type Sweep = { threshold: number; precision?: number; recall?: number; positives: number }

/** Precision and recall of `probability >= threshold` against labels, per threshold. */
export function sweep(points: readonly { probability: number; label: boolean }[], thresholds: readonly number[]): Sweep[] {
  return thresholds.map(threshold => {
    let tp = 0
    let fp = 0
    let fn = 0
    for (const { probability, label } of points) {
      const isPositive = probability >= threshold
      if (isPositive && label) tp++
      else if (isPositive) fp++
      else if (label) fn++
    }

    return {
      threshold,
      precision: tp + fp === 0 ? undefined : tp / (tp + fp),
      recall: tp + fn === 0 ? undefined : tp / (tp + fn),
      positives: tp + fp,
    }
  })
}

const fmt = (n: number | undefined, digits = 2): string => (n === undefined ? '-' : n.toFixed(digits))
const ms = (n: number | undefined): string => (n === undefined ? '-' : `${Math.round(n)} ms`)
const seconds = (n: number | undefined): string => (n === undefined ? '-' : `${(n / 1000).toFixed(1)}s`)

/** The report for one point, as plain text. */
export function pointReport(point: string, records: readonly ShadowRecord[], labels: ReadonlyMap<string, boolean>, threshold: number): string {
  const all = records.filter(r => r.point === point)
  if (all.length === 0) return `## ${point}\nNo records.`

  const skipped = new Map<string, number>()
  for (const r of all) if (r.skipped) skipped.set(r.skipped, (skipped.get(r.skipped) ?? 0) + 1)
  const eligible = all.filter(r => !r.skipped)
  const sent = eligible.filter(r => r.sent !== null)
  const answered = sent.filter(r => r.jev !== undefined)
  const failures = new Map<string, number>()
  for (const r of sent) if (r.error) failures.set(r.error, (failures.get(r.error) ?? 0) + 1)
  const decisions = new Map<string, number>()
  for (const r of all) if (r.decision) decisions.set(r.decision, (decisions.get(r.decision) ?? 0) + 1)

  const lines = [`## ${point}`, `records ${all.length}, eligible ${eligible.length}, sent ${sent.length}, answered ${answered.length}`]
  if (skipped.size > 0) lines.push(`skipped: ${[...skipped].map(([k, v]) => `${k} ${v}`).join(', ')}`)
  if (decisions.size > 0) lines.push(`decisions: ${[...decisions].map(([k, v]) => `${k} ${v}`).join(', ')}`)
  if (sent.length > 0) lines.push(`coverage ${fmt(answered.length / sent.length)}; failures: ${failures.size === 0 ? 'none' : [...failures].map(([k, v]) => `${k} ${v}`).join(', ')}`)
  lines.push(
    `hook p50 ${ms(percentile(all.map(r => r.hookMs), 0.5))}, p95 ${ms(percentile(all.map(r => r.hookMs), 0.95))}; ` +
      `jev p50 ${ms(percentile(answered.flatMap(r => (r.jevMs === undefined ? [] : [r.jevMs])), 0.5))}, p95 ${ms(percentile(answered.flatMap(r => (r.jevMs === undefined ? [] : [r.jevMs])), 0.95))}`,
  )
  const tokens = answered.flatMap(r => (r.usage ? [r.usage] : []))
  if (tokens.length > 0) {
    const sum = tokens.reduce((s, u) => ({ i: s.i + u.input_tokens, o: s.o + u.output_tokens }), { i: 0, o: 0 })
    lines.push(`tokens per call: in ${Math.round(sum.i / tokens.length)}, out ${Math.round(sum.o / tokens.length)}`)
  }

  const judged = answered.filter(r => r.heuristic !== undefined)
  if (judged.length > 0) {
    const c = confusion(judged.map(r => ({ rule: r.heuristic === true, jev: (r.jev ?? 0) >= threshold })))
    lines.push(
      `rule vs jev (>= ${threshold}): both ${c.both}, rule only ${c.ruleOnly}, jev only ${c.jevOnly}, neither ${c.neither}; kappa ${fmt(kappa(c))}`,
    )
    const disagreements = judged.filter(r => (r.heuristic === true) !== ((r.jev ?? 0) >= threshold) && !labels.has(r.id)).slice(-10)
    if (disagreements.length > 0) lines.push(`unlabeled disagreements (mark with /jev-mark <id> y|n): ${disagreements.map(r => r.id).join(' ')}`)
  }

  const labeled = answered.filter(r => labels.has(r.id)).map(r => ({ probability: r.jev ?? 0, label: labels.get(r.id) === true }))
  if (labeled.length > 0) {
    const positives = labeled.filter(p => p.label).length
    lines.push(`labels ${labeled.length} (positive ${positives}, negative ${labeled.length - positives})`)
    for (const s of sweep(labeled, [0.5, 0.6, 0.7, 0.8, 0.9, 0.95])) {
      lines.push(`  >= ${s.threshold}: precision ${fmt(s.precision)}, recall ${fmt(s.recall)}, flagged ${s.positives}`)
    }
  }

  return lines.join('\n')
}

/**
 * The instruction filter: the latest set of chunks, what left the loaded
 * files, what Jev would drop or defer and why, and for deferred chunks how
 * often the work they govern began without them.
 */
export function filterReport(records: readonly ShadowRecord[]): string {
  const chunkRecords = records.filter(r => r.point === 'instr-filter' && r.decision !== 'sent')
  if (chunkRecords.length === 0) return 'instr-filter: no records'
  const latestTs = chunkRecords.reduce((best, r) => (r.ts > best ? r.ts : best), '')
  const latestState = chunkRecords.find(r => r.ts === latestTs)?.facts?.state
  const latest = chunkRecords.filter(r => r.facts?.state === latestState && r.ts === latestTs)
  const chars = (rs: readonly ShadowRecord[]): number => rs.reduce((sum, r) => sum + Number(r.facts?.chars ?? 0), 0)
  const by = (decision: string) => latest.filter(r => r.decision === decision)
  const dropped = [...by('drop'), ...by('would-drop').filter(r => r.heuristic)]
  const lines = [
    `instr-filter: ${latest.length} chunks (${chars(latest)} chars) in the latest set of instruction files`,
    `  loaded twice: ${dropped.length} chunks, ${chars(dropped)} chars (${by('drop').length > 0 ? 'left out' : 'would be left out in active'})`,
    `  Jev, if applied: would drop ${by('would-drop').filter(r => !r.heuristic).length} (${chars(by('would-drop').filter(r => !r.heuristic))} chars), would defer ${by('would-defer').length} (${chars(by('would-defer'))} chars), keep ${by('would-keep').length}`,
  ]
  for (const r of latest.filter(r => r.decision !== 'would-keep')) {
    lines.push(`  - ${r.decision} ${r.facts?.heading} (${r.facts?.file}, ${r.facts?.chars} chars): ${r.facts?.reason} [${r.id}]`)
  }

  // For each kind of work a deferred chunk governs: tool uses of that kind,
  // and how many came with no would-attach judgment before them in the session.
  const defers = records.filter(r => r.point === 'instr-defer')
  const uses = records.filter(r => r.point === 'instr-tool')
  const signatures = [...new Set(by('would-defer').map(r => r.facts?.signature).filter((s): s is string => s !== undefined && s !== '-'))]
  for (const signature of signatures) {
    const events = uses.filter(u => u.facts?.signature === signature)
    const missed = events.filter(u => !defers.some(d => d.sessionId === u.sessionId && d.ts <= u.ts && d.facts?.signature === signature && d.decision === 'would-attach'))
    const pct = events.length === 0 ? '-' : `${Math.round((missed.length / events.length) * 100)}%`
    lines.push(`  would-miss, ${signature}: ${events.length} tool uses, ${missed.length} with the chunk not yet attached (${pct})`)
  }

  return lines.join('\n')
}

/**
 * A block judgment (web pages, kept fold blocks): how often it ran, what it
 * returned, how much of the original it passed on, and what it cost in Jev.
 */
export function blockReport(point: string, records: readonly ShadowRecord[]): string {
  const rs = records.filter(r => r.point === point)
  const judged = rs.filter(r => r.facts?.status !== undefined)
  const statuses = new Map<string, number>()
  for (const r of judged) statuses.set(r.facts!.status!, (statuses.get(r.facts!.status!) ?? 0) + 1)
  const shares = judged.filter(r => Number(r.facts?.docTokens) > 0).map(r => Number(r.facts?.outTokens) / Number(r.facts?.docTokens))
  const jevTokens = judged.reduce((sum, r) => sum + (r.usage?.input_tokens ?? 0), 0)
  const requests = judged.reduce((sum, r) => sum + Number(r.facts?.requests ?? 0), 0)
  const failed = judged.reduce((sum, r) => sum + Number(r.facts?.failed ?? 0), 0)
  const ms = judged.map(r => r.jevMs).filter((v): v is number => typeof v === 'number')
  const median = (values: number[]): number | undefined => percentile(values, 0.5)
  const share = median(shares)
  const lines = [
    `${point}: ${rs.length} records, ${judged.length} judged, ${rs.length - judged.length} not (${[...new Set(rs.filter(r => r.facts?.status === undefined).map(r => r.skipped ?? r.error ?? '?'))].join(', ') || '-'})`,
    `  status: ${[...statuses].map(([s, n]) => `${s} ${n}`).join(', ') || '-'}`,
    `  passed on: median ${share === undefined ? '-' : `${Math.round(share * 1000) / 10}%`} of the original's tokens`,
    `  Jev: ${requests} requests, ${failed} failed, ${jevTokens} input tokens; time median ${median(ms) ?? '-'} ms, p90 ${percentile(ms, 0.9) ?? '-'} ms`,
  ]
  const decisions = new Map<string, number>()
  for (const r of judged) if (r.decision !== undefined) decisions.set(r.decision, (decisions.get(r.decision) ?? 0) + 1)
  if (point !== 'web') lines.push(`  decision: ${[...decisions].map(([d, n]) => `${d} ${n}`).join(', ') || '-'}`)
  if (point === 'web') {
    const fetched = judged.filter(r => r.facts?.webFetchChars !== undefined)
    if (fetched.length > 0) {
      const wf = median(fetched.map(r => Number(r.facts!.webFetchChars)))
      lines.push(`  beside WebFetch: ${fetched.length} calls, WebFetch answer median ${wf ?? '-'} chars`)
    }
  }

  return lines.join('\n')
}

/**
 * What the compactions did, in the terms the person felt: how long each one
 * held the turn, and what it changed in the window.
 *
 * This is the measurement that replaced the statistics. The numbers come from
 * the engine — `tokensBefore` and `tokensAfter` as it counted them, and the
 * wall clock the plugin measured — so they describe this person's own sessions
 * rather than a sample of someone else's.
 */
export function compactReport(records: readonly ShadowRecord[]): string | undefined {
  const compactions = records.filter(r => r.point === 'compact')
  if (compactions.length === 0) return undefined
  const byTrigger = new Map<string, number>()
  for (const r of compactions) {
    const trigger = (r.facts as Record<string, string> | undefined)?.trigger ?? 'unknown'
    byTrigger.set(trigger, (byTrigger.get(trigger) ?? 0) + 1)
  }
  const summarized = compactions.filter(r => r.decision === 'summarized')
  const withTokens = compactions.flatMap(r => {
    const before = Number((r.facts as Record<string, string> | undefined)?.tokensBefore)
    const after = Number((r.facts as Record<string, string> | undefined)?.tokensAfter)

    return Number.isFinite(before) && Number.isFinite(after) ? [{ before, after }] : []
  })
  const saved = withTokens.map(({ before, after }) => before - after)

  const lines = [
    '## compact',
    `compactions ${compactions.length} (${[...byTrigger].map(([k, v]) => `${k} ${v}`).join(', ')}); ` +
      `summaries ${summarized.length}, folds alone ${compactions.length - summarized.length}`,
    `held the turn: p50 ${ms(percentile(compactions.map(r => r.hookMs), 0.5))}, p95 ${ms(percentile(compactions.map(r => r.hookMs), 0.95))}`,
  ]
  if (saved.length > 0) {
    lines.push(
      `window: ${withTokens.length} of ${compactions.length} compactions reported tokens; ` +
        `before p50 ${Math.round(percentile(withTokens.map(t => t.before), 0.5) ?? 0)}, after p50 ${Math.round(percentile(withTokens.map(t => t.after), 0.5) ?? 0)}, ` +
        `saved p50 ${Math.round(percentile(saved, 0.5) ?? 0)} tokens`,
    )
  } else {
    lines.push('window: no compaction reported token counts')
  }
  // D5: how soon one compaction follows another, to compare against later changes.
  const since = (name: string): number[] =>
    compactions.flatMap(r => {
      const value = Number((r.facts as Record<string, string> | undefined)?.[name])

      return (r.facts as Record<string, string> | undefined)?.[name] !== undefined && Number.isFinite(value) ? [value] : []
    })
  const [prompts, turns, times] = [since('sincePrompts'), since('sinceTurns'), since('sinceMs')]
  if (times.length > 0) {
    lines.push(
      `between compactions: prompts p50 ${percentile(prompts, 0.5) ?? '-'}, turns p50 ${percentile(turns, 0.5) ?? '-'}, time p50 ${seconds(percentile(times, 0.5))}, p95 ${seconds(percentile(times, 0.95))}`,
    )
  }

  return lines.join('\n')
}

/** A3: how many labeled stop judgments it takes before precision can demote the gate, and the bar. */
export const DEMOTE_LABELS = 150
export const DEMOTE_PRECISION = 0.9

/**
 * The Stop gate's precision over the labeled judgments: of those Jev flagged
 * at the threshold, the share the person labeled as real announcements.
 */
export function stopPrecision(records: readonly ShadowRecord[], labels: ReadonlyMap<string, boolean>, threshold: number): { labeled: number; flagged: number; precision?: number } {
  const judged = records.filter(r => r.point === 'stop' && typeof r.jev === 'number' && labels.has(r.id))
  const flagged = judged.filter(r => r.jev! >= threshold)

  return {
    labeled: judged.length,
    flagged: flagged.length,
    ...(flagged.length === 0 ? {} : { precision: flagged.filter(r => labels.get(r.id) === true).length / flagged.length }),
  }
}

/** Whether the labels say the Stop gate is wrong too often to hold turns. */
export function shouldDemoteStop(p: { labeled: number; precision?: number }): boolean {
  return p.labeled >= DEMOTE_LABELS && p.precision !== undefined && p.precision < DEMOTE_PRECISION
}

/**
 * A7: how long each gate waited on Jev and held its event, p50 and p95, from
 * the records of calls that went out.
 */
export function latencyReport(records: readonly ShadowRecord[], timeoutMs: number): string | undefined {
  const byPoint = new Map<string, ShadowRecord[]>()
  for (const r of records) if (typeof r.jevMs === 'number' && r.jevMs > 0) byPoint.set(r.point, [...(byPoint.get(r.point) ?? []), r])
  if (byPoint.size === 0) return undefined
  const lines = [`## latency (timeout ${timeoutMs} ms)`]
  for (const [point, rs] of [...byPoint].sort(([a], [b]) => a.localeCompare(b))) {
    const jev = rs.map(r => r.jevMs!)
    const hook = rs.map(r => r.hookMs)
    const late = rs.filter(r => r.error === 'timeout').length
    lines.push(`${point}: jev p50 ${ms(percentile(jev, 0.5))}, p95 ${ms(percentile(jev, 0.95))}; hook p50 ${ms(percentile(hook, 0.5))}, p95 ${ms(percentile(hook, 0.95))}; ${rs.length} calls, ${late} timed out`)
  }

  return lines.join('\n')
}
