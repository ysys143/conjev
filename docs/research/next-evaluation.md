# Next evaluation: does context-harness keep long work on track?

**Status:** plan, not yet run. Written 2026-10-23 against context-harness 0.0.3 and Claude Code 2.1.309. Everything marked *frozen* is fixed after the pilot and not changed once the main runs start.

**Review.** Four read-only reviews by gpt-6-astra the same day, each against the code. The first found 16 problems (3 critical); the second, 7 left (2 critical) and the plan blocked for main runs; the third, one major gap in the device checks; the fourth judged that gap closed and asked for one assertion to be qualified, which was done. The fourth reviewer's verdict on phase 0 was "ready to start"; main-run readiness depends on phases 0-2 passing as written.

## Why this evaluation

[fold-recovery.md](fold-recovery.md) showed one narrow thing: after a compaction, a folded original comes back when it is asked for, where Claude Code's summary answers with a stale value. It did not test what the plugin exists for: that long work survives several compactions better. That rests on more than the fold:

| Layer | Device | Meant to |
| --- | --- | --- |
| Fold | Fold at `session.compact`; `read_coordinate`; the automatic `/compact` after a turn at `foldAtPercent` | Keep every message, remove only finished tool output, let the model fetch an original back |
| Project state | `INTENT.md`, `PHASE.md`, `sessions/`; the request to update them before an automatic fold; the note after a compaction; the `project-state` and `consolidate` skills | Carry the goal, the decisions and the state of the work past any compaction, a summary included |
| Judgment | Stop gate, tool gate, conditional instructions, fold relevance, instruction filter | Catch a turn that ends announcing undone work; refuse secret reads under other providers; attach instructions when needed; record what folds should keep; drop instruction text loaded twice |

## Questions

**Q1, outcome.** On staged tasks that go through at least three compactions, does Claude Code with the context-harness bundle (below) commit fewer goal-keeping failures than vanilla Claude Code, without completing less of the work?

**Q2, mechanism.** Does each device do what it was designed to do, on purpose-built cases and during the Q1 runs? A good outcome with devices that never fired, or fired wrongly, is not evidence for the design.

**What Q1 can and cannot say.** It estimates the effect of the whole bundle, seeded project files and notes included, on three fixed task families. It does not attribute the effect to any one device, it does not compare at equal compute, it does not generalize to a population of tasks, and with 9 pairs it is an exploratory estimate, not a significance test. It covers staged tasks under forced compaction; it does not establish behaviour under natural window pressure, the best timing for compaction, or autonomous long-task completion.

## Arms

| Arm | Plugins | Project files at the start | Initial prompt |
| --- | --- | --- | --- |
| **V** vanilla | none | none | The task statement |
| **H** harness | context-harness 0.0.3 | `INTENT.md` holding the same task statement; empty `PHASE.md`; empty `sessions/` | The same task statement, word for word |

**H's bundle:** folding at its defaults, the project-state files and skills, and `instructionFilter: active` (deterministic: drops instruction text loaded twice). Every Jev device runs in `shadow`, recording but not acting. None has met the bar the README sets before acting (records-and-labels), so in Q1 they are observed, not credited; their active behaviour is tested in phase 1. In Q1, conditional instructions (empty fragment folder) and the tool gate's Jev step (first-party sessions) are expected to stay **NOT EXERCISED** by design.

**No third arm this round.** A "files without the plugin" arm only matters once H differs from V, and would need instructions of its own, so it is not a clean subtraction.

Held equal across arms: model and settings, Claude Code binary, research account, task folder contents apart from H's seeded files, stage prompts, forced compaction points, permission policy, resource ceilings. V never gets prompts adapted to its failures.

## Research environment

**Hard isolation is required for every scored run (pilot and main).** A configuration without it is for setup only and contributes nothing to Q1.

- **A dedicated macOS user** (for example `chresearch`) runs the agent; the evaluator is another user. context-harness keeps archives and records under `$HOME`, cleans its records there at start, and reads fragments from `~/.agents/fragments` by default, and Claude Code loads `CLAUDE.md` from parent folders, so a separate `CLAUDE_CONFIG_DIR` alone is not enough.
- **Each run sees only its own task, session record and plugin state.** After each run, its teardown moves the run's task folder, session records (`<profile>/projects/…`) and plugin state (`~/.local/state/context-harness/`) into the evaluator's store, and the next run starts with none of them.
- **The agent cannot read** answer keys, hidden tests, generator secrets, proxy captures, the event log or other runs: all belong to the evaluator's user, mode 700.
- **Canary test** before every phase: canary files placed in each forbidden location, read through file tools and through shell commands from inside a session; every read must fail.
- **What every run can read:** its own session record. It is part of every Claude Code session, so it stays, and recovery through it is counted as its own route.
- **Settings.** Profile `settings.json`: `autoMemoryEnabled: false`; for H, context-harness from the marketplace at the version under test, with `fragmentsDir` set to an empty synthetic folder; no other plugins, hooks, output styles, MCP servers or skills; an empty user `CLAUDE.md`.
- **Phase 0 inventory.** What is actually in effect is checked in the captured system prompt at start and after a compaction. Auto-memory contributes nothing to any request and creates no memory files.
- **Credentials.** No `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or provider variables in the agent user's environment, so the subscription is used. Phase 0 checks the credential source without logging any value.
- **Steps only the person can do:** create the user, log in once as that user (`/login`), and accept any trust dialog the chosen driver shows. No driver answers a dialog.

## Capturing the real messages

The session record shows what Claude Code stored, not what it sent; a compaction answered by a plugin, the note after it, re-attached files and instruction blocks are only certain in the request itself. Every request is recorded on the way out by a recording reverse proxy on loopback, in both arms: `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`.

**Transport acceptance (phase 0), each with a test:**

- Method, path and query string, body and headers forwarded unchanged, including `anthropic-version` and `anthropic-beta` (the subscription's OAuth capability is carried there) and the credentials themselves.
- Status codes, error bodies and retry headers returned unchanged; a forced upstream failure is retried by Claude Code as it would be without the proxy.
- Compressed bodies decoded for the record only; no stale `content-encoding` or `content-length` forwarded.
- Streams (SSE) passed through as they arrive, never buffered, pings included, and recorded alongside. A capture is complete only when `message_stop` arrived; interrupted captures are kept and marked.
- Tested on a plain turn, a tool-use turn, a long stream, a compaction and a cancelled turn.
- Credentials removed from what is written, never from what is forwarded.

**Usage.** Rebuilt per request from `message_start` and the cumulative `message_delta` updates that follow; cumulative counters are not summed, `message_stop` only marks completion. An interrupted request keeps its partial usage, marked as such.

**Jev.** Jev calls go to another host, so they are counted from the plugin's records, once per originating call: conditional-instruction records copy one call's usage onto every fragment record, and other paths record usage on one member of a batch, so the mapping from call to records is written per device. A call that timed out may still have reached the service; its usage is reported unknown.

**Trust is a separate check.** The plugin treats a session as served by another provider when there is no first-party credential, any proxy variable, a custom CA, or a base URL that is neither Anthropic's nor in `trustedProxies` (`hooks/tool-gate.ts`, `decideTrust`). H sets `trustedProxies` to `127.0.0.1:<port>` and uses no `HTTPS_PROXY` or `NODE_EXTRA_CA_CERTS`. Phase 0 checks four things apart: the credential source (subscription), the plugin's classification (`/jev-report`: first-party, trusted proxy), the permission policy (the agent can read, edit and run tests in its task folder), and that the proxy changes nothing (one turn with and without it).

## Tasks

Three synthetic task families, generated per seed with random names and values, so nothing is memorized and every answer can be checked. Each is a small codebase built over 12 stage prompts.

| Element | Checks | Rule |
| --- | --- | --- |
| Constraints C1-C3, each with a unique identifier | Goal keeping | Stated once, in stage 1. Example: keep `api/v1` backward compatible; never add a dependency; never edit `legacy/` |
| Decisions D1-D2 | Goal keeping | Stated by the scripted person in stages 4-6, in fixed words ("Use approach A: …; not B: …"), whatever the agent proposed |
| Large outputs | Fold and recovery | Planted so that each forced compaction has eligible results (below); later stages need specific values from them |
| Dependencies across boundaries | Performance across compactions | Each task has stages that need information from before two or more compaction points, not one early fact asked repeatedly |
| Clarifications | Fairness | If the agent asks, the script answers from a fixed list, or "Use your judgement within the constraints"; never with new facts |
| Hidden checks | Scoring | Evaluator-owned; run on the evaluator's snapshots, never inside the agent's folder |

**Compaction.** `/compact` is sent after stages 3, 6 and 9 in both arms. H's own automatic `/compact` stays on as part of the bundle and is reported wherever it fires.

**Exposure, frozen per task family before the main runs:** at each forced boundary, at least 2 results eligible under the pinned policy (older than `keepRecentTurns`, at least `minFoldChars`, not in `keepTools`), totalling at least 4,000 characters, each linked to a later stage that needs a value from it. Each boundary is classed per run as *no opportunity*, *eligible and folded*, *eligible but not folded*, or *summary fallback* (with the reason). Exposure failures stay in the run ledger and in the analysis; no run is dropped to leave a better-exposed subset.

## Driver

Both arms use the same driver, and it keeps one Claude Code process alive for the whole run: the plugin's automatic `/compact` is scheduled one second after a turn ends, the note after a compaction is appended one second after it, and its consolidation counters live in the process. Driving each stage as a new `claude -p --resume` process (which does run `/compact`, checked 2026-10-23) would reset those and change the treatment.

Candidates, chosen in phase 0 by one test, the full chain in one process: a turn, the automatic `/compact` it schedules, the fold, the delayed note, the consolidation request, a Stop record and a delayed shadow judgment.

1. **One headless process with streamed input** (`claude -p --input-format stream-json --output-format stream-json`): stages are written to its input one at a time.
2. **One interactive session in tmux**, typing each stage.

**A stage is over** when the turn's result is in, the Stop hooks have finished, no automatic `/compact` or appended note is pending (a settle period longer than the plugin's one-second timers, confirmed in the session record), and no queued input is waiting. Turn ends are never read from the screen alone: that is what made the Opus trials of fold-recovery unscorable. Background judgments may overlap the next stage, as in normal use.

**Teardown drain.** After the last stage the process stays alive for a bounded drain (60 seconds: the longest background judgment is two sequential 15-second calls). Every independently expected event (each Stop turn end, each compaction's fold judgment, each instruction load) is then reconciled with a completed record, a recorded failure, or a timeout. Unreconciled evidence is *incomplete*, never a negative result and never a pass.

## Measures

### Q1

**Scoring map, frozen before the main runs.** For every requirement (C1-C3, D1-D2) and every stage where it applies: what counts as a failure, and what evidence shows it. At most one failure per requirement per stage; a transient violation (an edit to `legacy/` later undone) counts.

**Prohibited-action log.** An evaluator-owned watcher records file-system events in each task folder (for example macOS FSEvents through `fswatch`) alongside the captured tool calls. Phase 0 shows it catches a script that changes and restores a protected file within one tool call. Attempted operations (a refused or failed call) and completed changes are logged apart.

| Measure | Role | How |
| --- | --- | --- |
| **Goal-keeping failures** (scoring map) | **Primary** | Prohibited-action log, captured tool calls, and the evaluator's snapshot after every stage |
| **Task completion** | **Co-primary guard** | Hidden tests passing at the end, on the evaluator's snapshot |
| Constraint failures; decision failures | Secondary, apart | As the primary, split, so a gain in one cannot hide a loss in the other |
| Regressions observed across a compaction interval | Secondary | A fixed, stage-appropriate test set passing at the snapshot before a compaction and failing at the snapshot after the next stage. Without a run that never compacts, it does not show the compaction caused it |
| Goal restatement | Secondary (recoverability) | After the last stage: "State the goal, the constraints and the decisions." Scored per proposition (the goal, each Cn, each Dn: present, absent, contradicted; plus unsupported additions), blinded to arm, by a person, for all 18 outputs |
| Questions already answered | Secondary | The agent asking for a constraint or decision it was given |
| Ceiling exhaustions | Reported | Turn, token or wall-time ceiling reached |
| Cost | Reported | Usage per request, Jev per call, requests, compactions, wall time, extra turns from consolidation |

**Recovery routes**, for every value a later stage needed from before a boundary: read from context, `read_coordinate`, the file on disk, rerunning a command, the session record, or not recovered.

### Q2: device checks

**Two kinds of test.** *Deterministic action tests* use controlled judgment responses through the plugin's own test kit (`claude plugin test`, which stubs Jev's HTTP calls), so each branch is forced and checked exactly. *Live smoke tests* run the device against the real service in a session. Both are required for a PASS.

**Case manifest, frozen before phase 1.** For every case: the stimulus, the configuration, the expected action, the expected records (how many, and the value of each field that matters), and the conditions under which zero records is correct. Phase 1 cannot pass without the manifest and an assertion for every line of it; a record that is absent is a failure unless the manifest names it as a legitimate zero.

**Rules.** Each device and path below has a positive case (it should fire) and a negative case (it should not). Minimums for phase 1: every deterministic case at least once; every live positive and negative case at least **3** times. Fewer than the minimum is **NOT EXERCISED**, never PASS. Expected results come from this table and the README, not from the plugin's own functions. Each checker must first reject deliberately corrupted evidence (a pointer removed, a continuation dropped, a unique instruction line lost, a record deleted). Model compliance (does the agent follow a note) is reported as an observation, not as hook correctness.

| Device | Positive case | Negative case | Evidence |
| --- | --- | --- | --- |
| Fold, ordinary | Results older than `keepRecentTurns`, at least `minFoldChars`, not in `keepTools`, not a short error, become pointers; other messages and call/result pairs unchanged | Recent results, short errors and `keepTools` results stay whole | Requests before and after each compaction |
| Fold, other paths | Nothing to fold → engine summary; archive write fails → summary; folded transcript still above 60% of the window (a character estimate) → summary of the folded transcript; a second compaction folds only new results | A skipped compaction records nothing | Forced on purpose |
| `read_coordinate` | Body equals the archived lines asked for, beyond the default 400 too; header names the call | Unknown or malformed id → error; no other session's original | Tool results against the archive |
| Archive storage | Folders 700 before the first write | A forced `chmod` failure → nothing written | File modes |
| Automatic `/compact` | Fires after a turn at `foldAtPercent` when folding saves at least `minSavedPercent` | Does not fire below either | Low `foldAtPercent` |
| Consolidation request | Before an automatic fold, when `PHASE.md` or `sessions/` were not written since the last compaction; at most twice, then the fold goes ahead and the note names the overdue files | Not when they are current; not before a forced `/compact` | Appended notes, file times; file contents scored apart |
| Note after compaction | Before the next turn, when results were folded or project files exist | Absent when neither | Next request |
| Re-reading project files | The agent reads `INTENT.md` and `PHASE.md` after a compaction before new work | | Every eligible compaction; delivery (the note) and compliance (the reads) apart |
| Skills | `project-state` and `consolidate` are listed and invoked when the note asks | | Tool list and calls |
| Stop gate, active | An announcing turn end is sent back once, without a loop | A reporting turn end is not; every eligible turn end is labelled by a person, so missed announcements show | Records, captures, labels |
| Stop gate, shadow | One record per eligible turn end, with the skip reason where skipped | | Records against turn ends |
| Conditional instructions, active | A keyword match attaches once; a condition met without its keyword (Jev) attaches once; a pinned fragment is in the system prompt; after a summary it is attached again | A non-match attaches nothing; after a fold-only compaction nothing is attached again | Captures, records |
| Tool gate floor | Under forced external trust: a secret file, a secret-printing command and a direct read of the archive are refused | An ordinary file is allowed; under first-party trust only protected writes are refused | Tool results, records |
| Tool gate Jev, active | Under forced external trust, a target the floor allows but Jev classes restricted is refused | A target classed open is allowed | Tool results, records |
| Fold relevance, shadow | Fixtures with results of distinct sizes, more than 24 (one batch) and more than 48 (the sample limit), some folded and some kept by the policy. The expected sample is enumerated independently: results the fold could act on, at least `minFoldChars`, the 48 largest. One record per sampled result; `heuristic` equals whether that result was archived; with controlled answers, `jev` equals 1 − P(needed) | No record for a result outside the sample; no records and no call without a key or without a person's prompt; a failed call writes records with the error and no `jev` | Deterministic test with controlled answers; records against captures |
| Instruction filter, deterministic | A chunk loaded twice, planted on purpose, leaves once with the note in its place | A unique chunk stays; organization and memory files are never changed | Captured system prompt |
| Instruction filter, Jev readings (shadow) | With controlled scope and coverage answers, each chunk's record carries those values and the expected `would-keep`, `would-defer` or `would-drop`; Jev's readings never make an always-kept chunk `would-defer` or `would-drop` (a byte-for-byte duplicate or an older OMC copy is `would-drop` whatever its heading: that decision is deterministic and checked in the row above) | No chunk text is removed or attached by a reading | Records; captured system prompt unchanged |
| Instruction filter, deferred use (shadow) | After a chunk is `would-defer`: for every later request, slash commands included, one record per deferred chunk with `would-attach` or `skip` as the controlled answer says, the request's turn and origin; a tool call of the chunk's kind (browser, web fetch, `orca`, `claude -p`) writes one tool-use record | No deferred-use record when nothing is deferred, for an empty request, or without a key; no tool-use record for a call of no listed kind | Records against captures |
| Status line | Empty at start; `jev: no key` at once when the key is missing; appears after the first recorded event | | One screen check |

## Phases

| Phase | What | Exit |
| --- | --- | --- |
| 0. Setup | Research user and profile; login; proxy and its transport tests; trust, credential, permission, isolation and canary checks; the prohibited-action watcher test; driver chosen by the full-chain test | Every phase-0 check passes |
| 1. Devices | Deterministic action tests, then live smoke tests of H in diagnostic configurations | Every diagnostic case meets its minimum and passes. A failure stops the phase until the defect is fixed and retested; a filed defect is not a pass |
| 2. Pilot | 1 task family, 1 seed, V and H, on the model chosen for the main runs, under hard isolation | Scripts score a run end to end; exposure met; cost per run measured; the scoring map frozen |
| 3. Main | 3 task families × 3 seeds × V and H | All 18 runs scored, or every missing one accounted for |
| 4. Report | `docs/research/long-task-results.md` | Per-run and per-task tables, exposure, device checks (Q1 exposure reported apart, including expected NOT EXERCISED devices), cost, limits |

**Frozen before the main runs:** model and its settings; binary and plugin versions; task generators and seeds; the scoring map; exposure minimums; per-run ceilings (turns, wall time, tokens); and, for each pair, whether V or H runs first (randomized, then frozen).

**Interruptions.**
- Reaching a run's ceiling is an observed outcome of that arm and is not replaced.
- Infrastructure or usage-limit interruptions are told apart from treatment outcomes before any scoring, and allow at most one replacement pair. Every attempt and its cost is kept.
- If outcomes are still missing, the report gives available-pair estimates explicitly and does not make the 9-pair decision.

**Budget.**
- The pilot runs on the main model, so its measurement is the one the budget uses.
- The budget is set separately for setup, phase 1, the pilot, the main runs, scoring and Jev. The account's usage meters are recorded before and after each phase.
- A separate user or profile does not get a separate allowance.
- If the main runs do not fit, this plan is revised (fewer task families, the same seeds per family) before any main outcome is looked at.

## Deciding the result

Fixed before the runs:

- **Primary outcome:** goal-keeping failures per run (scoring map).
- **Comparison:** the mean of the 9 paired differences (V minus H). Its interval is a bootstrap over seeds *within* each task family, with the three families weighted equally. The interval covers these three families, not a population of tasks. Ties count as zero.
- **"Fewer goal-keeping failures in H"** is claimed when three conditions all hold:
  - the mean paired difference is at least 1 failure per run in H's favour;
  - H is not worse on average in any family;
  - neither constraint failures nor decision failures is worse in H on average.
- **"Fewer failures without completing less"** additionally needs H's hidden-test pass rate not lower than V's on average. This is the only outcome stated as H doing better overall.
- **"More failures in H"** when the mean paired difference is at least 1 in V's favour.
- **Otherwise:** no difference shown at this size.
- Secondary outcomes are reported with their observed differences and intervals; none is a non-inferiority claim at this size.
- **Q2 stands apart:** a device that failed, was not exercised, or has incomplete evidence is reported so, whatever the outcome.

## Risks

| Risk | Handling |
| --- | --- |
| The driver changes what the plugin does | Persistent process for both arms; the full-chain test; teardown drain |
| The agent reads answers or earlier runs | Evaluator-owned files; per-run teardown; canaries through file tools and shell |
| Transient violations go unseen | File-system watcher, tested against an edit-and-restore script |
| The proxy changes behaviour | Transport tests; one turn with and without it |
| Credentials or private text in captures | Removed from what is written; captures under the evaluator's user, never committed; synthetic tasks only |
| Costs miscounted | Usage rebuilt from the stream events; Jev counted per call |
| Usage limits | Pilot on the main model; budget per phase; meters recorded |
| Forced compaction is not natural compaction | Stated as a limit; exposure minimums per boundary |
| Run-to-run variation | Paired seeds; randomized arm order within pairs; per-run tables |
| Versions drifting mid-study | Binary and plugin pinned |

## Not in this round

- The accuracy of the judgment devices (Stop gate precision, whether attached fragments make answers better): checked here as mechanisms; their value needs labelled data of its own.
- A third arm separating the project files from the plugin.
- An external benchmark ([long-horizon-benchmarks.md](long-horizon-benchmarks.md)): after this round, not part of its completion.
- Natural window pressure, other models, other harnesses.
