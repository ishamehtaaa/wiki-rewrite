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

## Notes

- `.env` and `node_modules/` are gitignored — safe to put this folder in a repo.
- The rewrite requires the server and an API key — there is no offline mode.
- Cost is a fraction of a cent per rewrite (two Sonnet calls: rewrite + review).
- This is built for local use. If you ever expose it beyond localhost, add auth —
  the proxy will happily spend your key for anyone who can reach it.
- The tool can't confirm whether any claim is true; checking flagged claims
  against sources stays your job.
