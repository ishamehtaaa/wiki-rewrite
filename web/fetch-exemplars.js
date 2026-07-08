#!/usr/bin/env node
// Harvest known-good, HUMAN-written Wikipedia prose into exemplars.js, which
// rules.js embeds in the rewriter prompt as register calibration ("this is
// what passing prose reads like"). The model can't be fine-tuned, so good
// articles enter through the prompt — and like every prompt change, the
// result must be validated with `npm run evals`.
//
//   npm run fetch-exemplars -- "https://en.wikipedia.org/wiki/Caesium" "Thylacine"
//   npm run fetch-exemplars -- --before=2022-06-01 "Caesium"   # pre-ChatGPT revision
//   npm run fetch-exemplars -- --replace "Caesium"             # start over
//
// Or sample at random from Wikipedia's own quality lists until --count
// excerpts pass the filters:
//
//   npm run fetch-exemplars -- --from="https://en.wikipedia.org/wiki/Wikipedia:Featured_articles" --count=3
//   npm run fetch-exemplars -- --from="https://en.wikipedia.org/wiki/Wikipedia:Good_articles" --count=3
//   npm run fetch-exemplars -- --from="Category:Featured articles" --count=3
//
// Takes each article's lead section (the most polished register on the
// page), strips markup, and trims to ~1200 chars. Excerpts containing the
// STANCE vocabulary the evals ban are skipped — an exemplar that models
// stance would teach exactly the wrong thing.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { api, fromUrlOrTitle, categoryMembers, stripWikitext, extractTagRegion, trimToSentence, articleUrl } from '../detector/wiki.js';
import { stanceHits } from './lib/stance.js';

const MAX_CHARS = 1200;
const MIN_CHARS = 300;
const RECOMMENDED_MAX = 4; // beyond this the prompt bloats for no gain

const argv = process.argv.slice(2);
const opt = (name) => {
  const arg = argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=').slice(1).join('=') : null;
};
const before = opt('before');
const from = opt('from');
const count = parseInt(opt('count') ?? '3', 10);
const replace = argv.includes('--replace');
const titles = argv.filter((a) => !a.startsWith('--')).map(fromUrlOrTitle);
if (!titles.length && !from) {
  console.error('usage: node fetch-exemplars.js [--before=YYYY-MM-DD] [--replace] "title or URL" [more...]');
  console.error('       node fetch-exemplars.js --from="Wikipedia:Featured_articles URL or Category:..." [--count=N]');
  process.exit(1);
}

// The curated quality lists map to their tracking categories, which the API
// can enumerate; any Category: title works directly.
function listCategory(s) {
  const t = fromUrlOrTitle(s);
  if (/^Category:/i.test(t)) return t;
  if (/^Wikipedia:Featured articles$/i.test(t)) return 'Category:Featured articles';
  if (/^Wikipedia:Good articles/i.test(t)) return 'Category:Good articles';
  return null;
}

async function leadOf(title) {
  const params = { action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', rvlimit: '1', titles: title };
  if (before) params.rvstart = `${before}T00:00:00Z`;
  const d = await api(params);
  const wt = Object.values(d.query.pages)[0]?.revisions?.[0]?.slots?.main?.['*'];
  if (!wt || /^\s*#redirect/i.test(wt)) return null;
  const [lead] = extractTagRegion(wt, 'human'); // label != 'ai' → the lead
  return stripWikitext(lead);
}

const outPath = fileURLToPath(new URL('exemplars.js', import.meta.url));
const existing = replace ? [] : (await import('./exemplars.js').then((m) => m.EXEMPLARS).catch(() => []));
const entries = [...existing];

// Returns true if the article yielded a usable exemplar.
async function tryAdd(title) {
  const lead = await leadOf(title);
  if (!lead) { console.log(`✗ ${title} — missing page or redirect${before ? ` (before ${before})` : ''}`); return false; }
  const text = trimToSentence(lead, MAX_CHARS, MIN_CHARS);
  if (text.length < MIN_CHARS) { console.log(`✗ ${title} — lead too short (${text.length} chars)`); return false; }
  const hits = stanceHits(text);
  if (hits.length) {
    console.log(`✗ ${title} — skipped: the lead contains stance vocabulary the evals ban, so it would model the wrong register`);
    for (const h of hits) console.log(`    ${h.key}: ${h.hits.join(', ')}`);
    return false;
  }
  const entry = { title, url: articleUrl(title), fetched: before ? `revision before ${before}` : 'latest revision', text };
  const i = entries.findIndex((e) => e.title === title);
  if (i >= 0) entries[i] = entry; else entries.push(entry);
  console.log(`✓ ${title} — ${text.length} chars`);
  return true;
}

for (const title of titles) await tryAdd(title);

if (from) {
  const cat = listCategory(from);
  if (!cat) {
    console.error(`--from must be the Featured/Good articles list URL or a Category: title (got "${from}")`);
    process.exit(1);
  }
  console.log(`sampling ${count} exemplar(s) at random from ${cat}...`);
  const members = await categoryMembers(cat);
  for (let i = members.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [members[i], members[j]] = [members[j], members[i]];
  }
  let added = 0;
  for (const title of members) {
    if (added >= count) break;
    if (entries.some((e) => e.title === title)) continue;
    if (await tryAdd(title)) added++;
  }
}

writeFileSync(outPath, `// Generated by \`npm run fetch-exemplars\` — known-good, human-written
// Wikipedia prose embedded in the rewriter prompt as register calibration
// (see rules.js). Regenerate with the script rather than hand-editing.
// Any change here changes the prompt — validate with \`npm run evals\`.

export const EXEMPLARS = ${JSON.stringify(entries, null, 2)};
`);

console.log(`\n${entries.length} exemplar(s) in exemplars.js`);
if (entries.length > RECOMMENDED_MAX) {
  console.log(`⚠ more than ${RECOMMENDED_MAX} exemplars mostly pads the prompt — keep the few whose register you most want`);
}
console.log('Now validate the prompt change: npm run evals');
