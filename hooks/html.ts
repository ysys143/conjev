// A forgiving HTML reader: enough of a tree for blocks.ts to walk. The module
// has no DOM and no packages, so this stands in for BeautifulSoup + lxml in
// jevfetch (a2sys-ai/jevfetch, MIT). It knows void and raw-text elements, the
// end tags HTML lets a page leave out (p, li, dt, dd, tr, td, th and the
// table sections), and the common character references.

export type HtmlText = { kind: 'text'; text: string; parent?: HtmlElement }
export type HtmlElement = { kind: 'el'; name: string; attrs: Record<string, string>; children: HtmlNode[]; parent?: HtmlElement }
export type HtmlNode = HtmlText | HtmlElement

const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '))
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'template'])
// An open <p> ends where one of these starts.
const CLOSES_P = new Set(
  'address article aside blockquote details div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr main menu nav ol p pre section table ul'.split(' '),
)
// An element that starts while one of `closes` is open ends it, unless an element of `scope` comes first.
const IMPLIED: Record<string, { closes: string[]; scope: string[] }> = {
  li: { closes: ['li'], scope: ['ul', 'ol', 'menu'] },
  dt: { closes: ['dt', 'dd'], scope: ['dl'] },
  dd: { closes: ['dt', 'dd'], scope: ['dl'] },
  tr: { closes: ['tr', 'td', 'th'], scope: ['table', 'thead', 'tbody', 'tfoot'] },
  td: { closes: ['td', 'th'], scope: ['tr', 'table'] },
  th: { closes: ['td', 'th'], scope: ['tr', 'table'] },
  thead: { closes: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], scope: ['table'] },
  tbody: { closes: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], scope: ['table'] },
  tfoot: { closes: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'], scope: ['table'] },
  option: { closes: ['option'], scope: ['select', 'datalist'] },
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', middot: '·', bull: '•', times: '×', divide: '÷', para: '¶',
  sect: '§', deg: '°', plusmn: '±', micro: 'µ', frac12: '½', frac14: '¼', frac34: '¾',
  euro: '€', pound: '£', yen: '¥', cent: '¢', shy: '­', zwj: '‍', zwnj: '‌',
  thinsp: ' ', ensp: ' ', emsp: ' ', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  harr: '↔', lArr: '⇐', rArr: '⇒', hArr: '⇔', le: '≤', ge: '≥', ne: '≠',
  asymp: '≈', infin: '∞', minus: '−', prime: '′', Prime: '″', sup1: '¹', sup2: '²',
  sup3: '³', iexcl: '¡', iquest: '¿', dagger: '†', Dagger: '‡', permil: '‰',
  lowast: '∗', sum: '∑', prod: '∏', radic: '√', part: '∂', isin: '∈', notin: '∉',
  cap: '∩', cup: '∪', sub: '⊂', sup: '⊃', and: '∧', or: '∨', not: '¬',
  forall: '∀', exist: '∃', empty: '∅', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
  epsilon: 'ε', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', tau: 'τ', phi: 'φ',
  omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', grave: '`', Tab: '\t', NewLine: '\n', colon: ':',
  lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', lbrack: '[', rbrack: ']', lcub: '{', rcub: '}', vert: '|', verbar: '|',
  sol: '/', bsol: '\\', num: '#', excl: '!', quest: '?', period: '.', comma: ',', semi: ';', equals: '=', plus: '+',
  ast: '*', percnt: '%', dollar: '$', commat: '@', Hat: '^', lowbar: '_', hyphen: '‐',
}

const fromCode = (code: number): string => {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�'

  return String.fromCodePoint(code)
}

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text

  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);?/g, (whole, ref: string) => {
    if (ref[0] === '#') return fromCode(ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10))

    return NAMED[ref] ?? whole
  })
}

// Matched where the scan stands (sticky), so no copy of the page is made per tag.
const CLOSE_TAG = /<\/([A-Za-z][^\s\/>]*)[^>]*>/y
const OPEN_TAG = /<([A-Za-z][^\s\/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y
// Deeper than this, a page has lost its end tags; further elements open beside, not inside.
const MAX_DEPTH = 256

const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g

function attrsOf(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const m of source.matchAll(ATTR)) {
    const name = m[1]!.toLowerCase()
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  }

  return attrs
}

/** The page as a tree under one root element named `#document`. */
export function parseHtml(html: string): HtmlElement {
  const root: HtmlElement = { kind: 'el', name: '#document', attrs: {}, children: [] }
  const stack: HtmlElement[] = [root]
  const lower = html.toLowerCase()
  const top = (): HtmlElement => stack[stack.length - 1]!
  const addText = (text: string): void => {
    if (text === '') return
    const parent = top()
    const last = parent.children[parent.children.length - 1]
    if (last?.kind === 'text') last.text += text
    else parent.children.push({ kind: 'text', text, parent })
  }
  const closeTo = (index: number): void => {
    stack.length = Math.max(1, index)
  }
  const openIndex = (names: readonly string[], scope: readonly string[]): number => {
    for (let k = stack.length - 1; k > 0; k--) {
      const name = stack[k]!.name
      if (names.includes(name)) return k
      if (scope.includes(name)) return -1
    }

    return -1
  }

  // Elements opened past MAX_DEPTH, by name: their end tags are spent here, not on an ancestor.
  const unopened = new Map<string, number>()
  let i = 0
  const n = html.length
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      addText(decodeEntities(html.slice(i)))
      break
    }
    if (lt > i) addText(decodeEntities(html.slice(i, lt)))
    i = lt
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      i = end === -1 ? n : end + 3
      continue
    }
    if (html.startsWith('<![CDATA[', i)) {
      const end = html.indexOf(']]>', i + 9)
      addText(html.slice(i + 9, end === -1 ? n : end))
      i = end === -1 ? n : end + 3
      continue
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const end = html.indexOf('>', i)
      i = end === -1 ? n : end + 1
      continue
    }
    CLOSE_TAG.lastIndex = i
    const close = CLOSE_TAG.exec(html)
    if (close) {
      const name = close[1]!.toLowerCase()
      i += close[0].length
      const owed = unopened.get(name) ?? 0
      if (owed > 0) {
        unopened.set(name, owed - 1)
        continue
      }
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) {
          closeTo(k)
          break
        }
      }
      continue
    }
    OPEN_TAG.lastIndex = i
    const open = OPEN_TAG.exec(html)
    if (!open) {
      // With no '>' left, nothing after this can be a tag.
      if (html.indexOf('>', i) === -1) {
        addText(decodeEntities(html.slice(i)))
        break
      }
      addText('<')
      i += 1
      continue
    }
    i += open[0].length
    const name = open[1]!.toLowerCase()
    const rest = open[2] ?? ''
    if (CLOSES_P.has(name)) {
      const p = openIndex(['p'], ['button', 'table', 'li', 'dd', 'td', 'th'])
      if (p !== -1) closeTo(p)
    }
    const implied = IMPLIED[name]
    if (implied !== undefined) {
      const k = openIndex(implied.closes, implied.scope)
      if (k !== -1) closeTo(k)
    }
    const el: HtmlElement = { kind: 'el', name, attrs: attrsOf(rest), children: [], parent: top() }
    top().children.push(el)
    if (VOID.has(name) || /\/\s*$/.test(rest)) continue
    if (RAW.has(name)) {
      const end = lower.indexOf(`</${name}`, i)
      const body = html.slice(i, end === -1 ? n : end)
      if (body !== '') el.children.push({ kind: 'text', text: name === 'textarea' || name === 'title' ? decodeEntities(body) : body, parent: el })
      const gt = end === -1 ? -1 : html.indexOf('>', end)
      i = gt === -1 ? n : gt + 1
      continue
    }
    if (stack.length < MAX_DEPTH) stack.push(el)
    else unopened.set(name, (unopened.get(name) ?? 0) + 1)
  }

  return root
}

// What a tree offers blocks.ts: walking, finding and removing.

/** Every node below `el` in document order, walked with a stack of its own. */
export function* descendants(el: HtmlElement): Generator<HtmlNode> {
  const stack: { node: HtmlElement; at: number }[] = [{ node: el, at: 0 }]
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!
    const child = top.node.children[top.at++]
    if (child === undefined) {
      stack.pop()
      continue
    }
    yield child
    if (child.kind === 'el' && child.children.length > 0) stack.push({ node: child, at: 0 })
  }
}

export function findAll(el: HtmlElement, test: (e: HtmlElement) => boolean): HtmlElement[] {
  const found: HtmlElement[] = []
  for (const node of descendants(el)) if (node.kind === 'el' && test(node)) found.push(node)

  return found
}

export function find(el: HtmlElement, test: (e: HtmlElement) => boolean): HtmlElement | undefined {
  for (const node of descendants(el)) if (node.kind === 'el' && test(node)) return node

  return undefined
}

export function remove(node: HtmlNode): void {
  const parent = node.parent
  if (parent === undefined) return
  const at = parent.children.indexOf(node)
  if (at !== -1) parent.children.splice(at, 1)
  node.parent = undefined
}

export function replaceWith(node: HtmlNode, other: HtmlNode): void {
  const parent = node.parent
  if (parent === undefined) return
  remove(other)
  const at = parent.children.indexOf(node)
  if (at === -1) return
  parent.children[at] = other
  other.parent = parent
  node.parent = undefined
}

/** Whether `node` is still in the tree under `root`. */
export function isUnder(node: HtmlNode, root: HtmlElement): boolean {
  for (let p = node.parent; p !== undefined; p = p.parent) if (p === root) return true

  return false
}

export function closest(node: HtmlNode, name: string): HtmlElement | undefined {
  for (let p = node.parent; p !== undefined; p = p.parent) if (p.name === name) return p

  return undefined
}

/** All text below `el`, as written. */
export function textOf(el: HtmlNode): string {
  if (el.kind === 'text') return el.text
  let out = ''
  for (const node of descendants(el)) if (node.kind === 'text') out += node.text

  return out
}

export const classesOf = (el: HtmlElement): string[] => (el.attrs.class ?? '').split(/\s+/).filter(Boolean)

/** A relative href resolved against `base`, as a browser would; `href` as given when `base` is not a URL. */
export function resolveUrl(base: string, href: string): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)) return href
  const m = /^([A-Za-z][A-Za-z0-9+.-]*:)(\/\/[^\/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(base)
  if (m === null) return href
  const scheme = m[1]!
  const authority = m[2] ?? ''
  const basePath = m[3] ?? ''
  const baseQuery = m[4] ?? ''
  if (href.startsWith('//')) return `${scheme}${href}`
  if (href.startsWith('#')) return `${scheme}${authority}${basePath}${baseQuery}${href}`
  if (href.startsWith('?')) return `${scheme}${authority}${basePath}${href}`
  const hm = /^([^?#]*)(.*)$/.exec(href)!
  const own = hm[1]!
  const path = own.startsWith('/') ? own : `${basePath.replace(/[^\/]*$/, '') || '/'}${own}`
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '..') {
      if (out.length > 1) out.pop()
    } else if (seg !== '.') out.push(seg)
  }
  let joined = out.join('/')
  if (/\/\.\.?$/.test(path) && !joined.endsWith('/')) joined += '/'
  if (!joined.startsWith('/')) joined = `/${joined}`

  return `${scheme}${authority}${joined}${hm[2]}`
}
