"""Harvest known-good, HUMAN-written Wikipedia prose into
artifacts/exemplars.json, which the rewriter prompt (web/rules.js) embeds as
register calibration. Like every prompt change, a regenerated exemplars.json
must be validated with `npm run evals` before committing.

    wikidetect exemplars "Caesium" "Thylacine"
    wikidetect exemplars --from "Wikipedia:Featured articles" --count 3
    wikidetect exemplars --before 2022-06-01 --replace "Caesium"

Candidates are filtered three ways:
  - length: a lead trimmed to a sentence inside [MIN, MAX] chars
  - stance: excerpts containing the shared/stance.json vocabulary the evals
    ban are skipped — an exemplar that models stance teaches the wrong thing
  - detector: the excerpt must score human-typical on the calibrated
    detector (the old Node harvester couldn't do this)

Text quality: the default path uses the TextExtracts API (clean plain text,
no wikitext stripping), which eliminates the entity/template husks the old
regex stripper baked into the prompt ("&nbsp;", "£7,000 (about £ in)").
With --before, wikitext of the dated revision is stripped instead.
"""

import html
import json
import random
import re
from datetime import date

from . import config
from .stance import stance_hits
from .wiki import (
    WikiClient,
    article_url,
    extract_tag_region,
    from_url_or_title,
    strip_wikitext,
    trim_to_sentence,
)


def _list_category(s: str) -> str | None:
    t = from_url_or_title(s)
    if re.match(r"^Category:", t, re.I):
        return t
    if re.match(r"^Wikipedia:Featured articles$", t, re.I):
        return "Category:Featured articles"
    if re.match(r"^Wikipedia:Good articles", t, re.I):
        return "Category:Good articles"
    return None


def _clean(text: str) -> str:
    t = html.unescape(text).replace("\xa0", " ")
    t = re.sub(r"[ \t]+", " ", t)
    return t.strip()


async def _lead_of(client: WikiClient, title: str, before: str | None):
    """(clean lead text, revision description) or (None, None)."""
    if before:
        wt, revid = await client.revision_of(title, before)
        if not wt or wt.lstrip().lower().startswith("#redirect"):
            return None, None
        lead, _ = extract_tag_region(wt, "human")
        return _clean(strip_wikitext(lead)), f"revision {revid} (before {before})"
    d = await client.api(
        action="query", prop="extracts|revisions", explaintext="1", exintro="1",
        rvprop="ids", titles=title,
    )
    page = next(iter(d["query"]["pages"].values()))
    extract = page.get("extract")
    revid = (page.get("revisions") or [{}])[0].get("revid")
    if not extract:
        return None, None
    return _clean(extract), f"revision {revid}"


async def harvest_exemplars(
    titles: list[str],
    from_list: str | None = None,
    count: int = 3,
    before: str | None = None,
    replace: bool = False,
    detector_gate: bool = True,
):
    scorer = calibration = None
    if detector_gate:
        from .detect import load_calibration, verdict_for
        from .models import Scorer

        calibration = load_calibration()
        print(f"loading {config.DEFAULT_MODEL} for the human-typical gate...")
        scorer = Scorer(config.DEFAULT_MODEL)

    existing = []
    if not replace and config.EXEMPLARS.exists():
        existing = json.loads(config.EXEMPLARS.read_text())["entries"]
    entries = list(existing)

    client = WikiClient()

    async def try_add(title: str) -> bool:
        lead, revision = await _lead_of(client, title, before)
        if not lead:
            print(f"✗ {title} — missing page or redirect" + (f" (before {before})" if before else ""))
            return False
        text = trim_to_sentence(lead, config.EXEMPLAR_MAX_CHARS, config.EXEMPLAR_MIN_CHARS)
        if len(text) < config.EXEMPLAR_MIN_CHARS:
            print(f"✗ {title} — lead too short ({len(text)} chars)")
            return False
        hits = stance_hits(text)
        if hits:
            print(f"✗ {title} — skipped: contains stance vocabulary the evals ban")
            for h in hits:
                print(f"    {h['key']}: {', '.join(h['hits'])}")
            return False
        if scorer:
            from .detect import verdict_for

            p = scorer.score(text)
            verdict = verdict_for(p, calibration)["verdict"]
            if verdict != "human-typical":
                print(f"✗ {title} — skipped: detector says {verdict} (p(AI) {p:.3f})")
                return False
        entry = {"title": title, "url": article_url(title), "revision": revision, "text": text}
        for i, e in enumerate(entries):
            if e["title"] == title:
                entries[i] = entry
                break
        else:
            entries.append(entry)
        print(f"✓ {title} — {len(text)} chars")
        return True

    for title in [from_url_or_title(t) for t in titles]:
        await try_add(title)

    if from_list:
        cat = _list_category(from_list)
        if not cat:
            raise SystemExit(f'--from must be the Featured/Good articles list URL or a Category: title (got "{from_list}")')
        print(f"sampling {count} exemplar(s) at random from {cat}...")
        members = await client.category_members(cat)
        random.shuffle(members)
        added = 0
        for title in members:
            if added >= count:
                break
            if any(e["title"] == title for e in entries):
                continue
            if await try_add(title):
                added += 1

    await client.aclose()

    config.EXEMPLARS.write_text(
        json.dumps(
            {"schema": 1, "generated_at": date.today().isoformat(), "entries": entries},
            indent=2, ensure_ascii=False,
        )
        + "\n"
    )
    print(f"\n{len(entries)} exemplar(s) in {config.EXEMPLARS}")
    if len(entries) > config.EXEMPLAR_RECOMMENDED_MAX:
        print(f"⚠ more than {config.EXEMPLAR_RECOMMENDED_MAX} exemplars mostly pads the prompt — keep the few whose register you most want")
    print("Now validate the prompt change: npm run evals -- --fresh")
