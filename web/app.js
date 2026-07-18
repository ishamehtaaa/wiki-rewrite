// Three-stage flow (paste → review → neutral) wired to the real backends:
// /api/detect (wikidetect) scores the verdict, and the two-pass Claude
// pipeline produces the rewrite. Phrase highlighting comes from
// shared/stance.json — display only, never prompt material (rules.js
// explains why the prompts work from a principle, not a list).
import { runPipeline, MODEL } from './lib/pipeline.js';

const escHtml = s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const toHtml = s => escHtml(s).replace(/\n/g, '<br>');
const pct = x => Math.round(x * 100);
const wc = s => (s.match(/[A-Za-z0-9’'\-]+/g) || []).length;

const $ = id => document.getElementById(id);
const els = {
  input: $('input'), analyzeBtn: $('analyzeBtn'), legend: $('legend'),
  stageEdit: $('stageEdit'), stageReview: $('stageReview'), stageClean: $('stageClean'),
  verdictBadge: $('verdictBadge'), verdictLabel: $('verdictLabel'), verdictDesc: $('verdictDesc'),
  verdictFoot: $('verdictFoot'), chips: $('chips'), annotated: $('annotated'),
  editBtn: $('editBtn'), rewriteBtn: $('rewriteBtn'), backBtn: $('backBtn'),
  stripLabel: $('stripLabel'), stripStatus: $('stripStatus'),
  sourceProse: $('sourceProse'), cleanProse: $('cleanProse'), copyBtn: $('copyBtn'),
  sampleBtn: $('sampleBtn'), resetBtn: $('resetBtn'),
};

// Verdict tiers share colors with the detector chips of the old UI; matching
// verdict_for in ml/src/wikidetect/detect.py via the same startsWith test.
const TIER_COLOR = { high: '#c9543e', mid: '#c08a2e', low: '#3f7d54', info: '#4a90d9' };
const PENDING = '#8a8371';

const SAMPLE = 'John Rivera is a world-renowned entrepreneur and the visionary founder of Lumen Dynamics, a groundbreaking technology company based in Austin, Texas. He is widely regarded as one of the most influential figures in the software industry. The company develops a cutting-edge suite of productivity tools used by a growing number of organizations. Notably, its flagship product won several prestigious industry awards in 2024. I genuinely believe his story is truly inspirational. Today, Lumen Dynamics remains a leading player in the productivity market.';

// --- stance scan (annotations + chips), from shared/stance.json ---

const CAT_LABELS = {
  puffery: 'Promotional', editorial: 'Editorializing', slop: 'Stock AI phrasing',
  unsourced: 'Unsupported', drama: 'Dramatic narration', voice: 'First-person',
};

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRegex = terms =>
  new RegExp('\\b(?:' + [...terms].sort((a, b) => b.length - a.length).map(escRe).join('|') + ')\\b', 'gi');

const CATS = await fetch('/shared/stance.json')
  .then(r => r.json())
  .then(j => j.categories.map(c => ({
    key: c.key,
    label: CAT_LABELS[c.key] || c.key,
    re: c.terms
      ? termRegex(c.terms)
      : new RegExp(c.regex, c.flags.includes('g') ? c.flags : c.flags + 'g'),
  })))
  .catch(e => { console.error('stance.json unavailable — highlighting disabled:', e); return []; });

for (const c of CATS) {
  const item = document.createElement('span');
  item.className = 'legend-item';
  item.innerHTML = `<span class="dot cat-${c.key}"></span>${escHtml(c.label)}`;
  els.legend.append(item);
}

// Kept quotations may contain evaluative language (see lib/stance.js); blank
// them to same-length filler so match indices still line up with the text.
const maskQuotes = s => s.replace(/[“"][^“”"]*[”"]/g, m => ' '.repeat(m.length));

function findMatches(text) {
  const masked = maskQuotes(text);
  const all = [];
  for (const cat of CATS) {
    cat.re.lastIndex = 0;
    let m;
    while ((m = cat.re.exec(masked))) {
      all.push({ start: m.index, end: m.index + m[0].length, cat: cat.key });
      if (m.index === cat.re.lastIndex) cat.re.lastIndex++;
    }
  }
  // Longest match wins at each position; overlaps are dropped.
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out = []; let last = -1;
  for (const mt of all) if (mt.start >= last) { out.push(mt); last = mt.end; }
  return out;
}

function annotate(text, matches) {
  let html = '', i = 0;
  for (const m of matches) {
    html += escHtml(text.slice(i, m.start));
    html += `<mark class="mk cat-${m.cat}">${escHtml(text.slice(m.start, m.end))}</mark>`;
    i = m.end;
  }
  return (html + escHtml(text.slice(i))).replace(/\n/g, '<br>');
}

// --- stages ---

const state = { sourceText: '', matches: [], words: 1, annotated: '', final: null };

function setStage(name) {
  els.stageEdit.hidden = name !== 'edit';
  els.stageReview.hidden = name !== 'review';
  els.stageClean.hidden = name !== 'clean';
}

function setVerdict(v) {
  for (const el of [els.stageReview, els.stageClean]) el.style.setProperty('--verdict', v.color);
  els.verdictBadge.textContent = v.badge;
  els.verdictLabel.textContent = v.label;
  els.verdictDesc.textContent = v.desc;
  els.verdictFoot.textContent = v.foot;
  els.verdictFoot.hidden = !v.foot;
  els.stripLabel.textContent = v.label;
  // "anyway" only when nothing points at AI: detector says human-typical
  // (or is unavailable) AND the phrase scan came up empty.
  if (v.tier) els.rewriteBtn.textContent =
    v.tier === 'low' && !state.matches.length ? 'Rewrite anyway →' : 'Rewrite as neutral →';
}

function renderChips() {
  const chips = CATS
    .map(c => ({ ...c, count: state.matches.filter(m => m.cat === c.key).length }))
    .filter(c => c.count > 0);
  els.chips.innerHTML = chips.map(c =>
    `<span class="chip"><span class="dot cat-${c.key}"></span>${escHtml(c.label)}<span class="chip-count">${c.count}</span></span>`
  ).join('');
  els.chips.hidden = !chips.length;
}

const flaggedIn = () =>
  `${state.matches.length} flagged phrase${state.matches.length === 1 ? '' : 's'} in ${state.words} words.`;

function detectorVerdict(r) {
  const tier =
    r.verdict.startsWith('AI-typical') ? 'high' :
    r.verdict === 'human-typical' ? 'low' : 'mid';
  const bench = typeof r.benchmark === 'object'
    ? `AUROC ${r.benchmark.auroc} on ${r.benchmark.samples.ai} AI / ${r.benchmark.samples.human} human Wikipedia samples`
    : r.benchmark;
  const bits = [];
  if (r.atThisLevel) bits.push(`On the benchmark, scores this high caught ${pct(r.atThisLevel.caughtAI)}% of AI text while false-flagging ${pct(r.atThisLevel.falseFlaggedHuman)}% of human text.`);
  bits.push(flaggedIn());
  if (r.shortText) bits.push('Short text — low confidence.');
  return {
    tier,
    color: TIER_COLOR[tier],
    badge: `${pct(r.pAI)}%`,
    label: r.verdict,
    desc: bits.join(' '),
    foot: `p(AI) ${r.pAI} · ${bench}. Not proof of authorship — a triage signal; judge content against sources and history.`,
  };
}

// Used only when no wikidetect server is reachable: verdict from the phrase
// scan alone, at the density tiers the design shipped with.
function heuristicVerdict(errNote) {
  const density = state.matches.length / state.words * 100;
  const level =
    !state.matches.length ? { tier: 'low', label: 'No tells found', desc: 'None of the usual linguistic markers of AI-generated writing were detected. You can still rewrite it in a stricter encyclopaedic register.' } :
    density < 2.5 ? { tier: 'info', label: 'Mostly clean', desc: 'A few flagged phrases, at a rate consistent with ordinary human editing.' } :
    density < 6 ? { tier: 'mid', label: 'Some AI tells', desc: 'A noticeable rate of puffery and filler phrasing typical of AI drafts.' } :
    { tier: 'high', label: 'Strong AI signature', desc: 'A high density of promotional and formulaic phrasing strongly associated with AI drafts.' };
  return {
    tier: level.tier,
    color: TIER_COLOR[level.tier],
    badge: String(state.matches.length),
    label: level.label,
    desc: `${level.desc} ${flaggedIn()}`,
    foot: `ML detector unavailable (${errNote}) — this verdict comes from the phrase scan alone.`,
  };
}

let analyzeId = 0;

async function onAnalyze() {
  const text = els.input.value.trim();
  if (!text) return;
  state.sourceText = text;
  state.matches = findMatches(text);
  state.words = wc(text) || 1;
  state.annotated = annotate(text, state.matches);
  state.final = null;
  renderChips();
  els.annotated.innerHTML = state.annotated;
  els.rewriteBtn.textContent = 'Rewrite as neutral →';
  setVerdict({ color: PENDING, badge: '…', label: 'Scoring…', desc: 'Running the AI detector on this draft.', foot: '' });
  setStage('review');
  const id = ++analyzeId;
  let verdict;
  try {
    const resp = await fetch('/api/detect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const body = await resp.json();
    if (id !== analyzeId) return;
    if (!resp.ok) throw new Error(body.error || 'HTTP ' + resp.status);
    verdict = detectorVerdict(body);
  } catch (e) {
    if (id !== analyzeId) return;
    console.error('Detection failed:', e);
    verdict = heuristicVerdict(e.message);
  }
  setVerdict(verdict);
}

// --- rewrite (stage 3) ---

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

// Thrown from pipeline callbacks to abandon a run superseded by navigation,
// before paying for the second API call.
class Stale extends Error {}

let runId = 0;

const resolvedText = () => state.matches.length
  ? `${state.matches.length} flagged phrase${state.matches.length === 1 ? '' : 's'} resolved`
  : 'rewritten in encyclopaedic register';

async function onRewrite() {
  setStage('clean');
  els.sourceProse.innerHTML = state.annotated;
  els.copyBtn.textContent = 'Copy';
  if (state.final != null) { // cached from an earlier run over the same text
    els.cleanProse.innerHTML = toHtml(state.final);
    els.stripStatus.textContent = resolvedText();
    els.copyBtn.disabled = false;
    return;
  }
  els.cleanProse.innerHTML = '';
  els.copyBtn.disabled = true;
  els.stripStatus.textContent = 'Rewriting…';
  const id = ++runId;
  try {
    const { final, criticRevised } = await runPipeline(state.sourceText, callClaude, {
      onDraftDelta: partial => {
        if (id !== runId) throw new Stale();
        els.cleanProse.innerHTML = toHtml(partial);
      },
      onDraft: draft => {
        if (id !== runId) throw new Stale();
        els.cleanProse.innerHTML = toHtml(draft);
        els.stripStatus.textContent = 'Reviewing…';
      },
    });
    if (id !== runId) return;
    state.final = final;
    els.cleanProse.innerHTML = toHtml(final);
    els.stripStatus.textContent = resolvedText() + (criticRevised ? ' · revised in review' : '');
    els.copyBtn.disabled = false;
  } catch (e) {
    if (e instanceof Stale || id !== runId) return;
    console.error('Rewrite failed:', e);
    els.stripStatus.textContent = 'Rewrite failed — check that the server is running';
  }
}

function onCopy() {
  if (state.final == null) return;
  try { navigator.clipboard && navigator.clipboard.writeText(state.final); } catch {}
  els.copyBtn.textContent = 'Copied ✓';
  clearTimeout(onCopy._t);
  onCopy._t = setTimeout(() => { els.copyBtn.textContent = 'Copy'; }, 1600);
}

// --- navigation ---

els.analyzeBtn.addEventListener('click', onAnalyze);
els.rewriteBtn.addEventListener('click', onRewrite);
els.copyBtn.addEventListener('click', onCopy);
els.backBtn.addEventListener('click', () => { runId++; setStage('review'); });
els.editBtn.addEventListener('click', () => { analyzeId++; runId++; setStage('edit'); els.input.focus(); });
els.resetBtn.addEventListener('click', () => {
  analyzeId++; runId++;
  els.input.value = '';
  Object.assign(state, { sourceText: '', matches: [], words: 1, annotated: '', final: null });
  setStage('edit');
  els.input.focus();
});
els.sampleBtn.addEventListener('click', () => { els.input.value = SAMPLE; onAnalyze(); });
els.input.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onAnalyze(); });
