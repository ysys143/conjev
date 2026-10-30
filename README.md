# context-harness

**Fold, don't summarize: long Claude Code sessions keep every tool result one call away.**

When a Claude Code conversation compacts, the engine replaces it with a summary, and the exact output of every file read and command run leaves with it: the model reads the files again or works from a paraphrase. context-harness folds instead. Each large, older tool result becomes a one-line pointer, the original is kept on disk, and the model reads it back with `read_coordinate`. Your messages, the tool calls and the most recent results stay as they were. In a measured session, one compaction took the context from 137,469 to 36,995 tokens in 30 ms (context-fold 0.0.2, whose folding this plugin carries over; [Measured](#measured)).

It is a Claude Code plugin, written against Claude Code's mod API (function hooks). Folding needs no setup and no key. **An optional [judgment layer](#judgment-layer-optional) adds gates that use Jev, TypeSafe's decision model; every gate is off by default, and while they are off nothing leaves your machine.**

[Install](#install) · [Commands](#commands) · [How folding works](#how-folding-works) · [Compared with](#compared-with) · [Project state](#project-state-and-memory) · [Instruction files](#instruction-files) · [Judgment layer](#judgment-layer-optional) · [Data and privacy](#data-and-privacy) · [Measured](#measured) · [Limits](#limits)

![Before compaction, two large tool results fill the transcript, each two prompts old. After the fold, the same messages remain and those results are one-line pointers; the originals are in an archive on disk, read_coordinate returns them, and a note sends the model back to INTENT.md and PHASE.md.](docs/fold.svg)

A real pointer, as the model sees it; the id is what `read_coordinate` takes:

```text
[folded Read · src/billing/invoice.ts · 1201 lines — read_coordinate("toolu_01J7igoRSuY8xw8F8skCSEY3")]
```

## Install

Requires Claude Code 2.1.306 or later. The mod API it uses is marked early access and may change between releases. At the prompt of a Claude Code terminal session:

```text
/plugin install context-harness --marketplace ysys143/context-harness
```

Answer `y` to add the marketplace, then pick a scope. The install may list the settings as not set: the defaults [below](#how-folding-works) apply until you change them in `/config`.

<details>
<summary>From a shell, or the desktop app</summary>

- Shell: `claude plugin install context-harness --marketplace ysys143/context-harness`
- Desktop app, where `/plugin` does not run: + next to the prompt box, Plugins, Add marketplace `ysys143/context-harness`, then Add plugin.

</details>

Coming from context-fold or jev-harness: uninstall them first, then see [Upgrading](#upgrading).

**Check that it works.** Have the model read a file of a few hundred lines, send two more prompts so that result is no longer recent, then run `/compact`. The status line shows `folded 1 · −Nk chars`. Ask for a line of that file without opening it again, and the model fetches it with `read_coordinate`.

## Commands

| Command or tool | What it does |
| --- | --- |
| `/compact` | Compacts now; the plugin answers by folding |
| `read_coordinate` | The model's tool (`mcp__context-harness__read_coordinate`): returns a folded original, or a range of its lines |
| `/context-harness:tune-policy` | Measures your session and picks the fold settings with you |
| `/context-harness:project-state` | Keeps `INTENT.md` and `PHASE.md` |
| `/context-harness:consolidate` | Turns a stretch of work into memory that lasts |
| `/jev-report` | What the [judgment layer](#judgment-layer-optional) recorded |
| `/jev-mark <id> y\|n` | Labels one of its records yes or no |
| `/config` | All settings, under context-harness |
| `/plugin configure context-harness@context-harness` | The Jev key, kept in secure storage |

## How folding works

A tool result is folded when it is finished and large: older than the last `keepRecentTurns` turns, at least `minFoldChars` long, not an error shorter than `keepErrorsUnder`, and not from a tool in `keepTools`. A result whose pointer would be longer than itself stays.

1. **At compaction** (`/compact`, the engine's automatic compaction, or step 3), the plugin answers in place of the engine's summary. Each result that qualifies is written to the archive and replaced by its pointer; every other message is handed back untouched.
2. **If folding is not enough**, the engine's summary runs as before: on the whole transcript when nothing qualifies or the archive cannot be written ([Data and privacy](#data-and-privacy)), and on the folded one when it still fills more than 60% of the window (a fixed share, not `foldAtPercent`).
3. **At an idle boundary**, when a turn has ended with the window at least `foldAtPercent` full, the plugin runs `/compact` itself, but only if folding would remove at least `minSavedPercent` of the transcript: each compaction rebuilds the prompt cache once. If the project keeps `PHASE.md` or an episode log ([Project state](#project-state-and-memory)) not written since the last compaction, it first asks the agent to bring them up to date (at most twice).
4. **After a compaction** that folded something, or in a project that keeps those files, it appends a note: how many results were folded, and which of the project's files to re-read.
5. **`read_coordinate`** returns an original by the id in its pointer, 400 lines at a time unless `offset` and `limit` say otherwise.

| Setting | Default | Why |
| --- | --- | --- |
| `keepRecentTurns` | 2 | The work in progress still reads the most recent turns |
| `minFoldChars` | 1000 | In a measured session, 44% of results held 90% of all tool output |
| `keepErrorsUnder` | 2000 | Short errors stop the model repeating the same mistake |
| `keepTools` | `TodoWrite,AskUserQuestion,ExitPlanMode` | Small, and they hold current decisions |
| `foldAtPercent` | 60 | When to fold by itself after a turn; 0 turns it off |
| `minSavedPercent` | 20 | Fold by itself only when it saves at least this share |
| `intentFile` | `INTENT.md` | The agent's reading of what you want; empty turns it off |
| `phaseFile` | `PHASE.md` | The status board; empty turns it off |
| `episodeDir` | `sessions` | The episode log folder; empty turns it off |

`/context-harness:tune-policy` measures your session with the folding code itself (`policy_report`), asks you a few questions, dry-runs the values you chose beside the current ones, and applies them only after you agree (`set_policy`, which writes these nine settings and no other).

## Compared with

- **Claude Code's own compaction** replaces the conversation with a summary. context-harness answers the same compaction first and folds; the summary runs only when there is nothing to fold or the folded transcript still fills more than 60% of the window, and then on the folded transcript. After its summary, Claude Code attaches the files read recently as they are now: asked for a value as it was before the file changed, the model gave the new one as the old, 5 times of 5 ([fold-recovery](docs/research/fold-recovery.md)).
- **Memory plugins** keep what was learned across sessions, in a store of their own. context-harness works inside a session: exact tool output stays one call away, and what should last is written by the agent into the project's own files (`INTENT.md`, `PHASE.md`, `sessions/`).

## Project state and memory

A compaction summary is never the source of truth; files the project keeps are. The plugin uses three, each only while it exists, and never writes them itself: the agent does, and the plugin checks and points.

| File | What it holds | Written when |
| --- | --- | --- |
| `INTENT.md` | The agent's reading of what you want: goal, done-when, scope, constraints, open questions, each line citing your own words | You state or change a goal |
| `PHASE.md` | The status board you read: now, next, what needs you, done with evidence, resume notes; with several agents, who owns what | A step ends or blocks, you decide, before a handoff, when the plugin asks |
| `sessions/<date>-<slug>.md` | Episodes: what happened, when, and the evidence (paths, commits, folded `read_coordinate` ids) | Each stretch of work, append-only |

- `/context-harness:project-state` keeps `INTENT.md` and `PHASE.md`, alone or across several agent sessions, with the rules that keep one board consistent.
- `/context-harness:consolidate` turns a stretch of work into memory that lasts: the board, an episode, repeated procedures as project skills, lasting principles into `AGENTS.md` once you agree. A deterministic procedure that keeps repeating is proposed as code: see [just-dag-it](https://github.com/ysys143/just-dag-it).

## Instruction files

Claude Code loads its instruction files whole at the start of a conversation and again after each compaction: the user `CLAUDE.md` of the profile in use, a project's `CLAUDE.md` and `AGENTS.md`, every file they `@`-import, and the `.claude/CLAUDE.md` of every folder above the working folder. That last rule means a session run from inside your home folder also loads `~/.claude/CLAUDE.md` as a project file. If another profile's `CLAUDE.md` (say `~/.claude-3/CLAUDE.md`) is a copy of it, the same text loads twice.

**The fix needs no plugin.** In each profile other than `~/.claude` that keeps its own copy, exclude the shared one:

```json
{ "claudeMdExcludes": ["/Users/you/.claude/CLAUDE.md"] }
```

Never put this in `~/.claude/settings.json` itself: there the same file is the profile's own user file, and the profile would lose it. In the author's setup it took the first request from 69,152 to 66,655 tokens (the OMC block, 5.9k characters, loaded once instead of twice).

**`instructionFilter`** (`off`, `shadow`, `active`; default `off`) handles what is left, through the engine's `prompt.context` hook, which hands a plugin the instruction files just before they are sent. It splits them into chunks by heading and by tag block, keeping code fences whole, and then:

- **Loaded twice, byte for byte** (whitespace aside): `active` leaves the later copy out and puts a one-line note where it was (`[context-harness: left out "…", loaded from …]`), so the model knows. Of two OMC blocks at different versions, the older one leaves. Organization (`managed`) files and the auto-memory index are never changed.
- **Jev's reading of the rest, recorded only, in either mode:** after the request has gone, Jev is asked of every chunk whether nearly every request needs it, and of every user-level chunk whether the chunks before it already say all of it. `/jev-report` lists what that would drop or defer, and why. These rules are never dropped or deferred: identity, language, autonomy and approval, answering questions first, shell, git, API keys, browser, anything headed as deliberate repetition, and the OMC block. The Orca section is decided by the environment, not by Jev.
- **Would-miss:** for every prompt, slash commands included, Jev is asked whether the chunks it would defer apply. Tool uses of their kind (browser, web fetch, `orca`, `claude -p`) are recorded too, and `/jev-report` counts how often that work began with the chunk not yet attached.

Jev's readings are applied only once the records support it: at least 20 chunks labeled covered and 60 labeled partly or new with precision of 0.95 or more at the threshold, and a would-miss rate under 5% over 30 or more real sessions. Until then they cost a few hundred milliseconds in the background and nothing on the request path: `prompt.context` itself takes about 30 ms.

## Judgment layer (optional)

![Four Claude Code events, each with the gate that judges it and what it sends to Jev: instructions at the prompt, the tool gate at each tool call, the Stop gate when the turn ends, and fold relevance at compaction.](docs/turn.svg)

Each gate is set on its own to one of three modes:

- **`off`**, the default: the gate does nothing and sends nothing.
- **`shadow`**: the gate judges (Jev, or a rule for the tool gate floor) and records the judgment; nothing changes. Start here.
- **`active`**: the judgment acts: the model is sent back to work, a call is refused, a fragment is attached. A Jev judgment that acts holds the turn, the call or the prompt while Jev answers: usually 0.2-0.35 s, at most 2 s (`timeoutMs`).

| Gate | Setting | What it does | What leaves the machine |
| --- | --- | --- | --- |
| Stop gate | `stopGate` | After your own Stop hooks, sends the model back to work when a turn ends by announcing work it has not done ("이어서 리팩터링하겠습니다", "Next, I will…") | The turn's last paragraph, scrubbed |
| Tool gate floor | `toolGate` | When another provider serves the session (for example Bedrock, Vertex, a proxy, or a non-Anthropic base URL; see *Tool gate in detail*), refuses calls that touch secret files or print secrets, `read_coordinate` included. In every session, refuses writes to this plugin's files, its archives and Claude's settings files | Nothing |
| Tool gate Jev | `toolJev` | When another provider serves the session, classes each call the floor let through as open, standard, restricted or custom from its path or command, and refuses restricted and custom | The tool name and the scrubbed target |
| Conditional instructions | `instructions` | Attaches an instruction fragment to the prompt that first meets its condition | Your prompt, scrubbed, first 600 characters, and the fragments' conditions (never their bodies) |
| Instruction filter | `instructionFilter` | Leaves instruction chunks loaded twice out (`active`), and records Jev's reading of the rest ([Instruction files](#instruction-files)) | With a key: the instruction files' text, scrubbed, when they change; for chunks Jev would defer, each prompt's first 600 characters, scrubbed |
| Fold relevance | `foldJev` (shadow only) | Records which of the largest earlier results your request still needs, beside what the fold did | Your last prompt, scrubbed, first 400 characters, and for each result its tool and target: the path, the start of the command, or the search pattern, URL or description it was called with (never its output) |

Scrubbing removes secret-shaped strings, `NAME=value` secrets, email addresses and your home folder.

### Turning it on

1. Get a key from the [TypeSafe console](https://console.typesafe.ai/home).
2. Give it to the plugin with `/plugin configure context-harness@context-harness` (kept in secure storage). It is also read from a `TYPESAFE_API_KEY=` line in a `.env` in the plugin's folder, or from the `TYPESAFE_API_KEY` environment variable, in that order.
3. Set the gates you want to `shadow`, in `/config` under context-harness or in `settings.json`:

   ```json
   {
     "pluginConfigs": {
       "context-harness@context-harness": {
         "options": {
           "stopGate": "shadow",
           "toolGate": "shadow",
           "toolJev": "shadow",
           "instructions": "shadow",
           "foldJev": "shadow"
         }
       }
     }
   }
   ```

4. Read `/jev-report`, label records with `/jev-mark`, and switch a gate to `active` once it earns it (see [Records and labels](#records-and-labels)).

Without a key, the status line says only `jev: no key` and nothing is sent. The tool gate floor needs no key. Otherwise the judgment layer's status line stays empty until a gate has recorded something: Claude Code draws every plugin status line with a warning mark, which a plugin cannot change, so a line that only said the gates were on would look like a fault. With `toolGate: active`, the agent cannot write the plugin's `.env` or Claude's settings files; set those yourself.

<details>
<summary>Stop gate in detail</summary>

1. Your settings Stop hooks run first; if one blocks, that stands.
2. Not judged: re-entry, plan mode, background or scheduled work, subagents, a last sentence that is a question, and one with a condition ("알려주시면 처리하겠습니다", "once the checks pass…").
3. A rule looks for an announcing ending; Jev is asked a two-way choice, `announce` or `report`.
4. In `shadow` the turn ends at once and the judgment is recorded afterwards. In `active`, `announce` at or above `stopThreshold` (0.7) sends the model back to work: do it now, or say plainly what it needs from you.

</details>

<details>
<summary>Tool gate in detail</summary>

- **Provider trust.** First-party only when every sign agrees: an Anthropic credential, no `HTTPS_PROXY`/`HTTP_PROXY`, no `NODE_EXTRA_CA_CERTS`, no Bedrock/Vertex/Foundry, and an `ANTHROPIC_BASE_URL` that is empty or `https://*.anthropic.com`. A local proxy counts as external unless listed in `trustedProxies`. `providerTrust: external` forces external; nothing forces first-party.
- **Secret files.** `.env` and `.env.*` (not `.example`, `.sample`, `.template`), `*.env`, `~/.ssh` (not `*.pub`), `~/.aws`, `~/.gnupg`, gcloud, `~/.kube/config`, `~/.docker/config.json`, `~/.config/gh/hosts.yml`, Codex and Claude credential files, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.git-credentials`, `*.pem`, `*.p12`, `*.pfx`, `*.kdbx`, `id_rsa` and kin, resolved through `~`, `$HOME`, `..` and symlinks.
- **Shell.** Every argument of a Bash command is checked, including git pathspecs, `--opt=path` and redirects; `env`, `printenv`, `export -p`, `security … -w` and `gh auth token` count too.
- **Folded originals.** With the gate on in an external session, `read_coordinate` judges the call that produced a folded result as that call would have been judged, following a path that still exists to what it leads to; reading the archive folders directly is refused the same way. A secret file folded earlier does not come back either way.
- A guard that breaks in `active` refuses the call. `toolJev` asks once per target and session, never about a path the floor names.

</details>

<details>
<summary>Conditional instructions in detail</summary>

Claude Code already loads instructions by path (`.claude/rules/*.md` with `paths:`, CLAUDE.md in subfolders). These fragments are for conditions a path cannot tell, such as what you are asking for. A fragment is a Markdown file in `fragmentsDir` (default `~/.agents/fragments`, at most 24, each at most 4 KB):

```markdown
---
when: The person asks for prose meant for human readers, such as a report, an email or documentation.
keywords: report, email, 보고서
---
Lead with the conclusion. One idea per paragraph. Cut filler.
```

- **Attached once, kept.** A fragment is appended to the prompt that first meets its condition and stays in the conversation, so the cached prefix stays. Before each prompt, the plugin counts the fragments the next request still carries, and those attached to prompts still queued behind a running turn: a compaction that only folded keeps them, one the engine summarized drops them, and only dropped ones may be attached again.
- **A keyword decides without Jev**; otherwise one request asks about every fragment not attached, and `instructionThreshold` (0.95) attaches. `pin: true` puts a fragment in one fixed section at the end of the system prompt.
- Only prompts you write are judged. Write conditions narrowly: a broad prose condition reached 0.92-0.96 on "tell me in one sentence what this file shows".
- `examples/fragments/` has three generic fragments to copy.

</details>

<details>
<summary>Fold relevance in detail</summary>

At a compaction the prompt cache is rebuilt anyway, so judging what to keep costs no cache there. Jev is asked, for up to 48 of the largest results the fold could act on (at least `minFoldChars`), whether your current request still needs it, shown only as its tool, target and size. Each record holds what the fold did with that result and Jev's probability that it is done with. Nothing changes the compaction yet.

</details>

### Records and labels

- `/jev-report`: per gate, records, skips by reason, coverage, failures by kind, latency, tokens, the rule-versus-Jev table with Cohen's kappa, unlabeled disagreements, and, once labeled, precision and recall at several thresholds.
- `/jev-mark <id> y|n`: label a record yourself.

Before switching the Stop gate to `active`, aim for at least 50 positive and 100 negative labels and a threshold with precision of 0.9 or more on them. Agreement with the rule alone is not evidence: the rule flags about 5% of turn ends, so a gate that always says "no" agrees about 95% of the time.

`scripts/replay.ts` (run with `bun`) replays past transcripts (`$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects`) through the Stop rule offline; `--jev N` sends up to N scrubbed paragraphs to Jev.

### What Jev costs

With every gate on, one session costs at most about $0.03, and the author's last 30 days on a Claude Max 20x plan would have cost $0.28-1.00. The larger cost is time: in `active`, a judged turn end, the first call to each target in an external session, and a prompt with an unattached fragment and no keyword hit each wait for Jev, usually 0.2-0.35 s and at most 2 s (`timeoutMs`).

<details>
<summary>Per call, per session and per plan</summary>

Jev bills input tokens only, $0.042 per million ([TypeSafe's Models page](https://docs.typesafe.ai/models), 2026-10-23); output is free. A call from this plugin sends 370-500 input tokens, about 70 more for each further question in the same request.

| Gate | When it calls | Input tokens per call | Cost |
| --- | --- | --- | --- |
| Stop gate | Each turn end it judges (about 60%; the rest are skipped) | ~400 | $0.017 per 1,000 turn ends |
| Conditional instructions | Each prompt you write while some fragment is not attached | ~400 with 3 fragments, ~2,000 with 24 | $0.017-0.084 per 1,000 prompts |
| Fold relevance | Each compaction, one call per 24 results, at most two | up to ~2,500 | $0.21 per 1,000 compactions |
| Tool gate Jev | Each new target in a session another provider serves | ~455 | $0.019 per 1,000 targets |
| Instruction filter | Each new set of instruction files (two calls), then each prompt while some chunk would be deferred | ~13,600 per set, ~1,730 per prompt | $0.0006 per set, $0.073 per 1,000 prompts |

The session caps (`stopCap` 200, `instructionCap` 200, `foldCap` 20, `toolCap` 300 calls) bound one session at about 670,000 input tokens: $0.03. The instruction filter draws on `instructionCap` too.

The author's own use, priced as if every gate were on (2026-10-23, counted from Claude Code transcripts; nothing was sent), one Claude Max 20x account on two machines:

| Period | Sessions | Prompts | Tool calls | Compactions | Typical | Upper |
| --- | --- | --- | --- | --- | --- | --- |
| One week, 68% of the weekly limit used | 121 | 1,495 | 30,485 | 66 | $0.05 | $0.25 |
| That week scaled to 100% of the limit | | | | | $0.07 | $0.37 |
| 30 days | 764 | 5,812 | 182,775 | 165 | $0.28 | $1.00 |

*Typical* is three fragments, and the tool gate's Jev only where another provider served the session (none that week; 38 of 764 sessions over 30 days). *Upper* is 24 fragments asked on every prompt and every session served by another provider. Used up to its weekly limit, a Max 20x plan comes to about $0.32 a month typical and $1.57 at the upper end, 0.2-0.8% of the plan's $200 ([Claude pricing](https://claude.com/pricing)); Max 5x allows a quarter of Max 20x's usage, so roughly a quarter of that. The weekly limit also counts use outside Claude Code, which runs no plugin, so Claude Code alone at 100% would cost somewhat more.

</details>

## Data and privacy

Everything the plugin keeps is under one folder only you can open; every folder is made 700 before anything is written in it, and made again the same way if it was removed during a session. When that fails, nothing is written and the engine summarizes:

```text
~/.local/state/context-harness/
  archive/<session>/<tool_use_id>.json   folded originals, never deleted
  records/<session>/<gate>/<id>.json     judgment records, kept 14 days
  records/labels/labels/<id>.json        your labels, kept
  replay/                                replay output
```

An archive file holds exactly what the tool returned. A record holds what was sent (scrubbed), the verdicts and the timings.

Folds from before the rename stay at `~/.claude-context-fold/<session>/`; the plugin reads them and never writes or deletes there. Without `HOME`, it folds nothing and lets the engine summarize, rather than write into the project. To remove what it kept:

```sh
rm -rf ~/.local/state/context-harness/archive/<session-id>   # one session's originals
rm -rf ~/.local/state/context-harness ~/.claude-context-fold # everything
```

The plugin uses, and only for this: the network (Jev, only with a Jev setting on and a key), processes (`mkdir`, `chmod` and `find` on its own folder), and the environment (`HOME`, `TYPESAFE_API_KEY`, and the proxy and provider variables the trust check reads). One module uses all of them, folding included, so a policy that judges a module by what it uses judges the folding with them.

## Measured

| What | Result | Measured with |
| --- | --- | --- |
| One compaction | 137,469 → 36,995 tokens, 30 ms | context-fold 0.0.2 |
| A folded file, asked for row 777 | Read back with `read_coordinate` (`offset: 777, limit: 1`), answered correctly | context-fold 0.0.2 |
| Fold and its judgment in one compaction | 2 results folded (−32k characters); each record matches the archive | context-harness 0.0.1 |
| A fragment after a fold-only compaction | Kept once, not attached again (jev-harness attached it twice) | context-harness 0.0.1 |
| Stop gate, `active`, 12 ordinary turns | No false block | jev-harness 0.0.3 |
| Tool gate, external session | `.env`, a symlink to a `.pem` and `printenv` refused; 2-4 ms per call | jev-harness 0.0.3 |
| A Jev call, two-way choice | 206 ms p50, 339 ms p95 | jev-1.14.0 |
| The shared `CLAUDE.md` excluded in a second profile | OMC block loaded once, not twice; first request 69,152 → 66,655 tokens | Claude Code 2.1.309 |
| A chunk loaded twice, `instructionFilter: active` | Loaded once, with the note in place of the copy; `prompt.context` took 31 ms | context-harness 0.0.2 |
| Jev's reading of 34 real instruction chunks | Would defer 5 (1,770 characters), drop 0; nothing on the always-kept list | context-harness 0.0.2 |
| A file changed since it was read, after compaction: its earlier value | Fold 5/5 (through `read_coordinate`); fold with no pointer 0/5, said it could not know; Claude Code's summary 0/5, gave the new value 5 times | context-harness 0.0.2, Haiku 5.5 |
| An output that cannot be produced again, after compaction | Fold 5/5; fold with no pointer 0/5; summary 0/5 | context-harness 0.0.2, Haiku 5.5 |
| Folded results reached again in one long working session | 15 of 300, all files read again from disk; none through `read_coordinate` | context-fold 0.0.2 |
| Stop rule against Jev, 100 paragraphs | Agreement κ 0.35 | jev-harness 0.0.3 |
| A broad fragment condition | 0.92-0.96 on unrelated one-sentence questions | jev-harness 0.0.3 |
| Stop gate on real announcements | Not measured yet: ordinary turns never ended on one | jev-harness 0.0.3 |

Live runs used Claude Code 2.1.306-2.1.309 with Haiku 5.5 in the author's own folders; the Jev timings are direct API calls, and the rule replays use the author's transcripts. Research notes, with methods and limits, are indexed in [docs/research](docs/research/README.md): what each layer has and has not been measured on, [do folded results come back when needed](docs/research/fold-recovery.md) (kit in [`experiments/fold-recovery/`](experiments/fold-recovery/)), the [next evaluation](docs/research/next-evaluation.md), and [benchmarks for keeping a long task on track](docs/research/long-horizon-benchmarks.md).

The 2026-10-27 staged pilot now has one valid V/H pair and one active/off pair: all four conditions completed 12/12 stages with zero detected constraint/decision failures. Active Stop blocked one completed report without additional due-work progress. This single-family pilot does not establish a general completion benefit; the 36 main runs remain unrun. The [pilot report](docs/research/pilot-results.md) records corrected scoring, original evidence and cost coverage.

<details>
<summary>context-harness 0.0.2 (2026-10-23, Claude Code 2.1.309, Haiku 5.5, the author's own instruction files)</summary>

- **`prompt.context`** fired once before the first prompt, and again on the first prompt after `/compact` and after `/clear`. A general-purpose subagent got the rewritten files without the hook firing again: its recorded instructions lacked the section the hook removed.
- **Loaded twice.** With a section of `~/.agents/AGENTS.md` copied into a project `CLAUDE.md`, `shadow` loaded both (counted twice in the first message the model received) and recorded the copy as what `active` would leave out; `active` loaded it once, with the note in place of the copy. The hook took 31 ms.
- **Jev's reading** of 34 chunks (12,344 characters): two calls of 7,592 and 6,043 input tokens, answered in 298 and 214 ms, after the request had gone. It would defer "작업 방식" (0.97), "웹 페이지 가져오기" (1.00), "LLM 호출 경로" (0.99) and the test project's own lead (0.98); Orca was deferred by the environment; nothing was judged covered. What was sent held no home path, account name or email address.
- **Would-miss.** Each later prompt cost one call of about 1,730 input tokens (232-320 ms, in the background); for prompts like "Reply with the single word ok" no deferred chunk was judged to apply. Too few sessions yet for a rate.

</details>

<details>
<summary>context-harness 0.0.1 (2026-10-23, Claude Code 2.1.308, Haiku 5.5, a folder with a 301-line log and a 248-line Python file)</summary>

- **One compaction, fold and judgment together.** `/compact` folded both files (−32k characters) in the plugin's own hook; the two fold records state "folded", the same ids are in the archive, and Jev put the log at 0.82-0.84 and the Python file at 0.47-0.61 done with (two runs). The status line read `folded 2 · −32k chars | jev · tool active 1 hits · instr active 3 #34e698, 1 attached · fold shadow 2 judged`.
- **`read_coordinate`** returned line 5 of the folded log exactly. With `toolGate: active` and `providerTrust: external`, `ls ~/.local/state/context-harness/archive` was refused as folded originals.
- **Fragments.** `prose` was attached once, by its keyword. After the `/compact` that only folded, the next report request did not attach it again, and the messages the next request carried held exactly one `prose` block.
- **Cleanup.** A 15-day-old judgment record was deleted at the next session start; a 15-day-old archive file beside it was kept.
- **Folding by itself** (`foldAtPercent: 5`, every Jev setting off): after the third turn the plugin ran `/compact`, folding two results; the status line read `folded 2 · −32k chars`.
- **The engine.** Context a plugin attaches at `prompt.submit` appears in `$.session.messages({ as: 'api' })`: once before a compaction, once after a compaction the hook answered with the messages it got, none after the engine's summary. The fragment count relies on this.

</details>

<details>
<summary>context-fold 0.0.2 (Claude Code 2.1.306, Haiku 5.5)</summary>

| Compaction | Folded | Context before | After | Time |
| --- | --- | --- | --- | --- |
| First | 2 results | 137,469 tokens | 36,995 tokens | 30 ms |
| Second | 1 more result | 103,638 tokens | 23,373 tokens | 32 ms |

Asked for row 777 of a folded file, the model called `read_coordinate` with `offset: 777, limit: 1` and answered correctly. With stale `INTENT.md`, `PHASE.md` and `sessions/`, the plugin asked for consolidation; the agent ran it, then the plugin folded six results in 20 ms (89,108 to 26,223 tokens). With `tune-policy`'s candidate `keepRecentTurns: 1` applied, `/compact` folded the 37 results the dry run named (141,412 to 30,306 tokens).

</details>

<details>
<summary>jev-harness 0.0.3 (Jev jev-1.14.0, 2026-10-22)</summary>

Jev answers a question in one of three shapes: a choice among named options, a score on a scale, or a noul, a yes-or-no question answered with a number from 0 to 1.

| Question | p50 | p95 | Tokens in / out |
| --- | --- | --- | --- |
| noul | 217 ms | 448 ms | 366 / 20 |
| choice (2 options) | 206 ms | 339 ms | 373 / 31 |
| score (4 levels) | 312 ms | 363 ms | 356 / 17 |
| 12 noul questions in one request | 184 ms (n=1) | | 1132 / 210 |

- **Why a choice, not a noul:** on "…Next I will refactor the cache layer." a noul gave 0.45-0.55 and a two-way choice 0.98-0.99 for `announce`; on a report both gave 0.01-0.02.
- **The Stop rule, replayed** over the 3,000 most recent turn ends of the author's transcripts: 1,205 skipped (conditional 898, question 297, empty 10), 91 of the remaining 1,795 (5.1%) flagged. Nudges ("계속", "go") followed 1.3% and none the rule flagged, so labels have to come from `/jev-mark`.
- **The rule against Jev** on 100 of those paragraphs, sent with the author's consent: at 0.7, both 17, rule only 23, Jev only 6, neither 54; kappa 0.35.
- **Stop gate, live:** in shadow, 7 judged turn ends, all reports, the hook holding the turn 0-1 ms. In active, 12 ordinary turns gave no false block; of 3 turns asked to end on an announcement, the one judged (0.99) was sent back, with no loop, and the settings Stop hook still ran every time.
- **Tool gate, live** (`providerTrust: external`): `.env`, a symlink to a `.pem`, `git diff --no-index /dev/null .ENV` and `printenv` refused; `README.md` and `ls` allowed; 2-4 ms per call. Jev classed `./config/secrets.yaml`, `./infra/prod.tfvars`, `./data/customers.csv` and `./research/unpublished_model.py` as restricted or custom at 1.00 and `./README.md` as open at 0.00, in 168-385 ms.
- **Conditional instructions, live:** release 0.99 and attached on "Explain in three steps how you would put version 1.2 live"; prose 0.92 (not attached) and 0.96 (attached) on two one-sentence questions. After a `/compact` that context-fold answered by folding, prose was attached again: the duplicate context-harness removes.
- **Fold relevance, live:** with "Look for a rounding problem in total()" as the request, Jev put `./invoice.py` at 0.11 done with and `./server.log` at 0.88; loaded after context-fold, jev-harness did not see the compaction at all.

</details>

## Limits

- Results fold only at compaction: a plugin cannot rewrite a model request turn by turn.
- Claude Code already saves very large Bash outputs to a file; the largest gains come from tools whose output it keeps whole, such as `Read`.
- "Turns" are user messages with text; reminders the engine injects count too, so the recent window can be shorter than the setting.
- Subagent transcripts are not folded. A folded result is readable only from the session that folded it: not after `/clear` or in a fork.
- The plugin starts its own folds by running `/compact`, so the command shows in the transcript.
- A plugin loaded before this one that answers compactions itself takes them; this plugin then neither folds nor judges them.
- A changed setting reloads the plugin, which starts its counters and its count of consolidation requests over.
- In `shadow`, nothing is attached, so what would have been is remembered, and forgotten only when the plugin sees a compaction summarized or the conversation cleared; `active` counts the conversation instead.
- The instruction filter sees only what loads at the start and after a compaction; a subfolder's `CLAUDE.md` and `.claude/rules` arrive later, as Claude Code reads files, and pass it by.
- Not yet: fold relevance as a decision rather than a record; applying Jev's instruction readings; whether attached fragments make answers better; the Stop gate's accuracy on real announcements.

## Upgrading

context-harness joins two plugins that were built apart to test each idea, [context-fold](https://github.com/ysys143/context-fold) and [jev-harness](https://github.com/ysys143/jev-harness). Apart, they could not share what one compaction did, and their load order decided whether the second saw it at all. Uninstall both before installing this one: installed beside either, folding or sending to Jev happens twice.

- **Folds made by context-fold** stay readable: `read_coordinate` looks in `~/.claude-context-fold/<session>/` after its own archive, for the same session.
- **Settings and the key** do not carry over: set them again under context-harness (`/config`, and `/plugin configure context-harness@context-harness` for the key).
- **jev-harness records** under `~/.local/state/jev-harness/` are not read; their fold verdicts came from a copy of the rule that this release replaces with the fold itself. Delete that folder when you no longer need it.
- **Coming from jev-harness alone**, you now also get folding at compaction, an automatic `/compact` once the window is 60% full (`foldAtPercent`, 0 turns it off), originals kept on disk, and a note after each compaction.
- **Coming from context-fold alone**, you now also get `/jev-report`, `/jev-mark`, a hook on every tool call that passes straight through while the gates are off, and a cleanup of judgment records older than 14 days at each session start.
- **Behaviour that changed:** a fragment already in the conversation is not attached again after a compaction that only folded (jev-harness attached it again); fold judgment records state what the fold did, counting turns as the fold does.

## Development

```sh
claude --plugin-dir /path/to/context-harness   # a session with the plugin loaded
claude plugin test /path/to/context-harness    # tests/*.test.ts
claude plugin validate /path/to/context-harness
```

The plugin suite has 139 tests; the separate long-task evaluation kit has its own Python tests. Nineteen defects planted back one at a time each made at least one of the original tests fail. For the instruction filter: the always-kept list ignored, a deferred chunk counted as already saying another, a project rule dropped for a user one, a late Jev answer dropped, chunk names the attached-fragment count cannot read, the memory or organization file cut, a heading inside a code fence taken for a section, and records written while the setting is off. From 0.0.1: the cleanup over the whole folder, a fixed size floor for the judgment, the earlier turn count, folders left readable, a failed `chmod` ignored, archives readable directly, a `/compact` without `HOME`, fragments counted without the conversation, queued prompts not remembered, a failure after the fold undoing it, and a quoted opening tag taken for a block.

Research processes may set `CONTEXT_HARNESS_STATE_HOME` to an absolute directory to keep their archives, records, labels and startup cleanup under that directory's `.local/state/context-harness/`. Without it, the default location and legacy-archive lookup remain unchanged. With it, personal legacy archives are not read. This isolates plugin storage only; it does not isolate credentials, instructions or host file access.

## Credits

The idea of folding completed tool output into addressed one-line pointers, instead of summarizing, comes from Hwang Dae Jin and Yeni, *The Context Coordinate System and the Principle of Unbroken Memory* (Philosophy That Works, 2026; DOI [10.5281/zenodo.23377916](https://doi.org/10.5281/zenodo.23377916); [repository](https://github.com/philosophythatworks/context-lattice)). This plugin is an independent implementation and contains no code from that project. Related work: observation masking in [Lindenbauer et al., 2025](https://arxiv.org/abs/2508.21433); agent-managed offloading and retrieval in [ACM](https://arxiv.org/abs/2607.23809); and Anthropic's [context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing).

## Versions

Versions stay at 0.0.x while the plugin is young. 0.0.1 is the first release, joining context-fold 0.0.2 and jev-harness 0.0.3. 0.0.2 adds the instruction filter. 0.0.3 keeps the status line empty until there is something to show.

## License

MIT
