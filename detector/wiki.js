// Shared Wikipedia API + wikitext helpers for the detector tools
// (fetch-samples.js, sweep.js).

const API = 'https://en.wikipedia.org/w/api.php';
const HEADERS = { 'User-Agent': 'wiki-rewrite-detector/1.0 (local cleanup triage; contact: local use only)' };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', redirects: '1', ...params })}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: HEADERS });
    if (res.status === 429 && attempt < 4) {
      const wait = 5000 * (attempt + 1);
      console.log(`  ... rate limited, waiting ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} from ${url}`);
    await sleep(400); // be polite
    return res.json();
  }
}

export function fromUrlOrTitle(s) {
  const m = s.match(/\/wiki\/([^#?]+)/);
  return decodeURIComponent(m ? m[1] : s).replace(/_/g, ' ');
}

export async function categoryMembers(cat) {
  const members = [];
  let cont = {};
  do {
    const d = await api({ action: 'query', list: 'categorymembers', cmtitle: cat, cmnamespace: '0', cmlimit: '500', ...cont });
    members.push(...d.query.categorymembers.map((m) => m.title));
    cont = d.continue ?? null;
  } while (cont && members.length < 5000);
  return members;
}

// Latest wikitext, or the newest revision strictly before `before` (YYYY-MM-DD).
export async function wikitextOf(title, before = null) {
  const params = { action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', rvlimit: '1', titles: title };
  if (before) params.rvstart = `${before}T00:00:00Z`;
  const d = await api(params);
  const page = Object.values(d.query.pages)[0];
  return page?.revisions?.[0]?.slots?.main?.['*'] ?? null;
}

export function stripWikitext(wt) {
  let t = wt;
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/<ref[^>/]*\/>/gi, '');
  t = t.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  t = t.replace(/\{\|[\s\S]*?\|\}/g, '');
  // Render measurement templates as "value unit" before the generic strip
  // deletes them, so prose isn't left with holes ("a melting point of ,").
  t = t.replace(/\{\{\s*(?:convert|cvt)\s*\|([^|{}]+)\|([^|{}]+)(?:\|[^{}]*)?\}\}/gi, '$1 $2');
  for (let i = 0; i < 6; i++) t = t.replace(/\{\{[^{}]*\}\}/g, '');
  t = t.replace(/\[\[(?:File|Image):[^[\]]*(?:\[\[[^\]]*\]\][^[\]]*)*\]\]/gi, '');
  t = t.replace(/\[\[Category:[^\]]*\]\]/gi, '');
  t = t.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1');
  t = t.replace(/\[https?:[^\s\]]*\s?([^\]]*)\]/g, '$1');
  t = t.replace(/'{2,}/g, '');
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/^=+[^=\n]+=+ *$/gm, ''); // section headings are not prose
  t = t.replace(/^[*#:;]+\s*/gm, '');
  t = t.replace(/[ \t]+/g, ' ');
  // Husks left by stripped pronunciation/lang templates: drop parentheses
  // holding only connectives ("( , or , also )"), trim orphaned separators
  // after an opening paren ("( ; Hawaiian:" → "(Hawaiian:"), fix spacing.
  t = t.replace(/\(\s*(?:[,;.]|\bor\b|\balso\b|\s)*\)/g, '');
  t = t.replace(/\(\s*[,;.]\s*/g, '(');
  t = t.replace(/ +([,.;:)])/g, '$1');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

export const AI_TAG = /\{\{\s*AI[ -]?generated\b/i;

// Everything before the terminal link/citation sections — the prose an
// article-top tag covers.
export const stripTerminalSections = (wt) =>
  wt.replace(/\n== *(References|External links|See also|Further reading|Notes|Sources|Bibliography|Citations) *==[\s\S]*$/i, '');

// The region an {{AI-generated}} tag covers: the tagged section, or the
// ENTIRE article (minus terminal link/citation sections) for a top-of-page
// tag. Falls back to whole-article when no tag is present. For label=human
// harvesting, the lead. Returns [wikitextRegion, isWholeArticle].
export function extractTagRegion(wt, label) {
  const firstHeading = wt.search(/\n==[^=]/);
  const tag = wt.match(AI_TAG);
  if (label === 'ai' && tag && firstHeading !== -1 && tag.index > firstHeading) {
    const close = wt.indexOf('}}', tag.index);
    const start = close === -1 ? tag.index : close + 2;
    const next = wt.slice(start).search(/\n==[^=]/);
    return [wt.slice(start, next === -1 ? undefined : start + next), false];
  }
  if (label === 'ai') {
    return [stripTerminalSections(wt), true];
  }
  return [firstHeading === -1 ? wt : wt.slice(0, firstHeading), false];
}

// Label hygiene: a top-of-page tag on an article that predates ChatGPT
// usually means AI text was ADDED to a human article.
const CHATGPT_ERA = '2022-11-30T00:00:00Z';
export async function createdInAiEra(title) {
  const d = await api({ action: 'query', prop: 'revisions', rvprop: 'timestamp', rvdir: 'newer', rvlimit: '1', titles: title });
  const ts = Object.values(d.query.pages)[0]?.revisions?.[0]?.timestamp;
  return ts && ts >= CHATGPT_ERA;
}

export function trimToSentence(t, maxChars, minChars = 500) {
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('."'));
  return end > minChars ? cut.slice(0, end + 1) : cut;
}

export const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export const articleUrl = (title) => `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
