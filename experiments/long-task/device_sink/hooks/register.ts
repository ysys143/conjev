import type { Register } from 'claude-code'
export const register: Register = on => {
  let sequence = 0
  on('prompt.context', async ($, e, next) => {
    const below = await next(e)
    const root = await $.env.get('CH_DEVICE_LOG_DIR')
    if (root !== undefined) await $.fs.write(`${root}/sink-${String(sequence++).padStart(6, '0')}.json`, JSON.stringify({ kind: 'instruction-delivered', value: below.instructionFiles ?? e.instructionFiles ?? [] }))
    return below
  })
  on('prompt.submit', async ($, e, next) => {
    const path = await $.env.get('CH_DEVICE_SPEC_FILE')
    const spec = path === undefined ? {} : JSON.parse(await $.fs.read(path)) as Record<string, unknown>
    return spec.emptyPrompt === true ? next({ ...e, text: 'Controlled empty-input hook diagnostic is complete. Reply OK.' }) : next(e)
  })
  on('session.compact', async ($, e, next) => {
    const path = await $.env.get('CH_DEVICE_SPEC_FILE')
    const spec = path === undefined ? {} : JSON.parse(await $.fs.read(path)) as Record<string, unknown>
    const root = await $.env.get('CH_DEVICE_LOG_DIR')
    if (root !== undefined) await $.fs.write(`${root}/sink-${String(sequence++).padStart(6, '0')}.json`, JSON.stringify({ kind: 'summary-input', value: { messages: e.messages, skipped: spec.skipCore === true } }))
    return spec.skipCore === true ? { skip: 'Evaluator-injected compaction veto' } : next(e)
  })
  on('classic.Stop', async ($, e, next) => {
    const path = await $.env.get('CH_DEVICE_SPEC_FILE')
    const spec = path === undefined ? {} : JSON.parse(await $.fs.read(path)) as Record<string, unknown>
    return spec.stopBelowOnce === true && !e.stop_hook_active ? { block: 'Evaluator underlying Stop block' } : next(e)
  })
  on('tool.call', async ($, e, next) => {
    const path = await $.env.get('CH_DEVICE_SPEC_FILE')
    const spec = path === undefined ? {} : JSON.parse(await $.fs.read(path)) as Record<string, unknown>
    const tool = String(e.tool)
    return Array.isArray(spec.stubTools) && spec.stubTools.includes(tool)
      ? { result: 'Synthetic tool-kind fixture; no browser, web, Orca or nested LLM operation was performed.', isReadOnly: true }
      : next(e)
  })
}
