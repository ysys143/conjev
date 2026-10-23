# Research

What has been measured about context-harness, what has not, and what is planned. Results are dated and name the version and model they ran on.

| Layer | Measured so far | Not yet measured |
| --- | --- | --- |
| Fold | Tokens removed per compaction; a needed original comes back, where Claude Code's summary answers stale ([fold-recovery](fold-recovery.md)); in one long session, 15 of 300 folded results were needed again, all files read from disk | Whether long tasks finish better |
| Project state | The consolidation request and the note after compaction fire (context-fold 0.0.2, README) | Whether the files carry the goal past compactions |
| Stop gate | Rule against Jev, κ 0.35; no false block in 12 ordinary turns | Precision on real announcements |
| Tool gate | Refusals of secret files and secret-printing commands; Jev classes paths | False refusals in real use |
| Conditional instructions | Attached once; not attached again after a fold-only compaction | Whether answers get better |
| Fold relevance | Records are written | Too few needed results to judge |
| Instruction filter | Chunks loaded twice leave; Jev's readings recorded | Would-miss rate |

## Documents

- [next-evaluation.md](next-evaluation.md): **the plan.** Does the plugin keep long work on track through several compactions, against vanilla Claude Code, with every device checked along the way.
- [fold-recovery.md](fold-recovery.md): done. Does a folded result come back when it is needed? Field record and a controlled experiment.
- [long-horizon-benchmarks.md](long-horizon-benchmarks.md): survey of benchmarks for long tasks, and how LongMemEval would have to be adapted.

Experiment kits live in [`experiments/`](../../experiments/).
