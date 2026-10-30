// Blocks: the unit relevance.ts asks Jev about and returns verbatim. Ported
// from jevfetch's blocks.py (a2sys-ai/jevfetch@167fe8f, MIT). A block is a
// paragraph, list item, table row, code block or run of output lines,
// labelled with its heading path. Differences from jevfetch: notes (asides)
// stay in place with the page instead of being scored apart; XML is read as
// text; JSON is re-serialized compactly; token counts are estimated, since
// the module has no tokenizer.
import { classesOf, closest, find, findAll, isUnder, parseHtml, remove, replaceWith, resolveUrl, textOf, type HtmlElement, type HtmlNode } from './html'

export type BlockKind = 'p' | 'li' | 'pre' | 'row' | 'group' | 'frag'

export type Block = {
  id: number
  path: string[]
  text: string
  kind: BlockKind
  /** For a table row, the number of its table; 0 otherwise. */
  table: number
  /** A table's header row. */
  head: boolean
}

export const heading = (b: Block): string => b.path.join(' > ')

const DROP = new Set(['script', 'style', 'noscript', 'nav', 'footer', 'form', 'svg', 'button', 'iframe', 'template'])
// An <aside> is a sidebar on most sites, but documentation sites write notes as one; those stay.
const NOTE_CLASSES = new Set(['note', 'tip', 'hint', 'important', 'warning', 'caution', 'danger', 'admonition', 'key-point'])
const NOTE_ROLES = new Set(['note', 'doc-note', 'doc-notice', 'doc-tip'])
const NOTE_LABEL = /^\s*(?:note|important|warning|caution|tip|key point|danger)\s*:/i
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const LEAF_BLOCKS = new Set(['p', 'li', 'pre', 'blockquote', 'dt', 'dd', 'tr', 'figcaption', 'caption'])
const CONTAINERS = new Set(['table', 'ul', 'ol', 'dl'])
const BLOCK_LEVEL = new Set(
  'address article aside blockquote caption dd div dl dt figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tbody td tfoot th thead tr ul'.split(' '),
)
// Wikipedia furniture, heading permalinks, and what a browser does not show.
const NOISE_CLASSES = new Set(['mw-editsection', 'navbox', 'reflist', 'references', 'toc', 'sidebar', 'sortkey'])
const LINK_NOISE = new Set(['headerlink', 'hash-link', 'anchor-link'])
export const MAX_BLOCK_CHARS = 4000
const MAX_DATA_CHARS = 1500
const MIN_ROOT_SHARE = 0.1
// Output lines grouped into one block when a paragraph of tool output has no blank lines.
const LINES_PER_BLOCK = 40

/**
 * An estimate of cl100k tokens: about four characters of ASCII per token, and
 * close to one token per character of other scripts (Korean, Japanese, Chinese).
 */
export function tokenCount(text: string): number {
  let ascii = 0
  let other = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++
    else other++
  }

  return Math.ceil(ascii / 4 + other * 0.9)
}

export const plain = (text: string): string => text.replace(/\[([^\]]*)\]\([^)\s]*\)/g, '$1')

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

const block = (path: string[], text: string, kind: BlockKind, table = 0, head = false): Block => ({ id: 0, path: [...path], text, kind, table, head })

export type DocKind = 'html' | 'json' | 'text'

export function kindOf(doc: string, mediaType = ''): DocKind {
  const type = mediaType.split(';')[0]!.trim().toLowerCase()
  const body = doc.trimStart()
  if (body[0] === '{' || body[0] === '[') {
    try {
      JSON.parse(body)
      return 'json'
    } catch {
      // Not JSON after all.
    }
  }
  const headText = doc.slice(0, 3000).toLowerCase()
  const isPage = /^﻿?(?:\s*<!--[\s\S]*?-->)*\s*(?:<!doctype html|<html)/i.test(doc.slice(0, 3000))
  if (['text/plain', 'text/markdown', 'text/x-markdown'].includes(type) && !isPage) return 'text'
  if (['<html', '<body', '<div', '<p>', '<!doctype'].some(t => headText.includes(t))) return 'html'
  const root = /^<([A-Za-z_][\w.:-]*)[\s>/]/.exec(body)
  if (root && BLOCK_LEVEL.has(root[1]!.toLowerCase()) && body.trimEnd().endsWith(`</${root[1]}>`)) return 'html'

  return 'text'
}

/** Blocks of an HTML page, a JSON document, or text: markdown, code, or a tool's output. */
export function parseDocument(doc: string, base = '', mediaType = ''): Block[] {
  const kind = kindOf(doc, mediaType)
  if (kind === 'html') return parseHtmlBlocks(doc, base)
  if (kind === 'json') return parseJson(doc)

  return parseText(doc)
}

export function parseText(doc: string): Block[] {
  const path: { level: number; title: string }[] = []
  const out: Block[] = []
  let fence: string[] | undefined
  const paragraphs: string[] = []
  // Blank lines split paragraphs, except inside a code fence.
  let current: string[] = []
  for (const line of doc.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (fence === undefined) {
        if (current.length) paragraphs.push(current.join('\n'))
        current = []
        fence = [line]
      } else {
        fence.push(line)
        paragraphs.push(fence.join('\n'))
        fence = undefined
      }
      continue
    }
    if (fence !== undefined) fence.push(line)
    else if (line.trim() === '') {
      if (current.length) paragraphs.push(current.join('\n'))
      current = []
    } else current.push(line)
  }
  if (fence !== undefined) paragraphs.push(fence.join('\n'))
  if (current.length) paragraphs.push(current.join('\n'))

  for (const raw of paragraphs) {
    const para = raw.replace(/^\n+|\s+$/g, '')
    if (para.trim() === '') continue
    const m = /^(#{1,6})\s+(.*)$/.exec(para)
    if (m && !para.includes('\n')) {
      const level = m[1]!.length
      while (path.length && path[path.length - 1]!.level >= level) path.pop()
      path.push({ level, title: m[2]!.trim() })
      continue
    }
    const names = path.map(h => h.title)
    const lines = para.split('\n')
    // A long run of lines (a file read, a log) is cut into groups of lines, kept as written.
    if (lines.length > LINES_PER_BLOCK) {
      for (let i = 0; i < lines.length; i += LINES_PER_BLOCK) out.push(block(names, lines.slice(i, i + LINES_PER_BLOCK).join('\n'), 'pre'))
    } else out.push(block(names, para, lines.length > 1 ? 'pre' : 'p'))
  }

  return numbered(splitLong(out))
}

function parseJson(doc: string): Block[] {
  const out: Block[] = []
  const dump = (value: unknown): string => JSON.stringify(value) ?? 'null'
  const descend = (node: unknown, path: string[]): void => {
    const text = dump(node)
    if (text.length <= MAX_DATA_CHARS) {
      out.push(block(path, text, 'p'))
      return
    }
    if (node === null || typeof node !== 'object') {
      out.push(block(path, typeof node === 'string' ? node : text, 'p'))
      return
    }
    const isArray = Array.isArray(node)
    const items: [string, unknown][] = isArray ? (node as unknown[]).map((v, i) => [String(i), v]) : Object.entries(node as Record<string, unknown>)
    let group: [string, unknown][] = []
    const groupText = (g: [string, unknown][]): string => (isArray ? dump(g.map(([, v]) => v)) : dump(Object.fromEntries(g)))
    const flush = (): void => {
      if (group.length) out.push(block(path, groupText(group), 'p'))
      group = []
    }
    for (const [key, value] of items) {
      const piece = isArray ? dump(value) : dump({ [key]: value })
      if (piece.length > MAX_DATA_CHARS) {
        flush()
        descend(value, [...path, key])
        continue
      }
      if (group.length && groupText([...group, [key, value]]).length > MAX_DATA_CHARS) flush()
      group.push([key, value])
    }
    flush()
  }
  descend(JSON.parse(doc.trim()), [])

  return numbered(splitLong(out))
}

const isNote = (aside: HtmlElement): boolean =>
  classesOf(aside).some(c => NOTE_CLASSES.has(c.toLowerCase().split('--').pop()!)) ||
  NOTE_ROLES.has((aside.attrs.role ?? '').toLowerCase()) ||
  NOTE_LABEL.test(norm(textOf(aside)).slice(0, 40))

const isNoise = (el: HtmlElement): boolean => {
  const classes = classesOf(el)
  const style = (el.attrs.style ?? '').toLowerCase()

  return (
    (el.name === 'sup' && classes.includes('reference')) ||
    classes.some(c => NOISE_CLASSES.has(c)) ||
    el.attrs.id === 'toc' ||
    (el.name === 'a' && classes.some(c => LINK_NOISE.has(c))) ||
    style.includes('display:none') ||
    style.includes('display: none') ||
    'hidden' in el.attrs
  )
}

/** Drops what is not content; asides that are notes stay where they are. */
function clean(doc: HtmlElement): void {
  for (const header of findAll(doc, e => e.name === 'header')) {
    if (!isUnder(header, doc)) continue
    const h1 = find(header, e => e.name === 'h1')
    if (h1 !== undefined) replaceWith(header, h1)
    else remove(header)
  }
  for (const el of findAll(doc, e => DROP.has(e.name) || (e.name === 'aside' && !isNote(e)))) if (isUnder(el, doc)) remove(el)
  for (const el of findAll(doc, isNoise)) if (isUnder(el, doc)) remove(el)
}

function rootOf(doc: HtmlElement): HtmlElement {
  const body = find(doc, e => e.name === 'body') ?? doc
  const total = norm(textOf(body)).length
  const tests: ((e: HtmlElement) => boolean)[] = [
    e => e.name === 'main',
    e => e.name === 'article',
    e => e.attrs.role === 'main',
    e => e.attrs.id === 'content',
    e => e.attrs.id === 'main-content',
    e => classesOf(e).includes('body'),
  ]
  for (const test of tests) {
    const el = find(doc, test)
    const n = el === undefined ? 0 : norm(textOf(el)).length
    if (el !== undefined && n > 500 && n >= MIN_ROOT_SHARE * total) return el
  }

  return body
}

function linkTarget(a: HtmlElement, base: string): string {
  const href = (a.attrs.href ?? '').trim()
  if (href === '' || href.startsWith('#') || /^(?:javascript|vbscript|data):/i.test(href)) return ''
  const url = base === '' ? href : resolveUrl(base, href)

  return url.replace(/[()\s]/g, ch => encodeURIComponent(ch).replace('(', '%28').replace(')', '%29'))
}

/**
 * The element's text with inline elements joined as written, so that
 * <span>f</span><span>(x)</span> reads "f(x)". Block boundaries, <br>, and
 * super- and subscripts separate words.
 */
function textIn(el: HtmlElement, links: boolean, base: string): string {
  const out: string[] = []
  const walk = (node: HtmlElement): void => {
    for (const c of node.children) {
      if (c.kind === 'text') {
        out.push(c.text)
        continue
      }
      const target = links && c.name === 'a' ? linkTarget(c, base) : ''
      const inner = target ? textIn(c, true, base).trim() : ''
      if (target && inner) out.push(`[${inner}](${target})`)
      else if (c.name === 'br') out.push('\n')
      else if (BLOCK_LEVEL.has(c.name) || c.name === 'sup' || c.name === 'sub') {
        out.push(' ')
        walk(c)
        out.push(' ')
      } else walk(c)
    }
  }
  walk(el)

  return out.join('')
}

const hasAny = (el: HtmlElement, names: ReadonlySet<string>): boolean => find(el, e => names.has(e.name)) !== undefined

function ownText(li: HtmlElement, base: string): string {
  const parts: string[] = []
  for (const c of li.children) {
    if (c.kind === 'text') parts.push(c.text)
    else if (!CONTAINERS.has(c.name)) parts.push(textIn(c, true, base))
  }

  return parts.join(' ')
}

function definitionItems(dl: HtmlElement): HtmlElement[] {
  const items: HtmlElement[] = []
  for (const c of dl.children) {
    if (c.kind !== 'el') continue
    if (c.name === 'dt' || c.name === 'dd') items.push(c)
    else if (c.name === 'div') for (const x of c.children) if (x.kind === 'el' && (x.name === 'dt' || x.name === 'dd')) items.push(x)
  }

  return items
}

export function parseHtmlBlocks(html: string, base = ''): Block[] {
  const doc = parseHtml(html)
  const baseTag = find(doc, e => e.name === 'base' && typeof e.attrs.href === 'string')
  if (baseTag !== undefined) base = resolveUrl(base, baseTag.attrs.href!)
  clean(doc)
  const root = rootOf(doc)
  const path: { level: number; title: string }[] = []
  const out: Block[] = []
  const tables = new Map<HtmlElement, number>()
  const names = (): string[] => path.map(h => h.title)
  const emit = (text: string, kind: BlockKind, table = 0, head = false): void => {
    const t = kind === 'pre' ? text.replace(/^\n+|\n+$/g, '') : norm(text)
    if (t.trim().length >= 3) out.push(block(names(), t, kind, table, head))
  }
  const flush = (run: HtmlNode[]): void => {
    let text = ''
    for (const node of run) {
      if (node.kind === 'el' && node.attrs['data-as'] === 'p') {
        emit(text, 'p')
        text = ''
        emit(textIn(node, true, base), 'p')
      } else text += node.kind === 'text' ? node.text : textIn(node, true, base)
    }
    emit(text, 'p')
    run.length = 0
  }
  const walk = (node: HtmlElement, children?: readonly HtmlNode[]): void => {
    const run: HtmlNode[] = []
    for (const ch of children ?? node.children) {
      if (ch.kind === 'text') {
        run.push(ch)
        continue
      }
      if (!BLOCK_LEVEL.has(ch.name) && !hasAny(ch, BLOCK_LEVEL)) {
        run.push(ch)
        continue
      }
      flush(run)
      if (ch.name === 'dl') {
        // A definition term (a signature, an option name) heads its descriptions.
        const depth = path.length
        for (const item of definitionItems(ch)) {
          if (item.name === 'dt') {
            path.length = depth
            path.push({ level: 99, title: norm(textIn(item, false, base)).slice(0, 160) })
          } else if (hasAny(item, new Set([...LEAF_BLOCKS, ...CONTAINERS, 'div']))) walk(item)
          else emit(textIn(item, true, base), 'p')
        }
        path.length = depth
      } else if (HEADINGS.has(ch.name)) {
        const level = Number(ch.name[1])
        while (path.length && path[path.length - 1]!.level >= level) path.pop()
        path.push({ level, title: norm(textIn(ch, false, base)) })
      } else if (ch.name === 'tr') {
        const cells = ch.children.filter((c): c is HtmlElement => c.kind === 'el' && (c.name === 'td' || c.name === 'th'))
        const table = closest(ch, 'table')
        if (table !== undefined && !tables.has(table)) tables.set(table, tables.size + 1)
        const firstRow = table === undefined ? undefined : find(table, e => e.name === 'tr')
        const head = ch.parent?.name === 'thead' || (firstRow === ch && cells.length > 0 && cells.every(c => c.name === 'th'))
        emit(cells.map(c => norm(textIn(c, true, base))).join(' | '), 'row', table === undefined ? 0 : tables.get(table)!, head)
      } else if (ch.name === 'pre') {
        emit(textOf(ch), 'pre')
      } else if (ch.name === 'li') {
        if (hasAny(ch, CONTAINERS)) {
          emit(ownText(ch, base), 'li')
          walk(ch, ch.children.filter(c => c.kind === 'el' && CONTAINERS.has(c.name)))
        } else emit(textIn(ch, true, base), 'li')
      } else if (LEAF_BLOCKS.has(ch.name) && !hasAny(ch, new Set([...[...LEAF_BLOCKS].filter(n => n !== 'tr'), ...CONTAINERS]))) {
        emit(textIn(ch, true, base), 'p')
      } else walk(ch)
    }
    flush(run)
  }
  walk(root)

  return numbered(splitLong(mergeLeadins(out)))
}

/** A lead-in ending in a colon joined with the list items after it under the same heading. */
function mergeLeadins(blocks: readonly Block[]): Block[] {
  const merged: Block[] = []
  let i = 0
  while (i < blocks.length) {
    const b = blocks[i]!
    const parts = [b.text]
    let end = i + 1
    if (b.text.trimEnd().endsWith(':') && b.kind !== 'pre') {
      let j = i + 1
      while (j < blocks.length && parts.join('\n').length < 1500) {
        const item = blocks[j]!
        if (item.kind !== 'li' || item.path.join('\0') !== b.path.join('\0') || item.text.trimEnd().endsWith(':')) break
        parts.push(`- ${item.text}`)
        j++
        end = j
      }
    }
    merged.push(parts.length > 1 ? block(b.path, parts.join('\n'), 'group', b.table, b.head) : b)
    i = end
  }

  return merged
}

/** Consecutive short paragraphs or list items under one heading, merged: such fragments rarely say what they are about. */
export function mergeFragments(blocks: readonly Block[], short = 100, cap = 800): Block[] {
  const out: Block[] = []
  for (const b of blocks) {
    const prev = out[out.length - 1]
    if (
      prev !== undefined &&
      (b.kind === 'p' || b.kind === 'li') &&
      plain(b.text).length < short &&
      prev.path.join('\0') === b.path.join('\0') &&
      (prev.kind === 'frag' || ((prev.kind === 'p' || prev.kind === 'li') && plain(prev.text).length < short)) &&
      plain(prev.text).length + plain(b.text).length < cap
    ) {
      out[out.length - 1] = block(prev.path, `${prev.text}\n${b.text}`, 'frag')
    } else out.push({ ...b, path: [...b.path] })
  }

  return numbered(splitLong(out))
}

/** Blocks in order, with a "## heading path" line wherever the path changes; only `keep` when given. */
export function render(blocks: readonly Block[], keep?: ReadonlySet<number>): string {
  const lines: string[] = []
  let last: string | undefined
  for (const b of blocks) {
    if (keep !== undefined && !keep.has(b.id)) continue
    const at = heading(b)
    if (at !== last) {
      if (b.path.length) lines.push(`## ${at}`)
      last = at
    }
    lines.push(b.text)
  }

  return lines.join('\n')
}

/** Blocks over MAX_BLOCK_CHARS split at sentence (code: line) boundaries. */
function splitLong(blocks: readonly Block[]): Block[] {
  const out: Block[] = []
  for (const b of blocks) {
    if (b.text.length <= MAX_BLOCK_CHARS) {
      out.push(b)
      continue
    }
    const isCode = b.kind === 'pre'
    const sep = isCode ? '\n' : ' '
    const parts = isCode ? b.text.split('\n') : b.text.split(/(?<=[.!?。])\s+|\n/)
    let cur = ''
    for (let s of parts) {
      if (cur && cur.length + s.length > MAX_BLOCK_CHARS) {
        out.push({ ...b, text: cur.trimEnd() })
        cur = ''
      }
      while (s.length > MAX_BLOCK_CHARS) {
        out.push({ ...b, text: s.slice(0, MAX_BLOCK_CHARS) })
        s = s.slice(MAX_BLOCK_CHARS)
      }
      cur += s + sep
    }
    if (cur.trim()) out.push({ ...b, text: cur.trimEnd() })
  }

  return out
}

function numbered(blocks: Block[]): Block[] {
  blocks.forEach((b, k) => {
    b.id = k
  })

  return blocks
}
