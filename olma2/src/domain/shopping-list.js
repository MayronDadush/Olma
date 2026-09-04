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
const { ok, err } = require('./results');
const audit = require('./audit');

// The verb has to lead. "לקנות חלב, לחם" is a shopping list; "לשאול את דנה על
// החלב, הלחם והגבינה" is a sentence that happens to contain a list, and an
// unanchored verb match would shred it.
const BUY_HE = /^\s*(?:אני\s+)?(?:צרי(?:ך|כה|כים|כות)\s+)?(?:ל(?:קנות|רכוש)|תקנ[יה]?|קנ[יה])\s+(?:לי\s+)?/;
const BUY_EN = /^\s*(?:i\s+need\s+to\s+)?(?:buy|get|pick\s+up)\s+/i;

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
const LIST_TITLE = { he: 'קניות', en: 'Shopping' };
const LIST_CATEGORY = 'errands';

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
  const he = text.match(BUY_HE);
  if (he) { rest = text.slice(he[0].length); locale = 'he'; tail = TAIL_HE; }
  else {
    const en = text.match(BUY_EN);
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
async function openList(client, ownerId, listTitle) {
  const { rows } = await client.query(
    `SELECT * FROM tasks
      WHERE owner_id = $1 AND title = $2 AND category = $3
        AND parent_id IS NULL AND status = 'open' AND archived_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [ownerId, listTitle, LIST_CATEGORY]
  );
  return rows[0] || null;
}

// Create or extend the list. Returns null when the title is not a shopping
// list at all, which is the caller's signal to go on doing what it did before.
async function absorb(client, ownerId, { title, dueAt, source }) {
  const parsed = parseShoppingList(title);
  if (!parsed) return null;

  let list = await openList(client, ownerId, parsed.title);
  const merged = Boolean(list);
  if (!list) {
    const { rows } = await client.query(
      `INSERT INTO tasks (owner_id, title, category, due_at, source)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'chat')) RETURNING *`,
      [ownerId, parsed.title, LIST_CATEGORY, dueAt || null, source || null]
    );
    list = rows[0];
  }

  // Already on the list, in their words. Adding "חלב" to a list that has
  // "חלב" makes the list wrong in the shop, which is the only place it is
  // ever read.
  const { rows: have } = await client.query(
    `SELECT lower(title) AS t FROM tasks
      WHERE parent_id = $1 AND status = 'open' AND archived_at IS NULL`,
    [list.id]
  );
  const seen = new Set(have.map((r) => r.t));
  const fresh = parsed.items.filter((i) => !seen.has(i.toLowerCase()));

  const added = [];
  for (const item of fresh) {
    const { rows } = await client.query(
      `INSERT INTO tasks (owner_id, title, parent_id, source)
       VALUES ($1, $2, $3, COALESCE($4, 'chat')) RETURNING *`,
      [ownerId, item, list.id, source || null]
    );
    added.push(rows[0]);
  }
  await audit.record(client, ownerId, 'task.shopping_list', {
    taskId: Number(list.id), merged, added: added.length,
    duplicates: parsed.items.length - fresh.length,
  });

  return ok({
    task: list,
    shoppingList: true,
    merged,
    items: added.map((r) => ({ id: Number(r.id), title: r.title })),
    ...(parsed.items.length !== fresh.length
      ? { alreadyOnList: parsed.items.filter((i) => seen.has(i.toLowerCase())) } : {}),
    // A date they gave for a run that already exists is NOT applied to the
    // list already sitting there — that would silently re-date a plan they
    // made earlier. It is reported instead, so Olma can offer rather than
    // guess. (CLAUDE.md: no silent caps; this is the same rule about a thing
    // the system declined to do.)
    ...(merged && dueAt ? { dueAtIgnored: dueAt } : {}),
  });
}

module.exports = { parseShoppingList, absorb, LIST_TITLE, LIST_CATEGORY, ITEM_MAX_CHARS, MIN_ITEMS, MAX_ITEMS };
