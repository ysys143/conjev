---
description: "context-harness: find a Jev key, help place one without showing it, and say what each gate sends"
---

# context-harness: getting a Jev key in place

Folding works with no key. The gates that ask Jev do not. This command finds out
which case this project is in, helps with the rest, and stops.

**Never show, print, echo or repeat the key.** Not in a reply, not in a summary,
not in a file you write. If the person pastes one into the chat, do not repeat
it; tell them it is now in the transcript and in any folded archive, and that
they should rotate it.

## 1. Find out what is already there

Run this and read its first line: it says `Key: found, from <source>` or
`No Jev key found`, and that is the authoritative answer, because the plugin
knows every source it reads.

```bash
grep -c '^TYPESAFE_API_KEY=' "$HOME/.context-harness/key" 2>/dev/null || true
test -s "$HOME/.context-harness/key" && echo "shared key: yes" || echo "shared key: no"
```

Those print a count and a word, never a value.

## 2. If a key was found

Say where it came from — the source name only, never the value. If the source is
not `shared`, offer to move it to `~/.context-harness/key` so every Claude Code
profile uses the same one, and say why: the plugin's secure setting is kept per
profile, so a person with several profiles enters the key once per profile.

Then say what each gate sends when it is on, and that every gate starts `off`,
key or no key. Offer to set the ones they want to `shadow` with `/config`; do not
set them unasked.

## 3. If no key was found

Ask one plain question: **do you already have a TypeSafe key?**

- **No.** Give the address, https://console.typesafe.ai/home, and say that
  nothing else can be done until they have one. Folding keeps working; the gates
  stay off. Then stop.
- **Yes.** Offer these ways and let them pick. Do not pick for them.

  1. **If the key is already on this machine**, in the canonical store
     (`~/.oh-my-zsh/custom/apikey.env`) or anywhere else, place it yourself
     without ever seeing it. Source the file inside one command and let the shell
     write the copy, so the value never reaches your context, the transcript or
     the process list:

     ```bash
     mkdir -p "$HOME/.context-harness" && chmod 700 "$HOME/.context-harness"
     zsh -c 'source ~/.oh-my-zsh/custom/apikey.env && printf "%s\n" "$TYPESAFE_API_KEY" > "$HOME/.context-harness/key"'
     chmod 600 "$HOME/.context-harness/key"
     ```

     Then check only that it is non-empty, never what it is:
     `test -s "$HOME/.context-harness/key" && echo placed`. If the store holds a
     different name for this key, use that name. Do not print the file, do not
     `cat` it, do not compare its contents aloud.

  2. **For one profile only**, in their own terminal:
     ```
     claude plugin configure context-harness@context-harness
     ```

  3. **By hand**, if the key is somewhere you cannot reach: have them write it in
     an editor, so it never passes through this conversation and never lands in
     shell history.
     ```
     $EDITOR "$HOME/.context-harness/key"   # the key alone, then save
     chmod 600 "$HOME/.context-harness/key"
     ```

Never ask them to paste the key to you. There is no step where you need to see
it, and a key that reaches the chat is a key in the transcript and in any folded
archive.

## 4. Check the result

Whatever they did, run `/install-context-harness` again. It should now say
`Key: found, from ...`. If it still says none, the value is not where the plugin
reads it; check, in this order:

1. `~/.context-harness/key` exists, is a plain file, is readable, and holds the
   key alone — no `NAME=`, no quotes, no blank line before it;
2. the plugin's secure setting (`claude plugin configure context-harness@context-harness`);
3. `TYPESAFE_API_KEY` in the environment of the session that runs Claude Code —
   not only in the shell that started it, and not exported after it started.

## 5. When it works

Say that the gates are off until set, that `shadow` judges and records without
changing anything, and that `/jev-report` shows what a gate would have done.
Suggest one gate to start with — `foldJev: active` if they often run into
compaction, `stopGate: shadow` if they want to watch announcing endings — and
let them decide.

$ARGUMENTS
