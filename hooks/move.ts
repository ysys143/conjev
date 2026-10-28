// Moving a folder the plugin used to keep elsewhere. A rename can leave both
// the old and the new folder in place: a session started between two releases
// creates the new one, and a session still on the old code keeps writing the
// old one. So "move only when the new one is missing" is not enough; when both
// exist, what the new one lacks is merged in, and what both hold stays where
// it is in the old one rather than being overwritten.
import type { EngineInterface } from 'claude-code'

async function run($: EngineInterface, argv: string[]): Promise<void> {
  const { exitCode } = await $.process.run(argv)
  if (exitCode !== 0) throw new Error(`${argv[0]} exited ${exitCode}`)
}

/** Makes `dir` (and its parents), readable by the user alone. */
export async function privateDir($: EngineInterface, dir: string): Promise<void> {
  await run($, ['mkdir', '-p', dir])
  await run($, ['chmod', '700', dir])
}

/**
 * Moves `from` to `to`. With no `to`, one `mv`. With both, the files `to` lacks
 * move into it (one `rsync`, not one process a file: a records folder holds
 * thousands), files both hold stay in `from`, and folders left empty in `from`
 * are removed. Returns whether a file moved.
 */
export async function moveInto($: EngineInterface, from: string, to: string): Promise<boolean> {
  if (!(await $.fs.exists(from))) return false
  if (!(await $.fs.exists(to))) {
    await privateDir($, to.slice(0, to.lastIndexOf('/')))
    await run($, ['mv', from, to])
    await run($, ['chmod', '700', to])

    return true
  }
  const before = await filesUnder($, from)
  await run($, ['rsync', '-a', '--ignore-existing', '--remove-source-files', `${from}/`, `${to}/`])
  const left = await filesUnder($, from)
  // What is left, `to` holds too. A copy with the same contents is only a
  // duplicate, and leaving it would keep the old folder, and this move, alive
  // at every start; one that differs stays for the person to look at.
  for (const path of left) {
    const twin = `${to}${path.slice(from.length)}`
    if ((await readOr($, path)) === (await readOr($, twin)) && (await $.fs.exists(twin))) await run($, ['rm', path])
  }
  await run($, ['find', from, '-depth', '-type', 'd', '-empty', '-delete'])

  return left.length < before.length
}

/** The files under `dir`, as paths; one `find`, since there can be thousands. */
async function filesUnder($: EngineInterface, dir: string): Promise<string[]> {
  const { exitCode, stdout } = await $.process.run(['find', dir, '-type', 'f'])
  if (exitCode !== 0) throw new Error(`find exited ${exitCode}`)

  return stdout.split('\n').filter(line => line !== '')
}

async function readOr($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)

    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}
