#!/bin/sh
# Run the app + detector on Apple `container` (macOS) — the equivalent of
# docker-compose.dev.yml for hosts using container.apple.com instead of Docker.
#
#   cp .env.example .env    # add your ANTHROPIC_API_KEY
#   ./container-up.sh       # build + run -> http://localhost:2000
#   ./container-up.sh down  # stop and remove both containers
#
# The detector image bakes in the desklib weights (~1.7 GB download on the
# first build); at runtime it needs ~30s to load the model before /health
# comes up. The app works immediately and falls back to the phrase-scan
# verdict until the detector is ready.
set -eu
cd "$(dirname "$0")"

if [ "${1:-}" = "down" ]; then
  container delete -f wiki-app wiki-detector 2>/dev/null || true
  exit 0
fi

[ -f .env ] || { echo "cp .env.example .env and add your ANTHROPIC_API_KEY" >&2; exit 1; }
. ./.env

# Baking the model needs more than the builder's default memory.
container build -m 8g -t wiki-detector -f Dockerfile.ml .
container build -t wiki-app -f Dockerfile .

container delete -f wiki-app wiki-detector 2>/dev/null || true

# DeBERTa-large on CPU wants ~4 GB; the default container VM gets only 1 GB.
container run -d --name wiki-detector --memory 6g --cpus 4 wiki-detector

DETECTOR_IP=$(container inspect wiki-detector | python3 -c \
  'import json,sys; print(json.load(sys.stdin)[0]["status"]["networks"][0]["ipv4Address"].split("/")[0])')

container run -d --name wiki-app -p 2000:2000 \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e WIKIDETECT_URL="http://$DETECTOR_IP:8756" \
  wiki-app

echo
echo "  app:      http://localhost:2000"
echo "  detector: http://$DETECTOR_IP:8756 (model loads for ~30s before /health responds)"
