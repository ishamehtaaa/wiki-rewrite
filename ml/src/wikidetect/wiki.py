"""MediaWiki API client + wikitext helpers.

The wikitext-stripping regexes are a verbatim port of the JS detector's
wiki.js — parity with the old sweeps and the calibration corpus matters more
than elegance here. A real parser (mwparserfromhell) is a possible later
upgrade, gated on re-running calibration.
"""

import asyncio
import re
import urllib.parse

import httpx

from . import config

AI_TAG = re.compile(r"\{\{\s*AI[ -]?generated\b", re.I)


class WikiClient:
    """Async client with polite concurrency and 429 backoff."""

    def __init__(self, concurrency: int = config.FETCH_CONCURRENCY):
        self._sem = asyncio.Semaphore(concurrency)
        self._http = httpx.AsyncClient(
            headers={"User-Agent": config.USER_AGENT}, timeout=30.0
        )

    async def aclose(self):
        await self._http.aclose()

    async def api(self, **params) -> dict:
        merged = {"format": "json", "redirects": "1", **params}
        async with self._sem:
            for attempt in range(5):
                res = await self._http.get(config.API_URL, params=merged)
                if res.status_code == 429 and attempt < 4:
                    await asyncio.sleep(5 * (attempt + 1))
                    continue
                res.raise_for_status()
                return res.json()
        raise RuntimeError("unreachable")

    async def category_members(self, cat: str) -> list[str]:
        members: list[str] = []
        cont: dict = {}
        while True:
            d = await self.api(
                action="query", list="categorymembers", cmtitle=cat,
                cmnamespace="0", cmlimit="500", **cont,
            )
            members.extend(m["title"] for m in d["query"]["categorymembers"])
            cont = d.get("continue") or {}
            if not cont or len(members) >= config.CATEGORY_MAX:
                return members

    async def subcategories(self, cat: str) -> list[str]:
        d = await self.api(
            action="query", list="categorymembers", cmtitle=cat,
            cmnamespace="14", cmlimit="500",
        )
        return [m["title"] for m in d["query"]["categorymembers"]]

    async def revision_of(self, title: str, before: str | None = None):
        """(wikitext, revid) of the latest revision, or the newest strictly
        before `before` (YYYY-MM-DD). (None, None) if no such revision."""
        params = dict(
            action="query", prop="revisions", rvprop="content|ids",
            rvslots="main", rvlimit="1", titles=title,
        )
        if before:
            params["rvstart"] = f"{before}T00:00:00Z"
        d = await self.api(**params)
        page = next(iter(d["query"]["pages"].values()))
        revs = page.get("revisions")
        if not revs:
            return None, None
        return revs[0]["slots"]["main"].get("*"), revs[0].get("revid")

    async def created_in_ai_era(self, title: str) -> bool:
        """Label hygiene: a top-of-page tag on an article that predates the
        AI era usually means AI text was ADDED to a human article."""
        d = await self.api(
            action="query", prop="revisions", rvprop="timestamp",
            rvdir="newer", rvlimit="1", titles=title,
        )
        page = next(iter(d["query"]["pages"].values()))
        revs = page.get("revisions")
        ts = revs[0]["timestamp"] if revs else None
        return bool(ts and ts >= f"{config.AI_ERA_START}T00:00:00Z")


def from_url_or_title(s: str) -> str:
    m = re.search(r"/wiki/([^#?]+)", s)
    return urllib.parse.unquote(m.group(1) if m else s).replace("_", " ")


def strip_wikitext(wt: str) -> str:
    t = wt
    t = re.sub(r"<!--[\s\S]*?-->", "", t)
    t = re.sub(r"<ref[^>/]*/>", "", t, flags=re.I)
    t = re.sub(r"<ref[^>]*>[\s\S]*?</ref>", "", t, flags=re.I)
    t = re.sub(r"\{\|[\s\S]*?\|\}", "", t)
    # Render measurement templates as "value unit" before the generic strip
    # deletes them, so prose isn't left with holes ("a melting point of ,").
    t = re.sub(
        r"\{\{\s*(?:convert|cvt)\s*\|([^|{}]+)\|([^|{}]+)(?:\|[^{}]*)?\}\}",
        r"\1 \2", t, flags=re.I,
    )
    for _ in range(6):
        t = re.sub(r"\{\{[^{}]*\}\}", "", t)
    t = re.sub(r"\[\[(?:File|Image):[^\[\]]*(?:\[\[[^\]]*\]\][^\[\]]*)*\]\]", "", t, flags=re.I)
    t = re.sub(r"\[\[Category:[^\]]*\]\]", "", t, flags=re.I)
    t = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", t)
    t = re.sub(r"\[https?:[^\s\]]*\s?([^\]]*)\]", r"\1", t)
    t = re.sub(r"'{2,}", "", t)
    t = re.sub(r"<[^>]+>", "", t)
    t = re.sub(r"^=+[^=\n]+=+ *$", "", t, flags=re.M)  # headings are not prose
    t = re.sub(r"^[*#:;]+\s*", "", t, flags=re.M)
    t = re.sub(r"[ \t]+", " ", t)
    # Husks left by stripped pronunciation/lang templates: drop parentheses
    # holding only connectives ("( , or , also )"), trim orphaned separators
    # after an opening paren ("( ; Hawaiian:" → "(Hawaiian:"), fix spacing.
    t = re.sub(r"\(\s*(?:[,;.]|\bor\b|\balso\b|\s)*\)", "", t)
    t = re.sub(r"\(\s*[,;.]\s*", "(", t)
    t = re.sub(r" +([,.;:)])", r"\1", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def strip_terminal_sections(wt: str) -> str:
    """Everything before the terminal link/citation sections — the prose an
    article-top tag covers."""
    return re.split(
        r"\n== *(?:References|External links|See also|Further reading|Notes|Sources|Bibliography|Citations) *==",
        wt, maxsplit=1, flags=re.I,
    )[0]


def extract_tag_region(wt: str, label: str) -> tuple[str, bool]:
    """The region an {{AI-generated}} tag covers: the tagged section, or the
    ENTIRE article (minus terminal sections) for a top-of-page tag. Falls
    back to whole-article when no tag is present. For label='human'
    harvesting, the lead. Returns (wikitext_region, is_whole_article)."""
    heading = re.search(r"\n==[^=]", wt)
    first_heading = heading.start() if heading else -1
    tag = AI_TAG.search(wt)
    if label == "ai" and tag and first_heading != -1 and tag.start() > first_heading:
        close = wt.find("}}", tag.start())
        start = tag.start() if close == -1 else close + 2
        nxt = re.search(r"\n==[^=]", wt[start:])
        return (wt[start : start + nxt.start()] if nxt else wt[start:]), False
    if label == "ai":
        return strip_terminal_sections(wt), True
    return (wt if first_heading == -1 else wt[:first_heading]), False


def trim_to_sentence(t: str, max_chars: int, min_chars: int = 500) -> str:
    if len(t) <= max_chars:
        return t
    cut = t[:max_chars]
    end = max(cut.rfind(". "), cut.rfind(".\n"), cut.rfind('."'))
    return cut[: end + 1] if end > min_chars else cut


def slug(title: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return s[:60]


def article_url(title: str) -> str:
    return "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_"))


def split_paragraphs(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def word_count(text: str) -> int:
    return len(text.split())
