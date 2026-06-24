# Wikipedia sentence rewriter

A small local tool for cleaning up non-encyclopedic prose. Paste a sentence,
get Manual-of-Style issues flagged (peacock terms, weasel words, editorializing,
unsupported evaluative claims) plus 2–3 rewrite options in neutral register.
You pick or adapt the fix — it never auto-applies anything, and it flags claims
that should be checked against a source rather than silently polishing them.

The API key stays server-side (read from `.env`), so it never touches the browser.

## Setup

```bash
cp .env.example .env        # then edit .env and paste your key
npm install
npm start
```

Open http://localhost:3000

Get an API key at https://console.anthropic.com

## Notes

- `.env` and `node_modules/` are gitignored — safe to put this folder in a repo.
- Cost is a fraction of a cent per rewrite (a few hundred tokens on Sonnet).
- This is built for local use. If you ever expose it beyond localhost, add auth —
  the proxy will happily spend your key for anyone who can reach it.
- The verification flags are heuristic: the tool notices when a claim *sounds*
  like it needs a source, but it can't confirm whether anything is true. That
  step stays yours.
