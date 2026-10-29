# Field test: folding against the engine's summary

English · [한국어](compaction-field-test.ko.md)

**Result: with the Jev gates on, Claude Code's own summary at compaction (`fold: off`) produced the best document of the three configurations. Folding is therefore off by default, and `fold: off` with the gates on is the recommended setting.** The cost of the plugin came from the gates, not from folding, and folding kept an instruction given mid-conversation best. Each configuration ran once, so the gaps below are one sample each.

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

## Where the differences came from

- **Cost.** B and C cost the same, both about 1.5 times A. The extra is the gates, mostly `web_read` returning page passages verbatim. Folding added nothing measurable.
- **Length.** The reports differ almost entirely in their appendices, the logs of the full reads. The bodies are within 20 to 28 k characters of each other. B received half its checklist and a no-delegation rule mid-run, delegated work, and redid it. C received everything at the start.
- **The mid-run instruction.** B kept it everywhere, C mostly, A least. This is the one place where the plugin's compaction path showed a clear advantage.

## Limits

- One run per configuration. A second run can move a 0.02 gap either way.
- The configurations did not start the same way. A and B received part of the checklist and the no-delegation rule mid-run, and C received it all at the start. Some of C's lead may come from that.
- The task wrote its findings to a file as it went, so little that a compaction removed was needed again. This favors a summary. A task that re-reads earlier tool output, such as debugging, was not tested.
- The reference facts came from an earlier session's answers and may themselves be wrong in places.

## The setting

| | Default | When |
| --- | --- | --- |
| `fold` | `off` | `on` to try folding, for sessions that read earlier tool output again. Recency now counts model turns (`keepRecentTurns`, 10). |
| Jev gates | `auto` | Active once a key is in place and you consent. They are what C ran with. |
