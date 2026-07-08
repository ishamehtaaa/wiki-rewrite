#!/usr/bin/env node
// Derive Binoculars verdict thresholds from labeled samples.
//
//   npm run calibrate                 # score samples, write thresholds.json
//   npm run calibrate -- --dry-run    # report only, don't write
//   npm run calibrate -- --size=1.5b
//
// Drop known-AI text into detector/samples/ai/*.txt and known-human text
// into detector/samples/human/*.txt, then rerun. Scores are cached by
// content hash in detector/.scores-cache.json, so only new or changed
// files cost model time (~15–20s each).
//
// When the detector gets a verdict wrong in real use, the fix is to add
// that text to the right folder and recalibrate — never to hand-tweak
// thresholds.json.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PAIRS, MIN_TOKENS, scoreTexts } from './score.js';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const size = (argv.find((a) => a.startsWith('--size=')) || '--size=1.5b').split('=')[1];
if (!PAIRS[size]) {
  console.error(`unknown --size=${size}; options: ${Object.keys(PAIRS).join(', ')}`);
  process.exit(1);
}

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const CACHE_PATH = here('.scores-cache.json');
const THRESHOLDS_PATH = here('thresholds.json');

function loadSamples(label) {
  const dir = here(`samples/${label}/`);
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.txt'));
  } catch {
    files = [];
  }
  return files.map((f) => {
    const text = readFileSync(dir + f, 'utf8').trim();
    return { file: `${label}/${f}`, label, text, hash: createHash('sha256').update(text).digest('hex').slice(0, 16) };
  });
}

const samples = [...loadSamples('ai'), ...loadSamples('human')];
const nAi = samples.filter((s) => s.label === 'ai').length;
const nHuman = samples.length - nAi;
if (nAi < 2 || nHuman < 2) {
  console.error(`Need at least 2 samples per class; found ${nAi} in detector/samples/ai/, ${nHuman} in detector/samples/human/.`);
  console.error('Add known-AI text to samples/ai/*.txt and known-human text to samples/human/*.txt.');
  process.exit(1);
}

let cache = {};
try { cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8')); } catch { /* first run */ }
cache[size] ??= {};

const toScore = samples.filter((s) => !cache[size][s.hash]);
if (toScore.length) {
  console.log(`scoring ${toScore.length} new sample(s) with the ${size} pair (${samples.length - toScore.length} cached)...`);
  await scoreTexts(size, toScore.map((s) => s.text), (i, r) => {
    const s = toScore[i];
    if (!r) {
      console.error(`  skipping ${s.file}: too short to score`);
      return;
    }
    cache[size][s.hash] = { score: r.score, tokens: r.tokens, file: s.file };
    console.log(`  ${r.score.toFixed(4)}  ${s.file}${r.tokens < MIN_TOKENS ? '  ⚠ under ' + MIN_TOKENS + ' tokens' : ''}`);
  });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

const scored = samples
  .map((s) => ({ ...s, ...cache[size][s.hash] }))
  .filter((s) => s.score !== undefined);

// Best threshold by BALANCED accuracy (mean of per-class rates, so an
// imbalanced sample set can't buy accuracy by favoring the bigger class);
// ties broken by widest gap between adjacent scores.
function bestThreshold(rows) {
  const ai = rows.filter((r) => r.label === 'ai');
  const human = rows.filter((r) => r.label === 'human');
  const sorted = [...rows].sort((a, b) => a.score - b.score);
  let best = { t: 0, balanced: -1, gap: 0 };
  for (let i = 0; i < sorted.length - 1; i++) {
    const t = (sorted[i].score + sorted[i + 1].score) / 2;
    const gap = sorted[i + 1].score - sorted[i].score;
    const balanced = (ai.filter((r) => r.score < t).length / ai.length +
                      human.filter((r) => r.score >= t).length / human.length) / 2;
    if (balanced > best.balanced || (balanced === best.balanced && gap > best.gap)) {
      best = { t, balanced, gap };
    }
  }
  return best;
}

const { t: accuracy, balanced } = bestThreshold(scored);
const misses = scored.filter((r) => (r.label === 'ai') !== (r.score < accuracy));

// Conservative threshold: highest value with zero human samples below it,
// never above the accuracy threshold. With clean separation this sits a
// quarter of the way into the gap; with overlap it hugs the lowest human.
const minHuman = Math.min(...scored.filter((r) => r.label === 'human').map((r) => r.score));
const maxAiBelow = Math.max(...scored.filter((r) => r.label === 'ai' && r.score < minHuman).map((r) => r.score), 0);
const lowFpr = Math.min(maxAiBelow + (minHuman - maxAiBelow) * 0.25, accuracy);

// Leave-one-out: how well does a threshold fit on n-1 samples classify
// the held-out one? Honest small-sample estimate of real accuracy.
let looCorrect = 0;
for (const held of scored) {
  const { t } = bestThreshold(scored.filter((r) => r !== held));
  if ((held.label === 'ai') === (held.score < t)) looCorrect++;
}

console.log(`\n${'score'.padStart(8)}  sample`);
for (const r of [...scored].sort((a, b) => a.score - b.score)) {
  const flag = (r.label === 'ai') !== (r.score < accuracy) ? '  ✗ MISCLASSIFIED' : '';
  console.log(`${r.score.toFixed(4).padStart(8)}  ${r.file}${r.tokens < MIN_TOKENS ? ' ⚠short' : ''}${flag}`);
}
console.log(`\nthresholds (${size}): lowFpr=${lowFpr.toFixed(3)}  accuracy=${accuracy.toFixed(3)}`);
console.log(`fit: balanced accuracy ${(balanced * 100).toFixed(1)}% at accuracy threshold; leave-one-out ${looCorrect}/${scored.length}`);
if (misses.length) {
  console.log('\nmisclassified even at the best threshold — the classes overlap here.');
  console.log('More samples of the confusable kind will sharpen the boundary:');
  for (const m of misses) console.log(`  ${m.file} (${m.label}, ${m.score.toFixed(4)})`);
}

if (dryRun) {
  console.log('\n--dry-run: thresholds.json not written');
} else {
  let out = {};
  try { out = JSON.parse(readFileSync(THRESHOLDS_PATH, 'utf8')); } catch { /* first run */ }
  out[size] = {
    lowFpr: +lowFpr.toFixed(4),
    accuracy: +accuracy.toFixed(4),
    samples: { ai: scored.filter((r) => r.label === 'ai').length, human: scored.filter((r) => r.label === 'human').length },
    leaveOneOutAccuracy: +(looCorrect / scored.length).toFixed(3),
  };
  writeFileSync(THRESHOLDS_PATH, JSON.stringify(out, null, 2));
  console.log(`\nwrote detector/thresholds.json — npm run detect now uses these`);
}
