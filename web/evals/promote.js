// Promote a sweep finding into an eval-case skeleton — the triage step of
// the learning loop. The mechanical 90% (text, provenance, defaults) is
// filled in; the judgment 10% (mustKeep facts, what failure mode the case
// pins) is yours.
//
//   npm run promote -- --sweep=../artifacts/sweeps/<slug>.jsonl --title="Article Title"
//   npm run promote -- --sweep=... --title="..." --paragraphs=1,2   # worst paragraphs only
//
// Then: fill in mustKeep/notes in the new case file and run
//   npm run evals -- <case-name>
// If it passes, commit it as a regression guard. If it fails, it has
// exposed a prompt weakness: fix rules.js by principle (or grow
// shared/stance.json — that tightens the assertions, never the prompt),
// get the full suite green, and commit the case and the fix together.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = name => {
  const arg = argv.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=').slice(1).join('=') : null;
};
const sweepPath = opt('sweep');
const title = opt('title');
const paragraphs = opt('paragraphs');

if (!sweepPath || !title) {
  console.error('usage: npm run promote -- --sweep=path/to/sweep.jsonl --title="Article Title" [--paragraphs=0,2]');
  process.exit(1);
}

const record = readFileSync(sweepPath, 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l))
  .find(r => r.title === title);
if (!record) {
  console.error(`no record for "${title}" in ${sweepPath}`);
  process.exit(1);
}
if (record.pAI === undefined) {
  console.error(`"${title}" was not scored (${record.skipped ?? record.error})`);
  process.exit(1);
}

let input = record.text;
if (paragraphs) {
  const idx = paragraphs.split(',').map(Number);
  input = idx.map(i => record.paragraphs[i]?.text).filter(Boolean).join('\n\n');
  if (!input) {
    console.error(`--paragraphs=${paragraphs} selected nothing (record has ${record.paragraphs.length})`);
    process.exit(1);
  }
}
if (!input) {
  console.error('record has no full text — re-sweep with the current wikidetect (old sweeps stored previews only)');
  process.exit(1);
}

const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const casePath = fileURLToPath(new URL(`cases/${slug}.json`, import.meta.url));
if (existsSync(casePath)) {
  console.error(`${casePath} already exists`);
  process.exit(1);
}

writeFileSync(casePath, JSON.stringify({
  name: `${slug} (TODO: name the failure mode)`,
  notes: 'TODO — what failure mode does this case pin?',
  source: {
    url: record.url,
    revid: record.revid ?? null,
    sweep: sweepPath.split('/').pop(),
    pAI: record.pAI,
    promoted: new Date().toISOString().slice(0, 10),
  },
  maxRatio: 0.7,
  mustKeep: ['TODO — facts that must survive the rewrite'],
  maxPAI: 0.5,
  input,
}, null, 2) + '\n');

console.log(`wrote ${casePath}`);
console.log(`  p(AI) ${record.pAI}  (${record.verdict}, ${record.region})`);
console.log('\nnext:');
console.log('  1. fill in mustKeep and notes (and name), trim input if needed');
console.log(`  2. npm run evals -- ${slug}`);
console.log('  3. passes → commit as regression guard; fails → fix rules.js by principle, full suite green, commit together');
