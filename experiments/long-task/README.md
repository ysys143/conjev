# Long-task evaluation

This is the historical context-harness 0.0.3 evaluation kit. The 2026-10-27 receipts bind that build and its exact source fingerprints; they do not validate the current conjev build. Live probes keep the original plugin and tool identifiers and require the pinned build. The pure Python unit tests can run independently.

Source, reports, selected acceptance/usage receipts, analysis scripts and frozen source copies are tracked. Raw request/response captures, task workspaces and the study database remain local under the ignored `runs/` tree. Archived manifests retain those original paths and hashes. Reproducing a complete live acceptance requires the original local evidence; lightweight published receipts alone cannot establish it.

Implementation of [next-evaluation.md](../../docs/research/next-evaluation.md).
The study requires all phase 0–4 gates. Phase 0 passed its source-bound
23-gate acceptance; [the report](../../docs/research/phase-0-results.md) records
the actual evidence and limits. Phase 1 and the four-condition pilot are complete; each study has one valid pilot pair. The first main Q1 ledger/23 pair is complete: H/V both pass 12/12 stages, with zero detected goal failures and 6/7 restatement. Main execution is 2/36; the full study remains incomplete. See the [main-pair report](../../docs/research/main-pair-1-results.md) and [acceptance](runs/main-20261027-1/acceptance.json).

The authoritative 2026-10-27 result is [acceptance-final.json](runs/pilot-20261027-2/acceptance-final.json), with measurements in [report-data.json](runs/pilot-20261027-2/report-data.json) and the [Markdown report](../../docs/research/pilot-results.md). This pilot used execution specification 4 and versioned post-execution verification, full-instruction restatement grading and environment auditing. Original v1 counters and rejected/ungraded model responses remain intact.

Reproduction scripts for this frozen dataset are in [pilot-20261027-repair](runs/pilot-20261027-repair/): `grade_v2.py` binds tests to the task workspace, `resume_grading.py` retains valid judgments and preserves citation failures, `complete_restatement.py` supplies all original instructions, `scratch_audit.py` distinguishes a proven new temporary output from pre-existing foreign information, and `validate-pilot.py` checks their original artifacts. These dataset-specific scripts refuse to overwrite existing evidence. `negative_acceptance.py` rejects five deliberately incomplete temporary copies. The raw `pilot_run.py` CPU counters are retained as execution provenance; the corrected result is explicitly selected by the scoring and environment manifests.

Current components: a closed-run rubric grader, a recording loopback proxy,
a persistent streamed-input driver, a filesystem watcher, a native tmux job
launcher, a read-only environment audit, an evaluator-only Stop observer,
atomic Jev spend reservations, executable stage oracles, scoped contamination
checks and aggregate phase-0 acceptance. Their
fixture checks do not validate the real Claude transport or lifecycle. The
task generator supplies three seeded 12-stage families and executable stage
maps; its reference/mutant calibration is CPU evidence only. The complete
frozen device-case manifest and study orchestrator remain incomplete.
A 19-surface/92-case index now expands through `device_contract.py` into
89 executable controlled hook cases and three separate skill cases. The 89
hook cases and four product-mutation RED probes pass their preparation checks;
the complete live bindings and freeze remain required. Candidate live filter
and skill runners are `device_filter_probe.py` and `device_skill_probe.py`.
Their diagnostics do not credit phase-1 completion before that freeze.
On 2026-10-26 subscription
requests succeeded and the persistent automatic-compaction lifecycle passed
its closed-evidence audit. The basic Stop off/active observer controls also
passed, three repetitions per announce/report/question case in each mode.
These controlled cases are not Q3 completion outcomes. Native tmux execution verified the owner's existing login;
direct credential lookup failure was not evidence of incomplete user login.

The current host uses Python 3.14.7, Node 20.20.1 and fswatch 1.22.0. The capture
decoder uses Python's standard `compression.zstd` and Node's built-in Brotli
decoder; it does not install a provider SDK or a paid API transport.

```sh
python3 experiments/long-task/preflight.py --config ~/.claude-reserach
```

This inventory-only command returns 2 and does not load stored acceptance
evidence. Its result is not the aggregate phase-0 decision. The latter is
computed by `phase0_gate.py` from `phase0-evidence.json`, checking closed native
jobs, source identities, live captures and the component oracles.

`native_run.py` launches a task-owned session in the existing tmux server, using
an explicit existing cwd and removing the parent's `CLAUDECODE` flag. It keeps
stdout, stderr and a job receipt. It does not close or alter existing sessions.
It records the server PID and uses tmux `-N` so a missing server cannot silently
be replaced by a new server from the agent's failing command context. Credential
access is checked again in every job; earlier success is not a current grant.
Run the evaluator, its proxy and Claude children in this context consistently
so credential and transport checks describe the same execution conditions.

`driver.py` loads `user,project,local` setting sources in each fresh task folder
and applies invocation-only settings to disable synced plugins/skills,
bundled skills, remaining built-in skill listings and automatic memory.
Native session records and diagnostic watcher barriers remain under the
research profile's per-project directories. Local plugin option
keys use `context-harness@inline`, as confirmed by the real startup inventory.
The harness's own three skills remain available in harness runs.

The evaluator observer is loaded before the harness. It snapshots the task
before every main-agent Stop candidate, preserves the underlying hook result,
links automatic continuations, and records the stage handback snapshot.
`acceptance.py` audits the full-chain diagnostic against actual message
captures: schema examples do not count as delivered pointers. Its PASS covers
the persistent lifecycle component, not all of phase 0.

Evaluator plugin tests are stored as `*.fixture.ts`, copied into a fresh
evaluator-only plugin by `observer_test.py`. This prevents the product's
recursive test discovery from loading evaluator tests against the wrong plugin.

```sh
python3 experiments/long-task/observer_test.py
tsc --noEmit -p experiments/long-task/observer/tsconfig.json
python3 experiments/long-task/acceptance.py --run <closed-diagnostic> --output <new-audit.json>
```

The observer reserves each Jev call against one durable study ledger before
forwarding it unchanged. Unknown outcomes retain the full default-context
reservation; successful usage is settled once per originating call. Failed
diagnostics count toward the existing USD 10 total. See `spend.py` and the
current progress report for actual spend. No key is passed to the observer's
local accounting service.

`usage_map.py` and `jev-usage-map.json` bind record-to-call accounting to the
actual device source. Copied fragment usage is counted once; fold/deferred
batch usage is counted once; per-chunk instruction readings and deterministic
tool signatures do not create more charges. A separate ledger call census
detects missing groups. Unknown usage stays unknown.

`contamination.py` audits explicit captured tool targets, including relative
escapes and symlinks, with an exception for the run's own native session
record. It leaves opaque commands unresolved. This is not an OS syscall trace.
The live contamination probe uses evaluator-generated canaries and confirms
that a fresh session cannot retrieve the previous session's archive coordinate.

The live watcher probe caught an edit-and-restore within one process. Earlier
failed probes are retained: an incompatible fswatch option pair and a readiness
history event mistaken for the later probe. The checker now requires a new
event after its saved cursor. These are phase-0 watcher results, not acceptance
of the full driver, the devices or the study.

## Automated grading

The executor smoke test defaults to `claude-haiku-5-5` with `--effort max`
and thinking enabled, following the owner's 2026-10-25 model change. It records
the actual outgoing model, effort and thinking settings as well as the CLI
arguments. Pilot and main runs must use the same verified model and effort.
The separate judge model is supplied explicitly through `--judge-model`.

The grading method follows the local Harness² LAB implementation: separate
execution and grading, private frozen criteria, original evidence selected per
criterion, a fresh subscription judge with no tools, per-criterion reasons,
Partial and All-pass, and explicit ungraded results. The implementation is
independent and does not modify or import the reference checkout. See
`reference-provenance.json` for the exact source fingerprints, including local
changes beyond that checkout's Git HEAD.

`grading.py` accepts an evaluator-owned **closed run** and a private rubric.
It verifies `completion.json` and every artifact's SHA-256 before preparing
condition-neutral packets. Each criterion names evidence by relative path and
optional inclusive line range. Paths, run labels and the plugin's verdict are
not part of the packets. Evidence content itself can reveal the condition;
this is not a guarantee of perfect blinding.

```sh
python3 -m unittest discover -s experiments/long-task -p 'test_*.py' -v
python3 experiments/long-task/grading.py \
  --run /private/tmp/ch-research/closed/example \
  --rubric /private/tmp/ch-research/evaluator/rubric.json \
  --output /private/tmp/ch-research/evaluator/packets.json
```

Adding `--judge-model <frozen-full-model-id>` runs each criterion in a fresh
Claude Code subscription session. Login is checked before calls. The CLI's
API-price estimates are kept in raw transport output and are not subscription
charges. Jev's approved USD 10 budget is separate. No API-key fallback exists.

Every judge attempt keeps its packet, prompt, identity, stdout and stderr.
An accepted verdict must name the criterion, explain the decision, and quote
existing supplied evidence. Classifications must agree with the frozen
`class_verdicts` mapping. The CLI must report exclusive use of the frozen full
judge model ID. Invalid, failed or unscorable judgments remain
ungraded. Grounding checks validate references, not the semantic correctness
of a model's interpretation.

Results are reused only under the same run/evidence, rubric, prompt, model and
CLI fingerprint. A result file is never overwritten. Report `graded/expected`
alongside scores; Partial and All-pass are null until every expected criterion
is graded. `available_partial` is explicitly incomplete and cannot support the
study's nine-pair decision.

Goal-restatement and live Stop classifications are LLM-judged observations.
Hidden tests and controlled device cases retain deterministic oracles. Human
annotation is not an exit requirement.
