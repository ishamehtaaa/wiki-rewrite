"""wikidetect — AI-text detection for Wikipedia cleanup.

    wikidetect calibrate [--model desklib] [--samples DIR]
    wikidetect detect [--json] [FILE]        # or pipe text on stdin
    wikidetect serve [--port 8756]
    wikidetect sweep --category "..." [--limit N] [--out NAME]
    wikidetect exemplars --from "..." [--count N] [--replace] [TITLE...]
    wikidetect corpus harvest|fetch|split ...
    wikidetect train ... / wikidetect eval ...
"""

import argparse
import sys
from pathlib import Path

from . import config


def cmd_calibrate(args):
    from .cache import ScoreCache
    from .calibrate import calibrate, load_labeled_dir, report, score_samples, write_thresholds
    from .models import Scorer

    samples_dir = Path(args.samples) if args.samples else config.ML / "corpus-v0"
    rows = load_labeled_dir(samples_dir)
    if not rows:
        sys.exit(f"no samples under {samples_dir}")
    print(f"scoring {len(rows)} samples with {args.model}...", file=sys.stderr)
    scorer = Scorer(args.model)
    score_samples(rows, scorer, ScoreCache())
    entry = calibrate(rows, args.model, scorer.model_id, args.corpus_version)
    print(f"\nmodel: {args.model}")
    print(report(rows, entry))
    write_thresholds(args.model, entry)
    print(f"\nwrote calibration for '{args.model}' to {config.THRESHOLDS}")


def cmd_detect(args):
    from .detect import detect_text, render_human

    text = (Path(args.file).read_text() if args.file else sys.stdin.read()).strip()
    if not text:
        sys.exit("usage: wikidetect detect [--json] [file]  (or pipe text on stdin)")
    result = detect_text(text, model=args.model)
    if args.json:
        import json

        print(json.dumps(result, indent=2))
    else:
        print(render_human(result))


def cmd_serve(args):
    from .server import serve

    serve(port=args.port, model=args.model)


def cmd_sweep(args):
    import asyncio

    from .sweep import sweep

    asyncio.run(sweep(args.category, limit=args.limit, out=args.out, model=args.model))


def cmd_exemplars(args):
    import asyncio

    from .exemplars import harvest_exemplars

    asyncio.run(
        harvest_exemplars(
            titles=args.titles, from_list=args.from_list, count=args.count,
            before=args.before, replace=args.replace, detector_gate=not args.no_detector_gate,
        )
    )


def cmd_corpus(args):
    import asyncio

    from . import corpus

    if args.corpus_cmd == "backfill-v0":
        corpus.backfill_v0()
    elif args.corpus_cmd == "harvest":
        asyncio.run(
            corpus.harvest(
                version=args.version, months=args.months,
                negatives_per_positive=args.negatives_per_positive, limit=args.limit,
            )
        )
    elif args.corpus_cmd == "fetch":
        asyncio.run(corpus.fetch(version=args.version))
    elif args.corpus_cmd == "split":
        corpus.assign_splits(version=args.version, seed=args.seed)


def cmd_train(args):
    from .train.run import train

    train(
        name=args.name, corpus_version=args.corpus_version, epochs=args.epochs,
        lr=args.lr, lora_r=args.lora_r, resume=args.resume,
    )


def cmd_eval(args):
    from .train.evaluate import evaluate_run

    evaluate_run(args.run, corpus_version=args.corpus_version)


def main():
    ap = argparse.ArgumentParser(prog="wikidetect", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("calibrate", help="benchmark a model on labeled samples; write thresholds.json")
    p.add_argument("--model", default=config.DEFAULT_MODEL)
    p.add_argument("--samples", help="dir with ai/ and human/ subdirs (default: legacy detector/samples)")
    p.add_argument("--corpus-version", default="v0")
    p.set_defaults(fn=cmd_calibrate)

    p = sub.add_parser("detect", help="score one text (file or stdin)")
    p.add_argument("file", nargs="?")
    p.add_argument("--json", action="store_true")
    p.add_argument("--model", default=config.DEFAULT_MODEL)
    p.set_defaults(fn=cmd_detect)

    p = sub.add_parser("serve", help="long-lived local HTTP scoring server")
    p.add_argument("--port", type=int, default=config.SERVE_PORT)
    p.add_argument("--model", default=config.DEFAULT_MODEL)
    p.set_defaults(fn=cmd_serve)

    p = sub.add_parser("sweep", help="score every article in a cleanup category")
    p.add_argument("--category", required=True)
    p.add_argument("--limit", type=int, default=100000)
    p.add_argument("--out", help="output basename (default: artifacts/sweeps/<category-slug>)")
    p.add_argument("--model", default=config.DEFAULT_MODEL)
    p.set_defaults(fn=cmd_sweep)

    p = sub.add_parser("exemplars", help="harvest human-written register exemplars into artifacts/exemplars.json")
    p.add_argument("titles", nargs="*", help="article titles or URLs")
    p.add_argument("--from", dest="from_list", help="Featured/Good articles list URL or Category: title")
    p.add_argument("--count", type=int, default=3)
    p.add_argument("--before", help=f"use last revision before this date (e.g. {config.HUMAN_CUTOFF})")
    p.add_argument("--replace", action="store_true")
    p.add_argument("--no-detector-gate", action="store_true", help="skip the p(AI) check on candidates")
    p.set_defaults(fn=cmd_exemplars)

    p = sub.add_parser("corpus", help="labeled corpus: manifests, harvesting, splits")
    csub = p.add_subparsers(dest="corpus_cmd", required=True)
    c = csub.add_parser("backfill-v0", help="manifest the legacy detector/samples as corpus v0 (test-only)")
    c = csub.add_parser("harvest", help="harvest positives from monthly AI-cleanup categories + stratified negatives")
    c.add_argument("--version", default="v1")
    c.add_argument("--months", type=int, default=0, help="how many monthly categories (0 = all)")
    c.add_argument("--negatives-per-positive", type=float, default=1.0)
    c.add_argument("--limit", type=int, default=0, help="cap positives (0 = no cap; use for smoke tests)")
    c = csub.add_parser("fetch", help="re-materialize corpus texts from manifest revids")
    c.add_argument("--version", default="v1")
    c = csub.add_parser("split", help="assign grouped, stratified train/val/test splits")
    c.add_argument("--version", default="v1")
    c.add_argument("--seed", type=int, default=7)
    for c_ in csub.choices.values():
        c_.set_defaults(fn=cmd_corpus)

    p = sub.add_parser("train", help="LoRA fine-tune on a corpus version")
    p.add_argument("--name", required=True, help="run name (artifacts/runs/<name>)")
    p.add_argument("--corpus-version", default="v1")
    p.add_argument("--epochs", type=int, default=3)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--lora-r", type=int, default=16)
    p.add_argument("--resume", action="store_true")
    p.set_defaults(fn=cmd_train)

    p = sub.add_parser("eval", help="evaluate a training run vs the frozen baseline on the test split")
    p.add_argument("run", help="run name under artifacts/runs/")
    p.add_argument("--corpus-version", default="v1")
    p.set_defaults(fn=cmd_eval)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
