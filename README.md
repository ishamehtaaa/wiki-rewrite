# Neutralizer

Two halves of one loop for Wikipedia AI cleanup:

- **`web/` — the rewriter.** A small local web app: paste an AI-written or
  promotional draft and it streams a consolidated neutral rewrite from Claude
  in two passes (rewrite, then a critic review against the same neutrality
  test). Output is typically half to two-thirds the input length.
- **`ml/` — the detector (`wikidetect`).** A Python package that finds AI
  text on Wikipedia: benchmark-calibrated scoring (desklib DeBERTa-v3-large,
  local Apple-GPU), category-wide triage sweeps, a reproducible labeled
  corpus, and a LoRA training pipeline to eventually beat the frozen
  baseline.

They meet in `artifacts/` — JSON contracts the two sides read and write:

```
ml sweep ──► ranked findings (full text + revid)
                │  npm run promote  (human triage)
                ▼
        web/evals/cases/*.json ──► failing case? fix rules.js BY PRINCIPLE
                │                   (or grow shared/stance.json — that
                ▼                    tightens assertions, never the prompt)
        npm run evals  ── assertions + critic + detector p(AI) gate
                ▲
ml exemplars ──► artifacts/exemplars.json (register calibration in the
                 prompt; every regeneration is a prompt change — evals gate it)
```

Nothing in the loop ever appends detector findings to prompt vocabulary:
failures become eval cases and principled prompt fixes, never ban-list
patches.

## Setup

```bash
cp .env.example .env        # add your ANTHROPIC_API_KEY (console.anthropic.com)
cd web && npm install && npm start        # http://localhost:2000
```

Detector side (one-time; needs [uv](https://docs.astral.sh/uv/)):

```bash
cd ml && uv sync                          # torch/transformers env
uv run wikidetect calibrate               # reproduce the benchmark numbers
```

## The rewriter (`web/`)

Everything that defines "neutral" lives in `web/rules.js`: the neutrality
test (one principle plus example conversions — deliberately not a term
list) and the prompts for both passes. The two-pass pipeline itself is
`web/lib/pipeline.js`, shared verbatim by the browser app and the evals.

The stance vocabulary lives in `shared/stance.json` — pure assertion data
for the evals (compiled by `web/lib/stance.js` and `ml`'s `stance.py`),
never prompt material.

### Evals

Cases are JSON files in `web/evals/cases/`, one failure mode each, with
provenance when promoted from a sweep. Pipeline outputs are cached by a
hash of (model + prompts + input): tightening an assertion re-checks for
free; any prompt or exemplar change re-runs automatically.

```bash
npm run evals                 # all cases
npm run evals -- drama        # cases whose name matches
npm run evals -- --failed     # only last run's failures
npm run evals -- --fresh      # bypass the output cache
npm run evals -- --detector   # require the detector gate (see below)
```

When a `wikidetect serve` instance is up, every final output is also scored
by the detector: the rewriter's output should not read as AI to the very
detector that finds cleanup candidates. Currently a warning, not a failure
(the detector is calibrated on article leads, not condensed rewrites);
tighten per-case with `maxPAI`.

### The loop: sweep → promote → case → fix

```bash
cd ml && uv run wikidetect sweep --category "Category:Articles containing suspected AI-generated texts from November 2025"
cd ../web && npm run promote -- --sweep=../artifacts/sweeps/<slug>.jsonl --title="Worst Article"
# fill in mustKeep + notes in the new case file, then
npm run evals -- <case-name>
```

A case that passes immediately is a regression guard — commit it. A case
that fails has exposed a prompt weakness: fix `rules.js` by principle, get
the full suite green, and commit the case and the fix together.

### Register exemplars

Known-good human prose is embedded in the prompt as register calibration
(`artifacts/exemplars.json`, loaded by `rules.js`). Regenerate with:

```bash
npm run exemplars -- "Caesium" "Thylacine"
npm run exemplars -- --from "Wikipedia:Featured articles" --count 3
```

Candidates are stance-filtered, cleanly extracted (no wikitext husks), and
must score human-typical on the calibrated detector. Exemplars are a prompt
change like any other: validate with `npm run evals -- --fresh` before
committing the new JSON. A handful is the sweet spot; the tool warns past
four.

## The detector (`ml/`)

```bash
cd ml
uv run wikidetect detect suspect.txt      # p(AI) + benchmark-calibrated verdict
uv run wikidetect serve                   # long-lived HTTP scorer (model loads once)
uv run wikidetect sweep --category "..."  # ranked triage report for a category
uv run wikidetect calibrate               # benchmark -> artifacts/thresholds.json
```

- `serve` answers warm `/detect` and `/score` requests in well under 2s on
  127.0.0.1:8756 (the old stack paid a 30–60s model load per invocation).
- `sweep` overlaps concurrent Wikipedia fetches with batched GPU scoring
  through a shared sqlite score cache; a ~600-article month takes ~20–25
  minutes fresh (use `caffeinate -i` for unattended runs — a sleeping Mac
  suspends the GPU). Records carry full text and revid so findings can be
  promoted into eval cases even after the live article is cleaned up.
  Output: `artifacts/sweeps/<slug>.jsonl` + ranked `.md`, resumable.

Verdicts are phrased from measured benchmark operating points (catch rate
vs false-flag rate), never invented confidence. Detector output is a triage
signal, not proof: judge content against sources and history before acting.

### The corpus

Labeled data is versioned as manifests (`ml/manifests/corpus-*.jsonl`: one
row per sample with label, title, revid, sha256) plus a gitignored
content-addressed text store — `wikidetect corpus fetch` re-materializes
texts from the pinned revids and verifies hashes on any clone.

- **corpus-v0** is the frozen historical benchmark (`ml/corpus-v0/`,
  57 committed files) — permanently test-only.
- **corpus-v1** scales up: positives from every monthly cleanup category
  (whole-article tags trusted only on pages created after 2022-12-01);
  negatives from pre-2022-06-01 revisions in three strata — matched
  (pre-cutoff leads of the same tagged pages: hardest), random articles,
  and Featured Article leads.

```bash
uv run wikidetect corpus harvest --version v1          # all months (hours; resumable)
uv run wikidetect corpus split --version v1            # grouped, stratified 80/10/10
uv run wikidetect calibrate --samples ... --corpus-version v1
```

Category labels are editor suspicions: after calibrating, eyeball the
worst-scored positives / best-scored negatives and blocklist mislabels in
`ml/manifests/blocklist.txt`.

### Training

LoRA fine-tune of the desklib body on a corpus version, plain PyTorch loop,
runs tracked as directories under `ml/artifacts/runs/<name>/`:

```bash
uv run wikidetect train --name lora-a --corpus-version v1
uv run wikidetect eval lora-a
```

On a machine that can't take the full load, dial it down: `--max-length 384`
(the biggest lever; recorded in the run config so eval truncates the same
way), `--micro-batch 1` (accumulation keeps the effective batch at 16),
`--throttle 0.3` (sleep between micro-batches — slower wall-clock, usable
machine), and `--grad-checkpoint` if memory pressure/swap is the problem.

The eval always scores the frozen desklib baseline on the identical test
split. Adoption gate: the candidate must beat the baseline's test AUROC
without regressing FPR at the 0.90 operating point — only then does it get
calibrated into `artifacts/thresholds.json` and used for sweeps.

Findings so far: zero-shot perplexity methods (GPT-2 perplexity,
Binoculars) collapsed to near-chance on real cleanup data and were removed;
the supervised desklib detector holds AUROC 0.87 on corpus-v0.

## Repo layout

```
shared/stance.json     stance vocabulary (assertion data, both languages)
artifacts/             Node<->Python contracts: exemplars.json, thresholds.json,
                       sweeps/ (gitignored bulk)
web/                   rewriter app + evals (Node, 2 deps)
ml/                    wikidetect Python package (uv), corpus manifests,
                       corpus-v0 benchmark, training runs
```

## Notes

- `.env`, caches, venvs, sweeps, and corpus texts are gitignored; manifests,
  calibration, exemplars, and eval cases are committed — the state that
  defines behavior is all in git.
- Rewrites cost a fraction of a cent (two Sonnet calls); evals are cached.
  Detection is fully local — nothing leaves your machine after the one-time
  model download.
- Built for local use. If you expose the web app beyond localhost, add
  auth — the proxy will spend your key for anyone who can reach it.
- The tool can't confirm whether any claim is true; checking flagged claims
  against sources stays your job.
