"""Python view of shared/stance.json — the same vocabulary the Node eval
harness compiles (web/lib/stance.js). Data is shared; the ~15 lines of
compile logic are duplicated per language by design (no cross-language
imports)."""

import json
import re

from . import config

_QUOTE_RE = re.compile(r"[“\"][^“”\"]*[”\"]")


def _compile():
    raw = json.loads((config.REPO / "shared" / "stance.json").read_text())
    cats = []
    for cat in raw["categories"]:
        if "terms" in cat:
            terms = sorted(cat["terms"], key=len, reverse=True)
            pattern = r"\b(?:" + "|".join(re.escape(t) for t in terms) + r")\b"
            cats.append((cat["key"], re.compile(pattern, re.I)))
        else:
            flags = re.I if "i" in cat.get("flags", "") else 0
            cats.append((cat["key"], re.compile(cat["regex"], flags)))
    return cats


_CATEGORIES = None


def without_quotes(s: str) -> str:
    """Kept quotations may contain evaluative language; blank them out so
    only the article's own voice is checked."""
    return _QUOTE_RE.sub("“…”", s)


def stance_hits(text: str) -> list[dict]:
    global _CATEGORIES
    if _CATEGORIES is None:
        _CATEGORIES = _compile()
    prose = without_quotes(text)
    found = []
    for key, pattern in _CATEGORIES:
        hits = sorted(set(pattern.findall(prose)))
        if hits:
            found.append({"key": key, "hits": hits})
    return found
