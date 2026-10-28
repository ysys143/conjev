import { expect, test } from 'claude-code/testing'
import {
  chunksOf,
  exactDuplicates,
  isAlwaysKept,
  omcVersionOf,
  signatureOfChunk,
  signatureOfTool,
  supersededOmc,
  tokenEstimate,
  withoutChunks,
  wouldApply,
  type Chunk,
  type DocFile,
} from '../hooks/instruction-docs'
import { attachedNames } from '../hooks/instructions'
import { scrubInstruction } from '../hooks/filter-flow'
import { AGENTS, omc } from './fixtures'

const file = (path: string, kind: DocFile['kind'], content: string): DocFile => ({ path, kind, content })
const paths = (chunks: readonly Chunk[]): string[] => chunks.map(c => c.headingPath.join(' > '))

test('chunks follow the heading tree and tag blocks that stand alone on their lines', () => {
  const chunks = chunksOf([file('/u/AGENTS.md', 'user', AGENTS), file('/u/CLAUDE.md', 'user', omc())])
  expect(paths(chunks)).toEqual([
    '# AGENTS.md — rules',
    '# AGENTS.md — rules > ## 사용자 정체성',
    '# AGENTS.md — rules > ## 언어',
    '# AGENTS.md — rules > ## 도구 우선순위',
    '# AGENTS.md — rules > ## 도구 우선순위 > ### 브라우저 자동화',
    '# AGENTS.md — rules > ## 도구 우선순위 > ### 웹 페이지 가져오기',
    '# AGENTS.md — rules > ## 도구 우선순위 > ### Orca 오케스트레이션',
    '# AGENTS.md — rules > ## LLM 호출 경로',
    '# oh-my-claudecode - Intelligent Multi-Agent Orchestration',
    '# oh-my-claudecode - Intelligent Multi-Agent Orchestration > <operating_principles>',
    '# oh-my-claudecode - Intelligent Multi-Agent Orchestration > <verification>',
    '# oh-my-claudecode - Intelligent Multi-Agent Orchestration > ## Setup',
  ])
  // A heading with only subsections under it says nothing on its own.
  expect(chunks.find(c => c.headingPath.at(-1) === '## 도구 우선순위')?.isTrivial).toBe(true)
  // Every chunk is the file's own text, end to end.
  const own = chunks.filter(c => c.file === '/u/AGENTS.md')
  expect(own.map(c => c.text).join('')).toBe(AGENTS)
})

test('headings in a code fence and placeholders in angle brackets do not split a section', () => {
  const text = '## 셸 명령\n\nRun it as is:\n\n```sh\n## not a heading\n<name>\n```\n\nUse `<name>` folders.\n<category>\nStill the same section.\n'
  const chunks = chunksOf([file('/u/A.md', 'user', text)])
  expect(chunks.length).toBe(1)
  expect(chunks[0]?.text).toBe(text)
})

test('a long section splits into its lead and groups of top-level bullets, each at most 800 characters', () => {
  const bullets = Array.from({ length: 12 }, (_, i) => `- Rule ${i}: ${'x'.repeat(120)}\n  continued on a second line.`).join('\n')
  const text = `## 자율 실행\n\nLead paragraph.\n\n${bullets}\n`
  const chunks = chunksOf([file('/u/A.md', 'user', text)])
  expect(chunks.length > 1).toBe(true)
  for (const chunk of chunks) expect(chunk.text.length <= 800).toBe(true)
  expect(chunks.map(c => c.text).join('')).toBe(text)
  expect(chunks[0]?.headingPath.at(-1)).toBe(`## 자율 실행 (1/${chunks.length})`)
  // A split part of an always-kept section is always kept.
  for (const chunk of chunks) expect(isAlwaysKept(chunk)).toBe(true)
})

test('chunk ids are ASCII, stable, and read back as attached fragment names', () => {
  const a = chunksOf([file('/u/AGENTS.md', 'user', AGENTS)])
  const b = chunksOf([file('/u/AGENTS.md', 'user', AGENTS)])
  expect(a.map(c => c.id)).toEqual(b.map(c => c.id))
  for (const chunk of a) {
    expect(/^doc-[0-9a-f]{8}$/.test(chunk.id)).toBe(true)
    const block = `<instruction name="${chunk.id}" source="conjev">\nx\n</instruction>`
    expect([...attachedNames([{ role: 'user', content: [{ type: 'text', text: block }] }])]).toEqual([chunk.id])
  }
})

test('a chunk loaded twice keeps its first copy; organization and memory files are never cut', () => {
  const managed = file('/etc/CLAUDE.md', 'managed', '## 문체\n\nLead with the result, then give the evidence.\n')
  const user = file('/u/AGENTS.md', 'user', '## 문체\n\nLead   with the result, then give the evidence.\n\n## 산출물\n\nWrite reports in Markdown, always.\n')
  const project = file('/p/AGENTS.md', 'project', '## 산출물\n\nWrite reports in Markdown, always.\n')
  const memory = file('/u/MEMORY.md', 'memory', '## 산출물\n\nWrite reports in Markdown, always.\n')
  const chunks = chunksOf([managed, user, project, memory])
  const drops = exactDuplicates(chunks)
  const dropped = chunks.filter(c => drops.has(c.id)).map(c => `${c.file} ${c.headingPath.at(-1)}`)
  expect(dropped).toEqual(['/u/AGENTS.md ## 문체', '/p/AGENTS.md ## 산출물'])
  for (const [id, kept] of drops) expect(kept.id === id).toBe(false)

  const out = withoutChunks([managed, user, project, memory], chunks, drops, '/u')
  expect(out[0]).toBe(managed)
  expect(out[3]).toBe(memory)
  expect(out[1]?.content).toBe('[conjev: left out "문체", loaded from /etc/CLAUDE.md]\n\n## 산출물\n\nWrite reports in Markdown, always.\n')
  expect(out[2]?.content).toBe('[conjev: left out "산출물", loaded from ~/AGENTS.md]\n\n')
})

test('an organization file loaded after a copy of its section is never cut, by the duplicate rule or by any drop', () => {
  const user = file('/u/AGENTS.md', 'user', '## 문체\n\nLead with the result, then give the evidence.\n')
  const managed = file('/etc/CLAUDE.md', 'managed', '## 문체\n\nLead   with the result, then give the evidence.\n\n## 산출물\n\nWrite reports in Markdown, always.\n')
  const project = file('/p/AGENTS.md', 'project', '## 산출물\n\nWrite reports in Markdown, always.\n')
  const chunks = chunksOf([user, managed, project])
  const drops = exactDuplicates(chunks)
  expect(chunks.filter(c => drops.has(c.id)).map(c => c.file)).toEqual(['/p/AGENTS.md'])

  // Even a drop that names its chunks, as a judgment's would, leaves the file whole.
  const every = new Map(chunks.filter(c => c.file === managed.path).map(c => [c.id, chunks[0]!]))
  expect(withoutChunks([user, managed, project], chunks, every, '/u')[1]).toBe(managed)
  expect(withoutChunks([user, managed, project], chunks, drops, '/u')[1]).toBe(managed)
})

test('of two OMC blocks at different versions, the older one leaves whole', () => {
  const older = file('/u/.claude-3/CLAUDE.md', 'user', omc())
  const newer = file('/u/.claude/CLAUDE.md', 'project', omc('\n- A rule the newer version added.'))
  const chunks = chunksOf([older, newer])
  const versions = new Map([
    [older.path, omcVersionOf('<!-- OMC:VERSION:5.2.0 -->')!],
    [newer.path, omcVersionOf('<!-- OMC:START -->\n<!-- OMC:VERSION:5.7.8 -->')!],
  ])
  const drops = supersededOmc(chunks, versions)
  expect(chunks.filter(c => drops.has(c.id)).every(c => c.file === older.path)).toBe(true)
  expect(drops.size).toBe(chunks.filter(c => c.file === older.path).length)
  expect(supersededOmc(chunks, new Map([[older.path, '5.7.8'], [newer.path, '5.7.8']])).size).toBe(0)
  expect(omcVersionOf('no marker')).toBe(undefined)
})

test('an organization file is never superseded by a newer OMC block elsewhere', () => {
  // The managed file's own OMC block is older, but nothing this plugin does may
  // drop it: only user, project and local files are changeable.
  const managed = file('/etc/claude/managed.md', 'managed', omc())
  const newer = file('/u/.claude/CLAUDE.md', 'project', omc('\n- A rule the newer version added.'))
  const chunks = chunksOf([managed, newer])
  const versions = new Map([
    [managed.path, omcVersionOf('<!-- OMC:VERSION:5.2.0 -->')!],
    [newer.path, omcVersionOf('<!-- OMC:START -->\n<!-- OMC:VERSION:5.7.8 -->')!],
  ])
  const drops = supersededOmc(chunks, versions)

  expect([...drops.values()].some(chunk => chunk.file === managed.path)).toBe(false)
  expect(chunks.filter(c => c.file === managed.path && drops.has(c.id)).length).toBe(0)
})

const one = (heading: string, kind: DocFile['kind'] = 'user', body = 'Some instruction that is long enough to count.'): Chunk =>
  chunksOf([file('/u/A.md', kind, `${heading}\n\n${body}\n`)])[0]!

test('what would be applied: rules that stay in view, Orca by its environment, defer before drop, never a narrower tier', () => {
  const at = { inOrca: false, threshold: 0.95 }
  for (const heading of ['## 언어', '## 사용자 정체성', '## 자율 실행', '## 질문에는 먼저 답한다', '### 셸 명령', '## Git', '## API 키', '### 브라우저 자동화', '## 응답 언어 (AGENTS.md 언어 절의 중복 강조)']) {
    expect(wouldApply(one(heading), { conditional: 0.99, covered: 0.99 }, at).decision).toBe('keep')
  }
  expect(wouldApply(one('### Orca 오케스트레이션'), {}, at)).toEqual({ decision: 'defer', reason: 'not in an Orca session' })
  expect(wouldApply(one('### Orca 오케스트레이션'), {}, { ...at, inOrca: true }).decision).toBe('keep')
  expect(wouldApply(one('### 웹 페이지 가져오기'), { conditional: 0.99, covered: 0.99 }, at).decision).toBe('defer')
  expect(wouldApply(one('## LLM 호출 경로'), { conditional: 0.2, covered: 0.99 }, at).decision).toBe('drop')
  expect(wouldApply(one('## LLM 호출 경로', 'project'), { conditional: 0.2, covered: 0.99 }, at)).toEqual({ decision: 'keep', reason: 'covered 0.99, but project tier' })
  expect(wouldApply(one('## LLM 호출 경로'), { conditional: 0.94, covered: 0.94 }, at).decision).toBe('keep')
  expect(wouldApply(one('## LLM 호출 경로'), {}, at).reason).toBe('not judged')
})

test('the kind of work a chunk governs, and a tool use that shows it', () => {
  const chunks = chunksOf([file('/u/AGENTS.md', 'user', AGENTS)])
  const sig = (heading: string) => signatureOfChunk(chunks.find(c => c.headingPath.at(-1) === heading)!)
  expect([sig('### 브라우저 자동화'), sig('### 웹 페이지 가져오기'), sig('### Orca 오케스트레이션'), sig('## LLM 호출 경로'), sig('## 언어')]).toEqual(['browser', 'web', 'orca', 'llm', undefined])
  expect(signatureOfTool('WebFetch', { url: 'https://x.dev' })).toBe('web')
  expect(signatureOfTool('Bash', { command: 'curl -s https://r.jina.ai/https://x.dev' })).toBe('web')
  expect(signatureOfTool('Bash', { command: 'cd x && orca status --json' })).toBe('orca')
  expect(signatureOfTool('Bash', { command: 'claude -p "hi" --model haiku' })).toBe('llm')
  expect(signatureOfTool('Skill', { skill: 'ego-browser' })).toBe('browser')
  expect(signatureOfTool('Bash', { command: 'ls -la' })).toBe(undefined)
})

test('Hangul counts as more tokens than the same length of Latin text, and instruction text is scrubbed of the account', () => {
  expect(tokenEstimate('가'.repeat(100)) > tokenEstimate('a'.repeat(100))).toBe(true)
  expect(scrubInstruction('see ~/.claude-3/projects/-Users-alice-code/x and /Users/alice/.env, by alice', '/Users/alice')).toBe('see ~/.claude-3/projects/~-code/x and ~/.env, by <user>')
})
