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
 * are removed. Returns whether anything was there to move.
 */
export async function moveInto($: EngineInterface, from: string, to: string): Promise<boolean> {
  if (!(await $.fs.exists(from))) return false
  if (!(await $.fs.exists(to))) {
    await privateDir($, to.slice(0, to.lastIndexOf('/')))
    await run($, ['mv', from, to])
    await run($, ['chmod', '700', to])

    return true
  }
  await run($, ['rsync', '-a', '--ignore-existing', '--remove-source-files', `${from}/`, `${to}/`])
  await run($, ['find', from, '-depth', '-type', 'd', '-empty', '-delete'])

  return true
}
