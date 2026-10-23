#!/usr/bin/env bash
# Usage: run-trial.sh <arm K|S|F0|F1> <trial name> [model]
# Environment: CLAUDE_BIN (default: the newest ~/.local/share/claude/versions/*),
# CHX_CONFIG_DIR (a Claude Code profile folder; default: none, the default profile),
# CHX_RUNS (where trials, answers and archives go; default: runs/ here). Claude Code
# asks once whether to trust a new folder; this script never answers, so run
# under a folder the person has trusted.
# One fresh Claude Code session (an installed context-harness turned off for
# it) in its own folder: read a config and run a generator,
# two more turns so both results are no longer recent, the config is edited
# on disk, then /compact (not for K) and three questions. Answers no dialog.
set -u
ARM="$1"; NAME="$2"; MODEL="${3:-haiku}"
X=$(cd "$(dirname "$0")" && pwd)
TURNS="$X/turns-safe.sh"
BIN=${CLAUDE_BIN:-$(ls -d "$HOME"/.local/share/claude/versions/* | sort -V | tail -1)}
PROFILE=${CHX_CONFIG_DIR:+CLAUDE_CONFIG_DIR=$CHX_CONFIG_DIR}
R=${CHX_RUNS:-$X/runs}
mkdir -p "$R/trials" "$R/truth"
# The fold under test is the plugin's own.
cp "$X/../../hooks/fold.ts" "$X/chx/hooks/fold.ts"
DIR="$R/trials/$NAME"
T="chx-$NAME"
python3 "$X/make-trial.py" "$DIR" "$R/truth/$NAME.json"
printf '%s' '{"enabledPlugins":{"context-harness@context-harness":false}}' > "$R/settings-off.json"

tmux kill-session -t "$T" 2>/dev/null
tmux new-session -d -s "$T" -x 200 -y 50 "cd '$DIR' && env CHX_ARM=$ARM CHX_RUNS='$R' GEN_TRUTH='$R/truth/$NAME-gen.txt' $PROFILE $BIN --plugin-dir '$X/chx' --settings '$R/settings-off.json' --model $MODEL --allowedTools 'Read,Bash(python3 gen.py),mcp__chx__read_coordinate'"
sleep 14

printf '%s\n' \
  'Read config.yaml with the Read tool, then run `python3 gen.py`. Without quoting any key, value or token, tell me in one sentence what each contains.' \
  'Reply with the single word ok.' \
  'Reply with the single word ok again.' > "$DIR.p1"
bash "$TURNS" "$T" "$DIR.p1" > "$DIR.log" 2>&1 || { echo "$NAME: stopped in phase 1"; tmux kill-session -t "$T"; exit 3; }

# The file changes on disk after it was read: only the copy taken then holds the old value.
python3 - "$DIR/config.yaml" "$R/truth/$NAME.json" <<'EOF'
import json, sys
path, truth = sys.argv[1], json.load(open(sys.argv[2]))
s = open(path).read()
old = f"timeout_ms: {truth['timeout_old']}\n"
assert s.count(old) == 1
open(path, 'w').write(s.replace(old, f"timeout_ms: {truth['timeout_new']}\n"))
EOF

if [ "$ARM" = K ]; then first='Reply with the single word ok once more.'; else first='/compact'; fi
printf '%s\n' "$first" \
  'What is the value of retry_limit in config.yaml? Answer with the value only.' \
  'I edited config.yaml after you first read it. What was timeout_ms set to when you first read it? Answer with the value only.' \
  'What token did gen.py print on line 217 of the output you got earlier? Answer with the token only.' > "$DIR.p2"
bash "$TURNS" "$T" "$DIR.p2" >> "$DIR.log" 2>&1 || echo "$NAME: stopped in phase 2"
sleep 3
tmux capture-pane -p -t "$T" -S -300 > "$DIR.screen"
tmux kill-session -t "$T" 2>/dev/null
echo "$NAME done"
