import type { EngineInterface, Register, SessionMessage } from 'claude-code'

type Spec = { operation?: string; tools?: Record<string, unknown>[]; transcript?: SessionMessage[];
  instructions?: { path: string; kind: 'user' | 'project' | 'managed' | 'memory'; content: string }[];
  usage?: { percent?: number; window?: number }; stopFacts?: Record<string, unknown>; denyArchive?: boolean;
  caseId?: string; denyChmod?: boolean; failJev?: boolean; fastTimeout?: boolean; productHome?: string; mtimes?: Record<string, number>; emptyPrompt?: boolean; hideOrca?: boolean }
let sequence = 0
const specOf = async ($: EngineInterface): Promise<Spec> => {
  const path = await $.env.get('CH_DEVICE_SPEC_FILE')
  return path === undefined ? {} : JSON.parse(await $.fs.read(path)) as Spec
}
const record = async ($: EngineInterface, kind: string, value: unknown): Promise<void> => {
  const root = await $.env.get('CH_DEVICE_LOG_DIR')
  if (root === undefined) throw new Error('No device evidence directory')
  const spec = await specOf($)
  await $.fs.write(`${root}/${String(sequence++).padStart(6, '0')}.json`, JSON.stringify({ caseId: spec.caseId, kind, value }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'device', description: 'Run the declared evaluator fixture operation' })
    return next(e)
  })
  on('command.run', { command: 'device' }, async $ => {
    const spec = await specOf($)
    if (spec.operation === 'tools') {
      for (const request of spec.tools ?? []) {
        const result = await $.tool.call(request as never)
        await record($, 'tool-result', { request, result })
      }
    } else if (spec.operation === 'compact') {
      await $.command.run({ command: 'compact' })
    } else if (spec.operation === 'inspect') {
      await record($, 'transcript-after', await $.session.messages())
    } else if (spec.operation === 'invalidate') {
      $.ui.invalidate('prompt.context')
    }
    await record($, 'command-complete', { operation: spec.operation ?? 'ping', session: await $.session.id() })
    return { text: `Device fixture ${spec.operation ?? 'ping'} completed.` }
  })
  on('session.compact', async ($, e, next) => {
    const spec = await specOf($)
    const messages = spec.transcript ?? e.messages
    await record($, 'compact-input', { trigger: e.trigger, synthetic: spec.transcript !== undefined, messages })
    const result = await next({ ...e, messages })
    await record($, 'compact-result', result)
    return result
  })
  on('session.messages', async ($, e, next) => {
    const spec = await specOf($)
    return next.origin.plugin === 'context-harness' && e.as !== 'api' && spec.transcript !== undefined
      ? { value: spec.transcript as never } : next(e)
  })
  on('session.usage', async ($, e, next) => {
    const below = await next(e)
    const spec = await specOf($)
    return next.origin.plugin === 'context-harness' && spec.usage && 'value' in below && below.value
      ? { value: { ...below.value, context: { ...below.value.context, ...spec.usage } } } : below
  })
  on('prompt.context', async ($, e, next) => {
    const spec = await specOf($)
    if (spec.instructions === undefined) return next(e)
    await record($, 'instruction-input', { synthetic: true, files: spec.instructions })
    return next({ ...e, instructionFiles: spec.instructions })
  })
  on('prompt.submit', async ($, e, next) => {
    const spec = await specOf($)
    const effective = spec.emptyPrompt ? { ...e, text: '' } : e
    await record($, 'prompt-input', { original: e, effective })
    if (spec.emptyPrompt) await record($, 'empty-prompt-input', { originalText: e.text, injectedText: '' })
    return next(effective)
  })
  on('classic.Stop', async ($, e, next) => {
    const spec = await specOf($)
    const facts = spec.stopFacts ?? {}
    const allowed = ['permission_mode', 'background_tasks', 'session_crons', 'stop_hook_active']
    if (Object.keys(facts).some(key => !allowed.includes(key))) throw new Error('Unsupported Stop stimulus field')
    await record($, 'stop-input', { syntheticFacts: facts, original: e })
    return next({ ...e, ...facts })
  })
  on('fs.write', async ($, e, next) => {
    const spec = await specOf($)
    if (spec.denyArchive && e.path.includes('/.local/state/context-harness/archive/')) {
      await record($, 'archive-write-refused', { path: e.path })
      return { deny: 'Evaluator-injected archive write failure' }
    }
    if (next.origin.plugin === 'context-harness' && e.path.includes('/archive/')) await record($, 'archive-before-write', { path: e.path })
    return next(e)
  })
  on('process.run', async ($, e, next) => {
    const spec = await specOf($)
    if (next.origin.plugin !== 'context-harness') return next(e)
    if (spec.denyChmod && e.argv[0] === 'chmod') {
      await record($, 'process-return', { argv: e.argv, syntheticFailure: true, exitCode: 1 })
      return { value: { exitCode: 1, stdout: '', stderr: 'Evaluator chmod fault', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const result = await next(e)
    if (e.argv[0] === 'mkdir' || e.argv[0] === 'chmod') await record($, 'process-return', { argv: e.argv, result })
    return result
  })
  on('env.get', async ($, e, next) => {
    if (next.origin.plugin !== 'context-harness' || !['HOME','ORCA_CLI_COMMAND','ORCA_DEV_REPO_ROOT'].includes(e.name)) return next(e)
    const spec = await specOf($)
    if (spec.hideOrca && e.name !== 'HOME') return { value: undefined }
    return e.name === 'HOME' && spec.productHome ? { value: spec.productHome } : next(e)
  })
  on('fs.stat', async ($, e, next) => {
    const result = await next(e)
    if (next.origin.plugin !== 'context-harness') return result
    const spec = await specOf($)
    const mtime = spec.mtimes?.[e.path]
    return mtime !== undefined && 'value' in result && result.value ? { value: { ...result.value, mtimeMs: mtime } } : result
  })
  on('fs.list', async ($, e, next) => {
    const result = await next(e)
    if (next.origin.plugin !== 'context-harness') return result
    const spec = await specOf($)
    return spec.mtimes && 'value' in result && result.value ? { value: result.value.map(file => ({ ...file, mtimeMs: spec.mtimes?.[`${e.path}/${file.name}`] ?? file.mtimeMs })) } : result
  })
  on('clock.sleep', async ($, e, next) => {
    const spec = await specOf($)
    if (next.origin.plugin === 'context-harness' && spec.fastTimeout) {
      await record($, 'timeout-injected', { ms: e.ms })
      return { value: undefined }
    }
    return next(e)
  })
  on('ui.status', async ($, e, next) => {
    if (next.origin.plugin === 'context-harness') await record($, 'status-request', { text: e.text })
    return next(e)
  })
  on('http.fetch', async ($, e, next) => {
    if (e.url !== 'https://api.typesafe.ai/v1/systemone') return next(e)
    const spec = await specOf($)
    const request = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    if (spec.failJev) {
      await record($, 'jev-fault', { synthetic: true, request, status: 503 })
      return { value: { status: 503, ok: false, headers: {}, text: 'Evaluator HTTP failure' } }
    }
    const result = await next(e)
    if ('value' in result && result.value !== undefined) {
      let response: unknown
      try { response = JSON.parse(result.value.text) } catch { response = { status: result.value.status } }
      await record($, 'jev-response', { request, response })
    }
    return result
  })
}
