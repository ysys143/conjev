# Benchmarks for keeping a long task on track

The question: with context-harness folding instead of summarizing, does an agent finish long work better, through many compactions, than with Claude Code's own summary? [fold-recovery.md](fold-recovery.md) shows that a needed original comes back; it does not show that tasks go better. This note lists benchmarks that could, how well each fits, and what each would take. Surveyed 2026-10-23; details were checked against each paper's abstract or the project's own page.

## Fit, best first

| Benchmark | What it measures | Does compaction happen | Fit for this plugin |
| --- | --- | --- | --- |
| **LOCA-bench** ([arXiv 2602.07962](https://arxiv.org/abs/2602.07962)) | Agents as context grows ("context rot"), with the task's meaning held fixed while its context length is set by controlling the environment; evaluates model and scaffold together, context management included | Yes: length can be raised without limit | Best control: fold, summary and no compaction on the same task at chosen lengths. Not checked: whether Claude Code can be the agent |
| **LoCoBench-Agent** ([arXiv 2511.13998](https://arxiv.org/abs/2511.13998)) | Long-context software engineering, interactive: up to 50 turns, codebases of 10K to 1M tokens, 9 metrics including multi-session memory retention and architectural consistency | Yes; the paper describes its own tiered compression | Closest to real coding work. Uses its own 8 tools and compression, so Claude Code and the fold have to be put in their place |
| **Vending-Bench 2** ([Andon Labs](https://andonlabs.com/evals/vending-bench-2); v1 [arXiv 2502.15840](https://arxiv.org/abs/2502.15840)) | Running a simulated vending business for a year, scored by the bank balance at the end: long-term coherence | Yes: a v1 run exceeds 20M tokens | Measures "finishes long work" most directly. Not coding, its own environment, costly |
| **Governance Decay** ([arXiv 2606.22528](https://arxiv.org/abs/2606.22528)) | Whether constraints an agent obeys while visible are dropped by compaction, leading to prohibited tool actions | By design | Cheap to reproduce with this repo's kit, with constraints of our choosing. Aims at the summary's known failure |
| **MemoryAgentBench** ([arXiv 2507.05257](https://arxiv.org/abs/2507.05257), ICLR 2026) | Memory as information arrives in pieces: accurate retrieval, test-time learning, long-range understanding, selective forgetting | Information arrives as dialogue | "Selective forgetting" is P2 of the recovery experiment. Has to be fed as tool output for the fold to act |
| **LongMemEval** ([arXiv 2410.10813](https://arxiv.org/abs/2410.10813), ICLR 2025; [repository](https://github.com/xiaowu0162/LongMemEval)) | 500 questions over timestamped chat histories: single-session facts, preferences, temporal reasoning, knowledge updates, multi-session reasoning, abstention | `_S` (~40 sessions, about 115K tokens) fits a 1M window; `_M` (~500 sessions) does not | Fits once adapted (below). As shipped it does not test the plugin |

**For reference only**

- **Context-Bench** ([Letta](https://www.letta.com/blog/context-bench)): chaining file operations to find facts in fictional data. Retrieval rather than keeping a task going; compaction is unlikely.
- **SWE-ContextBench** ([arXiv 2602.08316](https://arxiv.org/abs/2602.08316)): whether experience from related earlier tasks is reused. Between sessions, not within one; fits a later cross-session archive.

## LongMemEval, adapted

As shipped, the history goes in as chat messages. context-harness leaves messages alone and folds tool output, so the fold never acts: `_S` fits in the window and is never compacted, and `_M` ends in Claude Code's summary whether the plugin is there or not.

Adapted: write each history session to a file, have the agent read the files with its tools, compact, then ask. The history is then tool output, and the questions exercise the fold and the route back:

- **Knowledge update** is P2 of the recovery experiment, where the summary answered with the new value every time.
- **Abstention** is what the fold did without a pointer: it said it could not know.
- **Multi-session reasoning** needs several folded results back at once.
- **Temporal reasoning** asks whether the pointer, which carries no time, is enough.

Costs: results compare the arms with each other, not with published scores; the original grades with an LLM judge, which would run through `claude -p`; all 500 questions in four arms is heavy, so a subset stratified by question type (around 50) is the practical start.

## Related work

- **The Complexity Trap** ([arXiv 2508.21433](https://arxiv.org/abs/2508.21433)): on SWE-bench Verified with SWE-agent, masking old observations halved cost and matched or slightly beat LLM summarization.
- **Less Context, Better Agents** ([arXiv 2606.10209](https://arxiv.org/abs/2606.10209)): enterprise tool use. Keeping the last 5 tool calls completed 79.0% against 71.0% for full history; adding summarization reached 91.6%. A counterpoint to the above, in a closed environment.
- **ACM: Agentic Context Management** ([arXiv 2607.23809](https://arxiv.org/abs/2607.23809)): lossless context management in which the agent offloads what it drops to an external memory and queries it on demand. The same idea as folding with `read_coordinate`, with the agent deciding when.
- **CliffCompaction** ([arXiv 2609.26779](https://arxiv.org/abs/2609.26779)): autocompaction that keeps recent turns verbatim and shortens older tool results, evaluated on Terminal-Bench.

## Before choosing

- **Plugging Claude Code in.** Most of these bring their own agent loop; whether Claude Code can be the agent has to be read in each repository.
- **Making compaction happen.** With a 1M window a single task may never compact; a smaller window or a forced compaction changes the conditions being measured.
- **Cost.** LoCoBench-Agent and Vending-Bench 2 are large runs on a subscription's usage limits.
