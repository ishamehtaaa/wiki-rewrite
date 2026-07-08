"""Model registry and batch scoring.

Names resolve to either a frozen Hugging Face detector ("desklib", "e5") or
a local training run under ml/artifacts/runs/<name>/ (a LoRA adapter over
the desklib body — see train/run.py). Every scorer loads once per process
and exposes score_batch() with dynamic padding: the desklib head mean-pools
with the attention mask, so padding length does not change the math, only
the wasted compute (the old classify.py padded everything to 768).
"""

import json

import torch
import torch.nn as nn
from huggingface_hub import hf_hub_download
from safetensors.torch import load_file
from transformers import (
    AutoConfig,
    AutoModel,
    AutoModelForSequenceClassification,
    AutoTokenizer,
)

from . import config

DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
DESKLIB_REPO = "desklib/ai-text-detector-v1.01"


class DesklibAIDetectionModel(nn.Module):
    """Head from the desklib model card: mean pooling + linear. Loaded as a
    plain nn.Module — the card's PreTrainedModel subclass breaks on current
    transformers."""

    def __init__(self, cfg):
        super().__init__()
        self.model = AutoModel.from_config(cfg)
        self.classifier = nn.Linear(cfg.hidden_size, 1)

    def forward(self, input_ids, attention_mask=None):
        last_hidden_state = self.model(input_ids, attention_mask=attention_mask)[0]
        mask = attention_mask.unsqueeze(-1).expand(last_hidden_state.size()).float()
        pooled = (last_hidden_state * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
        return self.classifier(pooled)


class Scorer:
    """score(text) / score_batch(texts) -> p(AI) in [0, 1]."""

    def __init__(self, name: str = config.DEFAULT_MODEL):
        self.name = name
        if name == "desklib":
            self.max_length = config.MODEL_MAX_LENGTH["desklib"]
            self.model_id = f"desklib@v1.01/{self.max_length}"
            self.tokenizer = AutoTokenizer.from_pretrained(DESKLIB_REPO)
            model = DesklibAIDetectionModel(AutoConfig.from_pretrained(DESKLIB_REPO))
            model.load_state_dict(load_file(hf_hub_download(DESKLIB_REPO, "model.safetensors")))
            self.model = model.to(DEVICE).eval()
            self._binary_logit = True
        elif name == "e5":
            repo = "MayZhou/e5-small-lora-ai-generated-detector"
            self.max_length = config.MODEL_MAX_LENGTH["e5"]
            self.model_id = f"e5@lora/{self.max_length}"
            self.tokenizer = AutoTokenizer.from_pretrained(repo)
            self.model = AutoModelForSequenceClassification.from_pretrained(repo).to(DEVICE).eval()
            self._binary_logit = False
        else:
            run_dir = config.RUNS / name
            run_cfg = json.loads((run_dir / "config.json").read_text())
            if run_cfg.get("base") != "desklib":
                raise ValueError(f"run {name}: unsupported base {run_cfg.get('base')!r}")
            from peft import PeftModel  # train extra

            self.max_length = run_cfg.get("max_length", config.MODEL_MAX_LENGTH["desklib"])
            self.model_id = f"{name}/{self.max_length}"
            self.tokenizer = AutoTokenizer.from_pretrained(DESKLIB_REPO)
            model = DesklibAIDetectionModel(AutoConfig.from_pretrained(DESKLIB_REPO))
            model.load_state_dict(load_file(hf_hub_download(DESKLIB_REPO, "model.safetensors")))
            model.model = PeftModel.from_pretrained(model.model, run_dir / "adapter")
            head = run_dir / "classifier.safetensors"
            if head.exists():
                model.classifier.load_state_dict(load_file(head))
            self.model = model.to(DEVICE).eval()
            self._binary_logit = True

    def score(self, text: str) -> float:
        return self.score_batch([text])[0]

    def _batches(self, texts: list[str]):
        """Length-sorted batches bounded by padded-token budget, so short
        paragraphs batch wide while full documents batch narrow."""
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
        batch: list[int] = []
        for i in order:
            # ~4 chars/token, clamped to the model window; ascending order
            # means the candidate item sets the batch's padded width
            est = min(len(texts[i]) // 4 + 8, self.max_length)
            if batch and (
                (len(batch) + 1) * est > config.MAX_BATCH_TOKENS
                or len(batch) >= config.MAX_BATCH_ITEMS
            ):
                yield batch
                batch = []
            batch.append(i)
        if batch:
            yield batch

    def score_batch(self, texts: list[str]) -> list[float]:
        scores: dict[int, float] = {}
        for idx in self._batches(texts):
            enc = self.tokenizer(
                [texts[i] for i in idx], return_tensors="pt", truncation=True,
                max_length=self.max_length, padding=True,
            ).to(DEVICE)
            with torch.inference_mode():
                if self._binary_logit:
                    logits = self.model(enc.input_ids, enc.attention_mask)
                    ps = torch.sigmoid(logits).squeeze(-1)  # 1 = AI-generated
                else:
                    ps = torch.softmax(self.model(**enc).logits, dim=-1)[:, 1]
            for i, p in zip(idx, ps.tolist()):
                scores[i] = p
        out = [scores[i] for i in range(len(texts))]
        return out
