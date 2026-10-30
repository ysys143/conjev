# Next evaluation: does context-harness keep long work on track?

**Scope:** evaluation specification. Current execution and acceptance are recorded in [pilot-results.md](pilot-results.md) and [evaluation-progress.md](evaluation-progress.md). Written 2026-10-23 against context-harness 0.0.3 and Claude Code 2.1.309. The experimental checkout includes storage isolation; the evaluated build is 0.0.3 plus its exact source fingerprint. Everything marked *frozen* is fixed after the pilot and not changed once the main runs start.

**Execution decisions (updated 2026-10-27).** At the owner's request, use the Claude subscription with **Haiku 5.5 (`claude-haiku-5-5`), effort `max`**, for the executor, pilot and main runs. Use adaptive thinking; the provider documents `max` support for Haiku 5.5 and requires adaptive thinking at that level ([effort](https://platform.claude.com/docs/en/build-with-claude/effort)). Verify the actual outgoing model and effort before scored runs. The prior Opus startup probe remains preparation evidence under its original identity. Jev's total additional spend is capped at USD 10 across all phases. Use automated grading following the local Harness² benchmark implementation, as requested by the owner; human annotation is no longer an exit requirement. The owner selected Opus/low for the automated rubric judge on 2026-10-26. It uses a fresh subscription session, receives the task, one criterion and its relevant original evidence, and has no tools. Record its exact served model and CLI version separately from the executor's.

**Review.** Four read-only reviews by gpt-6-astra the same day, each against the code. The first found 16 problems (3 critical); the second, 7 left (2 critical) and the plan blocked for main runs; the third, one major gap in the device checks; the fourth judged that gap closed and asked for one assertion to be qualified, which was done. The fourth reviewer's verdict on phase 0 was "ready to start"; main-run readiness depends on phases 0-2 passing as written. After the reviews, the research environment was changed at the owner's decision from a separate macOS user (the reviewers' recommendation) to a separate Claude configuration folder; that section has not been reviewed again.

Those historical reviews do not cover the Q3 amendment below; their readiness verdict is not acceptance of the added experiment.

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

**Q3, Stop-gate effect (added 2026-10-26).** With the rest of the harness held equal, does `stopGate: active` complete more of the assigned work than `stopGate: off`, reduce premature handbacks, and preserve legitimate stops? A continuation or a rewritten final sentence alone is not a successful recovery.

**What Q1 can and cannot say.** It estimates the effect of the whole bundle, seeded project files and notes included, on three fixed task families. It does not attribute the effect to any one device, it does not compare at equal compute, it does not generalize to a population of tasks, and with 9 pairs it is an exploratory estimate, not a significance test. It covers staged tasks under forced compaction; it does not establish behaviour under natural window pressure, the best timing for compaction, or autonomous long-task completion.

## Q1 arms

| Arm | Plugins | Project files at the start | Initial prompt |
| --- | --- | --- | --- |
| **V** vanilla | none | none | The task statement |
| **H** harness | context-harness 0.0.3 plus the recorded experimental source fingerprint | `INTENT.md` holding the same task statement; empty `PHASE.md`; empty `sessions/` | The same task statement, word for word |

**H's bundle:** folding at its defaults, the project-state files and skills, and `instructionFilter: active` (deterministic: drops instruction text loaded twice). Every Jev device runs in `shadow`, recording but not acting. None has met the bar the README sets before acting (records-and-labels), so in Q1 they are observed, not credited; their active behaviour is tested in phase 1. In Q1, conditional instructions (empty fragment folder) and the tool gate's Jev step (first-party sessions) are expected to stay **NOT EXERCISED** by design. The separate Q3 comparison below enables only the Stop gate in its intervention arm, inside the research environment.

**No files-only arm in Q1.** A "files without the plugin" arm only matters once H differs from V, and would need instructions of its own, so it is not a clean subtraction. Q3 compares two configurations of the same harness; it does not supply that subtraction.

Held equal across arms: model and settings, Claude Code binary, research account, task folder contents apart from H's seeded files, stage prompts, forced compaction points, permission policy, resource ceilings. V never gets prompts adapted to its failures.

## Research environment

A separate Claude Code configuration folder, `CLAUDE_CONFIG_DIR=~/.claude-research`, under the same macOS account. This does not isolate everything; what it leaves open is handled as follows and stated in the results.

**Actual profile and launch context.** The owner completed login under
`~/.claude-reserach` (that spelling). Use that existing profile explicitly;
do not rename it or copy credentials to the initially planned path. Direct
commands in this agent context fail macOS credential lookup, while the same
binary/profile in a task-owned tmux session with an explicit valid cwd and a
fresh CLI environment verifies `claude.ai`/`firstParty`. Use that native launch
context consistently for both arms and the judge. This does not waive the
single-process driver full-chain acceptance. The first plain-turn request
returned the subscription's weekly-limit error, so the study remains incomplete.

- **Settings.** `settings.json`: `autoMemoryEnabled: false`; for H, context-harness from the frozen local experimental checkout, identified by its manifest version and source fingerprint, with `fragmentsDir` set to an empty synthetic folder; no other plugins, hooks, output styles, MCP servers or skills; an empty user `CLAUDE.md`. Phase 0 checks in the captured system prompt, at start and after a compaction, that nothing else is in effect, and that auto-memory contributes nothing and writes no memory files.
- **Task folders outside the home folder** (for example under `/private/tmp/ch-research/`): Claude Code also loads `~/.claude/CLAUDE.md` for any folder below home.
- **The plugin's own state.** Set `CONTEXT_HARNESS_STATE_HOME` to an absolute per-run storage directory. Archives, judgment records, labels and startup cleanup then use `<selected>/.local/state/context-harness/`; the personal historical archive is not a fallback. This changes storage location without changing `HOME`, authentication or instruction discovery. Test archive writes/reads, cleanup and tool-gate protection through the actual hooks before live runs. Teardown moves only the run-owned state into the evaluator's store; the next run gets a fresh directory.
- **Answers out of reach by timing, not permission.** The same account can read anything the evaluator writes, so answer keys and hidden tests are not on disk while a run is going: the generator writes the task folder and keeps the answers in a store it creates only after the run's teardown. Proxy captures are written outside the task folder.
- **Reads are detected, not prevented.** Every tool call is in the capture. A run in which the agent touched the evaluator's store, another run's folder, another session's record or the author's own files is marked *contaminated*, kept, and reported apart; it does not count toward the decision.
- **What every run can read:** its own session record. It is part of every Claude Code session, so it stays, and recovery through it is counted as its own route.
- **Credentials.** No `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or provider variables in the run's environment, so the subscription is used. Phase 0 checks the credential source without logging any value.
- **Steps only the person can do:** log in once in the research folder (`CLAUDE_CONFIG_DIR=~/.claude-research claude`, then `/login`; Claude Code keeps a separate keychain entry for each configuration folder), and accept any trust dialog the chosen driver shows. No driver answers a dialog.

## Capturing the real messages

The session record shows what Claude Code stored, not what it sent; a compaction answered by a plugin, the note after it, re-attached files and instruction blocks are only certain in the request itself. Every request is recorded on the way out by a recording reverse proxy on loopback, in every arm: `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`.

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

Every arm uses the same driver, and it keeps one Claude Code process alive for the whole run: the plugin's automatic `/compact` is scheduled one second after a turn ends, the note after a compaction is appended one second after it, and its consolidation counters live in the process. Driving each stage as a new `claude -p --resume` process (which does run `/compact`, checked 2026-10-23) would reset those and change the treatment.

Candidates, chosen in phase 0 by one test, the full chain in one process: a turn, the automatic `/compact` it schedules, the fold, the delayed note, the consolidation request, a Stop record and a delayed shadow judgment.

1. **One headless process with streamed input** (`claude -p --input-format stream-json --output-format stream-json`): stages are written to its input one at a time.
2. **One interactive session in tmux**, typing each stage.

**A stage is over** when the turn's result is in, the Stop hooks have finished, no automatic `/compact` or appended note is pending (a settle period longer than the plugin's one-second timers, confirmed in the session record), and no queued input is waiting. Turn ends are never read from the screen alone: that is what made the Opus trials of fold-recovery unscorable. Background judgments may overlap the next stage, as in normal use.

**Teardown drain.** After the last stage the process stays alive for a bounded drain (60 seconds: the longest background judgment is two sequential 15-second calls). Every independently expected event (each Stop turn end, each compaction's fold judgment, each instruction load) is then reconciled with a completed record, a recorded failure, or a timeout. Unreconciled evidence is *incomplete*, never a negative result and never a pass.

## Measures

### Q1

**Benchmark grading method.** Adapt the approach implemented in Harness²'s LAB adapter and subscription judge (`harness2/benchmarks/lab.py`, `harness2/subscription_judge.py`, `harness2/core/judge.py`, and LAB's `evaluation/scoring.py`). Execution and grading are separate: first close the run and fingerprint its artifacts, then grade each frozen criterion against the relevant deliverables and source evidence. The agent never receives the grading rubric or judge feedback during a scored run. Both V and H are graded; there is no best-of-run selection. Store per-criterion verdicts and reasons, **Partial** (criteria passed / criteria expected, only when every criterion is graded), **All-pass**, and graded/expected coverage. A timeout, transport failure, malformed answer or missing evidence is **ungraded**, never zero or a task failure. An available-criteria fraction, if reported, is explicitly separate and cannot establish a complete-run result.

**Automated semantic judgments.** A fresh judge sees a condition-neutral run identifier, the task and relevant original evidence, not an arm label, another run's results, the plugin's verdict or its own previous answers. Its structured answer must name the criterion and quote evidence present in the supplied packet. Treat logs and deliverables as data, including any instructions inside them. Reject unknown evidence references, altered quotations and malformed classifications. Content such as a project-state file can reveal the treatment despite removing labels; report that limit. Goal-restatement and Stop classifications are **LLM-judged measurements**, not human ground truth or validated precision. Deterministic hidden tests and controlled device cases keep their executable or fixture-derived oracles.

**Identity and reuse.** Save CLI versions, resolved models, plugin/source fingerprints, settings, task generator, seed, stage prompts, rubric and judge prompt with the run. An explicit completion receipt, matching fingerprints and complete captures are required for reuse; the existence of files alone is insufficient. Cache grading only by the full evidence/rubric/judge identity. Preserve raw judge output and every failed attempt; a failed re-judge cannot erase an existing valid result with the same identity. The local reference checkout has changes beyond its Git HEAD, so record hashes of the specific Harness² files used as methodological references as well as its commit.

**Scoring map, frozen before the main runs.** For every requirement (C1-C3, D1-D2) and every stage where it applies: what counts as a failure, and what evidence shows it. At most one failure per requirement per stage; a transient violation (an edit to `legacy/` later undone) counts.

**Prohibited-action log.** An evaluator-owned watcher records file-system events in each task folder (for example macOS FSEvents through `fswatch`) alongside the captured tool calls. Phase 0 shows it catches a script that changes and restores a protected file within one tool call. Attempted operations (a refused or failed call) and completed changes are logged apart.

| Measure | Role | How |
| --- | --- | --- |
| **Goal-keeping failures** (scoring map) | **Primary** | Prohibited-action log, captured tool calls, and the evaluator's snapshot after every stage |
| **Task completion** | **Co-primary guard** | Hidden tests on the snapshot at the end of the last task stage, before the goal-restatement prompt |
| Constraint failures; decision failures | Secondary, apart | As the primary, split, so a gain in one cannot hide a loss in the other |
| Regressions observed across a compaction interval | Secondary | A fixed, stage-appropriate test set passing at the snapshot before a compaction and failing at the snapshot after the next stage. Without a run that never compacts, it does not show the compaction caused it |
| Goal restatement | Secondary (recoverability) | After the last stage: "State the goal, the constraints and the decisions." A separate automated rubric judge scores each proposition (the goal, each Cn, each Dn: present, absent, contradicted; plus unsupported additions) against the scripted instructions for all 18 outputs. Remove explicit arm labels; retain evidence and reasons |
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
| Stop gate, active | An announcing turn end is sent back once, without a loop | A reporting turn end is not; every eligible turn end is independently classified against the frozen rubric from the turn's request, actual actions and final answer | Records, captures, fixture labels and automated judgments; agreement with the judge is not ground-truth precision |
| Stop gate, shadow | One record per eligible turn end, with the skip reason where skipped | | Records against turn ends |
| Conditional instructions, active | A keyword match attaches once; a condition met without its keyword (Jev) attaches once; a pinned fragment is in the system prompt; after a summary it is attached again | A non-match attaches nothing; after a fold-only compaction nothing is attached again | Captures, records |
| Tool gate floor | Under forced external trust: a secret file, a secret-printing command and a direct read of the archive are refused | An ordinary file is allowed; under first-party trust only protected writes are refused | Tool results, records |
| Tool gate Jev, active | Under forced external trust, a target the floor allows but Jev classes restricted is refused | A target classed open is allowed | Tool results, records |
| Fold relevance, shadow | Fixtures with results of distinct sizes, more than 24 (one batch) and more than 48 (the sample limit), some folded and some kept by the policy. The expected sample is enumerated independently: results the fold could act on, at least `minFoldChars`, the 48 largest. One record per sampled result; `heuristic` equals whether that result was archived; with controlled answers, `jev` equals 1 − P(needed) | No record for a result outside the sample; no records and no call without a key or without a person's prompt; a failed call writes records with the error and no `jev` | Deterministic test with controlled answers; records against captures |
| Instruction filter, deterministic | A chunk loaded twice, planted on purpose, leaves once with the note in its place | A unique chunk stays; organization and memory files are never changed | Captured system prompt |
| Instruction filter, Jev readings (shadow) | With controlled scope and coverage answers, each chunk's record carries those values and the expected `would-keep`, `would-defer` or `would-drop`; Jev's readings never make an always-kept chunk `would-defer` or `would-drop` (a byte-for-byte duplicate or an older OMC copy is `would-drop` whatever its heading: that decision is deterministic and checked in the row above) | No chunk text is removed or attached by a reading | Records; captured system prompt unchanged |
| Instruction filter, deferred use (shadow) | After a chunk is `would-defer`: for every later request, slash commands included, one record per deferred chunk with `would-attach` or `skip` as the controlled answer says, the request's turn and origin; a tool call of the chunk's kind (browser, web fetch, `orca`, `claude -p`) writes one tool-use record | No deferred-use record when nothing is deferred, for an empty request, or without a key; no tool-use record for a call of no listed kind | Records against captures |
| Status line | Empty at start; `jev: no key` at once when the key is missing; appears after the first recorded event | | One screen check |

### Q3: does the Stop gate improve completion?

**User story.** A user enabling the gate wants the agent to finish feasible, authorized work after an otherwise premature stop, while still accepting a completed stage, a genuine need for user input, and an explicit user stop. This is an outcome comparison in addition to Q2's branch and lifecycle checks.

| Arm | Harness configuration | Starting state |
| --- | --- | --- |
| **S0** | H's bundle with `stopGate: off` | Fresh session and task copy; the same seeded project files as S1 |
| **S1** | H's bundle with `stopGate: active` | Identical generated task inputs, files and stage prompts for the paired seed |

The only configured difference is the Stop mode. Pin the Stop threshold (initially 0.7), timeout, cap, Jev model, executor model/effort, plugin build and every other setting before the main runs. Other Jev devices remain in `shadow`. S0 makes no Stop judgment calls; S1's judgment latency, extra turns and tokens are part of the intervention and are measured. This estimates the effect of enabling this gate within H's bundle, not an effect at equal compute or the quality of Jev alone. Active mode here is a research treatment, not qualification for deployment.

**Allocation.** Use the same three task families and three main seeds as Q1, in fresh runs: **9 pairs, 18 additional main runs**. The original Q1 18 runs remain required, for **36 main runs total**. Q1's shadow H runs are not reused as S0. Add a separate S0/S1 pilot pair, giving **4 pilot runs total** across Q1 and Q3. Pilot seeds are excluded from main-run scoring. Freeze a randomized order of all 18 Q1/Q3 pair units and the arm order inside each pair; run a pair's arms consecutively.

**Natural stops and stage contracts.** Both Q3 arms receive the same 12-stage workload, including the same forced compactions after stages 3/6/9 and automatic-fold policy. Start from identical generated, unfinished task states. Do not instruct the agent to announce unfinished work, inject an assistant ending, append a corrective user prompt, or select main cases after seeing which ones stopped. Forced announcements belong to Q2 only. The driver lets the real Stop hook run and any automatic continuation settle, takes the stage snapshot, and only then sends the next fixed stage prompt. It never repairs an early S0 handback with an extra "continue". Clarification replies stay within the same stage and follow the existing fixed answer policy. Score the requirements already assigned and due at that stage; future stage instructions are not unfinished work yet. Final task completion uses stage 12's snapshot before any restatement or recovery prompt.

**Independent Stop observations.** Add the same evaluator observer to S0 and S1. Capture every main-agent `classic.Stop` candidate before the gate decides, its stage/turn/attempt IDs, skip and re-entry facts, final assistant text, task snapshot fingerprint, and the returned block/allow result. Link any later continuation to that candidate and retain a post-continuation snapshot. The observer must return the underlying hook result unchanged and reveal no oracle, rubric or judge feedback to the agent. Record its latency; neutrality does not mean zero overhead. S0's plugin Stop-record count is legitimately zero; the observer supplies its census. A final `result` event alone cannot show the candidates suppressed by S1. Phase 0 must prove the observer's ordering and neutrality; if it cannot collect these observations, Q3 is not ready.

**Oracles and grading.** After teardown, apply frozen stage-specific checks to the captured artifacts and action log. Establish that each oracle accepts a reference solution and rejects a deliberately incomplete one. A claimed "done" with failing checks remains incomplete. A fresh, condition-neutral judge classifies each candidate using only its pre-decision request, actions and snapshot evidence, with the plugin's verdict, Jev probabilities and subsequent continuation withheld. Distinguish premature announcements, other premature handbacks, completed work and legitimate waits/stops; uncertainty stays ungraded. This uses the Harness² evidence/rubric method and does not turn model classifications into validated ground-truth precision.

| Measure | Definition |
| --- | --- |
| **Completed stages per run (primary)** | 0–12 stages whose due task contract is met when handed back, including required verification and constraints; wording alone earns no credit |
| **Final task completion (co-primary guard)** | Hidden-test pass fraction and All-pass on the last task-stage snapshot, using the same fixed criteria in S0/S1 |
| Premature handbacks | At most one per reached stage that ends with feasible, authorized work still due; report announcement and other-ending categories separately |
| False interventions | S1 asks for continuation when the pre-decision snapshot already satisfies the stage, or when waiting/stopping is legitimate; report counts and the number of such observed opportunities |
| Correction yield | A correctly intercepted premature stop is followed by an additional due criterion passing or the stage becoming complete; a continuation message, mtime change or progress-note update alone is insufficient |
| Goal-keeping failures | The existing constraint/decision scoring map, so extra work cannot hide a violation |
| Exposure and failures | Candidate/eligible/skipped/blocked counts, re-entry, actual continuations, Jev timeouts/caps/circuit failures, unreachable stages and evidence coverage |
| Cost and ceilings | Tokens, requests, Jev calls, wall time, extra turns/compactions and run-ceiling exhaustion under equal per-run ceilings |

A run ceiling is an observed treatment outcome, not a replacement opportunity. Unreached stages count as uncompleted for the 12-stage completion endpoint, but are not labelled premature stops. Missing captures, broken evaluators or uncertain semantic labels remain ungraded. An invalid artifact produced by the agent is a task failure when a valid oracle rejects it. Stop-count comparisons require complete stage coverage and labels in both arms; report incomplete counts with their coverage, not missing stages as zero failures. Jev timeouts, cap exhaustion and circuit opening during an otherwise valid S1 run stay in the treatment outcome; do not remove unfavorable cases as infrastructure failures.

**Q3 interpretation, frozen before main runs.** Report the mean of the 9 paired completed-stage differences (S1 minus S0), the paired premature-handback counts where fully observed, per-family results and a bootstrap interval over seeds within each equally weighted family. An observed completion benefit requires at least **one additional completed stage per run on average**, no family worse on average, final task completion no lower, neither constraint nor decision failures worse, and no observed false intervention on a legitimate stop. It also needs at least one correctly intercepted premature announcement followed by objective progress. Otherwise report the observed differences and any tradeoff or insufficient exposure; do not claim an overall benefit. A separate claim of fewer premature handbacks requires a positive S0-minus-S1 difference with full coverage and no worsening hidden by a change in ending category. If no premature announcement is exercised, the Stop mechanism's benefit is **NOT EXERCISED**, not proved absent or effective. These are exploratory results for these task families, not a significance or deployment-precision claim.

**Q3 acceptance and limits.** Before the pilot, Q2 must show one retry without a loop and preserve completed reports, questions, genuine approval/input waits, explicit user stop requests, missing-key/timeout behavior and underlying Stop-hook precedence. Run each live positive and negative case at least three times as specified above. The Q3 scorer must reject a dropped continuation, missing pre-decision snapshot and an incomplete artifact relabelled complete. Main-case manifests, oracles and ceilings are frozen after the paired pilots. If a pilot changes an oracle, observer or relevant case definition, version it and rerun the affected phase-1 checks before main runs. Evaluate every scheduled pair, including those with no natural premature stop; never replace cases to enrich the effect. Q3 cannot pass on Q1 or Q2 results alone.

**Decisions and assumptions.**

- 2026-10-26 | settled | The owner requested adding the previously discussed active/off outcome comparison. Earlier Q1/Q2 requirements and the Haiku/max/subscription/Jev-budget decisions remain in force.
- 2026-10-26 | assumed | Match Q1's nine-pair allocation for Q3 and use one extra completed stage per run as the practical benefit threshold. Check feasibility in the pilots before freezing; changing sample scope or the approved spend ceiling requires the owner's decision, not an automatic reduction.

## Phases

| Phase | What | Exit |
| --- | --- | --- |
| 0. Setup | Research configuration folder; login; proxy and its transport tests; trust, credential and permission checks; teardown and contamination detection tested; the prohibited-action watcher test; driver chosen by the full-chain test; Q3 Stop observer ordering/neutrality | Every phase-0 check passes |
| 1. Devices | Deterministic action tests, then live smoke tests of H in diagnostic configurations; Q3 scorer negative probes and legitimate-stop controls | Every diagnostic case meets its minimum and passes. A failure stops the phase until the defect is fixed and retested; a filed defect is not a pass |
| 2. Pilot | 1 task family and pilot seed: V/H plus a fresh S0/S1 pair, on the selected main model; 4 runs | Both comparisons score end to end; Q1 exposure met; Q3 oracles and observation coverage checked; cost measured separately; scoring maps and ceilings frozen |
| 3. Main | Q1: 3 families × 3 seeds × V/H = 18; Q3: 3 families × 3 seeds × S0/S1 = 18; 36 total | Both sets scored separately. Every missing run is accounted for; a missing comparison remains incomplete, not satisfied by the other set |
| 4. Report | `docs/research/long-task-results.md` | Separate Q1 and Q3 paired tables/decisions, completion, premature handbacks, false interventions, correction yield, exposure, device checks, cost and limits |

**Frozen before the main runs:** executor model/effort, separate judge model and prompts; binary/plugin/Jev versions; task generators, pilot/main seeds; both scoring maps and Q3 oracles; exposure minimums; common per-run ceilings (turns, wall time, tokens); the list/order of all 18 pair units and the randomized arm order inside each pair.

**Device evidence reuse (2026-10-27 clarification).** A prior native device observation can be rechecked with the current assertions when the relevant executed code, CLI binary and case definition are unchanged and the original artifact hashes verify. Keep its originating run identity; count retained and newly executed observations separately. A failed or missing observation does not become a pass. The terminal status display does not use the recording proxy, so changing that proxy alone does not require another UI launch when the rendered native observations and their unchanged execution inputs are already preserved. New transport behavior still requires its own live acceptance.

**Interruptions.**
- Reaching a run's ceiling is an observed outcome of that arm and is not replaced.
- A contaminated run (see Research environment) does not count toward the decision and is not replaced; its pair is reported missing.
- Infrastructure or usage-limit interruptions are told apart from treatment outcomes before any scoring. During the pilot, repair the failing execution or recording path and rerun fresh comparison pairs under a versioned specification until both comparisons can be scored end to end. The owner explicitly requested this on 2026-10-27; the previous one-pair replacement rule was a plan choice, not an owner-imposed pilot retry limit. Preserve every attempt and its cost. Any changed ceilings apply equally to all four fresh arms, and earlier ceiling outcomes remain under their original specification. Ordinary Jev timeout/cap/circuit behavior is not a Q3 replacement reason. Freeze the main-run replacement policy before main execution.
- If outcomes are still missing, report available-pair estimates explicitly and do not make the affected experiment's 9-pair decision. Q1 and Q3 cannot borrow each other's runs or complete each other.

**Budget.**
- The pilot runs on the main model, so its measurement is the one the budget uses.
- The budget is set separately for setup, phase 1, the Q1/Q3 pilots, each experiment's main runs, scoring and Jev. Include S1's extra turns and active Stop calls. The account's usage meters are recorded before and after each phase. The existing USD 10 total Jev ceiling covers both studies and every failed attempt; this amendment authorizes no higher spend ceiling or paid Claude API route.
- A separate configuration folder does not get a separate allowance.
- If all 36 planned main runs do not fit the approved budget or subscription allowance, stop with the study incomplete. Keep all evidence and both three-family scopes; changing that scope requires the owner's decision before further main outcomes are inspected.

## Deciding the Q1 result

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
| The agent reads answers or earlier runs | Answers not on disk during a run; per-run teardown; every read in the capture, contaminated runs reported apart |
| Transient violations go unseen | File-system watcher, tested against an edit-and-restore script |
| The proxy changes behaviour | Transport tests; one turn with and without it |
| Credentials or private text in captures | Removed from what is written; captures outside task folders, never committed; synthetic tasks only |
| Costs miscounted | Usage rebuilt from the stream events; Jev counted per call |
| Usage limits | Pilot on the main model; budget per phase; meters recorded |
| Forced compaction is not natural compaction | Stated as a limit; exposure minimums per boundary |
| Run-to-run variation | Paired seeds; randomized arm order within pairs; per-run tables |
| Versions drifting mid-study | Binary and plugin pinned |
| The gate only changes the wording of a bad stop | Q3 scores due artifact/test criteria at stage handback; a "done" claim does not satisfy them |
| Active mode delays legitimate stops or gets more chances | Observe every candidate in both arms; label before seeing the gate decision; false-intervention and completion guards; report extra compute |
| Selective Stop exposure or unequal stage coverage | Preserve all scheduled pairs and unreached/ungraded states; no after-the-fact enrichment or zero-filled missing Stop counts |

## Not in this round

- Deployment-grade calibration of judgment devices, including validated Stop-classifier precision, remains outside this round. Q3 measures downstream Stop-gate completion effects with explicit evidence and grading limits; it does not satisfy that calibration. Whether conditional fragments improve answers still needs its own outcome study.
- A third arm separating the project files from the plugin.
- An external benchmark ([long-horizon-benchmarks.md](long-horizon-benchmarks.md)): after this round, not part of its completion.
- Natural window pressure, other models, other harnesses.
