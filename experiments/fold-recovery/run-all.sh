#!/usr/bin/env bash
# Usage: run-all.sh [N] [model] [tag]
# N trials per arm, the four arms in parallel, trials within an arm one after another.
X=$(cd "$(dirname "$0")" && pwd)
R=${CHX_RUNS:-$X/runs}
mkdir -p "$R"
N=${1:-5}; MODEL=${2:-haiku}; TAG=${3:-m}
for arm in K S F0 F1; do
  ( for i in $(seq 1 "$N"); do bash "$X/run-trial.sh" "$arm" "$arm-$TAG$i" "$MODEL"; done ) > "$R/run-$arm-$TAG.out" 2>&1 &
  sleep 5
done
wait
cat "$R"/run-*-"$TAG".out
