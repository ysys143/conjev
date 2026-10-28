// A Read of a large image reads a smaller copy instead.
//
// Why this exists: an image costs about width×height/750 tokens, capped around
// 1,550, and a fold cannot reach it — the fold replaces text results, and a
// message holding media is left whole on purpose. So a screenshot read early in
// a session is paid for on every request until the session ends. Measured with
// one 2508×1310 PNG: reading a 640px copy instead took about 1,250 tokens off
// each request, and the model still described the image correctly.
//
// What it does not do: a PDF (whether Read renders a page as an image is not
// established here), or an image the person pasted (there is no file to point
// at). Both keep whatever size they had.
import type { EngineInterface } from 'claude-code'

/** The image types this knows how to resize. */
const IMAGE = /\.(png|jpe?g)$/i

/**
 * The commands to try: one per image tool this knows, in the order it tries
 * them. The platform is not consulted — a tool that is not installed answers
 * with a non-zero exit, which is the same answer as an unsupported platform and
 * needs no separate branch. macOS ships the first; Linux the second.
 */
const TOOLS = [
  { size: (from: string): string[] => ['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', from], resize: (px: number, from: string, to: string): string[] => ['sips', '-Z', String(px), from, '--out', to] },
  { size: (from: string): string[] => ['identify', '-format', '%w %h', from], resize: (px: number, from: string, to: string): string[] => ['convert', from, '-resize', `${px}x${px}>`, to] },
]

/** The long side an image reports, or undefined when its size cannot be read. */
export function longSideOf(stdout: string): number | undefined {
  const nums = [...stdout.matchAll(/\b(\d+)\b/g)].map(m => Number(m[1])).filter(n => n > 0)

  return nums.length === 0 ? undefined : Math.max(...nums)
}

/**
 * Where the smaller copy goes: beside the archive, keyed by the source path, so
 * a second Read of the same file finds the copy instead of resizing again.
 */
export function shrunkPathFor(dir: string, filePath: string): string {
  const safe = filePath.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')

  return `${dir}/shrunk-${safe}`
}

/**
 * The path to read instead of `filePath`, or undefined to read it as asked.
 *
 * A copy is made only when the image is larger than `maxPx` on its long side: a
 * smaller one is already cheap, and resizing it would only cost a second read.
 * Every failure returns undefined, so an image that cannot be resized is read
 * as the person asked — the behaviour that never loses anything.
 */
export async function imageToRead($: EngineInterface, filePath: string, maxPx: number, dir: string): Promise<string | undefined> {
  if (maxPx <= 0 || !IMAGE.test(filePath)) return undefined
  const to = shrunkPathFor(dir, filePath)
  if (await $.fs.exists(to)) return to
  for (const tool of TOOLS) {
    let longSide: number | undefined
    try {
      const measured = await $.process.run(tool.size(filePath))
      if (measured.exitCode === 0) longSide = longSideOf(measured.stdout)
    } catch {
      longSide = undefined
    }
    if (longSide === undefined) continue
    // A small image is cheap already, and resizing it would cost a second read.
    if (longSide <= maxPx) return undefined
    try {
      const { exitCode } = await $.process.run(tool.resize(maxPx, filePath, to))

      return exitCode === 0 ? to : undefined
    } catch {
      return undefined
    }
  }

  return undefined
}
