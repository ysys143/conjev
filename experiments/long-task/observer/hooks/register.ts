import type { EngineInterface, Register } from 'claude-code'

const endpoint = async ($: EngineInterface): Promise<string> => {
  const url = await $.env.get('CONTEXT_HARNESS_EVAL_URL')
  if (url === undefined || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('No evaluator endpoint')
  return url
}

const post = async ($: EngineInterface, path: string, body: unknown): Promise<Record<string, unknown>> => {
  const response = await $.http.fetch(`${await endpoint($)}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error('Evaluator evidence incomplete')
  return JSON.parse(response.text) as Record<string, unknown>
}

export const register: Register = on => {
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    try {
      await post($, '/lifecycle', { name: 'instruction-inventory',
        files: (result.instructionFiles ?? e.instructionFiles ?? []).map(file => ({ path: file.path, kind: file.kind, content: file.content })),
        blocks: (result.blocks ?? []).map(block => ({ name: block.name, text: block.text })) })
    } catch {}
    return result
  })

  on('command.run', { command: 'compact' }, async ($, e, next) => {
    try { await post($, '/lifecycle', { name: 'compact-command-before', origin: e.origin }) } catch {}
    const result = await next(e)
    try { await post($, '/lifecycle', { name: 'compact-command-after', origin: e.origin }) } catch {}
    return result
  })

  on('command.run', async ($, e, next) => {
    const result = await next(e)
    if (e.command === 'jev-report' || e.command === 'context-harness:jev-report') {
      try { await post($, '/lifecycle', { name: 'jev-report-output', command: e.command, text: result.text }) } catch {}
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    try { await post($, '/lifecycle', { name: 'compact-before', trigger: e.trigger, agent_id: e.agentId }) } catch {}
    const result = await next(e)
    const pointers = result.messages?.flatMap(m => m.toolResults ?? []).filter(r => r.text.startsWith('[folded ')).length ?? 0
    try { await post($, '/lifecycle', { name: 'compact-after', pointers, skipped: result.skip }) } catch {}
    return result
  })

  on('session.append', async ($, e, next) => {
    const result = await next(e)
    try { await post($, '/lifecycle', { name: 'session-appended', message: e.message }) } catch {}
    return result
  })

  on('classic.Stop', async ($, e, next) => {
    if (e.agent_id !== undefined) return next(e)
    const started = await $.clock.now()
    // A failed observer must never manufacture a block or call next twice.
    let candidate: Record<string, unknown> | undefined
    try {
      candidate = await post($, '/candidate', { event: e, messages: await $.session.messages({ as: 'api' }) })
    } catch { /* Missing observations fail the evaluator's census. */ }
    const before = await $.clock.now()
    const result = await next(e)
    const after = await $.clock.now()
    if (candidate !== undefined) {
      try {
        await post($, '/decision', { candidate_id: candidate.candidate_id, result,
          pre_observer_ms: before - started, underlying_ms: after - before })
      } catch { /* The underlying result is still returned byte-for-byte. */ }
    }
    return result
  })

  on('http.fetch', async ($, e, next) => {
    if (e.url !== 'https://api.typesafe.ai/v1/systemone') return next(e)
    // Never send credentials to the evaluator. Reserve before forwarding the
    // original request, including when the plugin later times out waiting for it.
    const request = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    const longContext = Object.entries(e.init?.headers ?? {}).some(([k, v]) =>
      k.toLowerCase() === 'typesafe-danger-zone-long-context' && v.toLowerCase() === 'true')
    let reserved: Record<string, unknown>
    try {
      reserved = await post($, '/reserve', { request, long_context: longContext })
    } catch {
      return { deny: 'The study-wide Jev reservation did not succeed.' }
    }
    const result = await next(e)
    if ('value' in result && result.value !== undefined && result.value.ok) {
      try {
        const response = JSON.parse(result.value.text) as Record<string, unknown>
        await post($, '/settle', { call_id: reserved.call_id, response: { model: response.model, usage: response.usage } })
      } catch { /* Unknown spend retains the full reservation. */ }
    }
    return result
  })
}
