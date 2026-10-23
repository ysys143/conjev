#!/usr/bin/env bash
# Usage: turns-safe.sh <tmux-target> <prompts-file>
# Sends each line of <prompts-file> as one turn and waits until the turn is
# over. It never answers a dialog: when one appears it stops and exits 3, so a
# person decides. TURN_IDLE: half-seconds without the busy marker before a
# turn counts as over (default 6); a slow model needs more, or the next prompt
# is queued while it still works.
set -u
T="$1"; FILE="$2"
nap() { perl -e "select(undef,undef,undef,$1)"; }
n=0
while IFS= read -r prompt; do
  [ -z "$prompt" ] && continue
  n=$((n + 1))
  # A dialog already on screen gets no keys: Enter would answer it.
  if tmux capture-pane -p -t "$T" | grep -q -E 'Enter to (confirm|select)|Do you want to|trust this folder'; then
    echo "dialog before turn $n: stopped, nothing sent"
    exit 3
  fi
  tmux send-keys -t "$T" -l "$prompt"; nap 0.5; tmux send-keys -t "$T" Enter
  for _ in $(seq 1 20); do nap 0.5; tmux capture-pane -p -t "$T" | grep -q 'esc to interrupt' && break; done
  idle=0
  for _ in $(seq 1 600); do
    nap 0.5
    screen=$(tmux capture-pane -p -t "$T")
    if echo "$screen" | grep -q -E 'Enter to (confirm|select)|Do you want to|trust this folder'; then
      echo "dialog at turn $n: stopped, nothing answered"
      exit 3
    fi
    if echo "$screen" | grep -q 'esc to interrupt'; then idle=0; else idle=$((idle + 1)); fi
    [ "$idle" -ge "${TURN_IDLE:-6}" ] && break
  done
  echo "turn $n done"
done < "$FILE"
