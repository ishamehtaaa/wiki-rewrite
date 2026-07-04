// Each category lists `strip` terms (phrase removed inline) and/or `drop` terms
// (whole sentence removed). Both feed the highlighter; a category may instead
// supply a prebuilt `re` when \b + case-insensitive matching is wrong for it.
const CATS = [
  { key:'puffery', label:'Promotional language',
    desc:'Peacock and marketing terms that assert importance without evidence.',
    strip:['world-renowned','renowned','world-famous','world-class','cutting-edge','state-of-the-art','revolutionary','revolutionized','groundbreaking','ground-breaking','innovative','pioneering','prestigious','acclaimed','critically acclaimed','celebrated','iconic','legendary','visionary','unparalleled','unrivaled','unrivalled','unmatched','incomparable','best-in-class','top-tier','premier','leading','foremost','seamless','robust','stunning','breathtaking','extraordinary','exceptional','remarkable','outstanding','magnificent','masterpiece','elite','flagship','game-changing','transformative','trailblazing','next-generation','one-of-a-kind','sought-after','esteemed','highly regarded','influential','inspirational','award-winning'] },
  { key:'editorial', label:'Editorializing',
    desc:'Qualifiers and asides that inject the writer’s stance.',
    strip:['notably','importantly','interestingly','arguably','clearly','obviously','undoubtedly','of course','indeed','certainly','remarkably','impressively','truly','absolutely','simply','genuinely','essentially','ultimately','furthermore','moreover','additionally','in essence','it is worth noting','it should be noted','it is important to note','it’s important to note','it\'s important to note','needless to say','nothing short of','without a doubt','it goes without saying'] },
  { key:'slop', label:'AI-stock phrasing',
    desc:'Formulaic phrases characteristic of machine-generated prose.',
    strip:['delve into','delves into','delved into','delving into','tapestry','boasts','boasting','nestled','vibrant','bustling','pivotal','crucial','vital','ever-evolving','fast-paced','dynamic landscape','myriad','plethora','embark on','embarked on','beacon of','underscores','underscoring','highlights the importance of','seamlessly','holistic','comprehensive','showcases','showcasing','showcased','leverages','leveraging','fosters','fostering','captivating','captivates','solidified','cemented','garnered','rich history','rich cultural heritage','profound','invaluable','must-visit','must-see','hidden gem'],
    drop:['testament to','stands as','serves as a reminder','left an indelible mark','continues to inspire','continues to captivate','continues to resonate','in conclusion','in summary','look no further','whether you’re','whether you\'re','whether you are'] },
  { key:'unsourced', label:'Unsupported claims',
    desc:'Weasel attributions with no verifiable source; the sentence is removed.',
    drop:['many believe','some say','it is said','experts say','experts agree','critics praise','praised by many','widely regarded','widely considered','widely known','widely recognized','considered by many','generally regarded','one of the most','some of the most','is known for','is famous for','often described as','frequently described as','frequently cited'] },
  { key:'voice', label:'Non-neutral voice',
    desc:'First-person sentences; removed to keep an impersonal tone.',
    // Case-sensitive so all-caps acronyms ("US") are not read as pronouns.
    re: /\b(?:I|[Ww]e|[Oo]ur|[Uu]s|[Mm]y|[Oo]urselves)\b/g },
];

const SYS = `You are an editing assistant for a Wikipedia editor cleaning up AI-generated or otherwise non-encyclopedic prose. Rewrite the text the user provides into neutral, encyclopedic register per Wikipedia's Manual of Style. You are a condensing editor, not a word-swapper: do not produce a sentence-for-sentence paraphrase of the input.

Consolidate first — this matters more than word choice:
- State each fact or claim exactly once. AI-generated drafts restate the same idea in different words across sentences and paragraphs; keep the single most concrete version and delete every restatement.
- Merge sentences that carry parts of the same idea into one sentence. Rewrite and reorder freely; you are not bound by the original sentence structure.
- Collapse summary scaffolding. Chains like "The book examines… It discusses… The book also addresses…" become direct statements of the content, with at most one framing verb per paragraph.
- Delete filler sentences outright: empty topic sentences, concluding exhortations ("In conclusion…", "As we look to the future…", "we have an important decision to make"), and sentences that only gesture at importance ("Understanding these patterns is crucial…") without adding a checkable claim.
- Target half the input length, and never exceed two-thirds of it. If your draft is longer than that, you have paraphrased instead of consolidated — merge and cut until it fits. This is a hard requirement that outranks every preservation rule below: when keeping something would break the cap, cut it.

Quotations and sourced opinions get no exemption:
- A reception or reviews section does not need every endorsement. When several sources make the same evaluative point (the work is important, influential, essential reading, the author a great teacher), keep the one or two most substantive and delete the rest entirely, with their attributions.
- Quote only when the exact wording matters. Reduce block quotes to the one essential clause, or paraphrase them into a tight indirect statement; delete quotes that merely praise.
- Compress attribution scaffolding: "In his 2015 obituary for X published in the journal Y, Z wrote:" becomes the shortest attribution that still names the source. Drop framing about what a quote or gesture signified ("a sign of the reach the book would garner").
- Keep citation markers like [3] attached to the claims they support; when you merge or paraphrase sentences, carry their markers along, and drop markers whose sentences you delete.

Also remove:
- Peacock and puffery terms (WP:PEACOCK) and promotional tone: renowned, world-class, iconic, award-winning, cutting-edge, and similar.
- Weasel attributions (WP:WEASEL): "many believe", "widely regarded", "experts say", "is known for", "often described as".
- Editorializing and filler qualifiers: notably, importantly, arguably, undoubtedly, "it is worth noting", furthermore, moreover.
- Stock AI vocabulary: "delve into", "tapestry", "testament to", "stands as", "nestled", "vibrant", "boasts", "pivotal", "ever-evolving", "seamlessly", "rich cultural heritage", "profound impact", "hidden gem", and other formulaic phrasing.
- Structural AI tells: rule-of-three flourishes, "not only … but also" constructions, and "whether you're X or Y" address to the reader.
- Participial clause glue: ", highlighting …", ", noting …", ", emphasizing …", ", underscoring …", ", showcasing …" tacked onto a sentence. Turn the clause into a direct statement or delete it.
- First-person voice and direct reader address.

Delete entire sentences that are purely evaluative, promotional, or unverifiable — do not soften them into weaker praise. Do NOT invent facts or add information not present in the original. Names, dates, and figures are preserved only when the claim they belong to survives; a name is not a reason to keep a sentence, and a sentence that exists only so another person can repeat praise already given should be deleted, name and all. Be strict about what counts as information worth keeping: a sentence earns its place only by adding a concrete, checkable claim not already stated. Assertions of importance, calls for a "shift in perspective", framing about what a work "stresses", "emphasizes", or "highlights", and generalized restatements of the thesis are not information — delete them even though they are technically claims. Every ban above applies to your own wording, not just the input's: while merging and paraphrasing, never write "highlight", "emphasize", "underscore", "stress", "note"/"noting", "showcase", "delve", "pivotal", or "crucial" in any form, and never bolt a clause onto a sentence with a participle of attribution. When summarizing a review or opinion, state the reviewer's single substantive point as its own plain sentence ("X called the book intellectually demanding") rather than layering verbs of emphasis. Keep paragraph breaks where the original's topics change. Reply with ONLY the rewritten text as plain prose — no preamble, no commentary, and no markdown formatting of any kind (no asterisks for italics or bold, no em-dash dividers, no headings). Separate paragraphs with a blank line only.`;

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escHtml = s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const toHtml = s => escHtml(s).replace(/\n/g, '<br>');

const termRegex = (terms, flags = 'gi') =>
  new RegExp('\\b(?:' + [...terms].sort((a, b) => b.length - a.length).map(escRe).join('|') + ')\\b', flags);

for (const cat of CATS) {
  if (!cat.re) cat.re = termRegex([...(cat.strip || []), ...(cat.drop || [])]);
}

function findMatches(text) {
  const all = [];
  for (const cat of CATS) {
    const re = cat.re;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      all.push({ start: m.index, end: m.index + m[0].length, text: m[0], cat: cat.key });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out = []; let last = -1;
  for (const mt of all) { if (mt.start >= last) { out.push(mt); last = mt.end; } }
  return out;
}

function annotate(text, matches) {
  let html = ''; let i = 0;
  for (const m of matches) {
    html += escHtml(text.slice(i, m.start));
    html += '<mark class="mk-' + m.cat + '">' + escHtml(m.text) + '</mark>';
    i = m.end;
  }
  html += escHtml(text.slice(i));
  return html.replace(/\n/g, '<br>');
}

function buildGroups(matches) {
  const groups = [];
  for (const cat of CATS) {
    const ms = matches.filter(m => m.cat === cat.key);
    if (!ms.length) continue;
    const seen = {}; const items = [];
    for (const m of ms) {
      const key = m.text.toLowerCase();
      if (seen[key] == null) { seen[key] = items.length; items.push({ text: m.text, count: 1 }); }
      else items[seen[key]].count++;
    }
    groups.push({ key: cat.key, label: cat.label, desc: cat.desc,
      items: items.map(it => ({ text: it.text, countText: it.count > 1 ? '×' + it.count : '' })) });
  }
  return groups;
}

// --- DOM wiring ---
const $ = id => document.getElementById(id);
const inputEl = $('input'), annotatedEl = $('annotated'), tabsEl = $('tabs'),
      editTab = $('editTab'), flagTab = $('flagTab'), issueCountEl = $('issueCount'),
      cleanEl = $('clean'), outputEmpty = $('outputEmpty'), statusEl = $('status'),
      groupsEl = $('groups'), legendEl = $('legend'), cleanBtn = $('cleanBtn');

let state = { ran: false, showAnnotated: true, result: null };
let runId = 0;

for (const c of CATS) {
  const row = document.createElement('div');
  row.className = 'legend-row';
  row.innerHTML = '<span class="swatch ' + c.key + '"></span><div>' +
    '<div class="legend-label">' + escHtml(c.label) + '</div>' +
    '<div class="legend-desc">' + escHtml(c.desc) + '</div></div>';
  legendEl.appendChild(row);
}

function render() {
  const r = state.result;
  const showEditor = !state.ran || !state.showAnnotated;
  tabsEl.hidden = !state.ran;
  inputEl.hidden = !showEditor;
  annotatedEl.hidden = showEditor;
  editTab.classList.toggle('active', !state.showAnnotated);
  flagTab.classList.toggle('active', state.showAnnotated);
  cleanEl.hidden = !r;
  outputEmpty.hidden = !!r;
  groupsEl.hidden = !r;
  legendEl.hidden = !!r;
  if (!r) return;
  issueCountEl.textContent = r.totalIssues;
  annotatedEl.innerHTML = r.annotated;
  cleanEl.innerHTML = r.cleaned;
  groupsEl.innerHTML = r.groups.map(g =>
    '<div class="group">' +
      '<div class="group-head"><span class="swatch ' + g.key + '"></span>' +
      '<span class="group-label">' + escHtml(g.label) + '</span></div>' +
      '<div class="group-desc">' + escHtml(g.desc) + '</div>' +
      '<div class="chips">' + g.items.map(it =>
        '<span class="chip">' + escHtml(it.text) + (it.countText ? '<span class="times">' + it.countText + '</span>' : '') + '</span>'
      ).join('') + '</div>' +
    '</div>'
  ).join('');
}

// Stream the neutral rewrite from the Claude proxy; returns the full text.
async function rewriteViaApi(text, onDelta) {
  const resp = await fetch('/api/rewrite', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      stream: true,
      system: SYS,
      messages: [{ role: 'user', content: 'Text:\n' + text }]
    })
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' — ' + (await resp.text()).slice(0, 200));
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', acc = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let evt; try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
        acc += evt.delta.text;
        onDelta(acc);
      } else if (evt.type === 'error') {
        throw new Error((evt.error && evt.error.message) || 'stream error');
      }
    }
  }
  return acc;
}

async function onClean() {
  const text = inputEl.value.trim();
  if (!text) return;
  const id = ++runId;
  const matches = findMatches(text);
  state = { ran: true, showAnnotated: true, result: {
    annotated: annotate(text, matches),
    cleaned: '',
    groups: buildGroups(matches),
    totalIssues: matches.length
  }};
  render();
  cleanBtn.disabled = true;
  statusEl.textContent = 'Rewriting…';
  try {
    const full = await rewriteViaApi(text, partial => {
      if (id !== runId) return;
      state.result.cleaned = toHtml(partial);
      render();
    });
    if (id !== runId) return;
    state.result.cleaned = toHtml(full.trim());
    statusEl.textContent = '';
  } catch (e) {
    if (id !== runId) return;
    console.error('Rewrite failed:', e);
    statusEl.textContent = 'Rewrite failed — check that the server is running';
  } finally {
    if (id === runId) { cleanBtn.disabled = false; render(); }
  }
}

cleanBtn.addEventListener('click', onClean);
$('resetBtn').addEventListener('click', () => {
  runId++;
  inputEl.value = '';
  state = { ran: false, showAnnotated: true, result: null };
  cleanBtn.disabled = false;
  statusEl.textContent = '';
  render();
});
editTab.addEventListener('click', () => { state.showAnnotated = false; render(); });
flagTab.addEventListener('click', () => { state.showAnnotated = true; render(); });
inputEl.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onClean(); });
