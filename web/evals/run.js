// Runs every case in cases/*.json through the same two-pass pipeline the app
// uses (lib/pipeline.js) and asserts the output. Usage:
//   npm run evals                # all cases
//   npm run evals -- drama       # only cases whose name matches "drama"
//   npm run evals -- --failed    # only cases that failed the previous run
//   npm run evals -- --fresh     # ignore cached pipeline outputs
//   npm run evals -- --verbose   # print outputs for passing cases too
//   npm run evals -- --detector  # require the wikidetect server for the p(AI) gate
//
// Detector gate: when a `wikidetect serve` instance is up (auto-probed),
// every case's final output is scored and compared to its maxPAI (default
// 0.5) — the rewriter's output should not read as AI to the very detector
// that finds cleanup candidates. Currently a WARNING, not a failure: the
// detector is calibrated on article leads, not condensed rewrites.
//
// Pipeline outputs are cached in .cache.json keyed by a hash of the model,
// both prompts, and the case input — so re-running after tightening an
// assertion (stance vocab, mustKeep, caps) costs zero API calls, while any
// prompt or exemplar change invalidates automatically.
//
// Needs ANTHROPIC_API_KEY in .env. Exits non-zero on any failure.
import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });
import { SYS, CRITIC_SYS } from '../rules.js';
import { runPipeline, MODEL } from '../lib/pipeline.js';
import { stanceHits } from '../lib/stance.js';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const CACHE_PATH = here('.cache.json');
const LAST_RUN_PATH = here('.last-run.json');
const CONCURRENCY = 4;

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const filter = argv.find(a => !a.startsWith('--'));

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error('Missing ANTHROPIC_API_KEY — copy .env.example to .env and add your key.');
  process.exit(1);
}

async function callClaude(system, user) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

// --- cases ---------------------------------------------------------------
const cases = readdirSync(here('cases'))
  .filter(f => f.endsWith('.json'))
  .sort()
  .map(f => ({ file: f, ...JSON.parse(readFileSync(here('cases/' + f), 'utf8')) }));

// --- pipeline-output cache ------------------------------------------------
const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
};
const cache = flags.has('--fresh') ? {} : readJson(CACHE_PATH, {});
const cacheKey = input =>
  createHash('sha256').update([MODEL, SYS, CRITIC_SYS, input].join('\x00')).digest('hex').slice(0, 16);

async function pipelineOutput(input) {
  const key = cacheKey(input);
  if (cache[key]) return { ...cache[key], cached: true };
  const { final, criticRevised } = await runPipeline(input, callClaude);
  cache[key] = { final, criticRevised };
  return { final, criticRevised, cached: false };
}

// --- assertions ------------------------------------------------------------
function checkCase(c, out) {
  const problems = [];
  for (const { key, hits } of stanceHits(out)) {
    problems.push(`stance survived (${key}): ${hits.join(', ')}`);
  }
  const cap = c.maxRatio ?? 0.7;
  const ratio = out.length / c.input.length;
  if (ratio > cap) problems.push(`too long: ${Math.round(ratio * 100)}% of input (cap ${Math.round(cap * 100)}%)`);
  for (const t of c.mustKeep ?? []) {
    if (!out.includes(t)) problems.push(`lost fact: "${t}"`);
  }
  if (c.atMostOf) {
    const found = c.atMostOf.terms.filter(t => out.includes(t));
    if (found.length > c.atMostOf.max) {
      problems.push(`kept ${found.length} ${c.atMostOf.label} (max ${c.atMostOf.max}): ${found.join(', ')}`);
    }
  }
  if (/(^|\n)#|\*\*|\n- /.test(out)) problems.push('markdown formatting in output');
  return problems;
}

// --- selection --------------------------------------------------------------
let selected = filter ? cases.filter(c => c.name.includes(filter)) : cases;
if (flags.has('--failed')) {
  const last = new Set(readJson(LAST_RUN_PATH, { failed: [] }).failed);
  selected = selected.filter(c => last.has(c.name));
  if (!selected.length) {
    console.log('No failures recorded from the previous run.');
    process.exit(0);
  }
}
if (!selected.length) {
  console.error(`No cases match "${filter}".`);
  process.exit(1);
}

// --- run (bounded concurrency) ----------------------------------------------
console.log(`Running ${selected.length} case(s) through the two-pass pipeline…\n`);
const queue = [...selected];
const results = [];
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
  for (let c; (c = queue.shift()); ) {
    try {
      const { final, criticRevised, cached } = await pipelineOutput(c.input);
      results.push({ c, final, criticRevised, cached, problems: checkCase(c, final) });
    } catch (e) {
      results.push({ c, final: null, criticRevised: false, cached: false, problems: ['pipeline error: ' + e.message] });
    }
  }
}));
results.sort((a, b) => a.c.name.localeCompare(b.c.name));

// --- detector gate (warning-first) -------------------------------------------
const DETECTOR_URL = process.env.WIKIDETECT_URL ?? 'http://127.0.0.1:8756';
async function detectorScores() {
  try {
    await fetch(`${DETECTOR_URL}/health`, { signal: AbortSignal.timeout(500) });
  } catch {
    if (flags.has('--detector')) {
      console.error(`--detector: no wikidetect server at ${DETECTOR_URL} — start one with: cd ml && uv run wikidetect serve`);
      process.exit(1);
    }
    return null;
  }
  const scored = results.filter(r => r.final);
  const resp = await fetch(`${DETECTOR_URL}/score`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ texts: scored.map(r => r.final) })
  });
  if (!resp.ok) return null;
  const { scores } = await resp.json();
  scored.forEach((r, i) => { r.pAI = scores[i]; });
  return true;
}
const detectorOn = await detectorScores();

let failed = 0, warned = 0;
for (const r of results) {
  const ok = r.problems.length === 0;
  if (!ok) failed++;
  const tags = [r.criticRevised && 'critic revised', r.cached && 'cached'].filter(Boolean);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.c.name}${tags.length ? '  (' + tags.join(', ') + ')' : ''}`);
  for (const p of r.problems) console.log(`      - ${p}`);
  if (r.pAI !== undefined && r.pAI > (r.c.maxPAI ?? 0.5)) {
    warned++;
    console.log(`      ⚠ detector: output p(AI) ${r.pAI} exceeds maxPAI ${r.c.maxPAI ?? 0.5} (warning, not a failure)`);
  }
  if ((!ok || flags.has('--verbose')) && r.final) {
    console.log(r.final.split('\n').map(l => '      | ' + l).join('\n'));
  }
}

writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
writeFileSync(LAST_RUN_PATH, JSON.stringify({
  failed: results.filter(r => r.problems.length).map(r => r.c.name)
}, null, 2));

console.log(`\n${results.length - failed}/${results.length} passed`
  + (detectorOn ? `, detector gate: ${warned ? `${warned} warning(s)` : 'clean'}` : ''));
process.exit(failed ? 1 : 0);
