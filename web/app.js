import { runPipeline, MODEL } from './lib/pipeline.js';

const escHtml = s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const toHtml = s => escHtml(s).replace(/\n/g, '<br>');

// --- DOM wiring ---
const $ = id => document.getElementById(id);
const inputEl = $('input'), cleanEl = $('clean'), outputEmpty = $('outputEmpty'),
      statusEl = $('status'), cleanBtn = $('cleanBtn');

let runId = 0;

function showOutput(html) {
  cleanEl.hidden = false;
  outputEmpty.hidden = true;
  cleanEl.innerHTML = html;
}

// Stream one Claude call through the proxy; returns the full text.
async function callClaude(system, userText, onDelta) {
  const resp = await fetch('/api/rewrite', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      stream: true,
      system,
      messages: [{ role: 'user', content: userText }]
    })
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' — ' + (await resp.text()).slice(0, 200));
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', acc = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let evt; try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
        acc += evt.delta.text;
        if (onDelta) onDelta(acc);
      } else if (evt.type === 'error') {
        throw new Error((evt.error && evt.error.message) || 'stream error');
      }
    }
  }
  return acc;
}

// Thrown from pipeline callbacks to abandon a run superseded by reset or a
// newer run, before paying for the second API call.
class Stale extends Error {}

async function onClean() {
  const text = inputEl.value.trim();
  if (!text) return;
  const id = ++runId;
  cleanBtn.disabled = true;
  showOutput('');
  statusEl.textContent = 'Rewriting…';
  try {
    // The draft stays on screen while the review runs; it is swapped only
    // if the critic corrects it.
    const { final, criticRevised } = await runPipeline(text, callClaude, {
      onDraftDelta: partial => {
        if (id !== runId) throw new Stale();
        showOutput(toHtml(partial));
      },
      onDraft: draft => {
        if (id !== runId) throw new Stale();
        showOutput(toHtml(draft));
        statusEl.textContent = 'Reviewing…';
      },
    });
    if (id !== runId) return;
    showOutput(toHtml(final));
    statusEl.textContent = criticRevised ? 'revised in review' : '';
  } catch (e) {
    if (e instanceof Stale || id !== runId) return;
    console.error('Rewrite failed:', e);
    statusEl.textContent = 'Rewrite failed — check that the server is running';
  } finally {
    if (id === runId) cleanBtn.disabled = false;
  }
}

cleanBtn.addEventListener('click', onClean);
$('resetBtn').addEventListener('click', () => {
  runId++;
  inputEl.value = '';
  cleanEl.hidden = true;
  cleanEl.innerHTML = '';
  outputEmpty.hidden = false;
  cleanBtn.disabled = false;
  statusEl.textContent = '';
});
inputEl.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onClean(); });
