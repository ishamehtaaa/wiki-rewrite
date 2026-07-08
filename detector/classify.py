#!/usr/bin/env python3
"""Supervised AI-text detectors: benchmark evaluation and serving.

Evaluate on the labeled samples (writes calibration into thresholds.json):

    detector/venv/bin/python detector/classify.py --model=e5
    detector/venv/bin/python detector/classify.py --model=desklib

Reads detector/samples/{ai,human}/*.txt, prints per-file p(AI), AUROC,
the best balanced-accuracy threshold, and an operating-point table —
directly comparable to the Binoculars numbers from calibrate.js.

Serve mode (used by detect.js): {"texts": [...]} on stdin, one JSON line
{"i": n, "p": 0.97} per text on stdout.

    detector/venv/bin/python detector/classify.py --serve --model=desklib

Models:
  e5      MayZhou/e5-small-lora-ai-generated-detector (~130MB, RAID leaderboard)
  desklib desklib/ai-text-detector-v1.01 (DeBERTa-v3-large, ~1.7GB)
"""

import hashlib
import json
import sys
from pathlib import Path

import torch
import torch.nn as nn
from huggingface_hub import hf_hub_download
from safetensors.torch import load_file
from transformers import AutoConfig, AutoModel, AutoModelForSequenceClassification, AutoTokenizer

SAMPLES = Path(__file__).parent / "samples"
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"


class DesklibAIDetectionModel(nn.Module):
    """Head from the desklib model card: mean pooling + linear. Loaded as a
    plain nn.Module — the card's PreTrainedModel subclass breaks on current
    transformers."""

    def __init__(self, config):
        super().__init__()
        self.model = AutoModel.from_config(config)
        self.classifier = nn.Linear(config.hidden_size, 1)

    def forward(self, input_ids, attention_mask=None):
        last_hidden_state = self.model(input_ids, attention_mask=attention_mask)[0]
        mask = attention_mask.unsqueeze(-1).expand(last_hidden_state.size()).float()
        pooled = (last_hidden_state * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
        return self.classifier(pooled)


def load_model(name):
    if name == "e5":
        repo = "MayZhou/e5-small-lora-ai-generated-detector"
        tok = AutoTokenizer.from_pretrained(repo)
        model = AutoModelForSequenceClassification.from_pretrained(repo).to(DEVICE).eval()

        def p_ai(text):
            enc = tok(text, return_tensors="pt", truncation=True, max_length=512).to(DEVICE)
            with torch.inference_mode():
                probs = torch.softmax(model(**enc).logits[0], dim=-1)
            return probs[1].item()  # label 1 = AI-generated

    elif name == "desklib":
        repo = "desklib/ai-text-detector-v1.01"
        tok = AutoTokenizer.from_pretrained(repo)
        model = DesklibAIDetectionModel(AutoConfig.from_pretrained(repo))
        model.load_state_dict(load_file(hf_hub_download(repo, "model.safetensors")))
        model = model.to(DEVICE).eval()

        def p_ai(text):
            enc = tok(text, return_tensors="pt", truncation=True, max_length=768, padding="max_length").to(DEVICE)
            with torch.inference_mode():
                logit = model(enc.input_ids, enc.attention_mask)
            return torch.sigmoid(logit).item()  # 1 = AI-generated

    else:
        sys.exit(f"unknown --model={name}; options: e5, desklib")
    return p_ai


def auroc(rows):
    """Probability a random AI sample outranks a random human one."""
    ai = sorted(r["p"] for r in rows if r["label"] == "ai")
    human = sorted(r["p"] for r in rows if r["label"] == "human")
    wins = sum(sum(1 if a > h else 0.5 if a == h else 0 for h in human) for a in ai)
    return wins / (len(ai) * len(human))


def serve(name):
    """Line protocol, one JSON object per line so a single process can
    serve an arbitrarily long run (detect.js one-shots, sweep.js overnight):
    in: {"id": <any>, "text": "..."}  out: {"id": <same>, "p": 0.97}
    """
    p_ai = load_model(name)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        print(json.dumps({"id": req.get("id"), "p": round(p_ai(req["text"]), 4)}), flush=True)


def main():
    name = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--model=")), "e5")
    if "--serve" in sys.argv:
        return serve(name)

    cache_path = Path(__file__).parent / ".classify-cache.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    cache.setdefault(name, {})

    todo = []
    rows = []
    for label in ("ai", "human"):
        for f in sorted((SAMPLES / label).glob("*.txt")):
            text = f.read_text().strip()
            h = hashlib.sha256(text.encode()).hexdigest()[:16]
            rows.append({"file": f"{label}/{f.name}", "label": label, "hash": h, "text": text})
            if h not in cache[name]:
                todo.append(rows[-1])

    if todo:
        p_ai = load_model(name)
        for r in todo:
            cache[name][r["hash"]] = {"p": round(p_ai(r["text"]), 4), "file": r["file"]}
            print(f"  {cache[name][r['hash']]['p']:.4f}  {r['file']}", file=sys.stderr)
        cache_path.write_text(json.dumps(cache, indent=2))

    for r in rows:
        r["p"] = cache[name][r["hash"]]["p"]
        del r["text"]

    # best balanced-accuracy threshold over midpoints
    ps = sorted({r["p"] for r in rows})
    best_t, best_bal = 0.5, 0
    n_ai = sum(r["label"] == "ai" for r in rows)
    n_human = len(rows) - n_ai
    for lo, hi in zip(ps, ps[1:]):
        t = (lo + hi) / 2
        bal = (sum(r["label"] == "ai" and r["p"] >= t for r in rows) / n_ai
               + sum(r["label"] == "human" and r["p"] < t for r in rows) / n_human) / 2
        if bal > best_bal:
            best_t, best_bal = t, bal

    misses = [r for r in rows if (r["label"] == "ai") != (r["p"] >= best_t)]
    print(f"\nmodel: {name}  samples: {n_ai} ai / {n_human} human")
    print(f"AUROC: {auroc(rows):.3f}")
    print(f"balanced accuracy: {best_bal * 100:.1f}% at p(AI) >= {best_t:.3f}")
    print(f"misclassified: {len(misses)}")
    for r in sorted(misses, key=lambda r: r["p"]):
        print(f"  {r['p']:.4f}  {r['file']} ({r['label']})")

    # Operating points: measured catch rate vs false-alarm rate, so verdicts
    # can be phrased in benchmark terms instead of invented confidence.
    points = []
    print("\n  p(AI) >=   catches AI   false-flags human")
    for t in (0.25, 0.50, 0.75, 0.90, 0.95, 0.99):
        tpr = sum(r["label"] == "ai" and r["p"] >= t for r in rows) / n_ai
        fpr = sum(r["label"] == "human" and r["p"] >= t for r in rows) / n_human
        points.append({"t": t, "tpr": round(tpr, 3), "fpr": round(fpr, 3)})
        print(f"      {t:.2f}       {tpr * 100:3.0f}%            {fpr * 100:3.0f}%")

    th_path = Path(__file__).parent / "thresholds.json"
    th = json.loads(th_path.read_text()) if th_path.exists() else {}
    th[name] = {
        "auroc": round(auroc(rows), 3),
        "bestThreshold": round(best_t, 3),
        "balancedAccuracy": round(best_bal, 3),
        "samples": {"ai": n_ai, "human": n_human},
        "operatingPoints": points,
    }
    th_path.write_text(json.dumps(th, indent=2))
    print(f"\nwrote calibration for '{name}' to detector/thresholds.json")


if __name__ == "__main__":
    main()
