#!/usr/bin/env node
// Overnight triage sweep: score EVERY article in a WikiProject AI Cleanup
// category with the benchmarked detector and write a ranked report.
//
//   npm run sweep -- --category="https://en.wikipedia.org/wiki/Category:Articles_containing_suspected_AI-generated_texts_from_November_2025"
//
//   # keep the Mac awake for an unattended run:
//   caffeinate -i npm run sweep -- --category="Category:..."
//
// Options:
//   --limit=N     stop after N scored articles (default: whole category)
//   --out=path    output basename (default: detector/sweeps/<category-slug>)
//
// Resumable by design: results append to <out>.jsonl as each article
// finishes; rerunning the same command skips everything already scored
// and rewrites the ranked <out>.md report at the end. Wikipedia calls are
// rate-limited (400ms + backoff) and the model loads once for the run.
//
// Scores each article's tag-covered region (whole article or tagged
// section), doc-level plus per-paragraph, so the report both ranks
// articles and points at the worst paragraphs.

import { appendFileSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromUrlOrTitle, categoryMembers, wikitextOf, stripWikitext, extractTagRegion, slug, articleUrl } from './wiki.js';
import { startScorer, loadCalibration, verdictFor } from './scorer.js';

const MODEL = 'desklib';
const MIN_CHARS = 400;      // skip stubs — too little prose to score
const MIN_PARA_WORDS = 25;  // paragraph scores below this are noise
const MAX_PARAS = 10;

const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const arg = argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=').slice(1).join('=') : dflt;
};
const category = opt('category');
const limit = parseInt(opt('limit', '100000'), 10);
if (!category) {
  console.error('usage: node detector/sweep.js --category="Category:... or URL" [--limit=N] [--out=path]');
  process.exit(1);
}

const catTitle = fromUrlOrTitle(category);
const sweepsDir = fileURLToPath(new URL('sweeps/', import.meta.url));
mkdirSync(sweepsDir, { recursive: true });
const outBase = opt('out', `${sweepsDir}${slug(catTitle.replace(/^Category:/i, ''))}`);
const jsonlPath = `${outBase}.jsonl`;
const reportPath = `${outBase}.md`;

// resume: everything already in the jsonl is done
const done = new Map();
if (existsSync(jsonlPath)) {
  for (const line of readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    done.set(r.title, r);
  }
  console.log(`resuming: ${done.size} article(s) already in ${jsonlPath}`);
}

console.log(`listing ${catTitle}...`);
const titles = await categoryMembers(catTitle);
console.log(`${titles.length} member articles\n`);

const calibration = loadCalibration(MODEL);
if (!calibration) console.log('⚠ no calibration for the detector — run: npm run calibrate\n');
const scorer = startScorer(MODEL);

let scored = 0;
let errors = 0;
for (const [idx, title] of titles.entries()) {
  if (scored >= limit) break;
  if (done.has(title)) continue;

  let record = { title, url: articleUrl(title) };
  try {
    const wt = await wikitextOf(title);
    if (!wt || /^\s*#redirect/i.test(wt)) {
      record.skipped = 'missing or redirect';
    } else {
      const [region, wholeArticle] = extractTagRegion(wt, 'ai');
      const text = stripWikitext(region).slice(0, 12000);
      if (text.length < MIN_CHARS) {
        record.skipped = `too little prose (${text.length} chars)`;
      } else {
        const pAI = await scorer.score(text);
        const paras = text.split(/\n\s*\n/).map((p) => p.trim())
          .filter((p) => p.split(/\s+/).length >= MIN_PARA_WORDS)
          .slice(0, MAX_PARAS);
        const paraScores = [];
        for (const p of paras.length > 1 ? paras : []) {
          paraScores.push({
            p: await scorer.score(p),
            preview: p.length > 100 ? p.slice(0, 97) + '...' : p,
          });
        }
        record = {
          ...record,
          pAI,
          verdict: verdictFor(pAI, calibration).verdict,
          region: wholeArticle ? 'whole article' : 'tagged section',
          chars: text.length,
          paragraphs: paraScores.sort((a, b) => b.p - a.p),
        };
        scored++;
      }
    }
  } catch (e) {
    record.error = e.message;
    errors++;
    if (errors > 20) {
      console.error('too many consecutive errors — aborting (rerun to resume)');
      break;
    }
  }
  if (!record.error) errors = 0;
  appendFileSync(jsonlPath, JSON.stringify(record) + '\n');
  done.set(title, record);
  const tag = record.pAI !== undefined ? record.pAI.toFixed(3) : (record.skipped ? 'skip ' : 'ERR  ');
  console.log(`[${idx + 1}/${titles.length}] ${tag}  ${title}`);
}
scorer.close();

// ranked report
const results = [...done.values()].filter((r) => r.pAI !== undefined).sort((a, b) => b.pAI - a.pAI);
const skipped = [...done.values()].filter((r) => r.skipped || r.error);
const buckets = {
  'AI-typical': results.filter((r) => r.verdict === 'AI-typical').length,
  'leaning AI': results.filter((r) => r.verdict?.startsWith('leaning')).length,
  'human-typical': results.filter((r) => r.verdict === 'human-typical').length,
};

const lines = [];
lines.push(`# AI-text sweep: ${catTitle.replace(/^Category:/i, '')}`);
lines.push('');
lines.push(`Detector: ${MODEL}${calibration ? ` (AUROC ${calibration.auroc} on ${calibration.samples.ai} AI / ${calibration.samples.human} human benchmark samples)` : ' (uncalibrated)'}`);
lines.push(`Scored ${results.length} of ${titles.length} articles (${skipped.length} skipped/errored). Verdicts: ${Object.entries(buckets).map(([k, v]) => `${v} ${k}`).join(', ')}.`);
lines.push('');
lines.push('Detector output is triage, not proof — verify against sources and history before acting.');
lines.push('');
lines.push('| p(AI) | verdict | article | worst paragraph |');
lines.push('|---|---|---|---|');
for (const r of results) {
  const worst = r.paragraphs?.[0];
  const cell = worst ? `${worst.p.toFixed(3)} — ${worst.preview.replaceAll('|', '\\|')}` : '';
  lines.push(`| ${r.pAI.toFixed(3)} | ${r.verdict} | [${r.title.replaceAll('|', '\\|')}](${r.url}) | ${cell} |`);
}
if (skipped.length) {
  lines.push('');
  lines.push('## Skipped');
  lines.push('');
  for (const r of skipped) lines.push(`- [${r.title}](${r.url}) — ${r.skipped ?? r.error}`);
}
writeFileSync(reportPath, lines.join('\n') + '\n');

console.log(`\nscored ${results.length}/${titles.length} (${skipped.length} skipped)`);
console.log(`raw results : ${jsonlPath}`);
console.log(`report      : ${reportPath}`);
