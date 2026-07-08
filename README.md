# Neutralizer

A small local tool that rewrites AI-generated, non-encyclopedic prose for
Wikipedia editing. Paste a draft and it streams a consolidated neutral rewrite
from Claude Sonnet in two passes: a rewrite, then a critic review against the
same neutrality test that corrects anything the first pass missed. Repeated
ideas are merged, filler sentences are deleted, and stance is stripped, so the
output is typically half to two-thirds the length of the input.

The API key stays server-side (read from `.env`), so it never touches the browser.

## Setup

```bash
cp .env.example .env        # then edit .env and paste your key
npm install
npm start
```

Open http://localhost:2000

Get an API key at https://console.anthropic.com

### Docker (alternative)

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # compose reads the key from your shell, not .env
docker compose -f docker-compose.dev.yml up --build
```

Same app, same port: http://localhost:2000

## Improving the rewriter

Everything that defines "neutral" lives in `rules.js`: the neutrality test
(one principle plus example conversions — deliberately not a term list), the
prompts for both the rewriter and the critic pass, and a stance vocabulary
used only by the evals as assertions.

When you find a bad rewrite, don't add its phrasing to a ban list. Add the
input to `evals/cases.js` with checks for what went wrong (facts that must
survive, a length cap, endorsement limits — stance language is asserted
automatically from the vocabulary in `rules.js`), then run:

```bash
npm run evals              # all cases; exits non-zero on failure
npm run evals -- drama     # only cases whose name matches
```

and adjust `rules.js` until every case passes without breaking the others.
Each eval case costs a couple of API calls.

### Register exemplars from known-good articles

The rewriter is Claude behind an API, so it can't be fine-tuned — but
known-good human prose can be embedded in the prompt as register
calibration ("this is what passing prose reads like"). Harvest excerpts
from articles you trust, or sample Wikipedia's own quality lists:

```bash
# specific articles you vouch for
npm run fetch-exemplars -- "https://en.wikipedia.org/wiki/Caesium" "Thylacine"

# or N random Featured/Good articles
npm run fetch-exemplars -- --from="https://en.wikipedia.org/wiki/Wikipedia:Featured_articles" --count=3
npm run fetch-exemplars -- --from="https://en.wikipedia.org/wiki/Wikipedia:Good_articles" --count=3
```

Each article's lead is stripped to plain prose and written to
`exemplars.js`, which `rules.js` appends to the rewrite prompt. Leads
that contain the stance vocabulary the evals ban are skipped
automatically — an exemplar that models stance would teach exactly the
wrong thing. `--before=YYYY-MM-DD` takes a pre-ChatGPT revision if you
want guaranteed-human text; `--replace` starts the set over.

Exemplars are a prompt change like any other: keep a set only if
`npm run evals` still passes with it (run the suite more than once —
single runs are noisy). A handful of excerpts is the sweet spot; the
script warns past four.

## AI detection (offline)

`npm run detect` scores text with the detector that performed best on
this repo's labeled benchmark of *real* Wikipedia cleanup data
(currently `desklib/ai-text-detector-v1.01`, a DeBERTa-v3-large
classifier, run locally on the Apple GPU). Output is p(AI) plus what
that score meant on the benchmark — measured catch and false-flag
rates, not invented confidence labels. No API key; nothing leaves your
machine after the one-time model download.

One-time setup (scoring runs in Python; the CLI stays Node):

```bash
python3 -m venv detector/venv
detector/venv/bin/pip install torch transformers sentencepiece protobuf
```

Usage:

```bash
npm run detect -- suspect.txt         # file
pbpaste | npm run detect              # clipboard
npm run detect -- --json suspect.txt  # machine-readable
```

Multi-paragraph input also gets per-paragraph scores, to localize an AI
passage spliced into an otherwise human article.

### Sweeping a whole cleanup category

`npm run sweep` scores every article in a WikiProject AI Cleanup monthly
category and writes a ranked triage report (worst first, linked, with
each article's most AI-typical paragraph):

```bash
caffeinate -i npm run sweep -- \
  --category="https://en.wikipedia.org/wiki/Category:Articles_containing_suspected_AI-generated_texts_from_November_2025"
```

`caffeinate -i` keeps the Mac awake for unattended runs. A ~600-article
month takes roughly an hour (rate-limited API calls; the model loads
once). Results append to `detector/sweeps/<category>.jsonl` as each
article finishes, so an interrupted run resumes exactly where it
stopped — rerun the same command. The ranked markdown report lands next
to it. `--limit=N` caps a trial run.

### The benchmark

Detectors are chosen by evidence, never reputation — same philosophy as
the rewriter evals. `detector/samples/ai/` holds text harvested from
articles tagged `{{AI-generated}}`; `detector/samples/human/` holds
pre-ChatGPT revisions (guaranteed human). `npm run calibrate` evaluates
the active detector on them (scores cached by content hash), prints
AUROC / balanced accuracy / an operating-point table, and writes
`detector/thresholds.json`, which `npm run detect` uses to phrase
verdicts.

Grow the benchmark straight from Wikipedia:

```bash
# articles tagged {{AI-generated}} (WikiProject AI Cleanup categories)
npm run fetch-samples -- --label=ai --limit=25 \
  --category="Category:Articles containing suspected AI-generated texts from December 2025"

# guaranteed-human: last revision before ChatGPT existed
npm run fetch-samples -- --label=human --limit=25 --before=2022-06-01 \
  --category="Category:Featured articles"

npm run calibrate
```

The AI fetcher samples the region the `{{AI-generated}}` tag covers
(the tagged section, or the whole article for a top-of-page tag) and
skips whole-article samples from pre-ChatGPT pages, whose authorship is
mixed. When the detector gets a real case wrong, add that text to the
right samples folder and recalibrate — don't tweak `thresholds.json` by
hand. To try a different detector, add it to `detector/classify.py` and
make it beat the incumbent on the benchmark first.

Findings so far: zero-shot perplexity methods — GPT-2 perplexity and
Binoculars (`detector/binoculars.js`, kept as a falsified baseline) —
collapse to near-chance on real cleanup data: edited, cross-generator
AI text reads as high-perplexity, while established human articles are
memorized by open models and read as low-perplexity.

Detector output is a triage signal, never proof: per WikiProject AI
Cleanup guidance, judge content against sources, style, and history
before tagging or removing anything. The category labels are editors'
suspicions, so inspect benchmark outliers by hand.

## Notes

- `.env` and `node_modules/` are gitignored — safe to put this folder in a repo.
- The rewrite requires the server and an API key — there is no offline mode.
- Cost is a fraction of a cent per rewrite (two Sonnet calls: rewrite + review).
- This is built for local use. If you ever expose it beyond localhost, add auth —
  the proxy will happily spend your key for anyone who can reach it.
- The tool can't confirm whether any claim is true; checking flagged claims
  against sources stays your job.
