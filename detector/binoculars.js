#!/usr/bin/env node
// Binoculars detector (Hans et al. 2024, arXiv:2401.12070) — zero-shot
// AI-text detection with a base/instruct model pair, run fully locally
// on the Apple GPU via detector/score.py.
//
//   node detector/binoculars.js suspect.txt
//   pbpaste | node detector/binoculars.js
//   node detector/binoculars.js --json --size=0.5b suspect.txt
//
// LOWER score = more AI-typical. The perplexity/cross-perplexity ratio
// normalizes away "this topic is inherently predictable", the main
// false-positive mode of raw perplexity.
//
// Verdict thresholds come from detector/thresholds.json, generated from
// your labeled samples by `npm run calibrate`. Without it, rough built-in
// defaults are used and flagged as such in the output.

import { readFileSync } from 'node:fs';
import { PAIRS, MIN_TOKENS, MAX_TOKENS, scoreTexts } from './score.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const size = (argv.find((a) => a.startsWith('--size=')) || '--size=1.5b').split('=')[1];
const thresholdArg = argv.find((a) => a.startsWith('--threshold='));
const file = argv.find((a) => !a.startsWith('--'));
if (!PAIRS[size]) {
  console.error(`unknown --size=${size}; options: ${Object.keys(PAIRS).join(', ')}`);
  process.exit(1);
}

// Uncalibrated placeholders — replaced by thresholds.json once you run
// `npm run calibrate` on labeled samples. Do not hand-tune these.
const FALLBACK_THRESHOLDS = {
  '0.5b': { lowFpr: 0.85, accuracy: 0.9 },
  '1.5b': { lowFpr: 0.85, accuracy: 0.9 },
};

let calibrated = null;
try {
  calibrated = JSON.parse(readFileSync(new URL('thresholds.json', import.meta.url), 'utf8'));
} catch {
  // no thresholds.json yet — fall back to built-ins
}
const { lowFpr, accuracy } = calibrated?.[size] ?? FALLBACK_THRESHOLDS[size];
const thresholdSource = calibrated?.[size]
  ? `calibrated on ${calibrated[size].samples.ai} AI / ${calibrated[size].samples.human} human samples`
  : 'UNCALIBRATED defaults — run `npm run calibrate`';

const text = (file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8')).trim();
if (!text) {
  console.error('usage: node detector/binoculars.js [--json] [--size=0.5b|1.5b] [--threshold=N] [file]');
  process.exit(1);
}

// Paragraph scores localize AI passages spliced into human articles.
const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const paraTexts = paragraphs.length > 1 ? paragraphs : [];

const [doc, ...paraScores] = await scoreTexts(size, [text, ...paraTexts]);
if (!doc) {
  console.error('text too short to score');
  process.exit(1);
}

const threshold = thresholdArg ? parseFloat(thresholdArg.split('=')[1]) : null;

function verdictFor(score) {
  if (threshold !== null) return score < threshold ? 'AI-typical' : 'human-typical';
  if (score < lowFpr) return 'AI-typical (below even the conservative threshold)';
  if (score < accuracy) return 'leaning AI — inspect manually';
  return 'human-typical';
}

const perParagraph = paraTexts
  .map((p, i) => ({ text: p, r: paraScores[i] }))
  .filter(({ r }) => r)
  .map(({ text: p, r }) => ({
    score: r.score,
    tokens: r.tokens,
    unreliable: r.tokens < MIN_TOKENS,
    preview: p.length > 80 ? p.slice(0, 77) + '...' : p,
  }));

const result = {
  pair: PAIRS[size],
  tokens: doc.tokens,
  truncated: doc.tokens >= MAX_TOKENS,
  logPerplexity: doc.logPpl,
  crossEntropy: doc.xEntropy,
  binocularsScore: doc.score,
  thresholds: threshold !== null ? { custom: threshold } : { lowFpr, accuracy, source: thresholdSource },
  verdict: verdictFor(doc.score),
  paragraphs: perParagraph,
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`model pair        : ${PAIRS[size].join('  +  ')}`);
  console.log(`tokens scored     : ${doc.tokens}${result.truncated ? ' (truncated to first 512)' : ''}${doc.tokens < MIN_TOKENS ? '  ⚠ short text — low confidence' : ''}`);
  console.log(`binoculars score  : ${doc.score}   (lower = more AI-typical)`);
  console.log(`  = logPPL ${doc.logPpl} / xEntropy ${doc.xEntropy}`);
  console.log(`verdict           : ${result.verdict}`);
  console.log(`thresholds        : <${lowFpr} AI, <${accuracy} leaning AI (${thresholdSource})`);
  if (perParagraph.length) {
    console.log('\nper-paragraph (lowest = most AI-typical):');
    for (const p of [...perParagraph].sort((a, b) => a.score - b.score)) {
      console.log(`  ${p.score.toFixed(3)}${p.unreliable ? '*' : ' '} ${p.preview}`);
    }
    if (perParagraph.some((p) => p.unreliable)) {
      console.log(`  (* fewer than ${MIN_TOKENS} tokens — score unreliable)`);
    }
  }
  console.log('\nNote: no detector output is proof of AI authorship. Use this to');
  console.log('prioritize review; judge content against sources and history.');
}
