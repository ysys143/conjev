# Do folded results come back when they are needed?

Folding does two things: it takes finished tool output out of the window, and it keeps the original so a later step can have it back. This note asks about the second: when the original is needed after a compaction, does the model get it, and by which route? It has a field record from one long working session and a controlled experiment.

Recorded 2026-10-23 with context-harness 0.0.2 (its fold is context-fold 0.0.2's), Claude Code 2.1.309.

## Summary

- **In ordinary work the archive was almost never used.** Of 300 results folded in one long working session, the model went back to 15, all files it read again from disk, and none through `read_coordinate`.
- **When the original cannot be had any other way, only the pointer brought it back.** For a file changed since it was read, and for an output that cannot be produced again, Haiku 5.5 answered 5 of 5 with the current fold, 0 of 5 with a bare marker in its place, and 0 of 5 after Claude Code's own summary.
- **Claude Code's summary fails silently.** After summarizing, Claude Code attaches recently read files as they are now. Asked for a value as it was before the file changed, the model gave the new value as the old one, 5 times of 5. With the fold and no pointer, it said it could not know.
- **A capable model has another archive.** Opus 5.5 found folded and summarized originals by searching Claude Code's own session record (`<profile>/projects/<folder>/<session>.jsonl`), which keeps every tool result verbatim whatever compaction does.

## 1. Field record: one long working session

**Method.** The one long working session that ran with folding is this plugin's own development session (2026-10-21 to 23): 12 compactions, 9 that only folded and 3 that also went to Claude Code's summary. For each of the 300 archived results, the session record was searched for what came after the fold: `read_coordinate` on its id, a Read or `cat`/`sed`/`grep` of the same file, the same command run again, or nothing.

| Folded | Count | Reached again | Route |
| --- | --- | --- | --- |
| File reads (`Read`) | 26 | 15 (58%) | From disk 15, `read_coordinate` 0 |
| Command output, subagent reports, web searches | 274 | 0 | |

- The 30 `read_coordinate` calls in that session were all development tests: 20 with an id that does not exist, 10 with a test id. The first fetch of a real folded result came later the same day: a command's output, which only the archive held.
- In 11 of the 15 re-reads, the file had not been named in a prompt or a reply since it was folded. The path came from the transcript: the pointer, or the tool call that stays beside it. Section 2 separates the two.

**Limits.** One session, kept by the plugin's developer, who knows the mechanism. A result never touched again may still have been needed and guessed at; this record cannot tell.

## 2. Controlled experiment

### Design

Each trial is a fresh Claude Code session in its own folder, with an installed context-harness turned off for it:

1. The model reads `config.yaml` (120 lines of random settings) and runs `gen.py` (300 lines of random tokens; a second run prints different ones). It is told to describe them without quoting any value, so no value survives in its own reply.
2. Two short turns follow, so both results are older than `keepRecentTurns`.
3. The driver changes `timeout_ms` in `config.yaml` on disk.
4. `/compact`, except in arm K.
5. Three questions, each answered in its own turn:
   - **P1, file unchanged:** the value of `retry_limit`. The disk has it.
   - **P2, file changed:** `timeout_ms` as it was when first read. The disk now holds a different value.
   - **P3, output not repeatable:** the token `gen.py` printed on line 217. Running it again prints another.

| Arm | What stands in for the two results after compaction |
| --- | --- |
| K | Nothing changes: no compaction |
| S | Claude Code's own summary |
| F0 | The tool call and `[folded]`: no target, no id, no note |
| F1 | The tool call, the pointer line and the note after compaction, as context-harness 0.0.2 leaves them |

F0 and F1 differ only in what is left in the result's place, so the difference between them is the pointer's effect. Answers are scored as right, stale (P2 answered with the new value), wrong, or abstain; the route is read from the tool calls the model made for that question. The kit is in [`experiments/fold-recovery/`](../../experiments/fold-recovery/).

### Haiku 5.5, 5 trials per arm

| Question | K | S | F0 | F1 |
| --- | --- | --- | --- | --- |
| P1 file unchanged | 5/5 | 5/5 (file re-attached 4, disk 1) | 5/5 (disk 5) | 5/5 (archive 2, disk 3) |
| P2 file changed | 5/5 | 0/5, **stale 5** | 0/5, abstain 5 | **5/5** (archive 3, already fetched in P1 2) |
| P3 not repeatable | 5/5 | 0/5, abstain 5 | 0/5, abstain 5 | **5/5** (archive 5) |

1. **Files come back without the pointer.** In F0 only the tool call was left, and the model read the file again 5 times of 5. The pointer text is not what brings a file back; the call beside it is enough.
2. **Only the archive brings back what the disk no longer holds.** For P2 and P3, F1 was right every time and used `read_coordinate` whenever the value was not already in view; F0 and S never were.
3. **The summary path re-attaches files as they are now.** After Claude Code's summary, the session record holds a `file` attachment for `config.yaml` with its current content. That answered P1 without a tool call, and made P2 wrong with confidence in every trial. The fold path attaches nothing, and F0 said so rather than guess.

### Opus 5.5, 5 trials per arm

These trials cannot be scored per question. The driver counts a turn as over after 3 seconds without Claude Code's busy marker; Opus paused longer while working, so later questions were queued and answered together (56 queue entries across the Opus trials against 12 for Haiku). `turns-safe.sh` now takes `TURN_IDLE` to wait longer.

One behaviour is clear from the tool calls alone: **after compaction, Opus searched the session record for the original output** in 4 of 5 S trials, 2 of 5 F0 trials and 2 of 5 F1 trials (`grep -o 'timeout_ms: [0-9]*' <profile>/projects/<folder>/<session>.jsonl`), and found it. Claude Code writes every tool result to that file and compaction does not change it, so any session already has an archive a capable model with shell access can reach. What the pointer adds is a direct route: one call, by id, with line ranges, and no shell.

## What this does not show

- **How often the original is needed.** The questions ask for earlier output directly. Section 1 is the better guide to frequency.
- **Whether long tasks go better.** See [long-horizon-benchmarks.md](long-horizon-benchmarks.md).
- **The pointer line against the note.** F1 has both, and the note names `read_coordinate`.
- **Other models.** Two models, five trials each; Opus without per-question scores.

## Follow-ups this suggests

- For a file read, point at the file to read again; the archived copy may be older than the disk.
- Rerun Opus with turn ends read from the session, not the screen, and the session record counted as its own route.
- An arm with the pointer line and no note, to separate the two.
- The larger question, whether long work goes better across compactions with every device of the plugin, is planned in [next-evaluation.md](next-evaluation.md).
