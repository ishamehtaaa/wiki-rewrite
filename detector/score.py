#!/usr/bin/env python3
"""Binoculars scoring core (Hans et al. 2024, arXiv:2401.12070).

Runs the base/instruct pair on MPS (Apple GPU) at fp16. Invoked by the
JS tools (binoculars.js, calibrate.js) via detector/venv/bin/python:

    stdin:  {"size": "1.5b", "texts": ["...", ...]}
    stdout: one JSON line per text, in input order:
            {"i": 0, "tokens": N, "logPpl": x, "xEntropy": y, "score": s}
            or {"i": 0, "error": "too short"}

Score = logPPL_performer / crossEntropy(observer -> performer), matching
the reference implementation (github.com/ahans30/Binoculars). LOWER =
more AI-typical.
"""

import json
import sys

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

PAIRS = {
    "0.5b": ("Qwen/Qwen2.5-0.5B", "Qwen/Qwen2.5-0.5B-Instruct"),
    "1.5b": ("Qwen/Qwen2.5-1.5B", "Qwen/Qwen2.5-1.5B-Instruct"),
}
MAX_TOKENS = 512  # reference implementation's max_token_observed


def main() -> None:
    req = json.load(sys.stdin)
    size = req.get("size", "1.5b")
    texts = req["texts"]
    if size not in PAIRS:
        print(f"unknown size {size!r}; options: {list(PAIRS)}", file=sys.stderr)
        sys.exit(1)

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    dtype = torch.float16 if device == "mps" else torch.float32
    observer_id, performer_id = PAIRS[size]
    print(f"loading {observer_id} + instruct on {device} ({dtype})...", file=sys.stderr)
    tokenizer = AutoTokenizer.from_pretrained(observer_id)
    observer = AutoModelForCausalLM.from_pretrained(observer_id, dtype=dtype).to(device).eval()
    performer = AutoModelForCausalLM.from_pretrained(performer_id, dtype=dtype).to(device).eval()

    with torch.inference_mode():
        for i, text in enumerate(texts):
            enc = tokenizer(text, return_tensors="pt", truncation=True, max_length=MAX_TOKENS).to(device)
            n_tokens = enc.input_ids.shape[1]
            if n_tokens < 2:
                print(json.dumps({"i": i, "error": "too short"}), flush=True)
                continue

            o_logits = observer(**enc).logits[0].float()   # [L, V]
            p_logits = performer(**enc).logits[0].float()  # [L, V]
            log_p = torch.log_softmax(p_logits, dim=-1)

            # logPPL: mean NLL of the actual tokens under the performer (shifted)
            targets = enc.input_ids[0, 1:].unsqueeze(1)
            log_ppl = -log_p[:-1].gather(1, targets).mean().item()

            # xEntropy: mean over ALL positions of -sum_v p_obs(v) log p_perf(v)
            x_entropy = -(torch.softmax(o_logits, dim=-1) * log_p).sum(-1).mean().item()

            print(json.dumps({
                "i": i,
                "tokens": n_tokens,
                "logPpl": round(log_ppl, 4),
                "xEntropy": round(x_entropy, 4),
                "score": round(log_ppl / x_entropy, 4),
            }), flush=True)


if __name__ == "__main__":
    main()
