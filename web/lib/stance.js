// Compiles shared/stance.json into the STANCE categories the eval harness
// and exemplar harvester assert with. Node-only (reads from disk) — the
// browser fetches shared/stance.json itself (app.js) for display-only
// highlighting; the vocabulary is never prompt material (see rules.js for why).
//
// To tighten what the evals catch, edit shared/stance.json — that file is
// the single source of the vocabulary for both the Node and Python sides.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const raw = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../shared/stance.json', import.meta.url)), 'utf8')
);

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRegex = (terms, flags = 'gi') =>
  new RegExp('\\b(?:' + [...terms].sort((a, b) => b.length - a.length).map(escRe).join('|') + ')\\b', flags);

export const STANCE = raw.categories.map(cat =>
  cat.terms
    ? { key: cat.key, terms: cat.terms, re: termRegex(cat.terms) }
    : { key: cat.key, re: new RegExp(cat.regex, cat.flags) }
);

// Kept quotations are allowed to contain evaluative language; blank them out
// before checking for stance so only the article's own voice is asserted.
export const withoutQuotes = s => s.replace(/[“"][^“”"]*[”"]/g, '“…”');

// All stance matches in `text` (quotes blanked), as [{key, hits}].
export function stanceHits(text) {
  const prose = withoutQuotes(text);
  const found = [];
  for (const cat of STANCE) {
    const m = prose.match(new RegExp(cat.re.source, cat.re.flags));
    if (m) found.push({ key: cat.key, hits: [...new Set(m)] });
  }
  return found;
}
