#!/usr/bin/env node
// AI-text triage for Wikipedia cleanup, backed by the best detector on
// this repo's labeled benchmark (currently desklib/ai-text-detector-v1.01;
// see detector/classify.py to re-run the shoot-out).
//
//   node detector/detect.js suspect.txt
//   pbpaste | node detector/detect.js
//   node detector/detect.js --json suspect.txt
//
// Output is p(AI) plus what that number meant on the benchmark of real
// tagged Wikipedia AI text vs pre-ChatGPT human revisions — measured
// catch/false-flag rates, not invented confidence labels.

import { readFileSync } from 'node:fs';
import { startScorer, loadCalibration, verdictFor } from './scorer.js';

const MODEL = 'desklib';
const MIN_WORDS = 40; // detector output on shorter fragments is noise

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const file = argv.find((a) => !a.startsWith('--'));
const text = (file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8')).trim();
if (!text) {
  console.error('usage: node detector/detect.js [--json] [file]  (or pipe text on stdin)');
  process.exit(1);
}

const calibration = loadCalibration(MODEL);
const scorer = startScorer(MODEL);

const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const paraTexts = paragraphs.length > 1 ? paragraphs : [];
const [docP, ...paraPs] = await Promise.all([text, ...paraTexts].map((t) => scorer.score(t)));
scorer.close();

const doc = verdictFor(docP, calibration);
const shortText = text.split(/\s+/).length < MIN_WORDS;

const result = {
  model: MODEL,
  pAI: docP,
  ...doc,
  shortText,
  benchmark: calibration
    ? { auroc: calibration.auroc, samples: calibration.samples }
    : 'uncalibrated — run: detector/venv/bin/python detector/classify.py --model=desklib',
  paragraphs: paraTexts.map((p, i) => ({
    pAI: paraPs[i],
    unreliable: p.split(/\s+/).length < MIN_WORDS,
    preview: p.length > 80 ? p.slice(0, 77) + '...' : p,
  })),
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`model      : ${MODEL}${calibration ? `  (AUROC ${calibration.auroc} on ${calibration.samples.ai} AI / ${calibration.samples.human} human Wikipedia samples)` : ''}`);
  console.log(`p(AI)      : ${docP}${shortText ? '   ⚠ short text — low confidence' : ''}`);
  console.log(`verdict    : ${doc.verdict}`);
  if (doc.atThisLevel) {
    console.log(`             on the benchmark, scores this high caught ${Math.round(doc.atThisLevel.caughtAI * 100)}% of AI text`);
    console.log(`             while false-flagging ${Math.round(doc.atThisLevel.falseFlaggedHuman * 100)}% of human text`);
  }
  if (result.paragraphs.length) {
    console.log('\nper-paragraph (highest p(AI) first):');
    for (const p of [...result.paragraphs].sort((a, b) => b.pAI - a.pAI)) {
      console.log(`  ${p.pAI.toFixed(3)}${p.unreliable ? '*' : ' '} ${p.preview}`);
    }
    if (result.paragraphs.some((p) => p.unreliable)) {
      console.log(`  (* under ${MIN_WORDS} words — score unreliable)`);
    }
  }
  console.log('\nNote: no detector output is proof of AI authorship. Use this to');
  console.log('prioritize review; judge content against sources and history.');
}
