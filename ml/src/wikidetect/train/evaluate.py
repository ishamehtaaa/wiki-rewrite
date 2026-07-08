"""Evaluate a training run on the frozen test split, always side-by-side
with the frozen desklib baseline on the identical samples.

Adoption gate (the user's standing rule — beat the benchmark before wiring
anything in): the candidate must beat the baseline's test AUROC and not
regress FPR at the t=0.90 operating point. Only an adopted model gets
`wikidetect calibrate --model <run>` and a thresholds.json entry.
"""

import json

from .. import config, corpus
from ..cache import ScoreCache
from ..calibrate import Sample, auroc, operating_points, score_samples


def _score_split(rows, model_name: str, cache) -> list[Sample]:
    from ..models import Scorer

    samples = [Sample(r["id"], r["label"], corpus.text_of(r)) for r in rows]
    score_samples(samples, Scorer(model_name), cache)
    return samples


def evaluate_run(run: str, corpus_version: str = "v1"):
    rows = [r for r in corpus.load_manifest(corpus_version) if r["split"] == "test"]
    if not rows:
        raise SystemExit(f"corpus-{corpus_version} has no test rows")
    print(f"test split: {len(rows)} samples ({sum(r['label'] == 'ai' for r in rows)} ai)")

    cache = ScoreCache()
    print("scoring with frozen desklib baseline...")
    base = _score_split(rows, "desklib", cache)
    print(f"scoring with run {run}...")
    cand = _score_split(rows, run, cache)

    report = {}
    for name, samples in (("desklib", base), (run, cand)):
        ops = operating_points(samples)
        at90 = next(o for o in ops if o["t"] == 0.90)
        report[name] = {"auroc": round(auroc(samples), 4), "tpr@0.90": at90["tpr"], "fpr@0.90": at90["fpr"]}
        print(f"  {name:>24}: AUROC {report[name]['auroc']:.4f}  tpr@.90 {at90['tpr']:.3f}  fpr@.90 {at90['fpr']:.3f}")

    beats = (
        report[run]["auroc"] > report["desklib"]["auroc"]
        and report[run]["fpr@0.90"] <= report["desklib"]["fpr@0.90"]
    )
    verdict = "ADOPT" if beats else "REJECT"
    print(f"\n{verdict}: candidate {'beats' if beats else 'does not beat'} the frozen baseline")
    if beats:
        print(f"next: wikidetect calibrate --model {run} --corpus-version {corpus_version}")

    out = config.RUNS / run / "eval.json"
    out.write_text(json.dumps({"corpus_version": corpus_version, "results": report, "adopt": beats}, indent=2) + "\n")
    print(f"wrote {out}")
