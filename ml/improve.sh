#!/usr/bin/env bash
# One unattended improvement cycle for the detector:
#   harvest new monthly categories -> re-split -> train a throttled LoRA
#   candidate -> eval against the frozen desklib baseline.
#
# Ends in ADOPT or REJECT (see artifacts/runs/<run>/eval.json). Promotion is
# deliberately NOT automated: on ADOPT, eyeball the worst-scored samples for
# mislabels (blocklist them), then
#   uv run wikidetect calibrate --model <run> --corpus-version v1
#   uv run wikidetect serve --model <run>
#
# Run under caffeinate so a sleeping Mac doesn't suspend the GPU:
#   caffeinate -i ./improve.sh            # run name defaults to lora-<date>
#   THROTTLE=0.5 caffeinate -i ./improve.sh lora-experiment
set -euo pipefail
cd "$(dirname "$0")"

RUN=${1:-lora-$(date +%Y%m%d)}
THROTTLE=${THROTTLE:-0.3}       # sleep between micro-batches; machine stays usable
MAX_LENGTH=${MAX_LENGTH:-0}     # 0 = model default (768); 384 halves the compute
LOG=artifacts/improve-$(date +%Y%m%d-%H%M%S).log
mkdir -p artifacts

run() { echo; echo "== $* =="; uv run wikidetect "$@"; }
{
  run corpus harvest --version v1
  run corpus split --version v1
  run train --name "$RUN" --corpus-version v1 \
    --throttle "$THROTTLE" --max-length "$MAX_LENGTH" --grad-checkpoint
  run eval "$RUN"
} 2>&1 | tee "$LOG"
echo "log: ml/$LOG"
