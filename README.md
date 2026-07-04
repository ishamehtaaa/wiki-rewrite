# Neutralizer

A small local tool for cleaning up AI-generated, non-encyclopedic prose for
Wikipedia editing. Paste a draft and it:

- flags Manual-of-Style problems by category — promotional language,
  editorializing, AI-stock phrasing, unsupported claims, and non-neutral voice
- streams a consolidated neutral rewrite from Claude Sonnet: repeated ideas
  are merged, filler sentences are deleted, and puffery is stripped, so the
  output is typically half to two-thirds the length of the input

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

## Notes

- `.env` and `node_modules/` are gitignored — safe to put this folder in a repo.
- The rewrite requires the server and an API key — there is no offline mode.
  Without them the app still flags issues, but the "Neutral version" pane
  shows an error instead of a rewrite.
- Cost is a fraction of a cent per rewrite (a few hundred tokens on Sonnet).
- This is built for local use. If you ever expose it beyond localhost, add auth —
  the proxy will happily spend your key for anyone who can reach it.
- The tool can't confirm whether any claim is true; checking flagged claims
  against sources stays your job.
