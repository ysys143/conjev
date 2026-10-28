// Writes commands/install-context-harness.md from hooks/install-command.ts, so
// the file the engine loads and the text the tests check are one source.
//
//   bun scripts/build-command.ts [--check]
//
// --check writes nothing and exits 1 when the file is out of date.
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { INSTALL_COMMAND_BODY, INSTALL_COMMAND_DESCRIPTION } from '../hooks/install-command'

const root = join(import.meta.dir, '..')
const target = join(root, 'commands', 'install-context-harness.md')
const text = `---\ndescription: "${INSTALL_COMMAND_DESCRIPTION}"\n---\n\n${INSTALL_COMMAND_BODY}`

if (process.argv.includes('--check')) {
  const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
  if (current !== text) {
    console.error('commands/install-context-harness.md is out of date: run bun scripts/build-command.ts')
    process.exit(1)
  }
  console.log('the command file matches')
} else {
  writeFileSync(target, text)
  console.log(`wrote ${target}`)
}
