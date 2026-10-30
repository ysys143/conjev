// Experiment: what is left in place of a folded tool result after a
// compaction, by arm (CHX_ARM). hooks/fold.ts is copied from the plugin's
// own hooks/fold.ts by run-trial.sh, so the fold is the shipped one.
//
//   K   no compaction is run (the driver skips /compact)
//   S   the engine summarizes, as Claude Code does without a plugin
//   F0  folded; the result becomes "[folded]", the tool call stays, no note
//   F1  folded as context-harness 0.0.2 does: pointer line and the note
import type { EngineInterface, Register, SessionMessage } from 'claude-code'
import { DEFAULT_SETTINGS, FOLD_MARK, foldTranscript, makePolicy, sliceLines, type Archived } from './fold'

const fileId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_')

export async function armOf($: EngineInterface): Promise<string> {
  return (await $.env.get('CHX_ARM')) ?? 'F1'
}

// Under the folder run-trial.sh writes to (CHX_RUNS), or runs/ beside the mod.
export async function archiveOf($: EngineInterface): Promise<string> {
  return `${(await $.env.get('CHX_RUNS')) ?? `${$.plugin.root}/../runs`}/archive`
}

export async function keep($: EngineInterface, archived: readonly Archived[]): Promise<void> {
  const dir = `${await archiveOf($)}/${fileId(await $.session.id())}`
  for (const item of archived) await $.fs.write(`${dir}/${fileId(item.id)}.json`, JSON.stringify(item))
}

export async function noteAfter($: EngineInterface, folded: number): Promise<void> {
  const text = `[context-harness] This conversation was just compacted; ${folded} tool results were folded into one-line pointers (read_coordinate returns the originals).`
  $.clock.after(1000, () => {
    void $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
  })
}

// F0: the pointer says nothing about what was there.
const bare = (messages: readonly SessionMessage[]): SessionMessage[] =>
  messages.map(m =>
    m.role === 'user' && (m.toolResults ?? []).some(r => r.text.startsWith(FOLD_MARK))
      ? { ...m, toolResults: (m.toolResults ?? []).map(r => (r.text.startsWith(FOLD_MARK) ? { ...r, text: '[folded]' } : r)) }
      : m,
  )

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'read_coordinate',
      description:
        'Return the original text of a tool result that was folded into a line like ' +
        '[folded Read · src/a.ts · 412 lines — read_coordinate("toolu_…")]. ' +
        'Pass that id. offset (1-based line) and limit (lines, default 400) select a part.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The id inside read_coordinate("…") of the folded line' },
          offset: { type: 'number', description: 'First line to return, 1-based' },
          limit: { type: 'number', description: 'How many lines to return' },
        },
        required: ['id'],
      },
      isDeferred: false,
    })

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const arm = await armOf($)
    if (arm !== 'F0' && arm !== 'F1') return next(e)
    const outcome = foldTranscript(e.messages, makePolicy(DEFAULT_SETTINGS))
    if (outcome.archived.length === 0) return next(e)
    await keep($, outcome.archived)
    if (arm === 'F0') return { messages: bare(outcome.messages) }
    await noteAfter($, outcome.archived.length)

    return { messages: outcome.messages }
  })

  on('tool.call', { tool: 'mcp__chx__read_coordinate' as never }, async ($, e) => {
    const input = e as unknown as { id?: unknown; offset?: unknown; limit?: unknown }
    const id = typeof input.id === 'string' ? input.id : ''
    const path = `${await archiveOf($)}/${fileId(await $.session.id())}/${fileId(id)}.json`
    if (id === '' || !(await $.fs.exists(path))) return { isError: true, result: `No folded result is kept under "${id}".` }
    const item = JSON.parse(await $.fs.read(path)) as Archived
    const part = sliceLines(item.text, typeof input.offset === 'number' ? input.offset : 1, typeof input.limit === 'number' ? input.limit : 400)

    return { isReadOnly: true, result: `${item.tool} ${JSON.stringify(item.input)} — lines ${part.from}-${part.to} of ${part.total}\n${part.body}` }
  })
}
