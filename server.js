import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static('.')); // serves index.html from this folder

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
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: { message: 'Proxy failed: ' + e.message } });
  }
});

const PORT = process.env.PORT || 2000;
app.listen(PORT, () => console.log(`\n  Wiki rewriter running at http://localhost:${PORT}\n`));
