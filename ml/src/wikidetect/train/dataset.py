"""Corpus manifest -> tokenized torch Dataset."""

import torch
from torch.utils.data import Dataset

from .. import config, corpus


class CorpusDataset(Dataset):
    def __init__(self, version: str, split: str, tokenizer, max_length: int):
        rows = [r for r in corpus.load_manifest(version) if r["split"] == split]
        if not rows:
            raise SystemExit(
                f"corpus-{version} has no split={split!r} rows — run: wikidetect corpus split"
            )
        self.rows = rows
        self.tokenizer = tokenizer
        self.max_length = max_length

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        r = self.rows[i]
        enc = self.tokenizer(
            corpus.text_of(r), truncation=True, max_length=self.max_length,
            return_tensors="pt",
        )
        return {
            "input_ids": enc.input_ids[0],
            "attention_mask": enc.attention_mask[0],
            "label": torch.tensor(1.0 if r["label"] == "ai" else 0.0),
        }


def collate(tokenizer):
    """Dynamic padding to the longest item in the batch."""

    def fn(items):
        pad_id = tokenizer.pad_token_id or 0
        width = max(len(x["input_ids"]) for x in items)
        input_ids = torch.full((len(items), width), pad_id, dtype=torch.long)
        mask = torch.zeros((len(items), width), dtype=torch.long)
        labels = torch.stack([x["label"] for x in items])
        for i, x in enumerate(items):
            n = len(x["input_ids"])
            input_ids[i, :n] = x["input_ids"]
            mask[i, :n] = x["attention_mask"]
        return input_ids, mask, labels

    return fn
