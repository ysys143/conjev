// Browser routing: whether a request needs a browser operated (clicks, typing
// into pages, logging in, screenshots) rather than a page read, and if so which
// installed browser tool to use, in a fixed order of preference. The request is
// judged by keywords, then by Jev; what is installed is found by rules once per
// process. The guidance goes to the model as one instruction block, attached to
// the prompt that first needs it; a missing tool is recommended to the person.
import type { EngineInterface } from 'claude-code'
import type { JevQuestion } from './jev'

export const BROWSER_POINT = 'browser-route'
export const BROWSER_BLOCK = 'browser-route'

export type BrowserId = 'ego' | 'aside' | 'agent-browser' | 'playwright' | 'cdp'

/** The order of preference, and how the model is pointed at each. */
export const BROWSER_TOOLS: readonly { id: BrowserId; name: string; guidance: string }[] = [
  { id: 'ego', name: 'ego-browser', guidance: 'Run `ego-browser skill` first and follow the guide it prints; run browser scripts with `ego-browser nodejs`.' },
  {
    id: 'aside',
    name: 'Aside',
    guidance:
      "Use `aside repl`. Never print or serialize the REPL's globals: they can hold stored credentials. Check which model provider Aside is set to before delegating work to it.",
  },
  { id: 'agent-browser', name: 'agent-browser', guidance: 'Use the `agent-browser` CLI; run `agent-browser --help` for its commands.' },
  { id: 'playwright', name: 'Playwright', guidance: 'Use Playwright from a script in this project (its installed package), driving a browser it launches.' },
  { id: 'cdp', name: 'a Chrome DevTools Protocol tool', guidance: '' },
]

// Words that settle a request as browser work without asking Jev.
export const BROWSER_KEYWORDS: readonly string[] = [
  'click',
  'fill in',
  'fill out',
  'log in',
  'login',
  'sign in',
  'screenshot',
  'add to cart',
  'checkout',
  'browser',
  'ego-browser',
  'submit the form',
  '클릭',
  '입력해',
  '로그인',
  '스크린샷',
  '장바구니',
  '브라우저',
  '폼 작성',
  '예약해',
  '주문해',
]

// The pages Jev reads are the person's request, scrubbed, first 600 characters.
export const BROWSER_QUESTION: JevQuestion = {
  type: 'choice',
  instructions:
    'Does fulfilling this request require operating a web browser: clicking, typing into or submitting forms on a site, logging in, taking screenshots, or moving through several pages of a site? Reading or summarizing a page\'s text, or searching the web, does not.',
  criteria: {
    operate: 'The request needs a web browser operated.',
    read: 'Reading pages, searching, or no web at all is enough.',
  },
}

export type Detected = { available: BrowserId[]; blocked: BrowserId[]; cdp: string }

/** The first available tool in the order of preference. */
export function chooseBrowser(detected: Detected): BrowserId | undefined {
  return BROWSER_TOOLS.map(tool => tool.id).find(id => detected.available.includes(id))
}

/** The block the model reads: the tool to use, and what else is here. */
export function routeBlock(detected: Detected): string {
  const chosen = chooseBrowser(detected)
  const name = (id: BrowserId): string => BROWSER_TOOLS.find(tool => tool.id === id)!.name
  let body: string
  if (chosen === undefined) {
    body =
      'This request needs a web browser operated, and no browser tool this plugin knows is available here' +
      (detected.blocked.length > 0 ? ` (blocked by settings: ${detected.blocked.map(name).join(', ')})` : '') +
      '. Do what can be done without one, say what could not be done, and recommend installing ego lite (https://lite.ego.app/), which provides the `ego-browser` command, to the person. Do not reach for a blocked tool.'
  } else {
    const guidance = chosen === 'cdp' ? `Use ${detected.cdp}.` : BROWSER_TOOLS.find(tool => tool.id === chosen)!.guidance
    const others = detected.available.filter(id => id !== chosen)
    body =
      `This request needs a web browser operated. Use ${name(chosen)}. ${guidance}` +
      (others.length > 0 ? ` Also installed, in order of preference: ${others.map(name).join(', ')}; use one only if ${name(chosen)} cannot do the step.` : '') +
      (detected.blocked.length > 0 ? ` Never use ${detected.blocked.map(name).join(', ')}: blocked by settings.` : '') +
      ' For reading a page without interacting, a fetch tool is enough.'
  }

  return `<instruction name="${BROWSER_BLOCK}" source="conjev">\n${body}\n</instruction>`
}

export const parseBlocked = (value: string): BrowserId[] =>
  value
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter((s): s is BrowserId => BROWSER_TOOLS.some(tool => tool.id === s))

/** Folders a CLI is commonly installed in, for a process whose PATH may be shorter than the person's shell. */
const BIN_DIRS = ['~/.local/bin', '/opt/homebrew/bin', '/usr/local/bin', '~/.bun/bin', '~/.npm-global/bin']

/**
 * What is installed, by rules: a CLI on PATH or in a common folder, Playwright in the project or its browser cache, and a CDP tool only
 * when the settings name one. Nothing is launched and no debugging port is
 * probed.
 */
export async function detectBrowsers($: EngineInterface, blocked: readonly BrowserId[], cdp: string): Promise<Detected> {
  const home = ((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
  const expand = (path: string): string => (path.startsWith('~/') ? `${home}${path.slice(1)}` : path)
  const exists = async (path: string): Promise<boolean> => {
    try {
      return await $.fs.exists(expand(path))
    } catch {
      return false
    }
  }
  const hasBin = async (bin: string): Promise<boolean> => {
    try {
      if ((await $.process.run(['which', bin])).exitCode === 0) return true
    } catch {
      // No `which`, or running it was refused: look in the common folders.
    }
    for (const dir of BIN_DIRS) if (home !== '' && (await exists(`${dir}/${bin}`))) return true

    return false
  }
  const cwd = await $.session.cwd().catch(() => '')
  const found: Record<BrowserId, boolean> = {
    // The skill alone is not enough: the ego lite app provides the command.
    ego: await hasBin('ego-browser'),
    aside: await hasBin('aside'),
    'agent-browser': await hasBin('agent-browser'),
    playwright: (cwd !== '' && (await exists(`${cwd}/node_modules/playwright`))) || (await exists('~/Library/Caches/ms-playwright')) || (await exists('~/.cache/ms-playwright')),
    cdp: cdp.trim() !== '',
  }
  const order = BROWSER_TOOLS.map(tool => tool.id)

  return {
    available: order.filter(id => found[id] && !blocked.includes(id)),
    blocked: order.filter(id => found[id] && blocked.includes(id)),
    cdp: cdp.trim(),
  }
}
