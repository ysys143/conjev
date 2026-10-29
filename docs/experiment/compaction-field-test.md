# Field test: folding against the engine's summary

English · [한국어](compaction-field-test.ko.md)

**Result: folding did not write a better report than Claude Code's own summary and cost as much, so it is off by default. Beyond that, the runs could not rank the configurations: a second run of the default scored below both others, where the first had scored above them.** Every report was accurate; the scores differed mostly by how much each covered, and that varied as much between two runs of one setting as between settings. Folding kept an instruction given mid-conversation best.

## The task

One long, autonomous research-and-writing task, run to the end without a person in the loop:

- Read a codebase and four external repositories in full (several hundred source files), check external facts on the web, and write one report that answers sixteen questions with a citation for every claim (`path:line` or URL).
- 21 checklist items in a task file, including two recall checks ("say what you were told without reopening the file") and two full reviews.
- Started with one `/goal` prompt and left to run. One instruction was sent mid-run, in the conversation only: "put the check date after every external URL".
- Claude Haiku 5.5 in every session, from a clean profile. Each session ran about two to two and a half hours, processed 180 to 270 million tokens, and compacted three or four times, each time at about 97% of a one-million-token window.

## The configurations

| | Compaction | Jev gates |
| --- | --- | --- |
| **A** | the engine's summary (no plugin) | none |
| **B** | conjev folding, recency counted by the person's prompts | all eight, active |
| **C** | the engine's summary (`fold: off`) | all eight, active |

A fourth run, folding with recency counted by model turns, was stopped before it finished and is not scored ([below](#what-folding-did)).

## Measured

| | A | B | C |
| --- | --- | --- | --- |
| Tokens processed | 179 M | 266 M | 263 M |
| Report length | 223 k chars | 104 k chars | 186 k chars |
| Citations that resolve | 99.5% | 99.5% | 99.5% |
| Mid-run instruction kept (dated URLs) | 16 of 23 (70%) | 35 of 35 (100%) | 38 of 43 (88%) |
| Compactions | 3 | 4 | 3 |

Citations were checked mechanically against the files each session read. No judgment was involved.

## Judged blind

Two judges, Claude Opus 5.5 and Codex, scored each pair of reports without knowing which configuration wrote which. The order was random and run traces were removed. Each report was scored against 25 reference facts, the required sections and the instructions given. The overall score is the mean of accuracy (correct over correct plus contradicted) and coverage, averaged over the two judges.

| Pair | Scores | Judges differ by |
| --- | --- | --- |
| A and B | A 0.909, B 0.862 | 0.04, 0.09 |
| A and C | **C 0.946**, A 0.925 | 0.02, 0.03 |
| B and C | **C 0.958**, B 0.889 | 0.02, 0.03 |

The same report scored 0.02 to 0.03 differently from one judging run to the next, so C over A is within that noise. C over B is not. C had no contradicted fact in either pairing. B rejected a reference fact on grounds it said it could not verify, and both judges marked that as contradicted.

## What folding did

Under one long `/goal`, folding barely ran:

- The plugin's early fold waits for a turn to end, and under `/goal` the turn never ends. Every compaction was the engine's automatic one, at the window's edge.
- Recency was counted in the person's prompts. A session prompted once keeps every result after that prompt as recent, so B folded 7 tool results across four compactions. Three of the four were partial summaries instead.

So B against C did not compare folding with summarizing. It compared conjev's partial summary, with B's own detours, against the engine's summary. Recency is now counted in model turns, with one response's rows counted once and the last 10 kept. In the stopped fourth run, the first compaction folded 133 results. Whether folding, working as intended, beats the summary on this kind of task has not been measured.

## A second run of the default

After the first three runs, `fold: off` was changed to also archive the conversation a summary replaces and to write the note that points back at the project's files. That version (**C2**) ran once on the same task, with the same checklist given at the start as C.

| | C | C2 |
| --- | --- | --- |
| Tokens processed | 263 M | 186 M |
| Compactions | 3 | 2 |
| Report length | 186 k chars | 77 k chars |
| Citations that resolve | 99.5% | 99.3% |
| Dated URLs, any date | 39 of 43 (91%) | 17 of 25 (68%) |

| Pair | Scores | Judges differ by |
| --- | --- | --- |
| C and C2 | C 0.921, C2 0.896 | 0.09, 0.07 |
| A and C2 | A 0.908, C2 0.871 | 0.08, 0.08 |

C2 had no contradicted fact; it lost on coverage. The note never fired, since C2's project had no status board (C had made one during its run), so the only difference in configuration was the archive and its pointer. Two runs of nearly one setting wrote 186 k and 77 k characters: the run, not the setting, decided most of the score. In this pairing the judges also differed more than before (0.07 to 0.09), and C's own score moved from 0.946 and 0.958 to 0.921.

C2, like B, stopped on the two recall checks (it had reopened the task file, so it could not recall without it) and needed one closing instruction from the person.

## Where the differences came from

- **Cost.** B and C cost the same, both about 1.5 times A, and folding added nothing measurable. C2, with the same gates, cost about as much as A. The difference follows how much each run read and fetched: C called `web_read` 39 times, C2 six. The gates' own cost is small; what a run chooses to do is not.
- **Length.** The reports differ almost entirely in their appendices, the logs of the full reads. The bodies are within 20 to 28 k characters of each other. B received half its checklist and a no-delegation rule mid-run, delegated work, and redid it. C received everything at the start.
- **The mid-run instruction.** B kept it everywhere, C mostly, A least. This is the one place where the plugin's compaction path showed a clear advantage.

## Limits

- One run per configuration, and a second run of the default moved its score by more than any gap between configurations.
- The configurations did not start the same way. A and B received part of the checklist and the no-delegation rule mid-run, and C received it all at the start. Some of C's lead may come from that.
- The task wrote its findings to a file as it went, so little that a compaction removed was needed again. This favors a summary. A task that re-reads earlier tool output, such as debugging, was not tested.
- The reference facts came from an earlier session's answers and may themselves be wrong in places.
- C ran with the compaction handed to the engine untouched. Since then, `fold: off` also archives the conversation a summary replaces and writes the note that points back at the project's files. That version has not been measured.

## The setting

| | Default | When |
| --- | --- | --- |
| `fold` | `off` | `on` to try folding, for sessions that read earlier tool output again. Recency now counts model turns (`keepRecentTurns`, 10). Not measured on this task in that form. |
| Jev gates | `auto` | Active once a key is in place and you consent. They are what C ran with. |
