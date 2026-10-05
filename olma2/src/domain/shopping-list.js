'use strict';
// "לקנות חלב, קוטג׳ וגבינה צהובה" is not one task. It is three things to pick
// up, and it sat in the list as a single line nobody could tick off halfway.
// Recognising it is done HERE, in code, and never by asking the model: this
// fires on a large share of everything anybody dictates, and a token cost on
// every task in the system is the wrong price for a formatting decision.
//
// The whole design of this file is refusal. It rewrites what a person wrote,
// which is a thing to do rarely and only when nearly certain, so every rule
// below narrows rather than widens — and anything that does not match comes
// back null and stays the plain task they typed.
const { ok } = require('./results');
const audit = require('./audit');

// The verb has to lead. "לקנות חלב, לחם" is a shopping list; "לשאול את דנה על
// החלב, הלחם והגבינה" is a sentence that happens to contain a list, and an
// unanchored verb match would shred it.
const BUY_HE = /^\s*(?:אני\s+)?(?:צרי(?:ך|כה|כים|כות)\s+)?(?:ל(?:קנות|רכוש)|תקנ[יה]?|קנ[יה])\s+(?:לי\s+)?/;
const BUY_EN = /^\s*(?:i\s+need\s+to\s+)?(?:buy|get|pick\s+up)\s+/i;
// …or the list's own NAME leads, and a dash or colon says the items follow:
// "קניות - נייר טואלט, מגבונים, …" is how jobs/fact-extraction.js wrote Dov's
// list back on 2026-10-05, half an hour after the live turn had saved the same
// ten things, and as a title nobody recognised it became an eleventh row
// holding all ten. The separator is required, so "קניות לשבת" or "סופר מחר"
// — a task ABOUT shopping — never reads as a list of one.
const NAMED_HE = /^\s*(?:רשימת\s+)?(?:קניות|סופר)(?:\s+(?:ל|ב)?סופר)?\s*[-–—:]\s*/;
const NAMED_EN = /^\s*(?:shopping|grocer(?:y|ies))(?:\s+list)?\s*[-–—:]\s*/i;

// A comma is REQUIRED, and that is the single most important line here. Split
// on the conjunction alone and "לקנות מתנה לאמא ולאבא" becomes two items, one
// of which is a person. Nobody writes a real shopping list of two or more
// things without a comma, so demanding one costs almost nothing and removes
// the entire class of false splits that have no comma in them.
const HAS_COMMA = /,/;

// A shopping item is a couple of words. Anything longer is a sentence that
// wandered in, and the safe answer to a sentence is to leave the task alone.
const ITEM_MAX_CHARS = 40;
const MIN_ITEMS = 2;
const MAX_ITEMS = 30;

// The list's own name. Miron asked Olma to title it herself; this is the title,
// and it is fixed rather than generated because it is also the merge key — a
// name that varied would produce a second list instead of finding the first.
// 'קניות סופר' since 2026-10-05, the owner's choice (it was 'קניות'); a list
// open under the old name is still found, through SHOPPING_TITLES.
const LIST_TITLE = { he: 'קניות סופר', en: 'Shopping' };
// A list is its own category (owner, 2026-10-05: "רשימות תהיה קטגוריה נפרדת
// כברירת מחדל"), chosen by us and therefore `category_auto` — a person who
// moves it somewhere else has the last word, and nothing below looks the list
// up by its category, so moving it never makes the next request start a rival.
const LIST_CATEGORY = 'lists';
// Before 2026-10-05 a shopping list was filed under 'errands'. Those rows are
// still open on the box, and the readers that skip a list (jobs/checkin.js's
// stalled goals) have to keep recognising them.
const LEGACY_LIST_CATEGORIES = ['errands'];

// Every name a shopping run already goes by on the box — 'קניות' (ours until 2026-10-05),
// 'סופר', 'קניות בסופר', and 'קניות סופר', ours now. A new
// item joins whichever of these is open, rather than starting a 'קניות' beside
// a 'סופר' that is already half bought.
const SHOPPING_TITLES = ['קניות', 'סופר', 'קניות סופר', 'קניות בסופר', 'קניות לסופר',
  'רשימת קניות', 'shopping', 'shopping list', 'groceries', 'grocery list'];
const SHOPPING_TITLE_SET = new Set(SHOPPING_TITLES);
const normTitle = (t) => String(t == null ? '' : t).trim().toLowerCase().replace(/\s+/g, ' ');
const isShoppingTitle = (t) => SHOPPING_TITLE_SET.has(normTitle(t));

// Only ever applied to the LAST comma-separated piece: "חלב, קוטג׳ וגבינה
// צהובה" ends "קוטג׳ וגבינה צהובה", and that trailing conjunction is the one
// place Hebrew puts it. Looking for ו everywhere would catch it mid-item.
const TAIL_HE = /\s+ו(?=[א-ת]{2,})/;
const TAIL_EN = /\s+and\s+/i;

function splitItems(rest, tail) {
  const parts = rest.split(',');
  const last = parts.pop();
  return [...parts, ...last.split(tail)].map((s) => s.trim()).filter(Boolean);
}

// Returns { locale, title, items } or null. Pure — no client, no clock, so the
// rule can be argued with in a test rather than against a database.
function parseShoppingList(title) {
  if (typeof title !== 'string') return null;
  const text = title.trim();
  if (!text) return null;

  let rest = null; let locale = null; let tail = null;
  const he = text.match(BUY_HE) || text.match(NAMED_HE);
  if (he) { rest = text.slice(he[0].length); locale = 'he'; tail = TAIL_HE; }
  else {
    const en = text.match(BUY_EN) || text.match(NAMED_EN);
    if (!en) return null;
    rest = text.slice(en[0].length); locale = 'en'; tail = TAIL_EN;
  }
  if (!HAS_COMMA.test(rest)) return null;

  const items = splitItems(rest, tail);
  if (items.length < MIN_ITEMS || items.length > MAX_ITEMS) return null;
  // One over-long piece condemns the whole title, rather than being dropped:
  // a list silently missing the thing they actually needed is worse than a
  // list that was never split.
  if (items.some((i) => i.length > ITEM_MAX_CHARS)) return null;
  return { locale, title: LIST_TITLE[locale], items };
}

// The open list to add to, or nothing. Miron's rule: a list per shopping run,
// but never two at once — so "open" is the whole of it. Ticking one off ends
// that run and the next request starts a fresh list, which is how a shopping
// list behaves in life.
//
// By TITLE, never by category: the category is the person's to change, and a
// list they moved to "בית" is still the list. A shopping run is found under
// any of its names; any other list only under its own.
async function openList(client, ownerId, listTitle) {
  const names = isShoppingTitle(listTitle) ? SHOPPING_TITLES : [normTitle(listTitle)];
  const { rows } = await client.query(
    `SELECT * FROM tasks
      WHERE owner_id = $1 AND lower(regexp_replace(btrim(title), '\\s+', ' ', 'g')) = ANY($2::text[])
        AND parent_id IS NULL AND status = 'open' AND archived_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [ownerId, names]
  );
  return rows[0] || null;
}

// Create or extend a list with these items. The one writer behind both doors:
// a dictated "לקנות א, ב" (absorb, below) and a list the model saved in bulk
// (tasks.addTasksBulk with `list`).
async function addToList(client, ownerId, { listTitle, items, dueAt, source }) {
  let list = await openList(client, ownerId, listTitle);
  const merged = Boolean(list);
  if (!list) {
    const { rows } = await client.query(
      `INSERT INTO tasks (owner_id, title, category, category_auto, due_at, source)
       VALUES ($1, $2, $3, true, $4, COALESCE($5, 'chat')) RETURNING *`,
      [ownerId, String(listTitle).trim(), LIST_CATEGORY, dueAt || null, source || null]
    );
    list = rows[0];
  }

  // Already on the list, in their words. Adding "חלב" to a list that has
  // "חלב" makes the list wrong in the shop, which is the only place it is
  // ever read. Also within one call: Dov's list, pasted twice, is one list.
  const { rows: have } = await client.query(
    `SELECT lower(title) AS t FROM tasks
      WHERE parent_id = $1 AND status = 'open' AND archived_at IS NULL`,
    [list.id]
  );
  const seen = new Set(have.map((r) => r.t));
  const already = [];
  const added = [];
  for (const raw of items) {
    const item = String(raw).trim();
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) { already.push(item); continue; }
    seen.add(key);
    const { rows } = await client.query(
      `INSERT INTO tasks (owner_id, title, parent_id, source)
       VALUES ($1, $2, $3, COALESCE($4, 'chat')) RETURNING *`,
      [ownerId, item, list.id, source || null]
    );
    added.push(rows[0]);
  }
  await audit.record(client, ownerId, 'task.shopping_list', {
    taskId: Number(list.id), merged, added: added.length, duplicates: already.length,
  });

  return ok({
    task: list,
    shoppingList: true,
    merged,
    items: added.map((r) => ({ id: Number(r.id), title: r.title })),
    ...(already.length ? { alreadyOnList: already } : {}),
    // A date they gave for a run that already exists is NOT applied to the
    // list already sitting there — that would silently re-date a plan they
    // made earlier. It is reported instead, so Olma can offer rather than
    // guess. (CLAUDE.md: no silent caps; this is the same rule about a thing
    // the system declined to do.)
    ...(merged && dueAt ? { dueAtIgnored: dueAt } : {}),
  });
}

// Create or extend the list. Returns null when the title is not a shopping
// list at all, which is the caller's signal to go on doing what it did before.
async function absorb(client, ownerId, { title, dueAt, source }) {
  const parsed = parseShoppingList(title);
  if (!parsed) return null;
  return addToList(client, ownerId, { listTitle: parsed.title, items: parsed.items, dueAt, source });
}

// ── A bulk save that is plainly a shopping list ─────────────────────────────
//
// Dov, 2026-10-05: "הולך לעשות קניות עכשיו רשימה-" and ten lines, one item
// each. The model understood it — it tagged every item `errands` and replied
// "שמרתי … בקניות" — and called add_tasks_bulk with ten top-level items,
// because that tool had no way to say "these are one list". Ten separate
// tasks, each with its own row on the page. `list` on the tool is the door
// for next time; THIS is what catches the turn that does not use it.
//
// Same discipline as the parser above: it rewrites how somebody's things are
// filed, so every condition narrows, and a miss falls back to exactly what
// add_tasks_bulk always did.
//   - the model itself filed EVERY item under errands — the one signal that it
//     read this as shopping, and the reason a dump of short nouns about
//     anything else never qualifies;
//   - three or more, none dated, none an event, none with a place;
//   - every item a few words, the way a thing on a shelf is named;
//   - none led by an infinitive ("לאסוף", "לשלם") — that is an errand to DO,
//     not a thing to buy — and none our own keywords place in a category
//     other than shopping ("דואר", "מוסך", "רופא").
const BULK_MIN_ITEMS = 3;
const BULK_ITEM_MAX_WORDS = 3;
const BULK_ITEM_MAX_CHARS = 25;
const INFINITIVE_HE = /^ל[א-ת]{3,}/;
const SHOPPING_STEMS = /סופר|מכולת|קניות|לקנות|groceries|grocery|supermarket|shopping/i;

function looksLikeShoppingBulk(items, classify) {
  if (!Array.isArray(items) || items.length < BULK_MIN_ITEMS || items.length > MAX_ITEMS) return false;
  return items.every((i) => {
    if (!i || typeof i.title !== 'string') return false;
    const title = i.title.trim();
    if (!title || title.length > BULK_ITEM_MAX_CHARS) return false;
    if (title.split(/\s+/).length > BULK_ITEM_MAX_WORDS) return false;
    if (String(i.category || '').trim().toLowerCase() !== 'errands') return false;
    if (i.dueAt || i.endsAt || i.location || i.kind === 'event') return false;
    if (INFINITIVE_HE.test(title)) return false;
    const cat = classify(title);
    return cat === null || (cat === 'errands' && SHOPPING_STEMS.test(title));
  });
}

module.exports = {
  parseShoppingList, absorb, addToList, looksLikeShoppingBulk, isShoppingTitle,
  LIST_TITLE, LIST_CATEGORY, LEGACY_LIST_CATEGORIES, SHOPPING_TITLES,
  ITEM_MAX_CHARS, MIN_ITEMS, MAX_ITEMS,
};
