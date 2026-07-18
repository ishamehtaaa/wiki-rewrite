import dotenv from 'dotenv';
import express from 'express';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
dotenv.config({ path: here('../.env') }); // secrets live at the repo root

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(here('.'))); // serves index.html from web/
// Read-only view of the Node↔Python contract layer (exemplars, thresholds).
app.use('/artifacts', express.static(here('../artifacts')));
// Stance vocabulary, fetched by the browser for display-only highlighting.
app.use('/shared', express.static(here('../shared')));

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error('\n  Missing ANTHROPIC_API_KEY. Copy .env.example to .env and add your key.\n');
  process.exit(1);
}

app.post('/api/rewrite', async (req, res) => {
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('content-type', ct);
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
    else res.end();
  } catch (e) {
    res.status(502).json({ error: { message: 'Proxy failed: ' + e.message } });
  }
});

const PORT = process.env.PORT || 2000;
app.listen(PORT, () => console.log(`\n  Wiki rewriter running at http://localhost:${PORT}\n`));
