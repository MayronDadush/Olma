'use strict';
// The vision bench, rerunnable when a new model comes out.
//
//   node food/bench/run.js see      every model, every photo, twice (resumes)
//   node food/bench/run.js match    every name any model said -> one table row
//   node food/bench/run.js score    plate numbers through the SAME table
//
// The models return names and grams only (the production prompt). Calories
// never come from a model: a name is matched to one row of the USDA table,
// once, and every model that said that name gets that row. So the only thing
// that differs between models is what they SAW and how much of it.
//
// The key is read from Olma/.env and never printed.
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const MODELS = (process.env.MODELS || [
  'google/gemini-3.8-flash', 'google/gemini-3.5-flash-lite', 'openai/gpt-6-luna',
  'qwen/qwen3.8-flash', 'anthropic/claude-sonnet-5.5', 'deepseek/deepseek-v4-flash-vision-exp',
].join(',')).split(',');
const RUNS = Number(process.env.RUNS || 2);
const MATCHER = process.env.MATCHER || 'google/gemini-3.8-flash';

function key() {
  const env = fs.readFileSync(path.join(DIR, '../../.env'), 'utf8');
  const m = env.match(/^(?:export )?OPENROUTER_API_KEY=["']?([^"'\s]+)/m);
  if (!m) throw new Error('no OPENROUTER_API_KEY in Olma/.env');
  return m[1];
}

const PROMPT = `את עולמה. בתמונה ארוחה שמישהו צילם כדי לרשום מה הוא אוכל. פרקי אותה לרכיבים שרואים, והעריכי לכל רכיב כמה גרם יש ממנו לפי גודל הצלחת והכלים. אל תחשבי קלוריות: הן יבואו מטבלה לפי השם.
החזירי JSON בלבד, בלי טקסט נוסף, במבנה:
{"title":"שם קצר לארוחה","items":[{"name":"שם בעברית","name_en":"chicken breast, roasted","grams":120,"group":"protein","confidence":"high"}],"question":null}
name_en: השם כמו בטבלת הרכב מזון, באנגלית, עם אופן ההכנה (cooked, raw, fried, roasted). רוטב, שמן או ממרח שרואים הם רכיב נפרד.
group: protein, veg, fruit, grain, fat, sweet, drink. confidence: high, mid או low. אם כמות של רכיב אחד ממש לא ברורה, question הוא שאלה קצרה אחת לאדם; אחרת null.`;

async function chat(body) {
  const t0 = Date.now();
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json', 'X-Title': 'Olma food vision bench' },
    body: JSON.stringify({ usage: { include: true }, ...body }),
  });
  const j = await r.json().catch(() => ({ error: `http ${r.status}` }));
  const ms = Date.now() - t0;
  if (!r.ok || j.error) return { ms, error: JSON.stringify(j.error || j).slice(0, 300) };
  const text = j.choices?.[0]?.message?.content || '';
  let parsed = null;
  try { parsed = JSON.parse(text.replace(/^[^{]*/s, '').replace(/[^}]*$/s, '')); } catch { /* unparseable */ }
  return { ms, text, parsed, cost: j.usage?.cost ?? null, tokens: j.usage ? [j.usage.prompt_tokens, j.usage.completion_tokens] : null };
}

function images() {
  const out = [];
  const weighed = JSON.parse(fs.readFileSync(path.join(DIR, 'weighed.json'), 'utf8'));
  for (const id of Object.keys(weighed)) out.push({ id, file: path.join(DIR, 'weighed', `${id}.png`), mime: 'image/png', set: 'weighed' });
  for (const f of fs.readdirSync(path.join(DIR, 'photos')).filter(f => /\.jpe?g$/i.test(f)).sort()) {
    out.push({ id: f.replace(/\.\w+$/, ''), file: path.join(DIR, 'photos', f), mime: 'image/jpeg', set: 'photos' });
  }
  return out;
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return d; } };
const writeJson = (f, v) => fs.writeFileSync(path.join(DIR, f), JSON.stringify(v, null, 1));

// ---- see ---------------------------------------------------------------------
async function see() {
  const done = readJson('see.json', []);
  const have = new Set(done.filter(d => !d.error).map(d => `${d.model}|${d.id}|${d.run}`));
  const imgs = images();
  const missing = imgs.filter(i => !fs.existsSync(i.file));
  if (missing.length) throw new Error(`missing images: ${missing.map(i => i.id).join(', ')}`);
  const deadline = Date.now() + Number(process.env.BUDGET_MS || 160000);
  await Promise.all(MODELS.map(async model => {
    for (const img of imgs) for (let run = 0; run < RUNS; run++) {
      if (have.has(`${model}|${img.id}|${run}`) || Date.now() > deadline) continue;
      const b64 = fs.readFileSync(img.file).toString('base64');
      const res = await chat({
        model, temperature: 0, max_tokens: 2000,
        messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: `data:${img.mime};base64,${b64}` } }] }],
      });
      const row = { model, id: img.id, set: img.set, run, ms: res.ms, cost: res.cost, tokens: res.tokens, parsed: res.parsed, error: res.error || (res.parsed?.items ? undefined : 'unparseable') };
      const i = done.findIndex(d => d.model === model && d.id === img.id && d.run === run);
      if (i >= 0) done[i] = row; else done.push(row);
      writeJson('see.json', done);
    }
  }));
  const total = MODELS.length * imgs.length * RUNS;
  const ok = done.filter(d => !d.error).length;
  console.log(`see: ${ok}/${total} answered, ${done.filter(d => d.error).length} errors, $${done.reduce((a, d) => a + (d.cost || 0), 0).toFixed(3)} so far`);
}

// ---- match -------------------------------------------------------------------
function loadTable() {
  const lines = fs.readFileSync(path.join(DIR, '..', 'data', 'usda-sr-legacy.csv'), 'utf8').trim().split('\n').slice(1);
  const rows = [];
  for (const line of lines) {
    const cells = []; let cur = '', q = false;
    for (const ch of line) {
      if (ch === '"') q = !q; else if (ch === ',' && !q) { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    const [id, description, category, kcal, protein, carbs, fat] = cells;
    if (/Baby Foods|American Indian/.test(category)) continue;
    rows.push({ id: Number(id), description, category, kcal: +kcal, protein: +protein, carbs: +carbs, fat: +fat });
  }
  return rows;
}

const STOP = new Set(['and', 'with', 'or', 'in', 'of', 'the', 'a', 'fresh', 'sliced', 'plain', 'piece', 'pieces', 'slice', 'slices', 'portion', 'small', 'large', 'mixed', 'style', 'homemade', 'diced', 'chopped', 'whole', 'baby', 'mini', 'probably', 'edible', 'only', 'meat']);
function stem(w) {
  if (w.length > 4 && /(oes|ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
  return w;
}
const toks = s => String(s).toLowerCase().split(/[^a-z]+/).filter(w => w && !STOP.has(w)).map(stem);

function candidates(table, idf, name, n = 30) {
  const nt = new Set(toks(name));
  const scored = [];
  for (const row of table) {
    let s = 0;
    for (const t of row._t) if (nt.has(t)) s += idf.get(t);
    if (!s) continue;
    const head = toks(row.description.split(',')[0]);
    if (head.length && head.every(t => nt.has(t))) s += 2;
    s -= 0.05 * row._t.size;
    scored.push([s, row]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, n).map(x => x[1]);
}

async function match() {
  const table = loadTable();
  const df = new Map();
  for (const row of table) { row._t = new Set(toks(row.description)); for (const t of row._t) df.set(t, (df.get(t) || 0) + 1); }
  const idf = new Map([...df].map(([t, c]) => [t, Math.log(table.length / c)]));
  const byId = new Map(table.map(r => [r.id, r]));

  const names = new Map(); // key -> {en, he}
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const d of readJson('see.json', [])) for (const it of d.parsed?.items || []) {
    const k = norm(it.name_en || it.name); if (k && !names.has(k)) names.set(k, { en: it.name_en || it.name, he: it.name });
  }
  const weighed = readJson('weighed.json', {});
  for (const g of Object.values(weighed)) for (const ing of g.ings) { const k = norm(ing.name); if (!names.has(k)) names.set(k, { en: ing.name, he: '' }); }

  const cache = readJson('match.json', {});
  const todo = [...names].filter(([k]) => !cache[k]);
  console.log(`match: ${names.size} names, ${todo.length} to match`);
  const deadline = Date.now() + Number(process.env.BUDGET_MS || 160000);
  let spent = 0;
  const batches = [];
  for (let i = 0; i < todo.length; i += 8) batches.push(todo.slice(i, i + 8));
  const worker = async () => { for (let next; (next = batches.shift()) && Date.now() < deadline;) await one(next); };
  const one = async slice => {
    const batch = slice.map(([k, v]) => ({ k, ...v, c: candidates(table, idf, v.en, 20) }));
    const prompt = `For each food item, pick the ONE row of the USDA table whose values per 100 g best represent the item as it is eaten (its cooked state and usual preparation). If no row is exact, pick the closest in nutrition (a similar food or dish). Always pick one of the listed ids.
Return JSON only: {"picks":[{"i":0,"id":123456}]}

${batch.map((b, j) => `Item ${j}: "${b.en}"${b.he ? ` (Hebrew: ${b.he})` : ''}\n${b.c.map(r => `  ${r.id}: ${r.description}`).join('\n') || '  (no candidates)'}`).join('\n\n')}`;
    const res = await chat({ model: MATCHER, temperature: 0, max_tokens: 8000, reasoning: { effort: 'low' }, messages: [{ role: 'user', content: prompt }] });
    spent += res.cost || 0;
    if (!res.parsed?.picks) console.log('batch failed:', res.error || String(res.text).slice(-160));
    for (const p of res.parsed?.picks || []) {
      const b = batch[p.i]; const row = byId.get(Number(p.id));
      if (b && row && b.c.some(c => c.id === row.id)) cache[b.k] = { id: row.id, description: row.description, kcal: row.kcal, protein: row.protein, carbs: row.carbs, fat: row.fat };
    }
    writeJson('match.json', cache);
  };
  await Promise.all(Array.from({ length: Number(process.env.PARALLEL || 4) }, worker));
  const left = [...names.keys()].filter(k => !cache[k]);
  console.log(`match: ${names.size - left.length}/${names.size} matched, $${spent.toFixed(4)} this pass${left.length ? `; unmatched: ${left.slice(0, 20).join(' | ')}` : ''}`);
}

// ---- score -------------------------------------------------------------------
function score() {
  const see = readJson('see.json', []);
  const cache = readJson('match.json', {});
  const weighed = readJson('weighed.json', {});
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const plate = items => {
    const t = { kcal: 0, protein: 0, carbs: 0, fat: 0, grams: 0, unmatched: 0 };
    for (const it of items) {
      const g = +it.grams || 0; const row = cache[norm(it.name_en || it.name)];
      t.grams += g;
      if (!row) { t.unmatched += 1; continue; }
      for (const k of ['kcal', 'protein', 'carbs', 'fat']) t[k] += row[k] * g / 100;
    }
    return t;
  };
  const truth = {};
  for (const [id, g] of Object.entries(weighed)) truth[id] = { ...plate(g.ings.map(i => ({ name_en: i.name, grams: i.grams }))), n5k_kcal: g.kcal };
  const rows = see.filter(d => !d.error).map(d => ({ model: d.model, id: d.id, set: d.set, run: d.run, cost: d.cost, ms: d.ms, n: d.parsed.items.length, ...plate(d.parsed.items) }));
  writeJson('score.json', { truth, rows });
  console.log(`score: ${rows.length} answers scored; truth plates ${Object.keys(truth).length}`);
}

const cmd = process.argv[2];
const fn = { see, match, score }[cmd];
if (!fn) { console.error('usage: run.js see|match|score'); process.exit(2); }
Promise.resolve().then(fn).catch(e => { console.error(String(e.message || e)); process.exit(1); });
