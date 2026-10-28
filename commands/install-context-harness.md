---
description: "context-harness: find a Jev key, help place one without showing it, and say what each gate sends"
---

# context-harness: getting a Jev key in place

The person ran this to learn whether context-harness has what it needs, and to
get it in place if not. They may never have heard of Jev, TypeSafe or any file
named below; this command is where they meet them.

**Never show, print, echo or repeat the key.** Not in a reply, not in a summary,
not in a file you write. If the person pastes one into the chat, do not repeat
it; tell them it is now in the transcript and in any folded archive, and that
they should rotate it.

## What you need to understand first

These are facts for you, not text to read out. Say them in your own words,
and only as much as the moment needs.

- **What it is for.** It keeps a long session in step with the work in front
  of the person: nothing the model saw is lost, and what the model sees and
  does is what that work needs. Without it, a full conversation is compacted
  into a summary that takes the exact output of every file read and command
  run with it, and the agent goes on from a paraphrase.
- **The one rule.** The original stays in the archive; the context holds only
  what the current work needs. What it needs is judged by Jev, a small
  judging model run by TypeSafe. Where Jev is not set up or does not answer
  in time, a fixed rule decides instead.
- **Where that judgment is made.** At every point where the session changes
  what the model sees or does. When the conversation compacts: which tool
  results and inputs fold to one-line pointers with the original on disk, and
  which passages stay under them. When the model reads an original back: only
  the parts that bear on the request. When something comes in: the blocks of a
  web page that answer the question, and the instruction fragments that apply
  to this prompt. When the model acts: a turn that ends on a promise instead
  of a result is sent back to finish, and a call that reaches for a secret
  file is stopped.
- **The key and consent.** Without a key every one of those points runs on its
  rule alone, a reduced mode in which the originals are still kept. With a
  TypeSafe key and the person's consent, Jev makes the calls. Setting up both
  is what this command is for.
- **What leaves the machine, once they consent.** Short, bounded excerpts at
  each of those moments (the latest prompt, the tail of the last paragraph,
  tool names and targets, the opening of a large result), with secrets, email
  addresses, the home folder and Korean personal data replaced by labels
  first. Nothing is sent before consent, and one switch (`jev: off`) stops it.

## How to talk to them

- Answer in the person's language. Write it as you would explain it to a
  colleague sitting next to you: plain words, whole sentences, no labels.
- Open with two or three sentences built from the facts above, in this order:
  what goes wrong in a long session, the one rule that keeps it right, and
  that Jev is what judges what the work needs at each point. Describe one
  system, not a list of features. Do not open with a definition
  ("context-harness is a plugin that ..."), and do not translate any sentence
  of this prompt word for word.
- Do not use the plugin's internal words unless the person asks: leave out
  "gates", `auto`, `shadow` and setting names until they matter.
- Then say that Jev needs a TypeSafe API key and their consent, that without
  them the plugin runs in a reduced mode on rules alone, and that this is what
  you are about to set up together.
- Then give the result as what it means for them: a key is set up, so Jev can
  take over the judgment once they consent; or no key is set up yet, so the
  plugin is in its reduced mode for now, and placing a key is the next step. Do not open with a file path, a missing file, or a list of
  what you did not check. When none was found, do not list the places the
  plugin looked either: they are for 4, when a key that was placed still is not
  found.
- The first time you name a file or a setting, say what it is and why it is
  there. `~/.context-harness/key` is a file the person creates: it holds the key
  alone, the plugin only reads it, and every Claude Code profile on this machine
  uses it.
- Do not look for the key in files or settings the person has not named. Ask.

## 1. Find out what is already there

The plugin has already looked. Its answer is attached to this command as a note
that begins `context-harness key check:`: either found, with where, or none found, with
every place it looked. That is the authoritative answer, because the plugin
reads the key from those places and no others. The note never holds the key.

If no such note is attached, the plugin's hooks are not running in this
session; it was installed or changed after the session started. Say that a new
session is needed for the plugin to answer, and that until then only the shared
file can be checked:

```bash
test -s "$HOME/.context-harness/key" && echo "shared key file: present" || echo "shared key file: absent"
```

That prints a word, never a value.

## 2. If a key was found

Say where it is kept, in the words of the note: the place, never the value. If
it is not `~/.context-harness/key`, offer to copy it there, the same way as in
3, so every Claude Code profile uses the same one, and say why: the plugin's
secure setting is kept per profile, so a person with several profiles enters the
key once per profile.

Then go to 5: the gates wait for the person's consent.

## 3. If no key was found

Ask one plain question: **do you already have a TypeSafe key?**

- **No.** Give the address, https://console.typesafe.ai/home, and say that
  getting one is the next step. Until then the plugin runs folding by rule
  only, without Jev. Then go to 5: consent can be given before the key.
- **Yes.** Offer these ways and let them pick. Do not pick for them.

  1. **If the key is already on this machine**, you can place it without ever
     seeing it. Ask where they keep it: a file of keys, a project's `.env`, or an
     environment variable, and the name it is stored under. If they know the file
     but not the name, list the names in that file only, never a value:
     `grep -o '^[A-Za-z_][A-Za-z0-9_]*=' <the file>`.

     Then copy it inside one command, so the value never reaches your context,
     the transcript or the process list. Put in the file they named, as an
     absolute path, and the name in it:

     ```bash
     mkdir -p "$HOME/.context-harness" && chmod 700 "$HOME/.context-harness"
     sh -c 'umask 077; . <the file> && printf "%s\n" "$<THE_NAME>" > "$HOME/.context-harness/key"'
     chmod 600 "$HOME/.context-harness/key"
     ```

     If it is an environment variable of this session, leave out `. <the file> &&`.
     Then check only that it is non-empty, never what it is:
     `test -s "$HOME/.context-harness/key" && echo placed`. Do not print the file,
     do not `cat` it, do not compare its contents aloud.

  2. **For one profile only**, in their own terminal:
     ```
     claude plugin configure context-harness@context-harness
     ```

  3. **By hand**, if the key is somewhere you cannot reach, such as a password
     manager: have them write it in an editor, so it never passes through this
     conversation and never lands in shell history.
     ```
     $EDITOR "$HOME/.context-harness/key"   # the key alone, then save
     chmod 600 "$HOME/.context-harness/key"
     ```

Never ask them to paste the key to you. There is no step where you need to see
it, and a key that reaches the chat is a key in the transcript and in any folded
archive.

## 4. Check the result

Whatever they did, ask them to run `/install-context-harness` again. The plugin
looks afresh each time, so its note should now say found. If it still says none,
the value is not where the plugin reads it; check, in this order:

1. `~/.context-harness/key` exists, is a plain file, is readable, and holds the
   key alone: no `NAME=`, no quotes, no blank line before it;
2. the plugin's secure setting (`claude plugin configure context-harness@context-harness`);
3. `TYPESAFE_API_KEY` in the environment of the session that runs Claude Code,
   not only in the shell that started it, and not exported after it started.

Once it says found, go to 5.

## 5. Consent

The Jev gates are set to `auto` by default: each one turns on by itself once
there is a key, the `jev` switch is on, and the person has said yes. Until
they say yes, nothing goes to Jev, key or no key, and folding runs by rule.

Tell them what saying yes sends. The text below is the disclosure the plugin
itself shows on `/jev-consent`; it is your source, not your script. Explain it
in their language and your own sentences, as you would to a colleague, and
leave none of its points out or softer than it says: what is sent, that parts
of the original text are included, what is masked first, that each part is cut
short, and how to stop it.

> With your consent, Jev, a judging model run by TypeSafe, judges what the work needs at each point, and to do so it is sent parts of this session: your latest prompt, the end of the assistant's last paragraph, tool names and targets, the opening lines of large tool results, instruction file text, and the passages of a folded result or web page a question is about. Parts of the original text are included. Before anything leaves, secrets, email addresses, your home folder and Korean personal information (names, phone, resident and card numbers) are replaced by labels, and each part is cut to a fixed length. Nothing is sent without a key, and `jev: off` in ~/.context-harness/config.json stops all of it.

Then ask them to answer by typing it themselves; you cannot answer for them:

- `/jev-consent yes`: allow it. The `auto` gates turn on now, or as soon as a
  key is in place.
- `/jev-consent no`: refuse it. The gates stay off; folding still works.
- `/jev-consent later`: decide later. This setup will not start by itself
  again; `/install-context-harness` brings it back.

Any of the three ends the setup. Say that `/jev-consent no` takes a yes back
at any time, that `jev: off` in `~/.context-harness/config.json` switches every
Jev gate off at once, and that `/jev-report` shows what each gate did.

$ARGUMENTS
