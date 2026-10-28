// One place for the settings and the key, shared by every Claude Code profile.
//
// Why: the plugin's settings live in each profile's own `settings.json`, and a
// sensitive value lives in each profile's keychain item — on macOS the service
// is `Claude Code-credentials` with a suffix from a hash of the config folder,
// so a person with three profiles enters the key three times and tunes the same
// settings three times. Reading one file under the home folder settles that.
//
// The order is: this folder first, then wherever the value was before. The key
// is put there by the person (the `key` file is theirs to write) and the plugin
// only reads it. The plugin writes two records of its own beside it, both of
// them answers the person gave: whether they consented to sending to Jev
// (`consent.json`, written by /jev-consent), and whether the first-run setup is
// finished or declined (`onboarding.json`), so it is not offered again. A folder that cannot be
// read is not an error — every value then comes from the older source, which is
// exactly how the plugin behaved before this existed.
import type { EngineInterface } from 'claude-code'

/** Where the shared settings and key live, under the person's home folder. */
export const SHARED_DIR = '.context-harness'
export const SHARED_CONFIG = 'config.json'
export const SHARED_KEY = 'key'
export const SHARED_CONSENT = 'consent.json'
export const SHARED_ONBOARDING = 'onboarding.json'

export type Onboarding = 'done' | 'declined'

/** What a record file says, or undefined for a missing or unreadable one. */
export function consentFromShared(text: string | undefined): boolean | undefined {
  const value = settingsFromShared(text).consent

  return typeof value === 'boolean' ? value : undefined
}

export function onboardingFromShared(text: string | undefined): Onboarding | undefined {
  const value = settingsFromShared(text).state

  return value === 'done' || value === 'declined' ? value : undefined
}

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
export type Shared = { settings: Record<string, unknown>; key?: string; consent?: boolean; onboarding?: Onboarding }

export async function readShared($: EngineInterface, home: string | undefined): Promise<Shared> {
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
  const [config, key, consent, onboarding] = await Promise.all([read(SHARED_CONFIG), read(SHARED_KEY), read(SHARED_CONSENT), read(SHARED_ONBOARDING)])
  const consented = consentFromShared(consent)
  const onboarded = onboardingFromShared(onboarding)

  return {
    settings: settingsFromShared(config),
    ...(keyFromShared(key) === undefined ? {} : { key: keyFromShared(key)! }),
    ...(consented === undefined ? {} : { consent: consented }),
    ...(onboarded === undefined ? {} : { onboarding: onboarded }),
  }
}

/** Writes one of the plugin's own records into the shared folder, made private first. */
export async function writeSharedRecord($: EngineInterface, home: string, name: typeof SHARED_CONSENT | typeof SHARED_ONBOARDING, value: Record<string, unknown>): Promise<void> {
  const dir = sharedDirOf(home)
  for (const argv of [['mkdir', '-p', dir], ['chmod', '700', dir]]) {
    const { exitCode } = await $.process.run(argv)
    if (exitCode !== 0) throw new Error(`${argv[0]} exited ${exitCode}`)
  }
  await $.fs.write(`${dir}/${name}`, `${JSON.stringify(value)}\n`)
}
