'use strict';
// "שמורים" — links a person keeps for later, sorted into lists
// (docs/design/saved-links-handoff.md, owner 2026-10-08).
//
// A link is a thing on a list, like "בננה" on a shopping list: it has no date
// and no reminder of its own. Turning one into a task (`toTask`) makes an
// ordinary task that carries it, and from then on it is a task in every way.
//
// Two doors save: brokerd's `save_link_shortcut` (a message that is only a
// link, answered by code) and the `saved_links` tool. Both go through
// `saveUrls`, which READS before it WRITES — the fetch and the list choice
// happen first, the rows after — and never asks which list: it decides, saves,
// and the reply says how to move it.
//
// What a row says about the page (title, author, caption, line) is only ever
// what the fetch returned (domain/link-extract.js), never a model's words.
// The ONE line under a title is the exception that proves it: the words the
// person sent with the link win over anything read, and `line_by` says whose
// they are, so a later re-read never writes over a person.
const { ok, err } = require('./results');
const audit = require('./audit');
const extract = require('./link-extract');
const classify = require('./link-classify');
// Every row here carries a `url` the model must copy, never retype.
const actionLink = require('./action-link');
const templates = require('./message-templates');

const MOVE_WINDOW_MS = 30 * 60 * 1000;
const LINE_MAX = 120;
const LIST_NAME_MAX = 40;
const LIST_LIMIT = 30;
// What one save may spend reading the page, so a reply is never late for it.
// A read that runs past this saves the link unread and the enrich job reads
// it later; the list is then chosen from the platform alone.
const READ_BUDGET_MS = 3500;
// Backoff for a link that could not be read, by attempt: 1h, 6h, 24h, then no
// more (owner's brief). A link nobody can read is still saved.
const RETRY_AFTER_MS = [60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];

// The model has to copy every url it is shown — a list of rows is several
// links, and `actionLink.withLink` speaks about one.
const ROWS_VERBATIM = 'Each row\'s `url` reaches the person ONLY if you copy it into your reply exactly, '
  + 'every character, on a line of its own. Never retype, shorten or invent one.';

// What the platform alone says, for a link that could not be read.
const KIND_BY_PLATFORM = { youtube: 'video', tiktok: 'video', yad2: 'listing', maps: 'place' };

// A task made from a link starts with what you would DO with it.
const TASK_PREFIX = {
  he: { recipe: 'לנסות: ', video: 'לצפות: ', listing: 'לתאם צפייה: ' },
  en: { recipe: 'Try: ', video: 'Watch: ', listing: 'Book a viewing: ' },
};

function langOf(user) { return user && String(user.locale || '').startsWith('en') ? 'en' : 'he'; }
function nowOf(now) { return typeof now === 'function' ? now() : (now instanceof Date ? now.getTime() : (now || Date.now())); }

function withDeadline(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function cleanLine(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, LINE_MAX) : null;
}

// ---- lists --------------------------------------------------------------------

async function listsOf(client, userId) {
  const { rows } = await client.query(
    `SELECT l.id, l.name, l.emoji, l.created_auto,
            count(s.id)::int AS count,
            count(s.id) FILTER (WHERE s.status = 'new')::int AS fresh
       FROM saved_link_lists l
       LEFT JOIN saved_links s ON s.list_id = l.id AND s.deleted_at IS NULL
      WHERE l.user_id = $1 AND l.deleted_at IS NULL
      GROUP BY l.id ORDER BY l.position, l.id`,
    [userId]
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

// Recent titles per list, the ones THEY moved first: a move is a correction,
// and it is the best example of what a list is for.
async function examplesOf(client, userId) {
  const { rows } = await client.query(
    `SELECT list_id, title FROM (
       SELECT list_id, title, row_number() OVER (PARTITION BY list_id ORDER BY list_auto, created_at DESC) AS n
         FROM saved_links
        WHERE user_id = $1 AND deleted_at IS NULL AND list_id IS NOT NULL AND title IS NOT NULL
     ) x WHERE n <= 3`,
    [userId]
  );
  const out = {};
  for (const r of rows) (out[Number(r.list_id)] = out[Number(r.list_id)] || []).push(r.title);
  return out;
}

// The list by that name, made if it is not there. A soft-deleted list of the
// same name is not revived — it was deleted, and its links with it.
async function ensureList(client, userId, { name, emoji, auto }) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, LIST_NAME_MAX);
  if (!clean) return null;
  const found = await client.query(
    `SELECT id, name, emoji FROM saved_link_lists
      WHERE user_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL`,
    [userId, clean]
  );
  if (found.rows[0]) return { ...found.rows[0], id: Number(found.rows[0].id), created: false };
  const { rows } = await client.query(
    `INSERT INTO saved_link_lists (user_id, name, emoji, created_auto, position)
     VALUES ($1, $2, $3, $4,
       (SELECT COALESCE(max(position), 0) + 1 FROM saved_link_lists WHERE user_id = $1))
     ON CONFLICT (user_id, lower(name)) WHERE deleted_at IS NULL DO NOTHING
     RETURNING id, name, emoji`,
    [userId, clean, emoji || null, Boolean(auto)]
  );
  if (rows[0]) {
    await audit.record(client, userId, 'saved_list.created', { listId: Number(rows[0].id), auto: Boolean(auto) });
    return { ...rows[0], id: Number(rows[0].id), created: true };
  }
  // Lost a race to the same name: the other one is the list.
  return ensureList(client, userId, { name: clean, emoji, auto });
}

// ---- saving -------------------------------------------------------------------

async function liveByCanonical(client, userId, canonical) {
  const { rows } = await client.query(
    `SELECT s.*, l.name AS list_name, l.emoji AS list_emoji
       FROM saved_links s LEFT JOIN saved_link_lists l ON l.id = s.list_id
      WHERE s.user_id = $1 AND s.canonical_url = $2 AND s.deleted_at IS NULL`,
    [userId, canonical]
  );
  return rows[0] || null;
}

// Saving is TWO phases, and only the second holds a transaction (review of PR
// #802): reading a page is up to 3.5s on somebody else's server and choosing a
// list may be a 2s model call, and neither may sit inside an open tx on a
// 2-vCPU box whose pool every live turn shares.
//
// prepareSave(db, user, {urls, hint, list, now}, deps) → { lang, items }
//   `db` is a pool (or any client) used only for short reads. Every URL is
//   read AT ONCE under one shared deadline whose abort reaches each socket,
//   then a list is chosen for each. Nothing is written.
// commitSave(client, user, {line, messageId, now}, prepared) →
//   ok({ saved: [{ id, url, title, list, emoji, createdList, duplicate, savedAt, read }] })
//   Inside the caller's tx: the dedupe is asked again (another door may have
//   saved it meanwhile), a chosen list that has gone since is chosen again by
//   code, and the rows are written.
// saveUrls = both, on one client — for a caller that has nothing better.
//
// `hint` names a list the way a person writes it beside a link ("לחתונה",
// its ל stripped); `list` is a name handed over as a name (the tool), kept as
// it is; `line` is their own words about the link and is kept as the line
// under its title. `deps` carries `fetchImpl`, `lookup`, `complete`,
// `readBudgetMs`, `deadline` (an absolute ms the whole thing must finish
// inside) and `model: false`.
const COMMIT_RESERVE_MS = 400;
const CLASSIFY_FLOOR_MS = 300;

async function prepareSave(db, user, input = {}, deps = {}) {
  const userId = Number(user.id);
  const lang = langOf(user);
  const urls = [...new Set((input.urls || []).map(String))]
    .filter((u) => { const p = extract.normalize(u); return p && !extract.isOwnHost(new URL(p.url).hostname); })
    .slice(0, extract.MAX_URLS);
  const items = [];
  for (const url of urls) {
    const n = extract.normalize(url);
    const before = await liveByCanonical(db, userId, n.canonical);
    items.push({ url, n, dup: Boolean(before), read: null });
  }
  const end = Math.min(
    Date.now() + (deps.readBudgetMs || READ_BUDGET_MS),
    deps.deadline ? deps.deadline - COMMIT_RESERVE_MS : Infinity
  );
  const toRead = items.filter((it) => !it.dup);
  if (toRead.length && end - Date.now() > 0) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), end - Date.now());
    try {
      await Promise.all(toRead.map(async (it) => {
        it.read = await withDeadline(
          extract.extract(it.url, { fetchImpl: deps.fetchImpl, lookup: deps.lookup, lang, signal: ac.signal, deadline: end }),
          Math.max(0, end - Date.now()) + 50
        ) || null;
      }));
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
  }
  const hint = input.list || input.hint || null;
  let lists = null;
  let examples = {};
  for (const it of toRead) {
    if (it.read && it.read.canonical && it.read.canonical !== it.n.canonical
      && await liveByCanonical(db, userId, it.read.canonical)) { it.dup = true; continue; }
    if (!lists) {
      lists = await listsOf(db, userId);
      examples = lists.length ? await examplesOf(db, userId) : {};
    }
    const left = (deps.deadline || Infinity) - COMMIT_RESERVE_MS - Date.now();
    const classifyMs = Math.min(deps.classifyMs || classify.CLASSIFY_TIMEOUT_MS, left);
    const platform = (it.read && it.read.platform) || it.n.platform;
    it.kind = (it.read && it.read.kind) || KIND_BY_PLATFORM[platform] || null;
    it.platform = platform;
    it.choice = await classify.choose({
      meta: { platform, kind: it.kind, title: it.read && it.read.title, caption: it.read && it.read.caption },
      lists, examples, hint, exactName: Boolean(input.list), lang,
    }, {
      client: db, userId, complete: deps.complete, timeoutMs: classifyMs,
      model: deps.model === false || classifyMs < CLASSIFY_FLOOR_MS ? false : deps.model,
    });
  }
  return { lang, items };
}

async function commitSave(client, user, input = {}, prepared = {}) {
  const userId = Number(user.id);
  const now = nowOf(input.now);
  const ownLine = cleanLine(input.line);
  const saved = [];
  let lists = null;
  for (const it of prepared.items || []) {
    const { url, n, read } = it;
    const canonical = (read && read.canonical) || n.canonical;
    const before = await liveByCanonical(client, userId, n.canonical)
      || (canonical !== n.canonical ? await liveByCanonical(client, userId, canonical) : null);
    if (before) { saved.push(dupOf(before, url)); continue; }
    if (it.dup) continue;   // was saved when read, and is gone now: nothing to say
    let choice = it.choice;
    lists = lists || await listsOf(client, userId);
    let list = choice.listId ? lists.find((l) => l.id === choice.listId) : null;
    if (choice.listId && !list) {
      // Chosen a moment ago, deleted since: code chooses again, no model.
      choice = await classify.choose({ meta: { platform: it.platform, kind: it.kind }, lists, lang: prepared.lang }, { model: false });
      list = choice.listId ? lists.find((l) => l.id === choice.listId) : null;
    }
    if (!list) {
      list = await ensureList(client, userId, { name: choice.newName, emoji: choice.emoji, auto: choice.by !== 'hint' });
      if (list && list.created) lists = null;
    }

    const line = ownLine || (read && read.line) || null;
    const { rows } = await client.query(
      `INSERT INTO saved_links
         (user_id, list_id, list_auto, url, canonical_url, platform, kind, title, author, caption,
          recipe, image_url, line, line_by, extract_level, next_try_at, source_message_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, to_timestamp($18 / 1000.0))
       ON CONFLICT (user_id, canonical_url) WHERE deleted_at IS NULL DO NOTHING
       RETURNING *`,
      [userId, list ? list.id : null, choice.by !== 'hint', url, canonical, it.platform, it.kind,
        read && read.title, read && read.author, read && read.caption,
        read && read.recipe ? JSON.stringify(read.recipe) : null, read && read.image,
        line, ownLine ? userId : null,
        read ? read.level : 'none',
        // Unread: the enrich job's first try is now. Read: nothing left to
        // retry, the picture is the thumb pass's (dueForThumb).
        read ? null : new Date(now).toISOString(),
        input.messageId || null, now]
    );
    if (!rows[0]) {
      // The same link saved by another door in the same instant.
      const raced = await liveByCanonical(client, userId, canonical);
      if (raced) saved.push(dupOf(raced, url));
      continue;
    }
    await audit.record(client, userId, 'saved_link.saved', {
      linkId: Number(rows[0].id), listId: list ? list.id : null, platform: it.platform, kind: it.kind,
      read: read ? read.level : 'none', listBy: choice.by, createdList: Boolean(list && list.created),
    });
    saved.push({
      id: Number(rows[0].id), url, title: rows[0].title || null, line,
      list: list ? list.name : null, emoji: list ? list.emoji : null,
      createdList: Boolean(list && list.created), duplicate: false,
      savedAt: rows[0].created_at, read: Boolean(read),
    });
  }
  if (!saved.length) return err('invalid', 'no url that can be saved');
  return ok({ saved });
}

async function saveUrls(client, user, input = {}, deps = {}) {
  if (!(input.urls || []).length) return err('invalid', 'no url');
  const prepared = await prepareSave(client, user, input, deps);
  return commitSave(client, user, input, prepared);
}

function dupOf(row, url) {
  return {
    id: Number(row.id), url, title: row.title || null, line: row.line || null,
    list: row.list_name || null, emoji: row.list_emoji || null,
    createdList: false, duplicate: true, savedAt: row.created_at, read: row.extract_level !== 'none',
  };
}

// ---- reading back -------------------------------------------------------------

function rowOut(r) {
  return {
    id: Number(r.id), url: r.url, title: r.title || null, line: r.line || null,
    list: r.list_name || null, platform: r.platform, done: r.status === 'done',
    inTasks: Boolean(r.task_id), savedAt: r.created_at,
  };
}

const ROW_SQL = `
  SELECT s.*, l.name AS list_name,
         (SELECT t.id FROM tasks t WHERE t.saved_link_id = s.id AND t.archived_at IS NULL LIMIT 1) AS task_id
    FROM saved_links s LEFT JOIN saved_link_lists l ON l.id = s.list_id`;

async function findList(client, userId, name) {
  if (!name) return null;
  const lists = await listsOf(client, userId);
  return classify.matchList(name, lists, { exact: true });
}

// The links on one list, or the latest across all of them.
async function list(client, userId, { list: name, limit } = {}) {
  let listRow = null;
  if (name) {
    listRow = await findList(client, userId, name);
    if (!listRow) return err('not_found', `no saved list called "${name}"`, { lists: (await listsOf(client, userId)).map((l) => l.name) });
  }
  const { rows } = await client.query(
    `${ROW_SQL}
      WHERE s.user_id = $1 AND s.deleted_at IS NULL AND ($2::bigint IS NULL OR s.list_id = $2)
      ORDER BY s.created_at DESC LIMIT $3`,
    [userId, listRow ? listRow.id : null, Math.min(Number(limit) || LIST_LIMIT, LIST_LIMIT)]
  );
  return ok({ list: listRow ? listRow.name : null, links: rows.map(rowOut), sendLinksVerbatim: ROWS_VERBATIM });
}

// Every word must appear somewhere in the row or its list's name.
async function search(client, userId, { query } = {}) {
  const words = String(query || '').split(/\s+/).map((w) => w.trim()).filter((w) => w.length >= 2).slice(0, 5);
  if (!words.length) return err('invalid', 'query required');
  const params = [userId];
  const conds = words.map((w) => {
    params.push(`%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const p = `$${params.length}`;
    return `(s.title ILIKE ${p} OR s.caption ILIKE ${p} OR s.author ILIKE ${p} OR s.line ILIKE ${p} OR l.name ILIKE ${p})`;
  });
  const { rows } = await client.query(
    `${ROW_SQL}
      WHERE s.user_id = $1 AND s.deleted_at IS NULL AND ${conds.join(' AND ')}
      ORDER BY s.created_at DESC LIMIT ${LIST_LIMIT}`,
    params
  );
  return ok({ query: words.join(' '), links: rows.map(rowOut), sendLinksVerbatim: ROWS_VERBATIM });
}

// ---- changing one -------------------------------------------------------------

async function ownLink(client, userId, linkId) {
  const { rows } = await client.query(
    `${ROW_SQL} WHERE s.id = $1 AND s.user_id = $2 AND s.deleted_at IS NULL`,
    [Number(linkId), userId]
  );
  return rows[0] || null;
}

// The link they mean when they name none: their latest save, if it was in
// the last half hour. Older than that, "לחתונה" is not about a save.
async function latestSave(client, userId, now) {
  const { rows } = await client.query(
    `${ROW_SQL}
      WHERE s.user_id = $1 AND s.deleted_at IS NULL AND s.created_at > to_timestamp($2 / 1000.0)
      ORDER BY s.created_at DESC, s.id DESC LIMIT 1`,
    [userId, nowOf(now) - MOVE_WINDOW_MS]
  );
  return rows[0] || null;
}

async function target(client, userId, { linkId, now }) {
  if (linkId) {
    const row = await ownLink(client, userId, linkId);
    return row ? ok(row) : err('not_found', 'no such saved link');
  }
  const row = await latestSave(client, userId, now);
  return row ? ok(row) : err('not_found', 'nothing saved in the last 30 minutes — give link_id (search first)', { reason: 'no_recent' });
}

async function move(client, userId, { linkId, list: name, now } = {}) {
  if (!name || !String(name).trim()) return err('invalid', 'list required');
  const t = await target(client, userId, { linkId, now });
  if (!t.ok) return t;
  const lists = await listsOf(client, userId);
  // A name handed over as a name: nothing stripped (classify.hintForms).
  const hit = classify.matchList(name, lists, { exact: true });
  const dest = hit || await ensureList(client, userId, { name: classify.nameFromHint(name, { exact: true }), auto: false });
  if (!dest) return err('invalid', 'list required');
  await client.query(
    `UPDATE saved_links SET list_id = $1, list_auto = false, touched_at = now() WHERE id = $2`,
    [dest.id, t.data.id]
  );
  await audit.record(client, userId, 'saved_link.moved', {
    linkId: Number(t.data.id), from: t.data.list_id ? Number(t.data.list_id) : null, to: dest.id, createdList: Boolean(dest.created),
  });
  return ok({ id: Number(t.data.id), title: t.data.title || null, from: t.data.list_name || null, list: dest.name, createdList: Boolean(dest.created) });
}

// Anybody may change the line; whoever wrote it last is who it is by.
async function setLine(client, userId, { linkId, line, now } = {}) {
  const t = await target(client, userId, { linkId, now });
  if (!t.ok) return t;
  const clean = cleanLine(line);
  await client.query(
    `UPDATE saved_links SET line = $1, line_by = $2, touched_at = now() WHERE id = $3`,
    [clean, clean ? userId : null, t.data.id]
  );
  await audit.record(client, userId, 'saved_link.line_set', { linkId: Number(t.data.id), cleared: !clean });
  return ok({ id: Number(t.data.id), title: t.data.title || null, line: clean });
}

async function setStatus(client, userId, { linkId, done } = {}) {
  const row = linkId ? await ownLink(client, userId, linkId) : null;
  if (!row) return err('not_found', 'no such saved link — give link_id');
  const status = done === false ? 'new' : 'done';
  await client.query(`UPDATE saved_links SET status = $1, touched_at = now() WHERE id = $2`, [status, row.id]);
  await audit.record(client, userId, 'saved_link.status', { linkId: Number(row.id), status });
  return ok({ id: Number(row.id), title: row.title || null, done: status === 'done' });
}

// Soft, so the page's "ביטול" and `restore` can bring it back.
async function remove(client, userId, { linkId, now } = {}) {
  const t = await target(client, userId, { linkId, now });
  if (!t.ok) return t;
  await client.query(`UPDATE saved_links SET deleted_at = now() WHERE id = $1`, [t.data.id]);
  await audit.record(client, userId, 'saved_link.deleted', { linkId: Number(t.data.id) });
  return ok({ id: Number(t.data.id), title: t.data.title || null, deleted: true });
}

async function restore(client, userId, { linkId } = {}) {
  const { rows } = await client.query(
    `UPDATE saved_links s SET deleted_at = NULL
      WHERE s.id = $1 AND s.user_id = $2 AND s.deleted_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM saved_links o WHERE o.user_id = s.user_id
                         AND o.canonical_url = s.canonical_url AND o.deleted_at IS NULL)
      RETURNING id`,
    [Number(linkId), userId]
  );
  if (!rows[0]) return err('not_found', 'nothing to restore');
  await audit.record(client, userId, 'saved_link.restored', { linkId: Number(rows[0].id) });
  return ok({ id: Number(rows[0].id), restored: true });
}

// An ordinary task that carries the link. Refused when one already does.
async function toTask(client, user, { linkId } = {}) {
  const userId = Number(user.id);
  const row = linkId ? await ownLink(client, userId, linkId) : null;
  if (!row) return err('not_found', 'no such saved link — give link_id');
  if (row.task_id) return err('conflict', 'already a task', { taskId: Number(row.task_id) });
  const tasks = require('./tasks');
  const lang = langOf(user);
  const prefix = (TASK_PREFIX[lang] || TASK_PREFIX.he)[row.kind] || '';
  let name = row.title;
  if (!name) { try { name = new URL(row.url).hostname.replace(/^www\./, ''); } catch { name = row.url; } }
  const made = await tasks.addTask(client, userId, { title: `${prefix}${name}`.slice(0, 200), source: 'saved_link' });
  if (!made.ok) return made;
  const task = made.data && made.data.task;
  if (!task || !task.id) return err('conflict', 'the task was not created as one row');
  await client.query(`UPDATE tasks SET saved_link_id = $1 WHERE id = $2`, [row.id, task.id]);
  await audit.record(client, userId, 'saved_link.to_task', { linkId: Number(row.id), taskId: Number(task.id) });
  return ok({ id: Number(row.id), taskId: Number(task.id), task: task.title });
}

// ---- the lists themselves -----------------------------------------------------

async function lists(client, userId) {
  const rows = await listsOf(client, userId);
  return ok({ lists: rows.map((l) => ({ id: l.id, name: l.name, emoji: l.emoji || null, links: l.count, fresh: l.fresh })) });
}

async function renameList(client, userId, { list: name, to } = {}) {
  const row = await findList(client, userId, name);
  if (!row) return err('not_found', `no saved list called "${name}"`);
  const clean = String(to || '').replace(/\s+/g, ' ').trim().slice(0, LIST_NAME_MAX);
  if (!clean) return err('invalid', 'new name required');
  const clash = await client.query(
    `SELECT 1 FROM saved_link_lists WHERE user_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL AND id <> $3`,
    [userId, clean, row.id]
  );
  if (clash.rows[0]) return err('conflict', `a list called "${clean}" already exists — move links there instead`);
  await client.query(`UPDATE saved_link_lists SET name = $1, created_auto = false WHERE id = $2`, [clean, row.id]);
  await audit.record(client, userId, 'saved_list.renamed', { listId: row.id });
  return ok({ list: clean, was: row.name });
}

// The list and every link on it go together, under one stamp, so the undo
// brings back exactly what this deleted and nothing deleted before it.
async function deleteList(client, userId, { list: name } = {}) {
  const row = await findList(client, userId, name);
  if (!row) return err('not_found', `no saved list called "${name}"`);
  const { rows } = await client.query(`UPDATE saved_link_lists SET deleted_at = now() WHERE id = $1 RETURNING deleted_at`, [row.id]);
  const gone = await client.query(
    `UPDATE saved_links SET deleted_at = $2 WHERE list_id = $1 AND deleted_at IS NULL`,
    [row.id, rows[0].deleted_at]
  );
  await audit.record(client, userId, 'saved_list.deleted', { listId: row.id, links: gone.rowCount });
  return ok({ list: row.name, deleted: true, links: gone.rowCount });
}

// ---- the shortcut's reading of a message -------------------------------------

const SHORTCUT_MAX_CHARS = 2000;
const HINT_MAX_WORDS = 3;

// A message the shortcut may answer: one to five links and, at most, a few
// words beside them. `null` for anything else — that is a model turn.
function parseShortcut(body) {
  const text = String(body == null ? '' : body);
  if (!text.trim() || text.length > SHORTCUT_MAX_CHARS) return null;
  const all = extract.findUrls(text);
  // A link to OUR pages (their /me, a coordination's page) is never saved —
  // it is somebody's sign-in, and a message carrying one is about it, so it
  // goes to the model whole, whatever else is beside it (review of PR #802).
  if (!all.length || all.length > extract.MAX_URLS || all.some((u) => extract.isOwnHost(new URL(u).hostname))) return null;
  const urls = all;
  let rest = text;
  for (const u of urls) rest = rest.split(u).join(' ');
  // Only words count: an emoji or a dash beside a link says nothing.
  rest = rest.replace(/[^\p{L}\p{N}\s\-־']/gu, ' ').replace(/\s+/g, ' ').trim();
  if (rest && rest.split(' ').length > HINT_MAX_WORDS) return null;
  return { urls, rest: rest || null };
}

// The words beside a link are a list's name only when they plainly are one:
// "לחתונה" (a ל in front), or the name of a list they have, or of a starter.
// Anything else ("מה דעתך") is a sentence, and a sentence goes to the model.
// Words that only ask to save ("שמרי לי", "תודה") say nothing about a list.
// A ל in front is also how Hebrew spells a verb ("לנסות", "לראות"), so a
// verb is never a list's name — that message goes to the model, which can
// tell "לנסות" from "לנסיעה".
// `undefined` = not a shortcut; `null` = no hint, save by the link alone.
const FILLER = new Set(['שמור', 'שמרי', 'תשמור', 'תשמרי', 'לשמור', 'שמירה', 'לי', 'את', 'זה', 'זאת', 'תודה',
  'בבקשה', 'save', 'this', 'please', 'pls', 'thanks', 'for', 'me', 'later']);
const VERB_RE = /^ל(ראות|קרוא|נסות|קנות|צפות|בדוק|זכור|בשל|הכין|שמוע|הזמין|עשות|שלוח|הראות|שתף|ספר|הוסיף|העביר)$/;

// A ל word that is a question or a preposition, never a list ("link למה?"
// opened a list called "מה" — review of PR #802). The new-list door is also
// ONE word: "ל חתונה של דנה" is a sentence, and a sentence is the model's.
const NOT_A_LIST = new Set(['למה', 'לאן', 'לפני', 'לפי', 'לדעתך', 'לדעתי', 'לדעתכם', 'לגבי', 'לכן', 'למשל',
  'לפעמים', 'לא', 'לבד', 'לגמרי', 'לאט', 'למרות', 'לעולם', 'לכל', 'לפחות', 'לעומת', 'לכאן', 'לשם', 'לאחר',
  'לך', 'לו', 'לה', 'לנו', 'לכם', 'להם', 'להן', 'למי', 'לכמה', 'לבינתיים', 'לעכשיו', 'להיום', 'למחר']);

function shortcutHint(rest, lists) {
  if (!rest) return null;
  const words = rest.split(' ').filter((w) => !FILLER.has(w.toLowerCase()));
  if (!words.length) return null;
  // Before any matching: "למה" stripped to "מה" is inside half the names
  // anybody could have ("מתכונים מהירים").
  if (words.some((w) => NOT_A_LIST.has(w))) return undefined;
  const hint = words.join(' ');
  if (classify.matchList(hint, lists)) return hint;
  const starters = Object.values(classify.STARTERS).flatMap((set) => Object.values(set))
    .map((st, i) => ({ id: i, name: st.name }));
  if (classify.matchList(hint, starters)) return hint;
  if (words.length !== 1 || VERB_RE.test(words[0])) return undefined;
  const m = /^ל[-־]?(\S+)$/.exec(hint);
  return m && m[1].length >= 2 ? hint : undefined;
}

// A page's title as it may stand inside OUR sentence (review of PR #802): no
// link — a title carrying a URL would put a link in front of them that nobody
// chose to send — and no WhatsApp markup, or "*SALE*" bolds half the reply
// and an underscore pairs with one in the list's name. Somebody else's words,
// so trimmed rather than trusted.
const TITLE_URL = /(?:\bhttps?:\/\/|\bwww\.)\S+|\b[\w-]+(?:\.[\w-]+)+\/\S*/gi;
function cleanTitle(t, max = 80) {
  const s = String(t == null ? '' : t).replace(TITLE_URL, ' ').replace(/[*_~`]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function countWords(n, lang) {
  if (lang === 'en') return n === 1 ? '1 link' : `${n} links`;
  return n === 1 ? 'קישור אחד' : `${n} קישורים`;
}

// The sentence the shortcut answers with. Every item must carry a list — the
// caller does not claim a save it cannot name. `now` may be a clock function.
function shortcutReply(items, { lang = 'he', now, timezone, overrides } = {}) {
  const about = (t) => { const c = cleanTitle(t); return c ? `— ${c}` : ''; };
  const name = (l) => String(l || '').replace(/[*_~`]/g, '').trim();
  // Only a save made NOW says so: not read, or read with no title to show
  // (Instagram's front door gives a picture and nothing else). `read` is
  // absent on a row that never went through the read, and a duplicate is not
  // news about the page.
  const unread = (it) => !it.duplicate && (it.read === false || (it.read === true && !cleanTitle(it.title)));
  let text;
  if (items.length === 1) {
    const it = items[0];
    text = it.duplicate
      ? templates.render(templates.keyFor('saved_link_dup', lang),
        { list: name(it.list), when: savedWhen(it.savedAt, now, timezone, lang) }, overrides)
      : templates.render(templates.keyFor(`${it.createdList ? 'saved_link_new_list' : 'saved_link'}${unread(it) ? '_unread' : ''}`, lang),
        { list: name(it.list), emoji: it.emoji || '', about: about(it.title) }, overrides);
  } else {
    // "ב" before the list is not style: a line with no Hebrew letter in it
    // ("• *Wedding* — Rick Astley - Never Gonna…") is the reply gate's
    // `english` tier for a Hebrew reader, and the cut takes the whole reply.
    const at = lang === 'en' ? '' : 'ב';
    const lines = items.map((it) => {
      const where = it.duplicate
        ? (lang === 'en' ? `already in *${name(it.list)}*` : `כבר שמור ב*${name(it.list)}*`)
        : `${at}*${name(it.list)}*`;
      const a = unread(it)
        ? (lang === 'en' ? '— couldn’t read it' : '— לא הצלחתי לקרוא מה יש בו')
        : about(it.title);
      return `• ${where}${a ? ` ${a}` : ''}`;
    }).join('\n');
    const fresh = items.filter((it) => !it.duplicate).length;
    text = fresh
      ? templates.render(templates.keyFor('saved_link_many', lang), { count: countWords(fresh, lang), lines }, overrides)
      : templates.render(templates.keyFor('saved_link_many_dup', lang), { lines }, overrides);
  }
  // What an empty value left behind: "*חתונה*  —" with no emoji, or a space
  // at a line's end.
  return text.split('\n').map((l) => l.replace(/[ \t]{2,}/g, ' ').replace(/\s+$/, '')).join('\n');
}

// "היום", "אתמול", "ה־3.10" — when a link was saved, in their clock.
function savedWhen(savedAt, now, tz, lang) {
  const day = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  const then = day(savedAt);
  const today = day(nowOf(now));
  const yesterday = day(nowOf(now) - 24 * 60 * 60 * 1000);
  const en = lang === 'en';
  if (then === today) return en ? 'today' : 'היום';
  if (then === yesterday) return en ? 'yesterday' : 'אתמול';
  const [, m, d] = then.split('-').map(Number);
  return en ? `on ${d}.${m}` : `ה־${d}.${m}`;
}

// ---- the enrich job's half ----------------------------------------------------

// Links never read, or whose read failed, and whose next try is due.
async function dueForEnrich(client, { now, limit = 20 } = {}) {
  const { rows } = await client.query(
    `SELECT s.id, s.user_id, s.url, s.line_by, s.extract_attempts, u.locale
       FROM saved_links s JOIN users u ON u.id = s.user_id
      WHERE s.deleted_at IS NULL AND s.extract_level IN ('none', 'failed')
        AND s.next_try_at IS NOT NULL AND s.next_try_at <= to_timestamp($1 / 1000.0)
      ORDER BY s.next_try_at LIMIT $2`,
    [nowOf(now), limit]
  );
  return rows;
}

// Writes what a read returned. A person's line is never overwritten; an
// unreadable link is tried again on the backoff and then left alone.
async function applyRead(client, row, read, { now } = {}) {
  const t = nowOf(now);
  if (!read) {
    const attempts = Number(row.extract_attempts) + 1;
    const wait = RETRY_AFTER_MS[attempts - 1];
    await client.query(
      `UPDATE saved_links SET extract_level = 'failed', extract_attempts = $2, extract_error = 'unreadable',
              next_try_at = $3 WHERE id = $1`,
      [row.id, attempts, wait ? new Date(t + wait).toISOString() : null]
    );
    return { read: false, attempts };
  }
  await client.query(
    `UPDATE saved_links SET
        title = COALESCE(title, $2), author = COALESCE(author, $3), caption = COALESCE(caption, $4),
        recipe = COALESCE(recipe, $5), image_url = COALESCE(image_url, $6),
        kind = COALESCE(kind, $7),
        line = CASE WHEN line_by IS NULL THEN COALESCE($8, line) ELSE line END,
        extract_level = $9, extract_attempts = extract_attempts + 1, extract_error = NULL, next_try_at = NULL
      WHERE id = $1`,
    [row.id, read.title, read.author, read.caption, read.recipe ? JSON.stringify(read.recipe) : null,
      read.image, read.kind, read.line, read.level]
  );
  return { read: true, level: read.level };
}

// Links read with a picture whose bytes are not kept yet.
async function dueForThumb(client, { limit = 20 } = {}) {
  const { rows } = await client.query(
    `SELECT s.id, s.image_url FROM saved_links s
      WHERE s.deleted_at IS NULL AND s.image_url IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM saved_link_thumbs t WHERE t.link_id = s.id)
      ORDER BY s.created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

// Stores the picture, or forgets a picture that could not be fetched so it is
// not asked for again on every pass.
async function storeThumb(client, linkId, image) {
  if (!image) {
    await client.query(`UPDATE saved_links SET image_url = NULL WHERE id = $1`, [linkId]);
    return false;
  }
  await client.query(
    `INSERT INTO saved_link_thumbs (link_id, mime, bytes) VALUES ($1, $2, $3)
     ON CONFLICT (link_id) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, fetched_at = now()`,
    [linkId, image.mime, image.bytes]
  );
  return true;
}

module.exports = {
  saveUrls, prepareSave, commitSave, parseShortcut, shortcutReply, cleanTitle, shortcutHint, savedWhen, list, search, move, setLine, setStatus, remove, restore, toTask,
  lists, renameList, deleteList, listsOf, ensureList,
  dueForEnrich, applyRead, dueForThumb, storeThumb,
  withLink: actionLink.withLink,
  MOVE_WINDOW_MS, READ_BUDGET_MS, RETRY_AFTER_MS, ROWS_VERBATIM,
};
