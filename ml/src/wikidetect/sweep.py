"""Category-wide triage sweep: score EVERY article in a WikiProject
AI-Cleanup category and write a ranked report.

    wikidetect sweep --category "Category:Articles containing suspected
        AI-generated texts from November 2025" [--limit N] [--out NAME]

Replaces the retired sweep.js. Same record schema and resume semantics
(append JSONL keyed by title; rerun skips what's done; the ranked .md is
rewritten at the end), with three changes:
  - fetching is concurrent (async, polite semaphore) and overlaps scoring
  - inference is batched with dynamic padding, through the shared cache
  - records carry the FULL text and revid, so a finding can be promoted
    into an eval case even after the live article is cleaned up
"""

import asyncio
import json

from . import config
from .cache import ScoreCache
from .detect import load_calibration, verdict_for
from .wiki import (
    WikiClient,
    article_url,
    extract_tag_region,
    from_url_or_title,
    slug,
    split_paragraphs,
    strip_wikitext,
    word_count,
)


async def _fetch_one(client: WikiClient, title: str) -> dict:
    """Fetch + extract; returns a record missing only scores."""
    record = {"title": title, "url": article_url(title)}
    try:
        wt, revid = await client.revision_of(title)
        if not wt or wt.lstrip().lower().startswith("#redirect"):
            record["skipped"] = "missing or redirect"
            return record
        region, whole = extract_tag_region(wt, "ai")
        text = strip_wikitext(region)[: config.SWEEP_MAX_CHARS]
        if len(text) < config.SWEEP_MIN_CHARS:
            record["skipped"] = f"too little prose ({len(text)} chars)"
            return record
        record.update(
            revid=revid,
            region="whole article" if whole else "tagged section",
            chars=len(text),
            text=text,
        )
    except Exception as e:
        record["error"] = str(e)
    return record


def _score_record(record: dict, scorer, cache: ScoreCache, calibration) -> dict:
    text = record["text"]
    paras = [p for p in split_paragraphs(text) if word_count(p) >= config.MIN_PARA_WORDS]
    paras = paras[: config.MAX_PARAS] if len(paras) > 1 else []

    texts = [text, *paras]
    ps: list[float | None] = [cache.get(scorer.model_id, t) for t in texts]
    todo = [i for i, p in enumerate(ps) if p is None]
    if todo:
        fresh = scorer.score_batch([texts[i] for i in todo])
        for i, p in zip(todo, fresh):
            ps[i] = round(p, 4)
        cache.put_many(scorer.model_id, [(texts[i], ps[i]) for i in todo])

    doc_p, *para_ps = ps
    record["pAI"] = doc_p
    record["verdict"] = verdict_for(doc_p, calibration)["verdict"]
    record["paragraphs"] = sorted(
        ({"p": p, "text": t} for t, p in zip(paras, para_ps)),
        key=lambda x: -x["p"],
    )
    return record


def _write_report(path, cat_title: str, model: str, calibration, done: dict, total: int):
    results = sorted(
        (r for r in done.values() if r.get("pAI") is not None),
        key=lambda r: -r["pAI"],
    )
    skipped = [r for r in done.values() if r.get("skipped") or r.get("error")]
    buckets = {
        "AI-typical": sum(r["verdict"] == "AI-typical" for r in results),
        "leaning AI": sum(r["verdict"].startswith("leaning") for r in results),
        "human-typical": sum(r["verdict"] == "human-typical" for r in results),
    }
    lines = [f"# AI-text sweep: {cat_title.removeprefix('Category:')}", ""]
    lines.append(
        f"Detector: {model}"
        + (
            f" (AUROC {calibration['auroc']} on {calibration['samples']['ai']} AI / {calibration['samples']['human']} human benchmark samples)"
            if calibration
            else " (uncalibrated)"
        )
    )
    lines.append(
        f"Scored {len(results)} of {total} articles ({len(skipped)} skipped/errored). "
        f"Verdicts: {', '.join(f'{v} {k}' for k, v in buckets.items())}."
    )
    lines += ["", "Detector output is triage, not proof — verify against sources and history before acting.", ""]
    lines += ["| p(AI) | verdict | article | worst paragraph |", "|---|---|---|---|"]
    for r in results:
        worst = r["paragraphs"][0] if r.get("paragraphs") else None
        preview = ""
        if worst:
            t = worst["text"]
            preview = f"{worst['p']:.3f} — {(t[:97] + '...' if len(t) > 100 else t)}".replace("|", "\\|")
        lines.append(f"| {r['pAI']:.3f} | {r['verdict']} | [{r['title'].replace('|', chr(92) + '|')}]({r['url']}) | {preview} |")
    if skipped:
        lines += ["", "## Skipped", ""]
        lines += [f"- [{r['title']}]({r['url']}) — {r.get('skipped') or r.get('error')}" for r in skipped]
    path.write_text("\n".join(lines) + "\n")


async def sweep(category: str, limit: int = 100000, out: str | None = None, model: str = config.DEFAULT_MODEL):
    from .models import Scorer

    cat_title = from_url_or_title(category)
    config.SWEEPS.mkdir(parents=True, exist_ok=True)
    base = config.SWEEPS / (out or slug(cat_title.removeprefix("Category:")))
    jsonl_path = base.with_suffix(".jsonl")
    report_path = base.with_suffix(".md")

    done: dict[str, dict] = {}
    if jsonl_path.exists():
        for line in jsonl_path.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                done[r["title"]] = r
        print(f"resuming: {len(done)} article(s) already in {jsonl_path}")

    client = WikiClient()
    print(f"listing {cat_title}...")
    titles = await client.category_members(cat_title)
    print(f"{len(titles)} member articles\n")

    calibration = load_calibration(model)
    if not calibration:
        print("⚠ no calibration for the detector — run: wikidetect calibrate\n")
    print(f"loading {model}...")
    scorer = Scorer(model)
    cache = ScoreCache()

    todo = [t for t in titles if t not in done]
    scored = sum(1 for r in done.values() if r.get("pAI") is not None)
    errors = 0

    # Fetching (network-bound) overlaps scoring (GPU-bound): fetch tasks fill
    # a queue that the scoring loop drains in arrival order.
    fetch_tasks = asyncio.Queue(maxsize=config.FETCH_CONCURRENCY * 4)

    async def producer():
        async def one(title):
            await fetch_tasks.put(await _fetch_one(client, title))

        pending = set()
        for title in todo:
            if scored >= limit:
                break
            pending.add(asyncio.create_task(one(title)))
            while len(pending) >= config.FETCH_CONCURRENCY:
                _, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
        if pending:
            await asyncio.wait(pending)
        await fetch_tasks.put(None)  # sentinel

    prod = asyncio.create_task(producer())
    with jsonl_path.open("a") as jsonl:
        i = len(done)
        while True:
            record = await fetch_tasks.get()
            if record is None:
                break
            i += 1
            if scored >= limit:
                continue
            if "text" in record:
                # GPU work off the event loop so fetches keep flowing
                record = await asyncio.to_thread(_score_record, record, scorer, cache, calibration)
                scored += 1
                errors = 0
            elif record.get("error"):
                errors += 1
                if errors > 20:
                    print("too many consecutive errors — aborting (rerun to resume)")
                    break
            jsonl.write(json.dumps(record, ensure_ascii=False) + "\n")
            jsonl.flush()
            done[record["title"]] = record
            tag = f"{record['pAI']:.3f}" if record.get("pAI") is not None else ("skip " if record.get("skipped") else "ERR  ")
            print(f"[{i}/{len(titles)}] {tag}  {record['title']}")
    prod.cancel()
    await client.aclose()

    _write_report(report_path, cat_title, model, calibration, done, len(titles))
    results = sum(1 for r in done.values() if r.get("pAI") is not None)
    print(f"\nscored {results}/{len(titles)} ({len(done) - results} skipped)")
    print(f"raw results : {jsonl_path}")
    print(f"report      : {report_path}")
