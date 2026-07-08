"""Benchmark a detector on labeled samples and write calibration to
artifacts/thresholds.json (the Node side reads it to phrase verdicts and to
pick the eval detector-gate threshold).

Port of the retired classify.py benchmark mode: AUROC (Mann-Whitney), best
balanced-accuracy threshold over score midpoints, and an operating-point
table of measured catch/false-flag rates.
"""

import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from . import config
from .cache import ScoreCache

OPERATING_TS = (0.25, 0.50, 0.75, 0.90, 0.95, 0.99)


@dataclass
class Sample:
    file: str
    label: str  # "ai" | "human"
    text: str
    p: float = 0.0


def load_labeled_dir(samples_dir: Path) -> list[Sample]:
    rows = []
    for label in ("ai", "human"):
        for f in sorted((samples_dir / label).glob("*.txt")):
            rows.append(Sample(f"{label}/{f.name}", label, f.read_text().strip()))
    return rows


def auroc(rows: list[Sample]) -> float:
    """Probability a random AI sample outranks a random human one."""
    ai = [r.p for r in rows if r.label == "ai"]
    human = [r.p for r in rows if r.label == "human"]
    wins = sum(sum(1 if a > h else 0.5 if a == h else 0 for h in human) for a in ai)
    return wins / (len(ai) * len(human))


def best_balanced_threshold(rows: list[Sample]) -> tuple[float, float]:
    ps = sorted({r.p for r in rows})
    n_ai = sum(r.label == "ai" for r in rows)
    n_human = len(rows) - n_ai
    best_t, best_bal = 0.5, 0.0
    for lo, hi in zip(ps, ps[1:]):
        t = (lo + hi) / 2
        bal = (
            sum(r.label == "ai" and r.p >= t for r in rows) / n_ai
            + sum(r.label == "human" and r.p < t for r in rows) / n_human
        ) / 2
        if bal > best_bal:
            best_t, best_bal = t, bal
    return best_t, best_bal


def operating_points(rows: list[Sample]) -> list[dict]:
    n_ai = sum(r.label == "ai" for r in rows)
    n_human = len(rows) - n_ai
    return [
        {
            "t": t,
            "tpr": round(sum(r.label == "ai" and r.p >= t for r in rows) / n_ai, 3),
            "fpr": round(sum(r.label == "human" and r.p >= t for r in rows) / n_human, 3),
        }
        for t in OPERATING_TS
    ]


def score_samples(rows: list[Sample], scorer, cache: ScoreCache | None = None):
    """Fill Sample.p, going through the shared score cache."""
    todo = []
    for r in rows:
        p = cache.get(scorer.model_id, r.text) if cache else None
        if p is None:
            todo.append(r)
        else:
            r.p = p
    if todo:
        ps = scorer.score_batch([r.text for r in todo])
        for r, p in zip(todo, ps):
            r.p = round(p, 4)
        if cache:
            cache.put_many(scorer.model_id, [(r.text, r.p) for r in todo])


def calibrate(rows: list[Sample], name: str, model_id: str, corpus_version: str) -> dict:
    n_ai = sum(r.label == "ai" for r in rows)
    n_human = len(rows) - n_ai
    best_t, best_bal = best_balanced_threshold(rows)
    return {
        "model_id": model_id,
        "corpus_version": corpus_version,
        "created_at": date.today().isoformat(),
        "auroc": round(auroc(rows), 3),
        "bestThreshold": round(best_t, 3),
        "balancedAccuracy": round(best_bal, 3),
        "samples": {"ai": n_ai, "human": n_human},
        "operatingPoints": operating_points(rows),
    }


def write_thresholds(name: str, entry: dict, path: Path = None):
    path = path or config.THRESHOLDS
    th = json.loads(path.read_text()) if path.exists() else {}
    th[name] = entry
    path.write_text(json.dumps(th, indent=2) + "\n")


def report(rows: list[Sample], entry: dict) -> str:
    best_t = entry["bestThreshold"]
    misses = [r for r in rows if (r.label == "ai") != (r.p >= best_t)]
    lines = [
        f"samples: {entry['samples']['ai']} ai / {entry['samples']['human']} human",
        f"AUROC: {entry['auroc']:.3f}",
        f"balanced accuracy: {entry['balancedAccuracy'] * 100:.1f}% at p(AI) >= {best_t:.3f}",
        f"misclassified: {len(misses)}",
    ]
    for r in sorted(misses, key=lambda r: r.p):
        lines.append(f"  {r.p:.4f}  {r.file} ({r.label})")
    lines.append("")
    lines.append("  p(AI) >=   catches AI   false-flags human")
    for o in entry["operatingPoints"]:
        lines.append(f"      {o['t']:.2f}       {o['tpr'] * 100:3.0f}%            {o['fpr'] * 100:3.0f}%")
    return "\n".join(lines)
