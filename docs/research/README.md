# Research

What has been measured about context-harness, what has not, and what is planned. Results are dated and name the version and model they ran on.

| Layer | Measured so far | Not yet measured |
| --- | --- | --- |
| Fold | Tokens removed per compaction; a needed original comes back, where Claude Code's summary answers stale ([fold-recovery](fold-recovery.md)); in one long session, 15 of 300 folded results were needed again, all files read from disk | Whether long tasks finish better |
| Project state | The consolidation request and the note after compaction fire (context-fold 0.0.2, README) | Whether the files carry the goal past compactions |
| Stop gate | Earlier rule/Jev comparison, κ 0.35; the 2026-10-27 active/off pilot completed 12/12 in both arms and observed one blocked completed report | General task-completion benefit and precision on genuine premature announcements |
| Tool gate | Refusals of secret files and secret-printing commands; Jev classes paths | False refusals in real use |
| Conditional instructions | Attached once; not attached again after a fold-only compaction | Whether answers get better |
| Fold relevance | Records are written | Too few needed results to judge |
| Instruction filter | Chunks loaded twice leave; Jev's readings recorded | Would-miss rate |

## Documents

- [next-evaluation.md](next-evaluation.md): **the plan.** Q1 compares vanilla/harness on long work (18 main runs); Q2 checks every device; [Q3](next-evaluation.md#q3-does-the-stop-gate-improve-completion) compares Stop off/active on task completion (18 additional main runs).
- [evaluation-progress.md](evaluation-progress.md): current acceptance, execution and failure records.
- [phase-0-results.md](phase-0-results.md): current-source execution environment and capture acceptance, 23/23.
- [phase-1-results.md](phase-1-results.md): 19 device areas, 92 cases with three observations each, and evaluator corrections.
- [token-overhead-diagnosis.md](token-overhead-diagnosis.md): immutable-request analysis of the first main pair; retained history, memory upkeep, recovery work, and separate cached-token accounting.
- [main-pair-1-results.md](main-pair-1-results.md): first main Q1 ledger/23 pair; H/V both 12/12 with zero detected goal failures and 6/7 restatement. Main study 2/36; full study incomplete.
- [pilot-results.md](pilot-results.md): completed four-condition pilot; Q1 and Q3 each have one valid pair, all 48 stages pass, and active Stop blocks one completed report. Source/criterion corrections and costs are preserved.
- [fold-recovery.md](fold-recovery.md): done. Does a folded result come back when it is needed? Field record and a controlled experiment.
- [long-horizon-benchmarks.md](long-horizon-benchmarks.md): survey of benchmarks for long tasks, and how LongMemEval would have to be adapted.

Experiment kits live in [`experiments/`](../../experiments/).
