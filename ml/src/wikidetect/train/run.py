"""LoRA fine-tune of the desklib detector on a corpus version.

    wikidetect train --name lora-a --corpus-version v1 [--epochs 3]

Plain explicit PyTorch loop (no HF Trainer — the custom mean-pool head
doesn't fit its conventions and this is more debuggable). LoRA adapters on
the DeBERTa encoder attention, full training of the classifier head, BCE
loss, AdamW + linear warmup, gradient accumulation, early stop on val AUROC.

Each run writes artifacts/runs/<name>/:
    config.json    hyperparams + corpus version + git sha
    metrics.jsonl  per-epoch train loss / val AUROC
    adapter/       LoRA adapter (safetensors, ~tens of MB)
    classifier.safetensors  the trained head

Evaluate + compare against the frozen baseline with `wikidetect eval <name>`;
adopt only if it beats the baseline on the frozen test split.
"""

import json
import subprocess
import time

import torch
from torch.utils.data import DataLoader

from .. import config
from .dataset import CorpusDataset, collate

EFFECTIVE_BATCH = 16
WARMUP_FRAC = 0.06


def _val_auroc(model, loader, device) -> float:
    model.eval()
    scores, labels = [], []
    with torch.inference_mode():
        for input_ids, mask, y in loader:
            logits = model(input_ids.to(device), mask.to(device)).squeeze(-1)
            scores.extend(torch.sigmoid(logits).tolist())
            labels.extend(y.tolist())
    ai = [s for s, l in zip(scores, labels) if l == 1.0]
    human = [s for s, l in zip(scores, labels) if l == 0.0]
    if not ai or not human:
        return 0.0
    wins = sum(sum(1 if a > h else 0.5 if a == h else 0 for h in human) for a in ai)
    return wins / (len(ai) * len(human))


def train(name: str, corpus_version: str = "v1", epochs: int = 3, lr: float = 2e-4,
          lora_r: int = 16, resume: bool = False, micro_batch: int = 2,
          max_length: int = 0, throttle: float = 0.0, grad_checkpoint: bool = False):
    from peft import LoraConfig, get_peft_model
    from safetensors.torch import save_file

    from ..models import DEVICE, Scorer

    run_dir = config.RUNS / name
    if run_dir.exists() and not resume:
        raise SystemExit(f"{run_dir} exists — pick a new --name or pass --resume")
    run_dir.mkdir(parents=True, exist_ok=True)

    base = Scorer("desklib")  # reuse the exact benchmark model + tokenizer
    model, tokenizer = base.model, base.tokenizer
    # a shorter window is the cheapest compute lever; it is recorded in
    # config.json so eval truncates identically
    max_length = max_length or base.max_length
    accum_steps = max(1, EFFECTIVE_BATCH // micro_batch)

    lora = LoraConfig(
        r=lora_r, lora_alpha=lora_r * 2, lora_dropout=0.05,
        target_modules=["query_proj", "key_proj", "value_proj", "dense"],
        bias="none",
    )
    model.model = get_peft_model(model.model, lora)
    if grad_checkpoint:
        model.model.gradient_checkpointing_enable(
            gradient_checkpointing_kwargs={"use_reentrant": False})
    for p in model.classifier.parameters():
        p.requires_grad = True
    model.to(DEVICE).train()
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"trainable params: {trainable / 1e6:.1f}M")

    train_ds = CorpusDataset(corpus_version, "train", tokenizer, max_length)
    val_ds = CorpusDataset(corpus_version, "val", tokenizer, max_length)
    train_loader = DataLoader(train_ds, batch_size=micro_batch, shuffle=True, collate_fn=collate(tokenizer))
    val_loader = DataLoader(val_ds, batch_size=micro_batch, collate_fn=collate(tokenizer))
    print(f"corpus-{corpus_version}: {len(train_ds)} train / {len(val_ds)} val")

    git_sha = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"], cwd=config.REPO,
        capture_output=True, text=True,
    ).stdout.strip()
    (run_dir / "config.json").write_text(json.dumps({
        "base": "desklib", "corpus_version": corpus_version, "max_length": max_length,
        "epochs": epochs, "lr": lr, "lora_r": lora_r,
        "micro_batch": micro_batch, "accum_steps": accum_steps,
        "throttle": throttle, "grad_checkpoint": grad_checkpoint, "git_sha": git_sha,
    }, indent=2) + "\n")

    opt = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad), lr=lr)
    total_steps = max(1, len(train_loader) // accum_steps) * epochs
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt,
        lambda s: min(1.0, s / max(1, total_steps * WARMUP_FRAC))
        * max(0.0, 1 - s / total_steps),
    )
    loss_fn = torch.nn.BCEWithLogitsLoss()

    best_auroc, step = 0.0, 0
    metrics = (run_dir / "metrics.jsonl").open("a")
    for epoch in range(epochs):
        model.train()
        running, n_batches = 0.0, 0
        opt.zero_grad()
        for i, (input_ids, mask, y) in enumerate(train_loader):
            with torch.autocast("mps", dtype=torch.float16):
                logits = model(input_ids.to(DEVICE), mask.to(DEVICE)).squeeze(-1)
                loss = loss_fn(logits.float(), y.to(DEVICE)) / accum_steps
            loss.backward()
            running += loss.item() * accum_steps
            n_batches += 1
            if throttle:
                time.sleep(throttle)  # duty-cycle the GPU; machine stays usable
            if (i + 1) % accum_steps == 0:
                opt.step()
                sched.step()
                opt.zero_grad()
                step += 1
                if step % 20 == 0:
                    print(f"  epoch {epoch} step {step}/{total_steps} loss {running / n_batches:.4f}")

        auroc = _val_auroc(model, val_loader, DEVICE)
        row = {"epoch": epoch, "train_loss": round(running / max(1, n_batches), 4), "val_auroc": round(auroc, 4)}
        print(json.dumps(row))
        metrics.write(json.dumps(row) + "\n")
        metrics.flush()

        if auroc > best_auroc:
            best_auroc = auroc
            model.model.save_pretrained(run_dir / "adapter")
            save_file(model.classifier.state_dict(), run_dir / "classifier.safetensors")
            print(f"  saved (val AUROC {auroc:.4f})")
        else:
            print("  no val improvement — early stop")
            break

    metrics.close()
    print(f"\nbest val AUROC {best_auroc:.4f} — next: wikidetect eval {name}")
