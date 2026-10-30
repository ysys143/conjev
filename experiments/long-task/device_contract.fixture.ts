// Copied as a test into an evaluator-owned product copy by device_contract.py.
// Expectations are declared independently of the product's decision helpers.
import type { HttpResponse } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { drain, setup, type Setup } from './kit'
import { cases } from './device-cases'

type Row = Record<string, any>
type Rule = { source: string; where?: Row; count?: number; equals?: any; contains?: string; excludes?: string; all?: Row; ordered?: string[] }
const at = (value: any, path: string): any => path.split('.').reduce((v, key) => v?.[key], value)
const same = (a: any, b: any): boolean => JSON.stringify(a) === JSON.stringify(b)
const matches = (row: any, fields: Row): boolean => Object.entries(fields).every(([key, value]) => same(at(row, key), value))
export const failures = (snapshot: Row, rules: Rule[]): string[] => rules.flatMap((rule, n) => {
  if (!(rule.source in snapshot)) return [`${n}: missing ${rule.source}`]
  let value = snapshot[rule.source]
  if (rule.where !== undefined) {
    if (!Array.isArray(value)) return [`${n}: not an array: ${rule.source}`]
    value = value.filter(v => matches(v, rule.where!))
  }
  const why: string[] = []
  if (rule.count !== undefined && (!Array.isArray(value) || value.length !== rule.count)) why.push(`count expected ${rule.count}, got ${Array.isArray(value) ? value.length : 'non-array'}`)
  if ('equals' in rule && !same(value, rule.equals)) why.push('unequal value')
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (rule.contains !== undefined && !text.includes(rule.contains)) why.push(`missing text ${rule.contains}`)
  if (rule.excludes !== undefined && text.includes(rule.excludes)) why.push(`unexpected text ${rule.excludes}`)
  if (rule.ordered !== undefined) {
    let cursor = -1
    for (const part of rule.ordered) {
      const found = text.indexOf(part, cursor + 1)
      if (found < 0) why.push(`missing ordered text ${part}`)
      else cursor = found
    }
  }
  if (rule.all !== undefined && (!Array.isArray(value) || value.length === 0 || !value.every(v => matches(v, rule.all!)))) why.push('row fields differ')
  return why.map(w => `${n}: ${rule.source}: ${w}`)
})

// An independent preservation oracle: message count/order, roles, text, calls
// and result metadata stay identical; the only permitted change is an archived
// result's body becoming a pointer to that exact id. No product helper is used.
const foldFailures = (before: Row[], after: Row[], archives: Row[]): string[] => {
  const errors: string[] = []
  if (before.length !== after.length) return ['message count changed']
  const byId = new Map(archives.map(a => [a.id, a]))
  for (let i = 0; i < before.length; i++) {
    const original = before[i]!, changed = after[i]!
    const oldResults = original.toolResults ?? [], newResults = changed.toolResults ?? []
    if (!same({ ...original, toolResults: undefined }, { ...changed, toolResults: undefined })) errors.push(`message ${i} changed outside results`)
    if (oldResults.length !== newResults.length) errors.push(`message ${i} lost result`)
    for (let j = 0; j < oldResults.length; j++) {
      const a = oldResults[j], b = newResults[j]
      if (b === undefined) continue
      const kept = byId.get(a.tool_use_id)
      if (!same({ ...a, text: undefined }, { ...b, text: undefined })) errors.push(`result ${a.tool_use_id} metadata changed`)
      if (a.text === b.text) {
        if (kept) errors.push(`archived result ${a.tool_use_id} was not replaced by a pointer`)
        continue
      }
      if (!kept || kept.text !== a.text || kept.isError !== a.isError) errors.push(`result ${a.tool_use_id} original not archived exactly`)
      const call = before.flatMap(m => m.toolUses ?? []).find(t => t.tool_use_id === a.tool_use_id)
      if (!call || kept?.tool !== call.tool || !same(kept?.input, call.input)) errors.push(`result ${a.tool_use_id} call differs`)
      if (!String(b.text).startsWith('[folded ') || !String(b.text).endsWith(`read_coordinate("${a.tool_use_id}")]`)) errors.push(`result ${a.tool_use_id} pointer lost`)
    }
  }
  return errors
}

const response = (recipe: Row, body: Row): HttpResponse | Promise<HttpResponse> => {
  if (recipe.http === 'timeout') return new Promise(() => undefined)
  if (recipe.http === 'error') return { status: 503, ok: false, headers: {}, text: 'controlled unavailable' }
  const answers = Object.fromEntries(Object.entries(body.questions ?? {}).map(([name, question]) => {
    const labels = Object.keys((question as Row).criteria ?? {})
    let probabilities: Row
    if (name === 'stop') probabilities = { announce: recipe.announce ?? 0.01, report: 1 - (recipe.announce ?? 0.01) }
    else if (name === 'data') probabilities = recipe.restricted ? { open: 0.01, internal: 0, restricted: 0.99, custom: 0 } : { open: 0.99, internal: 0.01, restricted: 0, custom: 0 }
    else if (name.startsWith('r')) probabilities = { needed: 0.3, done: 0.7 }
    else if (/^s\d+$/.test(name)) probabilities = { conditional: recipe.scope ?? 0.99, always: 1 - (recipe.scope ?? 0.99) }
    else if (/^c\d+$/.test(name)) probabilities = { covered: recipe.cover ?? 0.99, partly: 0, new: 1 - (recipe.cover ?? 0.99) }
    else probabilities = { applies: recipe.applies ?? 0.99, not: 1 - (recipe.applies ?? 0.99) }
    const available = Object.fromEntries(labels.map(k => [k, probabilities[k] ?? 0]))
    const choice = labels.reduce((best, k) => available[k] > (available[best] ?? -1) ? k : best, labels[0] ?? '')
    return [name, { type: 'choice', choice, confidence: 0.99, probabilities: available }]
  }))
  return { status: 200, ok: true, headers: {}, text: JSON.stringify({ model: 'jev-1.14.0', answers, usage: { input_tokens: 400, output_tokens: 40 } }) }
}

for (const c of cases as Row[]) test(`device ${c.id}`, { options: c.options }, async ($, on) => {
  const recipe = c.response ?? {}
  const state = c.setup as Setup
  const io = setup(on, { ...state, fetch: body => response(recipe, body) })
  const outputs: Row[] = []
  const transitions: { before: Row[]; after: Row[]; archives: Row[] }[] = []
  for (const step of c.steps) {
    if (step.event === 'mutate-files') {
      Object.assign(io.files, step.files)
      if (step.mtimes) Object.assign(state.mtimes ??= {}, step.mtimes)
    } else if (step.event === 'mutate-env') Object.assign(io.env, step.values)
    else if (step.event === 'clear-api') io.api.length = 0
    else {
      const [group, method] = step.event.split('.')
      const cursor = io.summarizedInputs.length
      const output = await ($ as any)[group][method](step.input ?? {})
      outputs.push(output)
      if (step.event === 'session.compact') {
        const below = io.summarizedInputs[cursor]
        const after = below ?? output.messages
        if (after !== undefined) transitions.push({ before: step.input.messages, after,
          archives: io.writes.filter(w => w.path.includes('/archive/')).map(w => JSON.parse(w.text)) })
      }
    }
    await drain()
  }
  // Settles background chains and delayed one-second notes/automatic compactions
  // through the engine test runtime's clock, without serving an LLM request.
  for (let i = 0; i < 4; i++) await drain()
  const records = io.writes.filter(w => w.path.includes('/records/')).map(w => JSON.parse(w.text))
  const archives = io.writes.filter(w => w.path.includes('/archive/')).map(w => ({ path: w.path, ...JSON.parse(w.text) }))
  const snapshot: Row = { outputs, records, archives, fetches: io.fetches.map(f => f.body),
    disk: io.disk, runs: io.runs, loaded: io.loaded, submitted: io.submitted, appended: io.appended,
    commands: io.commands, statuses: io.statuses, sleeps: io.sleeps, order: io.order }
  const rules = c.assertions as Rule[]
  const failed = failures(snapshot, rules)
  if (failed.length > 0) throw new Error(JSON.stringify({ failed, outputs: snapshot.outputs, records: snapshot.records, appended: snapshot.appended }))
  for (const t of transitions) {
    expect(foldFailures(t.before, t.after, t.archives)).toEqual([])
    const changed = JSON.parse(JSON.stringify(t.after)) as Row[]
    const pointer = changed.flatMap(m => m.toolResults ?? []).find(r => String(r.text).startsWith('[folded ') && !t.before.flatMap(m => m.toolResults ?? []).some(o => o.text === r.text))
    if (pointer !== undefined) {
      pointer.text = 'POINTER REMOVED'
      expect(foldFailures(t.before, changed, t.archives).length > 0).toBe(true)
    }
    const lostCall = JSON.parse(JSON.stringify(t.after)) as Row[]
    const called = lostCall.find(m => m.toolUses?.length > 0)
    if (called) {
      called.toolUses = []
      expect(foldFailures(t.before, lostCall, t.archives).length > 0).toBe(true)
    }
  }
  // Every assertion must reject loss of its own original evidence, including
  // rules for legitimate zero-record paths. Zero is never inferred from missing data.
  for (const rule of rules) {
    const corrupt = { ...snapshot }
    delete corrupt[rule.source]
    expect(failures(corrupt, [rule]).length).toBe(1)
  }
  // Specific content-loss probes: a removed pointer, note/continuation, unique
  // instruction or record must be rejected even when the evidence file exists.
  for (const rule of rules) {
    if (rule.contains === undefined) continue
    const corrupt = JSON.parse(JSON.stringify(snapshot))
    // Replacing the evidence value is also valid for structural JSON strings;
    // replacing serialized substrings can accidentally make invalid JSON.
    corrupt[rule.source] = 'CORRUPTED'
    expect(failures(corrupt, [rule]).length > 0).toBe(true)
  }
  if (records.length > 0 && rules.some(r => r.source === 'records' && r.count !== undefined)) {
    const corrupt = { ...snapshot, records: records.slice(1) }
    expect(failures(corrupt, rules).length > 0).toBe(true)
  }
  if (c.id === 'stop-active.announce-retry-once') {
    expect(failures({ ...snapshot, outputs: outputs.slice(0, 1) }, rules).length > 0).toBe(true)
  }
  if (c.id === 'instruction-filter-deterministic.unique-preserved') {
    const corrupt = JSON.parse(JSON.stringify(snapshot))
    corrupt.loaded[0][0].content = corrupt.loaded[0][0].content.replace('DEVICE-UNIQUE', '')
    expect(failures(corrupt, rules).length > 0).toBe(true)
  }
})
