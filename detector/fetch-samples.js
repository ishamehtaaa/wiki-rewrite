#!/usr/bin/env node
// Harvest labeled calibration samples from Wikipedia into detector/samples/.
//
//   # known-AI: articles tagged {{AI-generated}} (WikiProject AI Cleanup)
//   node detector/fetch-samples.js --label=ai --limit=25 \
//     --category="https://en.wikipedia.org/wiki/Category:Articles_containing_suspected_AI-generated_texts_from_December_2025"
//
//   # known-human: pre-ChatGPT revisions (anything --before Nov 2022 is safe)
//   node detector/fetch-samples.js --label=human --limit=25 --before=2022-06-01 \
//     --category="Category:Featured articles"
//
//   # or explicit articles instead of a category
//   node detector/fetch-samples.js --label=human --before=2022-06-01 \
//     --titles="Ashford, Kent|Folkestone|Maidstone"
//
// For --label=ai the script samples the region the {{AI-generated}} tag
// covers (tagged section, or whole article for a top-of-page tag) and
// skips whole-article samples from pre-ChatGPT pages — their authorship
// is mixed and would mislabel human prose as AI.
//
// Files land in detector/samples/<label>/<title>.txt; existing files are
// never overwritten, so rerunning only adds. Then: npm run calibrate
//
// Category labels are editor judgments ("suspected"), so expect some
// noise — check calibration outliers by hand before trusting them.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromUrlOrTitle, categoryMembers, wikitextOf, stripWikitext, extractTagRegion, createdInAiEra, trimToSentence, slug } from './wiki.js';

const MIN_CHARS = 500;  // skip stubs — too short to score reliably
const MAX_CHARS = 3000; // ~768 tokens is all the detector reads anyway

const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const arg = argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=').slice(1).join('=') : dflt;
};
const label = opt('label');
const limit = parseInt(opt('limit', '25'), 10);
const before = opt('before'); // YYYY-MM-DD; use the last revision before this date
let category = opt('category');
const titlesArg = opt('titles');

if (!['ai', 'human'].includes(label) || (!category && !titlesArg)) {
  console.error('usage: node detector/fetch-samples.js --label=ai|human (--category="..." | --titles="A|B|C") [--limit=N] [--before=YYYY-MM-DD]');
  process.exit(1);
}

const outDir = fileURLToPath(new URL(`samples/${label}/`, import.meta.url));
mkdirSync(outDir, { recursive: true });

let titles;
if (titlesArg) {
  titles = titlesArg.split('|').map(fromUrlOrTitle);
} else {
  category = fromUrlOrTitle(category);
  console.log(`listing ${category}...`);
  titles = await categoryMembers(category);
  console.log(`${titles.length} member articles`);
  // random sample, not first-N: category order is alphabetical, which biases
  for (let i = titles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [titles[i], titles[j]] = [titles[j], titles[i]];
  }
}

let written = 0;
for (const title of titles) {
  if (written >= limit) break;
  const path = `${outDir}${slug(title)}.txt`;
  if (existsSync(path)) { console.log(`  = ${title} (already have it)`); continue; }
  let wt;
  try {
    wt = await wikitextOf(title, before);
  } catch (e) {
    console.log(`  ! ${title}: ${e.message}`);
    continue;
  }
  if (!wt) { console.log(`  - ${title}: no revision${before ? ` before ${before}` : ''}`); continue; }
  if (/^\s*#redirect/i.test(wt)) { console.log(`  - ${title}: redirect`); continue; }
  const [region, wholeArticle] = extractTagRegion(wt, label);
  if (label === 'ai' && wholeArticle && !(await createdInAiEra(title))) {
    console.log(`  - ${title}: pre-ChatGPT article with top tag — mixed authorship, skipped`);
    continue;
  }
  const text = trimToSentence(stripWikitext(region), MAX_CHARS, MIN_CHARS);
  if (text.length < MIN_CHARS || /may refer to:/.test(text)) {
    console.log(`  - ${title}: too little prose (${text.length} chars)`);
    continue;
  }
  writeFileSync(path, text + '\n');
  written++;
  console.log(`  + ${title} (${text.length} chars)`);
}
console.log(`\nwrote ${written} sample(s) to detector/samples/${label}/ — next: npm run calibrate`);
