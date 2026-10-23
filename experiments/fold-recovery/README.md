# fold-recovery

The kit behind [docs/research/fold-recovery.md](../../docs/research/fold-recovery.md): does a folded result come back when it is needed, and by which route?

Each trial is one Claude Code session driven through tmux: read a config and run a generator, two more turns, the config changed on disk, `/compact`, then three questions whose answers need the originals. Four arms decide what stands in for the results after compaction:

| Arm | After compaction |
| --- | --- |
| `K` | No compaction |
| `S` | Claude Code's own summary |
| `F0` | The fold, with `[folded]` in place of each result and no note |
| `F1` | The fold as the plugin ships it: pointer line and note |

`chx/` is a small mod that sets the arm from `CHX_ARM`. Its fold is the plugin's own: `run-trial.sh` copies `../../hooks/fold.ts` into it before each trial.

## Run

Requires Claude Code, tmux, Python 3 and perl.

```sh
./run-trial.sh F1 F1-a1 haiku     # one trial
./run-all.sh 5 haiku m            # five per arm, the four arms in parallel
python3 score.py '-m\d'           # answers and routes, per arm and question
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHX_RUNS` | `runs/` here | Where trials, answers and archives go |
| `CHX_CONFIG_DIR` | none (the default profile) | A Claude Code profile folder |
| `CLAUDE_BIN` | the newest `~/.local/share/claude/versions/*` | The Claude Code binary |
| `TURN_IDLE` | 6 | Half-seconds without the busy marker before a turn counts as over; raise it for slower models, or questions queue up |

- **Trust.** Claude Code asks whether to trust each new folder it opens. `turns-safe.sh` never answers a dialog: it stops and leaves it to you. Point `CHX_RUNS` at a folder you have trusted.
- **Other plugins.** An installed context-harness is turned off in each trial (`--settings`); other plugins in the profile stay on.
- **Answers.** `config.yaml`'s values and `gen.py`'s first output are written under `CHX_RUNS/truth/`, where the session does not look. A second run of `gen.py` is counted, never recorded over the first.
