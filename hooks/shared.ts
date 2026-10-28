// One place for the settings and the key, shared by every Claude Code profile.
//
// Why: the plugin's settings live in each profile's own `settings.json`, and a
// sensitive value lives in each profile's keychain item — on macOS the service
// is `Claude Code-credentials` with a suffix from a hash of the config folder,
// so a person with three profiles enters the key three times and tunes the same
// settings three times. Reading one file under the home folder settles that.
//
// The order is: this folder first, then wherever the value was before. Nothing
// is written here by the plugin: the key is put there by the person (the
// `key` file is theirs to write), and this only reads. A folder that cannot be
// read is not an error — every value then comes from the older source, which is
// exactly how the plugin behaved before this existed.
import type { EngineInterface } from 'claude-code'

/** Where the shared settings and key live, under the person's home folder. */
export const SHARED_DIR = '.context-harness'
export const SHARED_CONFIG = 'config.json'
export const SHARED_KEY = 'key'

/** The file's contents as settings, or undefined when there is no readable file. */
export function settingsFromShared(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}

    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * The key in the shared file, or undefined. The whole file is the key: a
 * trailing newline is the only thing dropped, so a person who writes the value
 * with an editor does not have to think about quoting or a `NAME=` line.
 */
export function keyFromShared(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const trimmed = text.trim()

  return trimmed === '' ? undefined : trimmed
}

/** The path of the shared folder, given the home folder. */
export function sharedDirOf(home: string): string {
  return `${home}/${SHARED_DIR}`
}

/**
 * Reads the shared settings and key once. Both are undefined when the folder or
 * the file is not there, which is the ordinary case for anyone who has not
 * moved them.
 */
export async function readShared($: EngineInterface, home: string | undefined): Promise<{ settings: Record<string, unknown>; key?: string }> {
  if (home === undefined) return { settings: {} }
  const dir = sharedDirOf(home)
  const read = async (name: string): Promise<string | undefined> => {
    const path = `${dir}/${name}`
    try {
      if (!(await $.fs.exists(path))) return undefined
      const text = await $.fs.read(path)

      return typeof text === 'string' ? text : undefined
    } catch {
      return undefined
    }
  }
  const [config, key] = await Promise.all([read(SHARED_CONFIG), read(SHARED_KEY)])

  return { settings: settingsFromShared(config), ...(keyFromShared(key) === undefined ? {} : { key: keyFromShared(key)! }) }
}
