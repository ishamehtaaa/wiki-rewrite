"""Score one text and phrase the verdict in benchmark terms.

Port of the retired detect.js + scorer.js verdictFor: the strictest
benchmark operating point a score clears gives the measured trade-off at
that level — honest phrasing, not invented confidence labels.
"""

import json

from . import config
from .wiki import split_paragraphs, word_count

_scorers: dict = {}


def get_scorer(model: str = config.DEFAULT_MODEL):
    if model not in _scorers:
        from .models import Scorer

        _scorers[model] = Scorer(model)
    return _scorers[model]


def load_calibration(model: str = config.DEFAULT_MODEL):
    try:
        return json.loads(config.THRESHOLDS.read_text()).get(model)
    except FileNotFoundError:
        return None


def verdict_for(p: float, calibration: dict | None) -> dict:
    if not calibration:
        return {"verdict": "AI-leaning (uncalibrated)" if p >= 0.5 else "human-leaning (uncalibrated)"}
    cleared = next((o for o in reversed(calibration["operatingPoints"]) if p >= o["t"]), None)
    if not cleared:
        return {"verdict": "human-typical"}
    verdict = "AI-typical" if cleared["fpr"] <= 0.05 else "leaning AI — inspect manually"
    return {"verdict": verdict, "atThisLevel": {"caughtAI": cleared["tpr"], "falseFlaggedHuman": cleared["fpr"]}}


def detect_text(text: str, model: str = config.DEFAULT_MODEL) -> dict:
    """The full structured finding the Node side renders."""
    calibration = load_calibration(model)
    scorer = get_scorer(model)

    paragraphs = split_paragraphs(text)
    para_texts = paragraphs if len(paragraphs) > 1 else []
    doc_p, *para_ps = scorer.score_batch([text, *para_texts])

    doc = verdict_for(doc_p, calibration)
    return {
        "model": model,
        "pAI": round(doc_p, 4),
        **doc,
        "shortText": word_count(text) < config.MIN_DOC_WORDS,
        "benchmark": (
            {"auroc": calibration["auroc"], "samples": calibration["samples"]}
            if calibration
            else "uncalibrated — run: wikidetect calibrate"
        ),
        "paragraphs": [
            {
                "pAI": round(p, 4),
                "unreliable": word_count(t) < config.MIN_DOC_WORDS,
                "preview": t[:77] + "..." if len(t) > 80 else t,
            }
            for t, p in zip(para_texts, para_ps)
        ],
    }


def render_human(result: dict) -> str:
    lines = []
    bench = result["benchmark"]
    suffix = (
        f"  (AUROC {bench['auroc']} on {bench['samples']['ai']} AI / {bench['samples']['human']} human Wikipedia samples)"
        if isinstance(bench, dict)
        else ""
    )
    lines.append(f"model      : {result['model']}{suffix}")
    lines.append(f"p(AI)      : {result['pAI']}{'   ⚠ short text — low confidence' if result['shortText'] else ''}")
    lines.append(f"verdict    : {result['verdict']}")
    if "atThisLevel" in result:
        a = result["atThisLevel"]
        lines.append(f"             on the benchmark, scores this high caught {round(a['caughtAI'] * 100)}% of AI text")
        lines.append(f"             while false-flagging {round(a['falseFlaggedHuman'] * 100)}% of human text")
    if result["paragraphs"]:
        lines.append("\nper-paragraph (highest p(AI) first):")
        for p in sorted(result["paragraphs"], key=lambda x: -x["pAI"]):
            mark = "*" if p["unreliable"] else " "
            lines.append(f"  {p['pAI']:.3f}{mark} {p['preview']}")
        if any(p["unreliable"] for p in result["paragraphs"]):
            lines.append(f"  (* under {config.MIN_DOC_WORDS} words — score unreliable)")
    lines.append("\nNote: no detector output is proof of AI authorship. Use this to")
    lines.append("prioritize review; judge content against sources and history.")
    return "\n".join(lines)
