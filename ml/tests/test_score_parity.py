"""Score parity with the retired classify.py.

fixtures/classify-cache.json holds the per-file desklib p(AI) the old stack
produced (sha256[:16] of stripped sample text -> {p, file}). The new batched
dynamic-padding scorer must reproduce those within MPS numerics, and batched
must equal single-item scoring.

Loads DeBERTa-v3-large — run explicitly:
    WIKIDETECT_PARITY=1 uv run pytest tests/test_score_parity.py -q
"""

import hashlib
import json
import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("WIKIDETECT_PARITY"),
    reason="model-loading parity gate; set WIKIDETECT_PARITY=1",
)

FIXTURES = Path(__file__).parent / "fixtures"
SAMPLES = Path(__file__).parents[1] / "corpus-v0"
TOL_CACHE = 2e-3   # vs old cached scores (old code rounded to 4dp)
TOL_BATCH = 1e-3   # batched vs single


def load_samples():
    rows = []
    for label in ("ai", "human"):
        for f in sorted((SAMPLES / label).glob("*.txt")):
            text = f.read_text().strip()
            h = hashlib.sha256(text.encode()).hexdigest()[:16]
            rows.append({"file": f"{label}/{f.name}", "hash": h, "text": text})
    return rows


def test_desklib_score_parity():
    from wikidetect.models import Scorer

    old = json.loads((FIXTURES / "classify-cache.json").read_text())["desklib"]
    rows = load_samples()
    assert len(rows) >= 57
    scorer = Scorer("desklib")
    ps = scorer.score_batch([r["text"] for r in rows])

    worst = 0.0
    misses = []
    for r, p in zip(rows, ps):
        assert r["hash"] in old, f"{r['file']} not in old cache"
        delta = abs(p - old[r["hash"]]["p"])
        worst = max(worst, delta)
        if delta > TOL_CACHE:
            misses.append((r["file"], old[r["hash"]]["p"], round(p, 4)))
    assert not misses, f"worst delta {worst:.4f}: {misses[:5]}"

    # batched == single on a spread of lengths
    subset = [rows[i]["text"] for i in range(0, len(rows), 11)]
    singles = [scorer.score(t) for t in subset]
    batched = scorer.score_batch(subset)
    for s, b in zip(singles, batched):
        assert abs(s - b) < TOL_BATCH
