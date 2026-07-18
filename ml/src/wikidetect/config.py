"""Every constant the package uses, in one place.

The magic numbers below were previously scattered as per-file consts across
the JS detector (detect.js, sweep.js, fetch-samples.js, score.js); the two
date cutoffs each existed in two conflicting versions.
"""

import os
from pathlib import Path

# Repo layout. The package is used from an editable install inside the repo;
# WIKI_REWRITE_ROOT overrides for anything else.
REPO = Path(os.environ.get("WIKI_REWRITE_ROOT", Path(__file__).resolve().parents[3]))
ML = REPO / "ml"
ARTIFACTS = REPO / "artifacts"           # Node<->Python contract layer (committed JSON)
SWEEPS = ARTIFACTS / "sweeps"            # bulk sweep outputs (gitignored)
DATA = ML / "data"                       # gitignored: corpus texts, score cache
CORPUS_TEXTS = DATA / "corpus" / "texts" # content-addressed sample store
CACHE_DB = DATA / "cache" / "scores.sqlite"
MANIFESTS = ML / "manifests"             # committed: corpus manifests + blocklist
RUNS = ML / "artifacts" / "runs"         # gitignored: training runs
THRESHOLDS = ARTIFACTS / "thresholds.json"
EXEMPLARS = ARTIFACTS / "exemplars.json"

# --- date cutoffs (the two distinct concepts, one definition each) ----------
# An article CREATED on/after this date whose whole body is tagged
# {{AI-generated}} is a trustworthy positive (ChatGPT public release).
AI_ERA_START = "2022-12-01"
# Human negatives come from revisions strictly BEFORE this date — a 6-month
# safety margin ahead of the AI era.
HUMAN_CUTOFF = "2022-06-01"

# --- Wikipedia API -----------------------------------------------------------
API_URL = "https://en.wikipedia.org/w/api.php"
USER_AGENT = "wiki-rewrite-detector/2.0 (ishamehtaaa@gmail.com)"
FETCH_CONCURRENCY = 5      # polite parallel fetches (replaces 400ms serial sleep)
CATEGORY_MAX = 5000        # cap on category enumeration

# --- text handling -----------------------------------------------------------
MIN_DOC_WORDS = 40         # detector output on shorter fragments is noise
MIN_PARA_WORDS = 25        # paragraph scores below this are noise
MAX_PARAS = 10             # per-article paragraph scoring cap in sweeps
SWEEP_MIN_CHARS = 400      # skip stubs — too little prose to score
SWEEP_MAX_CHARS = 12000    # per-article scoring window
SAMPLE_MIN_CHARS = 500     # corpus sample floor
SAMPLE_MAX_CHARS = 3000    # ~768 tokens is all the detector reads anyway
EXEMPLAR_MIN_CHARS = 300
EXEMPLAR_MAX_CHARS = 1200
EXEMPLAR_RECOMMENDED_MAX = 4  # beyond this the prompt bloats for no gain

# --- models ------------------------------------------------------------------
DEFAULT_MODEL = "desklib"
# DeBERTa-large attention is memory-hungry on MPS: bound batches by padded
# token budget, not item count (short paragraphs batch wide, full docs narrow).
MAX_BATCH_TOKENS = 4096
MAX_BATCH_ITEMS = 32
MODEL_MAX_LENGTH = {"desklib": 768, "e5": 512}

# --- serving -----------------------------------------------------------------
# Loopback-only by default; containers set WIKIDETECT_HOST=0.0.0.0 so the
# web app's bridge can reach them across the docker network.
SERVE_HOST = os.environ.get("WIKIDETECT_HOST", "127.0.0.1")
SERVE_PORT = 8756
