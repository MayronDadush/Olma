'use strict';
// Values per 100 g, from a table and never from a model (migrations/002).
//
// An item arrives with a name in their language and an English one in the
// words of a food composition table ("chicken breast, roasted"). The English
// name is looked up in `food_names`; a name seen for the first time is matched
// ONCE, by a cheap model choosing among the table rows whose words it shares,
// and saved for everybody. Nothing is guessed silently:
//
//   table  a row of the table (the normal case)
//   label  read off a nutrition label they sent: the label wins
//   model  the model's own values, kept only when no row could be found
//   group  nothing at all: a typical value for its group, marked low
//
// A table name is never matched from the Hebrew alone: "עוף" is a breast or a
// thigh, and only the English the model wrote says which.
const fs = require('fs');
const path = require('path');
const llm = require('./llm');

const DATA = path.join(__dirname, '..', 'data');
const USDA_CSV = path.join(DATA, 'usda-sr-legacy.csv');
const SEED_NAMES = path.join(DATA, 'food-names.json');

const norm = s => String(s || '').toLowerCase().replace(/[\s ]+/g, ' ').replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '').slice(0, 120);

// When nothing matches: a middle value for the group, so a meal is never
// dropped for want of a row. Marked `group` and `low` wherever it shows.
const GROUP_DEFAULTS = {
  protein: [180, 22, 2, 9], veg: [35, 1.5, 6, 0.5], fruit: [55, 0.7, 13, 0.3], grain: [160, 4.5, 30, 2],
  fat: [600, 3, 8, 62], sweet: [380, 5, 55, 16], drink: [40, 0.5, 9, 0],
};

/* ── the table ── */

function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

// Categories nobody eats off a plate in Israel, which only add wrong matches.
const SKIP_CATEGORIES = /Baby Foods|American Indian/;

function readUsda(file = USDA_CSV) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(1);
  const rows = [];
  for (const line of lines) {
    const [id, description, category, kcal, protein, carbs, fat] = parseCsvLine(line);
    if (SKIP_CATEGORIES.test(category)) continue;
    const v = [kcal, protein, carbs, fat].map(Number);
    if (v.some(x => !Number.isFinite(x)) || v[0] > 950 || v.slice(1).some(x => x > 100)) continue;
    rows.push({ source_id: id, name_en: description, category, v });
  }
  return rows;
}

// Loads the table and the names matched by hand or by the bench. Idempotent:
// rows are upserted by (source, source_id) and names are only ever added, so a
// name somebody fixed by hand is never overwritten by a seed.
async function seed(pool, { file = USDA_CSV, names = SEED_NAMES } = {}) {
  const rows = readUsda(file);
  const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM foods WHERE source = 'usda'`);
  let loaded = 0;
  if (n !== rows.length) {
    for (let i = 0; i < rows.length; i += 1000) {
      const part = rows.slice(i, i + 1000);
      await pool.query(
        `INSERT INTO foods (source, source_id, name_en, category, kcal100, protein100, carbs100, fat100)
         SELECT 'usda', * FROM unnest($1::text[], $2::text[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[])
         ON CONFLICT (source, source_id) DO UPDATE SET name_en = EXCLUDED.name_en, category = EXCLUDED.category,
           kcal100 = EXCLUDED.kcal100, protein100 = EXCLUDED.protein100, carbs100 = EXCLUDED.carbs100, fat100 = EXCLUDED.fat100`,
        [part.map(r => r.source_id), part.map(r => r.name_en), part.map(r => r.category), ...[0, 1, 2, 3].map(k => part.map(r => r.v[k]))]);
      loaded += part.length;
    }
  }
  let named = 0;
  if (names && fs.existsSync(names)) {
    const list = JSON.parse(fs.readFileSync(names, 'utf8'));
    const keys = Object.keys(list);
    const r = await pool.query(
      `INSERT INTO food_names (name, food_id, via)
       SELECT k, f.id, 'seed' FROM unnest($1::text[], $2::text[]) AS x(k, sid)
       JOIN foods f ON f.source = 'usda' AND f.source_id = x.sid
       ON CONFLICT (name) DO NOTHING`,
      [keys.map(norm), keys.map(k => String(list[k]))]);
    named = r.rowCount;
  }
  index = null;
  return { loaded, named };
}

/* ── finding a row ── */

const STOP = new Set(['and', 'with', 'or', 'in', 'of', 'the', 'a', 'fresh', 'sliced', 'plain', 'piece', 'pieces', 'slice', 'slices', 'portion', 'small', 'large', 'mixed', 'style', 'homemade', 'diced', 'chopped', 'whole', 'baby', 'mini', 'probably', 'edible', 'only', 'meat']);
function stem(w) {
  if (w.length > 4 && /(oes|ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
  return w;
}
const toks = s => String(s).toLowerCase().split(/[^a-z]+/).filter(w => w && !STOP.has(w)).map(stem);

// The whole table in memory, words and weights. ~8k rows; built once per
// process on first use and again after a seed.
let index = null;
async function indexOf(pool) {
  if (index) return index;
  const { rows } = await pool.query('SELECT id, name_en, kcal100, protein100, carbs100, fat100 FROM foods WHERE name_en IS NOT NULL');
  const df = new Map();
  const list = rows.map(r => {
    const t = new Set(toks(r.name_en));
    for (const w of t) df.set(w, (df.get(w) || 0) + 1);
    return { id: r.id, name_en: r.name_en, t, head: toks(r.name_en.split(',')[0]) };
  });
  const idf = new Map([...df].map(([w, c]) => [w, Math.log(list.length / c)]));
  index = { list, idf, byId: new Map(rows.map(r => [r.id, r])) };
  return index;
}

// The rows sharing the most telling words with a name: the shortlist a model
// chooses from. It never chooses outside it.
function candidates(ix, name, n = 20) {
  const nt = new Set(toks(name));
  const scored = [];
  for (const row of ix.list) {
    let s = 0;
    for (const w of row.t) if (nt.has(w)) s += ix.idf.get(w);
    if (!s) continue;
    if (row.head.length && row.head.every(w => nt.has(w))) s += 2;
    s -= 0.05 * row.t.size;
    scored.push([s, row]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, n).map(x => x[1]);
}

async function known(pool, keys) {
  if (!keys.length) return new Map();
  const { rows } = await pool.query(
    `SELECT n.name, f.id, f.name_en, f.kcal100, f.protein100, f.carbs100, f.fat100
       FROM food_names n JOIN foods f ON f.id = n.food_id WHERE n.name = ANY($1)`, [keys]);
  return new Map(rows.map(r => [r.name, r]));
}

// New names, eight to a call. A batch the model could not answer is simply
// left unmatched this time; the meal is logged anyway (`model` or `group`).
async function matchNew(pool, misses, { userId, fetchImpl } = {}) {
  const ix = await indexOf(pool);
  const found = new Map();
  const todo = misses.map(m => ({ ...m, c: candidates(ix, m.en) })).filter(m => m.c.length);
  for (let i = 0; i < todo.length; i += 8) {
    const batch = todo.slice(i, i + 8);
    const prompt = `For each food item, pick the ONE row of the USDA table whose values per 100 g best represent the item as it is eaten (its cooked state and usual preparation). If no row is exact, pick the closest in nutrition (a similar food or dish). Always pick one of the listed ids.
Return JSON only: {"picks":[{"i":0,"id":123}]}

${batch.map((b, j) => `Item ${j}: "${b.en}"${b.he ? ` (Hebrew: ${b.he})` : ''}\n${b.c.map(r => `  ${r.id}: ${r.name_en}`).join('\n')}`).join('\n\n')}`;
    let r;
    try { r = await llm.chat({ pool, userId, purpose: 'match', content: prompt, maxTokens: 4000, fetchImpl }); } catch (e) {
      if (e instanceof llm.ModelUnavailable) { console.error('[foodd foods] match failed:', e.message); continue; }
      throw e;
    }
    for (const p of Array.isArray(r.json?.picks) ? r.json.picks : []) {
      const b = batch[p.i];
      const id = Number(p.id);
      if (!b || !b.c.some(c => c.id === id)) continue;   // only ever a row from its own shortlist
      await pool.query(`INSERT INTO food_names (name, food_id, via) VALUES ($1, $2, 'model') ON CONFLICT (name) DO NOTHING`, [b.key, id]);
      found.set(b.key, ix.byId.get(id));
    }
  }
  return found;
}

const valuesOf = row => ({ kcal: Number(row.kcal100), protein: Number(row.protein100), carbs: Number(row.carbs100), fat: Number(row.fat100) });

// Fills every item's per100 from the table, as described at the top. Takes
// the items as a tool sends them and returns them ready for validate.items,
// with `food_id` and `value_src` beside.
async function resolve(pool, items, { userId = null, fetchImpl, canAsk = true } = {}) {
  // What arrives is what a tool was sent: its own food_id or value_src are
  // not claims anybody gets to make.
  const out = items.map(({ food_id: _f, value_src: _v, ...it }) => it);
  const keyOf = it => norm(it.name_en);
  const need = out.filter(it => !(it.confidence === 'label' && it.per100) && keyOf(it));
  const have = await known(pool, [...new Set(need.map(keyOf))]);
  const misses = [...new Map(need.filter(it => !have.has(keyOf(it))).map(it => [keyOf(it), { key: keyOf(it), en: it.name_en, he: it.name }])).values()];
  if (misses.length && canAsk) {
    try {
      for (const [k, row] of await matchNew(pool, misses, { userId, fetchImpl })) have.set(k, row);
    } catch (e) { console.error('[foodd foods] matching failed:', e && e.message || e); }
  }
  for (const it of out) {
    if (it.confidence === 'label' && it.per100) { it.value_src = 'label'; continue; }
    const row = keyOf(it) ? have.get(keyOf(it)) : null;
    if (row) { it.per100 = valuesOf(row); it.food_id = row.id; it.value_src = 'table'; continue; }
    if (it.per100) { it.value_src = 'model'; continue; }
    const g = GROUP_DEFAULTS[it.group] || GROUP_DEFAULTS.grain;
    it.per100 = { kcal: g[0], protein: g[1], carbs: g[2], fat: g[3] };
    it.value_src = 'group';
    it.confidence = 'low';
  }
  return out;
}

module.exports = { seed, resolve, candidates, indexOf, norm, readUsda, GROUP_DEFAULTS, reset: () => { index = null; } };
