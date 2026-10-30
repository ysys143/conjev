# Candidate long-task cases

Implementation: `experiments/long-task/task_generator.py` and `task_families/`.
These are candidate workloads for the existing Q1/Q3 study, not live results
or a frozen main-run manifest. Pilot and main counts remain 0/4 and 0/36.

| Family | Application | D1, stage 4 | D2, stage 6 |
| --- | --- | --- | --- |
| ledger | Normalize ledger rows, aggregate balances, convert rates and report | Round half up rather than ties to even | Preserve first-seen account order rather than sorting IDs |
| routing | Filter, rank, dispatch, assign and report jobs | Preserve arrival order among equal priorities | Do not mutate caller-owned jobs |
| telemetry | Parse, window, group, deduplicate and analyze JSON events | Preserve case-sensitive source identifiers | Keep the first occurrence of a duplicate ID |

Each case has twelve fixed stage prompts. Stage 1 alone states C1–C3:
preserve the existing `api.v1.summarize` behavior, add/install no dependencies,
and never modify `legacy/`, even temporarily. The old API is checked on empty,
integer, floating-point, large-integer and invalid inputs. These constraints
apply at every stage. D1/D2 apply from their assigned stages onward.

At stages 1, 4 and 7, the task asks for two separate `emit.py` Bash calls.
Each prints 128 rows with a seeded reference marker and value among filler.
Both real generated outputs exceed 1,000 characters and their combined size
exceeds 4,000. They are two scripted user turns old at boundaries 3, 6 and 9
under the pinned default policy. Stages 11/12 combine values from before two
or more boundaries. Recovery from context, archive coordinates, files, command
reruns or the run's own session record is allowed and reported separately.

These are predicted opportunities, not live exposure measurements. The runner
must inspect actual tool results and compactions for every run. Combining the
two requested commands into one tool call, for example, remains an exposure
failure in the ledger; that run is not silently replaced or excluded.

`TaskCase.materialize()` writes only public inputs. V receives those inputs;
H/S0/S1 additionally receive the identical initial statement in INTENT.md,
empty PHASE.md and empty sessions/. S0/S1 public starting states are equal.
Expected answers, criterion maps and reference solutions remain in evaluator
memory. `private_definition()` may be persisted only after actual teardown.
No judge feedback is delivered during execution.

The stage map checks all requirements already due, test execution and task
behavior. Unknown action/watcher evidence stays ungraded. Task-hidden-check
fractions are separate from criterion Partial/All-pass. Constraint/decision
probes collapse to at most one failure per requirement per stage. Independent
decision probes prevent a priority-order failure also becoming an input-mutation
failure, or duplicate selection automatically becoming a source-case failure.

## CPU calibration

```sh
python3 experiments/long-task/calibrate_tasks.py \
  --seeds 11,23,47,71 \
  --output <new-evaluator-receipt.json>
```

These include three potential main seeds and one separate pilot candidate.
They remain unfrozen until the planned pilot gate.

Current receipt: `experiments/long-task/runs/task-calibration-20261026-4/report.json`.
It records 3 families × 4 candidate seeds × 12 stages = **144** passing reference
solutions, **144** incomplete stage implementations rejected despite completion
claims, and **72** isolated C1/C2/C3/D1/D2 and transient-C3 mutations rejected.
Each goal mutation causes exactly one named requirement failure. Real local
unittest subprocesses run before the snapshot oracles. No model/Jev call occurs.

The scorer rejects Python's `True == 1` equivalence for integer results; its
regression test fails under the old equality mutant. A reproduced negative-case
bug accepted serialization ValueError as the function's expected ValueError.
Function execution, import/lookup and output validation are now separate; the
regression test and the complete calibration pass. Earlier receipts remain.

The 92-case device manifest, live repetitions, actual task exposure, pilots,
frozen ceilings, semantic judging and 36 main runs remain required. This CPU
calibration does not establish context-harness performance.
