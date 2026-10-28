// What a handoff has to say and what the repository actually holds: the plugin
// cannot write PHASE.md, but it can see when the board and the tree disagree.
//
// This exists because of a real lapse. Eighteen commits sat unpushed in a
// worktree while every note the plugin wrote pointed at the canonical files as
// the source of truth; none of them said the work was not sent anywhere. A
// session picking that up would have had to guess. So the plugin reads the
// repository and names the gap in the note it already writes before a fold.
import type { EngineInterface } from 'claude-code'

/** What the repository says about itself, in the few facts a handoff carries. */
export type RepoState = {
  /** The branch `git status` names, or undefined when the repository cannot be read. */
  branch?: string
  /** Commits on this branch that the upstream does not have. */
  ahead: number
  /** Files git reports as changed or untracked; 0 means a clean tree. */
  dirty: number
}

/**
 * Reads the repository through `git status --porcelain=v2 --branch`.
 *
 * Undefined facts are left out rather than guessed: in a folder that is not a
 * repository, or with no git at all, nothing is claimed.
 */
export async function repoStateOf($: EngineInterface): Promise<RepoState | undefined> {
  let stdout: string
  try {
    const result = await $.process.run(['git', 'status', '--porcelain=v2', '--branch'])
    if (result.exitCode !== 0) return undefined
    stdout = result.stdout
  } catch {
    return undefined
  }
  const branch = /^# branch\.head (.+)$/m.exec(stdout)?.[1]
  const ahead = /^# branch\.ab \+\d+ -\d+$/m.test(stdout) ? Number(/^# branch\.ab \+(\d+)/m.exec(stdout)![1]) : 0

  return {
    ...(branch === undefined ? {} : { branch }),
    ahead,
    dirty: stdout.split('\n').filter(line => line !== '' && !line.startsWith('#')).length,
  }
}

/**
 * What the handoff section of the status board says, as far as this can tell.
 * A board that mentions no handoff section at all cannot have described the
 * state, so it is reported as missing rather than as empty.
 */
export function boardHasHandoff(board: string | undefined): boolean {
  return board !== undefined && /^##\s+Handoff\s*$/m.test(board)
}

/**
 * The line to add when the repository and the board disagree, or undefined when
 * there is nothing to report. It names facts only, never a repair: the agent
 * writes the board, and the person decides what to do about an unpushed branch.
 */
export function handoffGap(state: RepoState | undefined, boardHasSection: boolean): string | undefined {
  if (state === undefined) return undefined
  const unsent = state.ahead > 0 ? [`${state.ahead} commit(s) not pushed`] : []
  const dirty = state.dirty > 0 ? [`${state.dirty} file(s) with uncommitted changes`] : []
  const facts = [...unsent, ...dirty]
  if (facts.length === 0) return undefined
  const where = state.branch === undefined ? '' : ` on ${state.branch}`
  const board = boardHasSection
    ? 'The "Handoff" section of the status board should say so.'
    : 'The status board has no "Handoff" section for this.'

  return `The repository${where} holds ${facts.join(' and ')}. ${board}`
}
