"""Reproducible labeled corpus for calibration and training.

A corpus version is a committed manifest (ml/manifests/corpus-<v>.jsonl) of
one row per sample — label, title, revid, region, sha256 — plus a gitignored
content-addressed text store (ml/data/corpus/texts/<sha256>.txt).
`wikidetect corpus fetch` re-materializes the texts on any clone from the
pinned revids and verifies hashes, so the corpus is versionable without
committing bulk text.

Labeling rules (the canonical versions of what fetch-samples.js did):
  positives  text under {{AI-generated}} tags in the monthly cleanup
             categories; whole-article tags only trusted on pages created
             in the AI era (config.AI_ERA_START) — otherwise authorship is
             mixed and the sample is skipped
  negatives  three strata of guaranteed-human prose (pre config.HUMAN_CUTOFF
             revisions): matched (pre-cutoff leads of the SAME tagged pages
             — same topics/obscurity, the hardest negatives), random
             articles, and Featured Article leads (polished minority)

extractor_version pins the strip pipeline: bump EXTRACTOR_VERSION when
strip_wikitext changes and re-run fetch to re-hash.
"""

import asyncio
import json
import random
import re
from datetime import date

from . import config
from .wiki import (
    WikiClient,
    article_url,
    extract_tag_region,
    slug,
    strip_wikitext,
    trim_to_sentence,
)

EXTRACTOR_VERSION = 1
PARENT_CATEGORY = "Category:Articles containing suspected AI-generated texts"
FA_CATEGORY = "Category:Featured articles"
# negative strata mix: matched hard negatives carry the most signal
STRATA_WEIGHTS = {"matched": 0.5, "random": 0.35, "fa": 0.15}


def manifest_path(version: str):
    return config.MANIFESTS / f"corpus-{version}.jsonl"


def load_manifest(version: str) -> list[dict]:
    path = manifest_path(version)
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def save_manifest(version: str, rows: list[dict]):
    config.MANIFESTS.mkdir(parents=True, exist_ok=True)
    manifest_path(version).write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
    )


def load_blocklist() -> set[str]:
    path = config.MANIFESTS / "blocklist.txt"
    if not path.exists():
        return set()
    return {
        l.strip() for l in path.read_text().splitlines()
        if l.strip() and not l.startswith("#")
    }


def store_text(text: str) -> str:
    from .cache import text_hash

    h = text_hash(text)
    config.CORPUS_TEXTS.mkdir(parents=True, exist_ok=True)
    (config.CORPUS_TEXTS / f"{h}.txt").write_text(text)
    return h


def text_of(row: dict) -> str:
    return (config.CORPUS_TEXTS / f"{row['sha256']}.txt").read_text()


def _usable(text: str) -> bool:
    if len(text) < config.SAMPLE_MIN_CHARS:
        return False
    if "may refer to:" in text:
        return False
    # bullet-heavy pages survive stripping as line noise, not prose
    if text.count("\n") > 0 and len(max(text.split("\n"), key=len)) < 200:
        return False
    return True


def _row(id_, label, title, revid, region, text, source):
    return {
        "id": id_,
        "label": label,
        "title": title,
        "revid": revid,
        "region": region,
        "sha256": store_text(text),
        "chars": len(text),
        "source": source,
        "extractor_version": EXTRACTOR_VERSION,
        "fetched_at": date.today().isoformat(),
        "split": None,
    }


# --- backfill v0 -------------------------------------------------------------

def backfill_v0():
    """Manifest the legacy detector/samples corpus as v0. These 57 files are
    the historical benchmark — they stay test-only forever (leakage guard:
    nothing that calibrated the original detector may train its successor)."""
    from .cache import text_hash

    samples = config.ML / "corpus-v0"
    rows = []
    for label in ("ai", "human"):
        for f in sorted((samples / label).glob("*.txt")):
            text = f.read_text().strip()
            rows.append(
                {
                    "id": f"v0/{label}/{f.stem}",
                    "label": label,
                    "title": None,  # legacy files kept only slugs
                    "revid": None,
                    "region": "legacy",
                    "sha256": store_text(text),
                    "chars": len(text),
                    "source": "legacy detector/samples",
                    "extractor_version": 0,
                    "fetched_at": date.today().isoformat(),
                    "split": "test",
                }
            )
    save_manifest("v0", rows)
    print(f"corpus-v0: {len(rows)} rows (all split=test) -> {manifest_path('v0')}")


# --- harvest -----------------------------------------------------------------

async def _harvest_positive(client: WikiClient, title: str, source: str) -> dict | None:
    if re.match(r"^List of ", title, re.I):
        return None
    wt, revid = await client.revision_of(title)
    if not wt or wt.lstrip().lower().startswith("#redirect"):
        return None
    region_wt, whole = extract_tag_region(wt, "ai")
    if whole and not await client.created_in_ai_era(title):
        return None  # pre-AI-era page with a top tag: mixed authorship
    text = trim_to_sentence(strip_wikitext(region_wt), config.SAMPLE_MAX_CHARS, config.SAMPLE_MIN_CHARS)
    if not _usable(text):
        return None
    return _row(
        f"ai/{slug(source)}/{slug(title)}", "ai", title, revid,
        "whole" if whole else "tagged_section", text, source,
    )


async def _harvest_negative(client: WikiClient, title: str, stratum: str) -> dict | None:
    if re.match(r"^List of ", title, re.I):
        return None
    wt, revid = await client.revision_of(title, before=config.HUMAN_CUTOFF)
    if not wt or wt.lstrip().lower().startswith("#redirect"):
        return None
    lead, _ = extract_tag_region(wt, "human")
    text = trim_to_sentence(strip_wikitext(lead), config.SAMPLE_MAX_CHARS, config.SAMPLE_MIN_CHARS)
    if not _usable(text):
        return None
    return _row(
        f"human/{stratum}/{slug(title)}", "human", title, revid, "lead", text,
        f"stratum:{stratum}",
    )


async def _random_titles(client: WikiClient, n: int) -> list[str]:
    titles = []
    while len(titles) < n:
        d = await client.api(action="query", list="random", rnnamespace="0", rnlimit="50")
        titles.extend(r["title"] for r in d["query"]["random"])
    return titles[:n]


async def harvest(version: str = "v1", months: int = 0, negatives_per_positive: float = 1.0, limit: int = 0):
    """Harvest positives from every monthly cleanup category (or the newest
    `months`), then negatives per the strata mix. Incremental: existing
    manifest rows are kept; titles already present are skipped."""
    random.seed(11)
    client = WikiClient()
    rows = load_manifest(version)
    have = {(r["label"], r["title"]) for r in rows}
    blocked = load_blocklist()

    print(f"listing monthly categories under {PARENT_CATEGORY}...")
    cats = [c for c in await client.subcategories(PARENT_CATEGORY) if " from " in c]
    cats.sort(reverse=True)  # newest first
    if months:
        cats = cats[:months]
    print(f"{len(cats)} monthly categories")

    n_pos = 0
    for cat in cats:
        titles = await client.category_members(cat)
        random.shuffle(titles)
        month_slug = cat.removeprefix("Category:")
        print(f"  {month_slug}: {len(titles)} members")
        results = await asyncio.gather(
            *[_harvest_positive(client, t, month_slug) for t in titles
              if ("ai", t) not in have and t not in blocked]
        )
        for r in results:
            if r and limit and n_pos >= limit:
                break
            if r:
                rows.append(r)
                have.add(("ai", r["title"]))
                n_pos += 1
        save_manifest(version, rows)
        if limit and n_pos >= limit:
            break
    print(f"positives harvested this run: {n_pos}")

    # --- negatives ---
    n_neg_target = int(n_pos * negatives_per_positive) if n_pos else 0
    quotas = {s: int(n_neg_target * w) for s, w in STRATA_WEIGHTS.items()}
    print(f"negatives target: {n_neg_target} {quotas}")

    async def fill(stratum: str, candidates: list[str]):
        got = 0
        for t in candidates:
            if got >= quotas[stratum]:
                break
            if ("human", t) in have or t in blocked:
                continue
            r = await _harvest_negative(client, t, stratum)
            if r:
                rows.append(r)
                have.add(("human", t))
                got += 1
        save_manifest(version, rows)
        print(f"  stratum {stratum}: +{got}")

    # matched: pre-cutoff leads of the very pages that got tagged
    matched_candidates = [r["title"] for r in rows if r["label"] == "ai" and r["title"]]
    random.shuffle(matched_candidates)
    await fill("matched", matched_candidates)
    await fill("random", await _random_titles(client, quotas["random"] * 4))
    fa = await client.category_members(FA_CATEGORY)
    random.shuffle(fa)
    await fill("fa", fa)

    await client.aclose()
    counts = {}
    for r in rows:
        counts[r["label"]] = counts.get(r["label"], 0) + 1
    print(f"corpus-{version}: {counts} -> {manifest_path(version)}")


# --- fetch (re-materialize) ---------------------------------------------------

async def fetch(version: str = "v1"):
    """Re-fetch every manifest row's pinned revid and verify hashes."""
    from .cache import text_hash

    client = WikiClient()
    rows = load_manifest(version)
    missing = [r for r in rows if not (config.CORPUS_TEXTS / f"{r['sha256']}.txt").exists()]
    print(f"{len(rows)} rows, {len(missing)} texts to fetch")
    bad = 0
    for r in missing:
        if not r["revid"]:
            print(f"  ! {r['id']}: no revid (legacy row) — cannot re-fetch")
            bad += 1
            continue
        d = await client.api(
            action="query", prop="revisions", revids=str(r["revid"]),
            rvprop="content", rvslots="main",
        )
        pages = d["query"].get("pages", {})
        wt = next(iter(pages.values()), {}).get("revisions", [{}])[0].get("slots", {}).get("main", {}).get("*")
        if not wt:
            print(f"  ! {r['id']}: revid {r['revid']} gone (deleted?)")
            bad += 1
            continue
        region_wt, _ = extract_tag_region(wt, "ai" if r["label"] == "ai" else "human")
        text = trim_to_sentence(strip_wikitext(region_wt), config.SAMPLE_MAX_CHARS, config.SAMPLE_MIN_CHARS)
        if text_hash(text) != r["sha256"]:
            print(f"  ! {r['id']}: hash mismatch (extractor changed?)")
            bad += 1
            continue
        store_text(text)
    await client.aclose()
    print(f"done ({bad} problems)" if bad else "done — all hashes verified")


# --- splits --------------------------------------------------------------------

def assign_splits(version: str = "v1", seed: int = 7, ratios=(0.8, 0.1, 0.1)):
    """Grouped by title (an article never straddles splits), stratified by
    (label, source), seeded. Rows with split already set (e.g. v0 test rows
    merged in) are left alone."""
    rows = load_manifest(version)
    rng = random.Random(seed)
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        if r["split"]:
            continue
        groups.setdefault((r["label"], r["source"], r["title"] or r["id"]), []).append(r)

    strata: dict[tuple, list[list[dict]]] = {}
    for (label, source, _), grp in groups.items():
        strata.setdefault((label, source), []).append(grp)

    for stratum_groups in strata.values():
        rng.shuffle(stratum_groups)
        n = len(stratum_groups)
        n_train = round(n * ratios[0])
        n_val = round(n * ratios[1])
        for i, grp in enumerate(stratum_groups):
            split = "train" if i < n_train else "val" if i < n_train + n_val else "test"
            for r in grp:
                r["split"] = split

    save_manifest(version, rows)
    counts: dict[str, int] = {}
    for r in rows:
        counts[f"{r['label']}/{r['split']}"] = counts.get(f"{r['label']}/{r['split']}", 0) + 1
    print(f"corpus-{version} splits: {json.dumps(counts, indent=2)}")
