// Runs every case in cases.js through the same two-pass pipeline the app
// uses (rewrite, then critic review) and asserts the output. Usage:
//   npm run evals            # all cases
//   npm run evals -- drama   # only cases whose name matches "drama"
// Needs ANTHROPIC_API_KEY in .env. Exits non-zero on any failure.
import 'dotenv/config';
import { STANCE, SYS, CRITIC_SYS } from '../rules.js';
import { cases } from './cases.js';

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
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

// Mirrors onClean() in app.js.
async function rewritePipeline(text) {
  const draft = await callClaude(SYS, 'Text:\n' + text);
  const review = await callClaude(CRITIC_SYS, 'Original:\n' + text + '\n\nRewrite:\n' + draft);
  const passed = /^PASS\b/.test(review) && review.length < 10;
  return { final: passed ? draft : review, criticRevised: !passed };
}

// Kept quotations are allowed to contain evaluative language; blank them out
// before checking for stance so only the article's own voice is asserted.
const withoutQuotes = s => s.replace(/[“"][^“”"]*[”"]/g, '“…”');

function checkCase(c, out) {
  const problems = [];
  const prose = withoutQuotes(out);
  for (const cat of STANCE) {
    const re = new RegExp(cat.re.source, cat.re.flags);
    const hits = prose.match(re);
    if (hits) problems.push(`stance survived (${cat.key}): ${[...new Set(hits)].join(', ')}`);
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

const filter = process.argv[2];
const selected = filter ? cases.filter(c => c.name.includes(filter)) : cases;
if (!selected.length) {
  console.error(`No cases match "${filter}".`);
  process.exit(1);
}

console.log(`Running ${selected.length} case(s) through the two-pass pipeline…\n`);
const results = await Promise.all(selected.map(async c => {
  try {
    const { final, criticRevised } = await rewritePipeline(c.input);
    return { c, final, criticRevised, problems: checkCase(c, final) };
  } catch (e) {
    return { c, final: null, criticRevised: false, problems: ['pipeline error: ' + e.message] };
  }
}));

let failed = 0;
for (const r of results) {
  const ok = r.problems.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.c.name}${r.criticRevised ? '  (critic revised)' : ''}`);
  for (const p of r.problems) console.log(`      - ${p}`);
  if ((!ok || process.argv.includes('--verbose')) && r.final) {
    console.log(r.final.split('\n').map(l => '      | ' + l).join('\n'));
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
