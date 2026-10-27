// Blocks and the two-stage relevance judgment, without the engine.
import { expect, test } from 'claude-code/testing'
import { mergeFragments, parseHtmlBlocks, parseText, render, type Block } from '../hooks/blocks'
import { resolveUrl } from '../hooks/html'
import { DEFAULT_RELEVANCE, selectRelevant, type Ask } from '../hooks/relevance'

const PAGE = `<!doctype html><html><head><title>t</title><script>var x = "<p>not text</p>"</script></head><body>
<nav><a href="/">Home</a> navigation menu items</nav>
<header><h1>Cache &amp; Tools</h1><div>language menu</div></header>
<main>
<p>Intro paragraph with a <a href="guide/start.html">relative link</a> &mdash; and more text here.</p>
<h2>Decorators</h2>
<dl><dt>@cache(maxsize=128)</dt><dd><p>If maxsize is None the cache grows without bound.</p></dd></dl>
<aside class="sidebar">Buy our course today</aside>
<aside class="admonition warning"><p>Warning: the cache keeps references.</p></aside>
<table><tr><th>Flag</th><th>Meaning</th></tr><tr><td>w</td><td>write</td></tr><tr><td>a</td><td>append</td></tr></table>
<ul><li>first item<li>second item</ul>
<pre>line one

line two</pre>
<p style="display:none">hidden text here</p>
</main><footer>copyright footer</footer></body></html>`

const byText = (blocks: readonly Block[], needle: string): Block | undefined => blocks.find(b => b.text.includes(needle))

test('HTML: heading paths, terms in the path, table rows, kept notes, dropped furniture', () => {
  const blocks = parseHtmlBlocks(PAGE, 'https://docs.example.org/lib/cache.html')
  const all = render(blocks)

  expect(byText(blocks, 'maxsize is None')?.path).toEqual(['Cache & Tools', 'Decorators', '@cache(maxsize=128)'])
  expect(byText(blocks, 'relative link')?.text).toContain('[relative link](https://docs.example.org/lib/guide/start.html)')
  expect(byText(blocks, 'Intro')?.text).toContain('—')
  expect(byText(blocks, 'w | write')?.kind).toBe('row')
  expect(byText(blocks, 'Flag | Meaning')?.head).toBe(true)
  expect(byText(blocks, 'Warning: the cache')).not.toBe(undefined)
  expect(byText(blocks, 'line one')?.text).toBe('line one\n\nline two')
  expect(byText(blocks, 'second item')?.kind).toBe('li')
  for (const gone of ['navigation menu', 'Buy our course', 'copyright footer', 'not text', 'hidden text', 'language menu']) expect(all).not.toContain(gone)
  expect(all).toContain('## Cache & Tools > Decorators > @cache(maxsize=128)')
})

test('text: a code fence stays whole across blank lines; a long run of lines is cut into groups', () => {
  const fence = '# Title\n\nSome prose.\n\n```\na()\n\nb()\n```\n'
  const blocks = parseText(fence)
  expect(blocks.map(b => b.text)).toEqual(['Some prose.', '```\na()\n\nb()\n```'])
  expect(blocks[1]?.path).toEqual(['Title'])

  const log = Array.from({ length: 95 }, (_, i) => `${i + 1}\tline ${i + 1}`).join('\n')
  const groups = parseText(log)
  expect(groups.length).toBe(3)
  expect(groups[2]?.text.startsWith('81\t')).toBe(true)
  expect(groups.map(b => b.text).join('\n')).toBe(log)
})

test('relative URLs resolve as a browser would', () => {
  expect(resolveUrl('https://a.org/x/y.html', '../z.html')).toBe('https://a.org/z.html')
  expect(resolveUrl('https://a.org/x/y.html', '/r')).toBe('https://a.org/r')
  expect(resolveUrl('https://a.org/x/y.html?q', '#h')).toBe('https://a.org/x/y.html?q#h')
  expect(resolveUrl('https://a.org/x/', '//cdn.org/s')).toBe('https://cdn.org/s')
  expect(resolveUrl('https://a.org/x/', 'mailto:me')).toBe('mailto:me')
})

// A long document: many filler paragraphs, one that answers, its neighbour, and a table.
const filler = (i: number): string => `Paragraph ${i} talks about something unrelated to the question at length, ${'filler words '.repeat(30)}`
const LONG = [
  '<html><body><main><h1>Spec</h1><p>Front matter of the spec, contact a@b.co for details.</p>',
  ...Array.from({ length: 40 }, (_, i) => `<p>${filler(i)}</p>`),
  '<h2>Status 421</h2><p>The 421 status code means the request was misdirected ANSWER.</p><p>A client MAY retry it over a new connection, whether or not the request method is idempotent, such as a fresh connection to the origin.</p>',
  ...Array.from({ length: 40 }, (_, i) => `<p>${filler(i + 40)}</p>`),
  '<table><tr><th>Code</th><th>Name</th></tr>',
  ...Array.from({ length: 10 }, (_, i) => `<tr><td>${400 + i}</td><td>${'name '.repeat(10)}${i}</td></tr>`),
  '<tr><td>421</td><td>Misdirected ANSWER</td></tr></table></main></body></html>',
].join('\n')

type Asked = { state: Record<string, unknown>; names: string[] }

/** Jev in a test: stage 1 and stage 2 say yes to text holding ANSWER, and stage 2 also to the retry sentence. */
const fakeJev = (asked: Asked[], fail = false): Ask => async (state, questions) => {
  asked.push({ state, names: Object.keys(questions) })
  if (fail) return { error: 'http 500' }
  const answers: Record<string, number> = {}
  if ('rel' in questions) {
    const text = String(state.passage)
    answers.rel = text.includes('ANSWER') ? 0.95 : text.includes('retry') ? 0.7 : 0.1
  } else {
    for (const p of state.passages as { id: string; text: string }[]) answers[p.id] = p.text.includes('ANSWER') || p.text.includes('retry') ? 0.9 : 0.02
  }

  return { answers, usage: { input_tokens: 100, output_tokens: 1 } }
}

const SCRUB = (text: string): string => text.replace(/a@b\.co/g, '<email>')

test('relevance: the answer, its close neighbour, the first block and the table header are kept', async () => {
  const asked: Asked[] = []
  const rel = await selectRelevant(parseHtmlBlocks(LONG), '421 meaning and retry', fakeJev(asked), SCRUB)

  expect(rel.status).toBe('filtered')
  expect(rel.text).toContain('misdirected ANSWER')
  expect(rel.text).toContain('MAY retry')
  expect(rel.text).toContain('Front matter')
  expect(rel.text).toContain('Code | Name')
  expect(rel.text).toContain('421 | Misdirected ANSWER')
  expect(rel.text).not.toContain('Paragraph 3 ')
  expect(rel.text).toContain('## Spec > Status 421')
  expect(rel.outTokens < rel.docTokens / 4).toBe(true)
  // Stage 2 is asked only for stage 1's candidates.
  expect(asked.filter(a => a.names[0] === 'rel').length).toBe(3)
  // Every text that left was prepared; what comes back is the page's own.
  expect(JSON.stringify(asked)).not.toContain('a@b.co')
  expect(rel.text).toContain('a@b.co')
})

test('relevance: a short document passes through whole without asking Jev', async () => {
  const asked: Asked[] = []
  const rel = await selectRelevant(parseText('# A\n\nshort text'), 'q', fakeJev(asked), SCRUB)
  expect(rel.status).toBe('passthrough')
  expect(asked.length).toBe(0)
})

test('relevance: when every request fails, only the first block goes out and the status says so', async () => {
  const asked: Asked[] = []
  const rel = await selectRelevant(parseHtmlBlocks(LONG), 'q', fakeJev(asked, true), SCRUB)
  expect(rel.status).toBe('jev_error')
  expect(rel.blocksKept).toBe(1)
  expect(rel.failed).toBe(rel.requests)
})

test('relevance: nothing above the keep line is no_match, topped up to the minimum length', async () => {
  const none: Ask = async (state, questions) => ({ answers: Object.fromEntries(Object.keys(questions).map(n => [n, 0.3])) })
  const rel = await selectRelevant(parseHtmlBlocks(LONG), 'q', none, SCRUB, { ...DEFAULT_RELEVANCE, minOutputTokens: 100 })
  expect(rel.status).toBe('no_match')
  expect(rel.blocksKept > 1).toBe(true)
})

test('short fragments under one heading merge; rows and code do not', () => {
  const blocks = parseText('# H\n\nstep one\n\nstep two\n\nstep three')
  expect(mergeFragments(blocks).map(b => b.text)).toEqual(['step one\nstep two\nstep three'])
})

test('relevance: the first block is kept even with no top-up', async () => {
  const asked: Asked[] = []
  const rel = await selectRelevant(parseHtmlBlocks(LONG), '421', fakeJev(asked), SCRUB, { ...DEFAULT_RELEVANCE, minOutputTokens: 0 })
  expect(rel.text).toContain('Front matter')
  expect(rel.text).not.toContain('Paragraph 0 ')
})

test('a page that never closes its tags parses without deep recursion', () => {
  const deep = `<html><body><main>${'<div><font>'.repeat(20_000)}<p>The answer is deep down here, past every unclosed tag.</p></main></body></html>`
  const blocks = parseHtmlBlocks(deep)
  expect(blocks.some(b => b.text.includes('answer is deep down'))).toBe(true)
})

test('an opening tag longer than 20,000 characters is still a tag', () => {
  const svg = `<html><body><main><p>Before the image, some text of the page.</p><img src="data:image/png;base64,${'A'.repeat(50_000)}"><p>After the image, more text of the page.</p></main></body></html>`
  const all = render(parseHtmlBlocks(svg))
  expect(all).toContain('After the image')
  expect(all).not.toContain('AAAA')
})

test('relevance: once stopped, no further request goes out', async () => {
  const asked: Asked[] = []
  let stop = false
  const ask: Ask = async (state, questions) => {
    stop = true
    return fakeJev(asked)(state, questions)
  }
  const rel = await selectRelevant(parseHtmlBlocks(LONG), '421', ask, SCRUB, { ...DEFAULT_RELEVANCE, concurrency: 1, windowTokens: 500 }, () => stop)
  expect(asked.length).toBe(1)
  expect(rel.isStopped).toBe(true)
})

test('past the nesting cap, an end tag does not close an ancestor of the same name', () => {
  // Spent on the wrap <div>, the extra end tags would end the <nav> early and leak its text into the page.
  const page = `<html><body><main><div class="wrap"><nav>${'<div>'.repeat(300)}menu entry${'</div>'.repeat(300)}nav text after the nest</nav><p>Real content of the page, after the navigation.</p></div></main></body></html>`
  const all = render(parseHtmlBlocks(page))
  expect(all).toContain('Real content of the page')
  expect(all).not.toContain('nav text after the nest')
})
