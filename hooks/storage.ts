// Everything the plugin keeps on disk, under one root only the user can enter,
// beside the shared settings and key so one folder holds all of it:
//   ~/.context-harness/state/archive/<session>/<id>.json  folded originals, never deleted
//   ~/.context-harness/state/records/<session>/<point>/   judgment records, 14 days
//   ~/.context-harness/state/records/labels/labels/       labels, kept
// The root was ~/.local/state/context-harness before: a session start moves it
// here when only the old one exists, and the old one is still read when both do.
// Folds made before the rename stay readable at ~/.claude-context-fold/<session>/.
import type { EngineInterface } from 'claude-code'
import type { Archived } from './fold'
import type { ShadowRecord } from './report'
import { madeDirs } from './state'

export const STATE_DIR = '.context-harness/state'
export const OLD_STATE_DIR = '.local/state/context-harness'
const LEGACY_ARCHIVE_DIR = '.claude-context-fold'

export function stateRoot(home: string): string {
  return `${home.replace(/\/+$/, '')}/${STATE_DIR}`
}

export function oldStateRoot(home: string): string {
  return `${home.replace(/\/+$/, '')}/${OLD_STATE_DIR}`
}

export function legacyArchiveRoot(home: string): string {
  return `${home.replace(/\/+$/, '')}/${LEGACY_ARCHIVE_DIR}`
}

export const fileId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_')

/**
 * The commands that drop judgment records older than 14 days. They name the
 * records folder alone, so archives and labels are never touched; any other
 * folder gets no command at all.
 */
export function cleanupArgs(recordsRoot: string): string[][] {
  if (!recordsRoot.endsWith(`/${STATE_DIR}/records`) && !recordsRoot.endsWith(`/${OLD_STATE_DIR}/records`)) return []

  return [
    ['find', recordsRoot, '-type', 'f', '-name', '*.json', '-mtime', '+14', '-not', '-path', `${recordsRoot}/labels/*`, '-delete'],
    ['find', recordsRoot, '-mindepth', '1', '-type', 'd', '-empty', '-delete'],
  ]
}

/** The root and every folder below it down to `dir`; empty when `dir` is outside the root. */
export function dirsBetween(root: string, dir: string): string[] {
  if (dir !== root && !dir.startsWith(`${root}/`)) return []
  const parts = dir.slice(root.length).split('/').filter(Boolean)

  return [root, ...parts.map((_, i) => `${root}/${parts.slice(0, i + 1).join('/')}`)]
}

export async function homeOf($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME')

  return home === undefined || home.trim() === '' ? undefined : home
}

/** The state root. Without HOME it throws, so nothing lands in the project folder instead. */
export async function rootOf($: EngineInterface): Promise<string> {
  const home = await homeOf($)
  if (home === undefined) throw new Error('HOME is not set')

  return stateRoot(home)
}

/** Makes `dir`, and every folder from the root down to it readable by the user alone, before anything is written there. */
export async function ensureDir($: EngineInterface, dir: string): Promise<void> {
  // Made earlier and still there: a folder removed since is made again, private.
  if (madeDirs.has(dir) && (await $.fs.exists(dir))) return
  madeDirs.delete(dir)
  const chain = dirsBetween(await rootOf($), dir)
  if (chain.length === 0) throw new Error(`${dir} is outside the state root`)
  for (const argv of [['mkdir', '-p', dir], ['chmod', '700', ...chain]]) {
    const { exitCode } = await $.process.run(argv)
    if (exitCode !== 0) throw new Error(`${argv[0]} exited ${exitCode}`)
  }
  madeDirs.add(dir)
}

export async function writeArchive($: EngineInterface, sessionId: string, archived: readonly Archived[]): Promise<void> {
  const dir = `${await rootOf($)}/archive/${sessionId}`
  await ensureDir($, dir)
  for (const item of archived) await $.fs.write(`${dir}/${fileId(item.id)}.json`, JSON.stringify(item))
}

/** A folded original by its call id: this plugin's archive first, then the one kept before the rename. */
export async function readArchived($: EngineInterface, sessionId: string, id: string): Promise<Archived | undefined> {
  const home = await homeOf($)
  if (home === undefined || id === '') return undefined
  for (const dir of [`${stateRoot(home)}/archive/${sessionId}`, `${oldStateRoot(home)}/archive/${sessionId}`, `${legacyArchiveRoot(home)}/${sessionId}`]) {
    const path = `${dir}/${fileId(id)}.json`
    if (await $.fs.exists(path)) return JSON.parse(await $.fs.read(path)) as Archived
  }

  return undefined
}

/** One record, one file. */
export async function writeRecord($: EngineInterface, record: ShadowRecord): Promise<void> {
  const dir = `${await rootOf($)}/records/${record.sessionId}/${record.point}`
  await ensureDir($, dir)
  await $.fs.write(`${dir}/${record.id}.json`, JSON.stringify(record))
}

export async function writeLabel($: EngineInterface, id: string, label: boolean, ts: string): Promise<void> {
  const dir = `${await rootOf($)}/records/labels/labels`
  await ensureDir($, dir)
  await $.fs.write(`${dir}/${id}.json`, JSON.stringify({ id, label, ts }))
}

/** Every record, at most `limit`, and the labels: the root's, then any the old root still holds. */
export async function readRecords($: EngineInterface, limit: number): Promise<{ records: ShadowRecord[]; labels: Map<string, boolean> }> {
  const home = await homeOf($)
  if (home === undefined) throw new Error('HOME is not set')
  const records: ShadowRecord[] = []
  const labels = new Map<string, boolean>()
  for (const root of [`${stateRoot(home)}/records`, `${oldStateRoot(home)}/records`]) {
    if (await $.fs.exists(root)) await readRecordsUnder($, root, limit, records, labels)
  }

  return { records, labels }
}

async function readRecordsUnder($: EngineInterface, root: string, limit: number, records: ShadowRecord[], labels: Map<string, boolean>): Promise<void> {
  for (const session of await $.fs.list(root)) {
    if (session.kind !== 'dir') continue
    const sessionDir = `${root}/${session.name}`
    for (const point of await $.fs.list(sessionDir)) {
      if (point.kind !== 'dir') continue
      for (const file of await $.fs.list(`${sessionDir}/${point.name}`)) {
        if (records.length >= limit || !file.name.endsWith('.json')) continue
        try {
          const parsed = JSON.parse(await $.fs.read(`${sessionDir}/${point.name}/${file.name}`)) as ShadowRecord | { id: string; label: boolean }
          if (session.name === 'labels' && 'label' in parsed) labels.set(parsed.id, parsed.label)
          else records.push(parsed as ShadowRecord)
        } catch {
          // A partly written or foreign file is skipped.
        }
      }
    }
  }
}

/** Drops judgment records older than 14 days, under the root and the old one. */
export async function cleanupRecords($: EngineInterface): Promise<void> {
  const home = await homeOf($)
  if (home === undefined) return
  for (const root of [`${stateRoot(home)}/records`, `${oldStateRoot(home)}/records`]) {
    if (!(await $.fs.exists(root))) continue
    for (const args of cleanupArgs(root)) await $.process.run(args)
  }
}

/**
 * Moves the old state root to the new one, once: only when the old one exists
 * and the new one does not, so a second session, or one that finds both, moves
 * nothing and reads both. Returns whether it moved.
 */
export async function migrateState($: EngineInterface): Promise<boolean> {
  const home = await homeOf($)
  if (home === undefined) return false
  const [from, to] = [oldStateRoot(home), stateRoot(home)]
  if (!(await $.fs.exists(from)) || (await $.fs.exists(to))) return false
  const parent = to.slice(0, to.lastIndexOf('/'))
  for (const argv of [['mkdir', '-p', parent], ['chmod', '700', parent], ['mv', from, to], ['chmod', '700', to]]) {
    const { exitCode } = await $.process.run(argv)
    if (exitCode !== 0) throw new Error(`${argv[0]} exited ${exitCode}`)
  }
  madeDirs.clear()

  return true
}
