// The body of `/install-context-harness`, as the model reads it.
//
// Why this is code and not only the Markdown file beside it: a command file's
// body is the prompt the model runs, and there is no way for a test to read a
// file (a hooks module imports its own `.ts` by relative path and nothing
// else). Keeping the text here lets the tests hold it to what it must say — and
// `commands/install-context-harness.md` is generated from it, so the two cannot
// drift.
//
// It replaces an earlier `command.run` hook. That hook could print a summary
// and leave a hidden note, but it could not start a turn: the note sat in the
// transcript unread until the person wrote again, which looked like no answer
// at all. A Markdown command's body is the turn.
//
// What the hook knew and the model does not is where the plugin found a key.
// That now travels with the command: when it expands, the hooks module attaches
// KEY_CHECK's note (register.ts), so the body never has to guess or probe.
import type { KeySource } from './key'

export const INSTALL_COMMAND_NAME = 'install-context-harness'

export const INSTALL_COMMAND_DESCRIPTION =
  'context-harness: find a Jev key, help place one without showing it, and say what each gate sends'

/** How the note attached to the command begins; the body tells the model to look for it. */
export const KEY_CHECK = 'context-harness key check:'

/** Where each source keeps the key, in words a person who set none of them up can follow. */
const SOURCE_WORDS: Record<KeySource | 'shared', string> = {
  shared: '~/.context-harness/key, the file every Claude Code profile on this machine reads',
  config: "this Claude Code profile's secure plugin setting (claude plugin configure)",
  dotenv: "the .env file in the plugin's own folder",
  env: 'TYPESAFE_API_KEY in the environment Claude Code was started with',
}

/** The note for the model: where the key was found, or every place looked. Never the key. */
export function keyNote(source: KeySource | 'shared' | undefined): string {
  if (source !== undefined) return `${KEY_CHECK} found, in ${SOURCE_WORDS[source]}.`

  return `${KEY_CHECK} none found. The plugin looked in ${Object.values(SOURCE_WORDS).join('; ')}.`
}

/** The body, front matter left to the writer. `$ARGUMENTS` is the engine's. */
export const INSTALL_COMMAND_BODY = `# context-harness: getting a Jev key in place

The person ran this to learn whether context-harness has what it needs, and to
get it in place if not. They may never have heard of Jev, TypeSafe or any file
named below; this command is where they meet them.

**Never show, print, echo or repeat the key.** Not in a reply, not in a summary,
not in a file you write. If the person pastes one into the chat, do not repeat
it; tell them it is now in the transcript and in any folded archive, and that
they should rotate it.

## How to talk to them

- Answer in the person's language.
- Before any result, say in a sentence or two what this is about: context-harness
  folds old tool output on its own, and that needs no key. A few optional
  checks, the gates, ask Jev, a judging model run by TypeSafe, and only those
  need a TypeSafe API key. Every gate is off until the person turns it on.
- Then give the result as what it means for them: a key is set up, so the gates
  can be turned on; or no key is set up yet, so the gates cannot run and folding
  works as before. Do not open with a file path, a missing file, or a list of
  what you did not check. When none was found, do not list the places the
  plugin looked either: they are for 4, when a key that was placed still is not
  found.
- The first time you name a file or a setting, say what it is and why it is
  there. \`~/.context-harness/key\` is a file the person creates: it holds the key
  alone, the plugin only reads it, and every Claude Code profile on this machine
  uses it.
- Do not look for the key in files or settings the person has not named. Ask.

## 1. Find out what is already there

The plugin has already looked. Its answer is attached to this command as a note
that begins \`${KEY_CHECK}\`: either found, with where, or none found, with
every place it looked. That is the authoritative answer, because the plugin
reads the key from those places and no others. The note never holds the key.

If no such note is attached, the plugin's hooks are not running in this
session; it was installed or changed after the session started. Say that a new
session is needed for the plugin to answer, and that until then only the shared
file can be checked:

\`\`\`bash
test -s "$HOME/.context-harness/key" && echo "shared key file: present" || echo "shared key file: absent"
\`\`\`

That prints a word, never a value.

## 2. If a key was found

Say where it is kept, in the words of the note: the place, never the value. If
it is not \`~/.context-harness/key\`, offer to copy it there, the same way as in
3, so every Claude Code profile uses the same one, and say why: the plugin's
secure setting is kept per profile, so a person with several profiles enters the
key once per profile.

Then say what each gate sends when it is on, and that every gate starts \`off\`,
key or no key. Offer to set the ones they want to \`shadow\` with \`/config\`; do not
set them unasked.

## 3. If no key was found

Ask one plain question: **do you already have a TypeSafe key?**

- **No.** Give the address, https://console.typesafe.ai/home, and say that
  nothing else can be done until they have one. Folding keeps working; the gates
  stay off. Then stop.
- **Yes.** Offer these ways and let them pick. Do not pick for them.

  1. **If the key is already on this machine**, you can place it without ever
     seeing it. Ask where they keep it: a file of keys, a project's \`.env\`, or an
     environment variable, and the name it is stored under. If they know the file
     but not the name, list the names in that file only, never a value:
     \`grep -o '^[A-Za-z_][A-Za-z0-9_]*=' <the file>\`.

     Then copy it inside one command, so the value never reaches your context,
     the transcript or the process list. Put in the file they named, as an
     absolute path, and the name in it:

     \`\`\`bash
     mkdir -p "$HOME/.context-harness" && chmod 700 "$HOME/.context-harness"
     sh -c 'umask 077; . <the file> && printf "%s\\n" "$<THE_NAME>" > "$HOME/.context-harness/key"'
     chmod 600 "$HOME/.context-harness/key"
     \`\`\`

     If it is an environment variable of this session, leave out \`. <the file> &&\`.
     Then check only that it is non-empty, never what it is:
     \`test -s "$HOME/.context-harness/key" && echo placed\`. Do not print the file,
     do not \`cat\` it, do not compare its contents aloud.

  2. **For one profile only**, in their own terminal:
     \`\`\`
     claude plugin configure context-harness@context-harness
     \`\`\`

  3. **By hand**, if the key is somewhere you cannot reach, such as a password
     manager: have them write it in an editor, so it never passes through this
     conversation and never lands in shell history.
     \`\`\`
     $EDITOR "$HOME/.context-harness/key"   # the key alone, then save
     chmod 600 "$HOME/.context-harness/key"
     \`\`\`

Never ask them to paste the key to you. There is no step where you need to see
it, and a key that reaches the chat is a key in the transcript and in any folded
archive.

## 4. Check the result

Whatever they did, ask them to run \`/install-context-harness\` again. The plugin
looks afresh each time, so its note should now say found. If it still says none,
the value is not where the plugin reads it; check, in this order:

1. \`~/.context-harness/key\` exists, is a plain file, is readable, and holds the
   key alone: no \`NAME=\`, no quotes, no blank line before it;
2. the plugin's secure setting (\`claude plugin configure context-harness@context-harness\`);
3. \`TYPESAFE_API_KEY\` in the environment of the session that runs Claude Code,
   not only in the shell that started it, and not exported after it started.

## 5. When it works

Say that the gates are off until set, that \`shadow\` judges and records without
changing anything, and that \`/jev-report\` shows what a gate would have done.
Suggest one gate to start with, \`foldJev: active\` if they often run into
compaction, \`stopGate: shadow\` if they want to watch announcing endings, and
let them decide.

$ARGUMENTS
`
