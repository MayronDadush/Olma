'use strict';
// Saved links ("שמורים", docs/design/saved-links-handoff.md): the domain, the
// list it goes into, the WhatsApp shortcut for a message that is only a link,
// the plugin's half of that shortcut, and the job that reads late. Every page
// is a fixture behind an injected fetch; nothing here leaves the machine.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const saved = require('../src/domain/saved-links');
const classify = require('../src/domain/link-classify');
const templates = require('../src/domain/message-templates');
const replyLeak = require('../src/domain/reply-leak');
const enrich = require('../src/jobs/saved-links-enrich');
process.env.OLMA_PLUGIN_TRACE = path.join(os.tmpdir(), `saved-links-plugin-test-${process.pid}.log`);

const F = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'links', n));
const PUBLIC = async () => [{ address: '93.184.216.34', family: 4 }];
const ok = (body, type) => () => new Response(body, { status: 200, headers: { 'content-type': type } });
function fakeFetch(routes, seen = []) {
  return async (url) => {
    seen.push(url);
    for (const [re, res] of routes) if (re.test(url)) return res();
    return new Response('no', { status: 404 });
  };
}
const SITES = [
  [/youtube\.com\/oembed/, ok(F('yt.json'), 'application/json')],
  [/tiktok\.com\/oembed/, ok(F('tt.json'), 'application/json')],
  [/yad2\.co\.il/, ok(F('yad2.html'), 'text/html')],
  [/10dakot/, ok(F('dakot.html'), 'text/html; charset=utf-8')],
  [/img\.example\.com/, ok(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg')],
];
const DEPS = { fetchImpl: fakeFetch(SITES), lookup: PUBLIC, model: false };
const DOWN = { fetchImpl: async () => { throw new Error('offline'); }, lookup: PUBLIC, model: false };

const YT = 'https://youtu.be/dQw4w9WgXcQ?si=abc';
const RECIPE = 'https://www.10dakot.co.il/recipe/chocolate/';
const FLAT = 'https://www.yad2.co.il/realestate/item/tel-aviv-area/abc123';

let db, now, n = 0;
before(async () => {
  db = await freshDb();
  now = Date.parse('2026-10-08T10:00:00Z');
});
after(async () => { await db.teardown(); });

async function person(extra = {}) {
  n += 1;
  const u = await makeUser(db.pool, `+97250777${String(n).padStart(4, '0')}`, extra);
  await db.pool.query(`UPDATE users SET agent_id = $2 WHERE id = $1`, [u.id, `u-${u.id}`]);
  const { rows } = await db.pool.query(`SELECT * FROM users WHERE id = $1`, [u.id]);
  return rows[0];
}
const tx = (fn) => withTx(db.pool, fn);
const save = (u, input, deps = DEPS) => tx((c) => saved.saveUrls(c, u, { now, ...input }, deps));

// ---- which list ------------------------------------------------------------------
test('a link goes to the starter list for what it is, made the first time it is needed', async () => {
  const u = await person();
  const r = await save(u, { urls: [RECIPE] });
  assert.equal(r.ok, true);
  const [it] = r.data.saved;
  assert.deepEqual({ list: it.list, emoji: it.emoji, createdList: it.createdList, read: it.read },
    { list: 'מתכונים', emoji: '🍝', createdList: true, read: true });
  assert.equal(it.title, 'עוגת שוקולד לילדים');
  const flat = (await save(u, { urls: [FLAT] })).data.saved[0];
  assert.equal(flat.list, 'דירות');
  assert.equal(flat.line, '₪10,000 · 5 חד׳ · 105 מ״ר · קומה 2', 'what was read becomes the line');
  const video = (await save(u, { urls: [YT] })).data.saved[0];
  assert.equal(video.list, 'לצפות אחר כך');
  const second = (await save(u, { urls: ['https://www.10dakot.co.il/recipe/other/'] })).data.saved[0];
  assert.equal(second.list, 'מתכונים');
  assert.equal(second.createdList, false, 'the starter is made once');
});

test('an English reader gets English starters', async () => {
  const u = await person({ locale: 'en' });
  const it = (await save(u, { urls: [YT] })).data.saved[0];
  assert.equal(it.list, 'Watch later');
});

test('"לחתונה" beside a link opens a list called חתונה, and the next one finds it', async () => {
  const u = await person();
  const a = (await save(u, { urls: [RECIPE], hint: 'לחתונה' })).data.saved[0];
  assert.deepEqual({ list: a.list, createdList: a.createdList }, { list: 'חתונה', createdList: true });
  const b = (await save(u, { urls: [YT], hint: 'ל-חתונה' })).data.saved[0];
  assert.deepEqual({ list: b.list, createdList: b.createdList }, { list: 'חתונה', createdList: false });
});

test('a name handed over AS a name keeps its first ל', async () => {
  const u = await person();
  const a = (await save(u, { urls: [RECIPE], list: 'לימודים' })).data.saved[0];
  assert.equal(a.list, 'לימודים', 'never "ימודים"');
  await save(u, { urls: [YT] });
  const moved = await tx((c) => saved.move(c, u.id, { list: 'לונדון', now }));
  assert.equal(moved.data.list, 'לונדון');
});

test('the model may only pick among THEIR lists, and any failure falls back to the starter', async () => {
  const lists = [{ id: 1, name: 'חתונה' }, { id: 2, name: 'מתכונים' }];
  const meta = { platform: 'web', kind: 'recipe', title: 'עוגה' };
  const answer = (text) => ({ complete: async () => ({ ok: true, text, model: 'm' }) });
  assert.deepEqual(await classify.choose({ meta, lists }, answer('{"list_id": 1}')), { listId: 1, by: 'model' });
  assert.deepEqual(await classify.choose({ meta, lists }, answer('{"list_id": 99}')), { listId: 2, by: 'kind' },
    'an id that is not theirs is no answer');
  assert.deepEqual(await classify.choose({ meta, lists }, answer('{"list_id": null}')), { listId: 2, by: 'kind' });
  assert.deepEqual(await classify.choose({ meta, lists }, answer('not json')), { listId: 2, by: 'kind' });
  assert.deepEqual(await classify.choose({ meta, lists }, { complete: async () => { throw new Error('timeout'); } }),
    { listId: 2, by: 'kind' });
  let asked = 0;
  const counting = { complete: async () => { asked += 1; return { ok: true, text: '{"list_id": 1}' }; } };
  await classify.choose({ meta, lists: [{ id: 2, name: 'מתכונים' }] }, counting);
  assert.equal(asked, 0, 'only starter lists: nothing to choose between, no call');
  await classify.choose({ meta, lists, hint: 'לחתונה' }, counting);
  assert.equal(asked, 0, 'a hint is never second-guessed');
});

test('the prompt fences the link as data and carries no instruction from it', () => {
  const u = classify.starterFor('nonsense', 'he');
  assert.equal(u.name, 'השראה');
  assert.equal(classify.matchList('החתונה', [{ id: 1, name: 'חתונה של דנה' }, { id: 2, name: 'חתונה' }]).id, 2,
    'an exact name beats a near one');
  assert.equal(classify.matchList('חתונה', [{ id: 1, name: 'חתונה של דנה' }, { id: 2, name: 'חתונה של גל' }]), null,
    'two near names are no match');
});

// ---- the same link twice --------------------------------------------------------------
test('the same thing saved twice is ONE row, said to be already there', async () => {
  const u = await person();
  const first = (await save(u, { urls: [YT] })).data.saved[0];
  const again = (await save(u, { urls: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=whatsapp'] })).data.saved[0];
  assert.equal(again.duplicate, true);
  assert.equal(again.id, first.id);
  assert.equal(again.list, 'לצפות אחר כך');
  const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM saved_links WHERE user_id = $1`, [u.id]);
  assert.equal(rows[0].n, 1);
  // Somebody else saving it is their own row.
  const v = await person();
  assert.equal((await save(v, { urls: [YT] })).data.saved[0].duplicate, false);
});

test('a page that cannot be read is still saved, unread, and the job reads it later', async () => {
  const u = await person();
  const it = (await save(u, { urls: [RECIPE] }, DOWN)).data.saved[0];
  assert.equal(it.read, false);
  assert.equal(it.title, null);
  assert.equal(it.list, 'השראה', 'unread, the kind is unknown');
  const before = await db.pool.query(`SELECT next_try_at, extract_level, list_id FROM saved_links WHERE id = $1`, [it.id]);
  assert.equal(before.rows[0].extract_level, 'none');
  assert.ok(before.rows[0].next_try_at);

  const out = await enrich.run(db.pool, { ...DEPS, now: now + 1000 });
  assert.ok(out.read >= 1);
  const { rows } = await db.pool.query(`SELECT * FROM saved_links WHERE id = $1`, [it.id]);
  assert.equal(rows[0].title, 'עוגת שוקולד לילדים');
  assert.equal(rows[0].kind, 'recipe');
  assert.equal(rows[0].next_try_at, null);
  assert.equal(rows[0].list_id, before.rows[0].list_id,
    'a late read never moves a link they may already have looked for');
});

// The save is the first read; the job tries again at once (the save may only
// have run out of time), then after 1h, 6h and 24h, and then never.
test('a read that keeps failing backs off 1h, 6h, 24h, and then stops', async () => {
  const u = await person();
  const it = (await save(u, { urls: ['https://dead.example.com/x'] }, DOWN)).data.saved[0];
  const tries = [];
  let t = now;
  for (let i = 0; i < 5; i += 1) {
    t += 25 * 60 * 60 * 1000;
    await enrich.run(db.pool, { ...DOWN, now: t });
    const { rows } = await db.pool.query(`SELECT extract_attempts, next_try_at FROM saved_links WHERE id = $1`, [it.id]);
    tries.push({ attempts: rows[0].extract_attempts, next: rows[0].next_try_at && rows[0].next_try_at.getTime() - t });
  }
  assert.deepEqual(tries.map((x) => x.attempts), [1, 2, 3, 4, 4], 'the fifth tick finds nothing due');
  assert.deepEqual(tries.slice(0, 3).map((x) => x.next), saved.RETRY_AFTER_MS);
  assert.equal(tries[3].next, null, 'given up: still saved, never tried again');
  const { rows } = await db.pool.query(`SELECT deleted_at FROM saved_links WHERE id = $1`, [it.id]);
  assert.equal(rows[0].deleted_at, null);
});

test('the job keeps the picture\'s BYTES, and a picture that is not one is let go', async () => {
  const u = await person();
  const it = (await save(u, { urls: [YT] }, { ...DEPS, fetchImpl: fakeFetch(SITES) })).data.saved[0];
  await db.pool.query(`UPDATE saved_links SET image_url = 'https://img.example.com/a.jpg' WHERE id = $1`, [it.id]);
  const out = await enrich.run(db.pool, { ...DEPS, now });
  assert.ok(out.thumbs >= 1);
  const { rows } = await db.pool.query(`SELECT mime, octet_length(bytes) AS size FROM saved_link_thumbs WHERE link_id = $1`, [it.id]);
  assert.deepEqual(rows[0], { mime: 'image/jpeg', size: 4 });
  const bad = (await save(u, { urls: [FLAT] })).data.saved[0];
  await db.pool.query(`UPDATE saved_links SET image_url = 'https://nothing.example.com/x' WHERE id = $1`, [bad.id]);
  await enrich.run(db.pool, { ...DEPS, now });
  const gone = await db.pool.query(`SELECT image_url FROM saved_links WHERE id = $1`, [bad.id]);
  assert.equal(gone.rows[0].image_url, null, 'not asked again every five minutes');
});

// ---- changing one ----------------------------------------------------------------------------
test('"לחתונה" after a save moves the latest one, but only inside half an hour', async () => {
  const u = await person();
  const it = (await save(u, { urls: [RECIPE] })).data.saved[0];
  const moved = await tx((c) => saved.move(c, u.id, { list: 'חתונה', now: now + 60_000 }));
  assert.deepEqual({ id: moved.data.id, from: moved.data.from, list: moved.data.list, createdList: moved.data.createdList },
    { id: it.id, from: 'מתכונים', list: 'חתונה', createdList: true });
  const late = await tx((c) => saved.move(c, u.id, { list: 'חתונה', now: now + saved.MOVE_WINDOW_MS + 60_000 }));
  assert.equal(late.ok, false);
  assert.equal(late.error.code, 'not_found');
  const { rows } = await db.pool.query(`SELECT list_auto FROM saved_links WHERE id = $1`, [it.id]);
  assert.equal(rows[0].list_auto, false, 'a list they chose is not a guess any more');
});

test('their own words are the line, and a late read never writes over them', async () => {
  const u = await person();
  const it = (await save(u, { urls: [FLAT], line: 'לשאול על חניה' }, DOWN)).data.saved[0];
  assert.equal(it.line, 'לשאול על חניה');
  await enrich.run(db.pool, { ...DEPS, now: now + 1000 });
  const { rows } = await db.pool.query(`SELECT line, line_by, title FROM saved_links WHERE id = $1`, [it.id]);
  assert.equal(rows[0].line, 'לשאול על חניה');
  assert.equal(Number(rows[0].line_by), Number(u.id));
  assert.match(rows[0].title, /^דירה/, 'the rest of the read still lands');

  const read = (await save(u, { urls: [RECIPE] })).data.saved[0];
  const set = await tx((c) => saved.setLine(c, u.id, { linkId: read.id, line: '  בלי   סוכר  ' }));
  assert.equal(set.data.line, 'בלי סוכר');
  const long = await tx((c) => saved.setLine(c, u.id, { linkId: read.id, line: 'א'.repeat(500) }));
  assert.ok(long.data.line.length <= 120);
  const cleared = await tx((c) => saved.setLine(c, u.id, { linkId: read.id, line: '' }));
  assert.equal(cleared.data.line, null);
});

test('list, search, done, delete and restore', async () => {
  const u = await person();
  const a = (await save(u, { urls: [RECIPE] })).data.saved[0];
  const b = (await save(u, { urls: [YT] })).data.saved[0];
  const all = await tx((c) => saved.list(c, u.id, {}));
  assert.deepEqual(all.data.links.map((l) => l.id).sort(), [a.id, b.id].sort());
  assert.ok(all.data.sendLinksVerbatim);
  const recipes = await tx((c) => saved.list(c, u.id, { list: 'מתכונים' }));
  assert.deepEqual(recipes.data.links.map((l) => l.id), [a.id]);
  const none = await tx((c) => saved.list(c, u.id, { list: 'אין כזו' }));
  assert.equal(none.ok, false);
  assert.ok(none.error.lists.includes('מתכונים'), 'a wrong name is answered with the real ones');

  assert.deepEqual((await tx((c) => saved.search(c, u.id, { query: 'שוקולד' }))).data.links.map((l) => l.id), [a.id]);
  assert.deepEqual((await tx((c) => saved.search(c, u.id, { query: 'astley' }))).data.links.map((l) => l.id), [b.id]);
  assert.deepEqual((await tx((c) => saved.search(c, u.id, { query: '100%_' }))).data.links, [], 'wildcards are literal');

  assert.equal((await tx((c) => saved.setStatus(c, u.id, { linkId: a.id, done: true }))).data.done, true);
  assert.equal((await tx((c) => saved.list(c, u.id, { list: 'מתכונים' }))).data.links[0].done, true);

  await tx((c) => saved.remove(c, u.id, { linkId: a.id }));
  assert.equal((await tx((c) => saved.list(c, u.id, { list: 'מתכונים' }))).data.links.length, 0);
  // Saved again while deleted: a new row, and the old one can no longer come back over it.
  const again = (await save(u, { urls: [RECIPE] })).data.saved[0];
  assert.equal(again.duplicate, false);
  assert.equal((await tx((c) => saved.restore(c, u.id, { linkId: a.id }))).ok, false);
  await tx((c) => saved.remove(c, u.id, { linkId: again.id }));
  assert.equal((await tx((c) => saved.restore(c, u.id, { linkId: a.id }))).ok, true);
});

test('nobody reads or changes somebody else\'s link', async () => {
  const u = await person();
  const v = await person();
  const it = (await save(u, { urls: [RECIPE] })).data.saved[0];
  for (const r of [
    await tx((c) => saved.move(c, v.id, { linkId: it.id, list: 'שלי' })),
    await tx((c) => saved.setLine(c, v.id, { linkId: it.id, line: 'x' })),
    await tx((c) => saved.setStatus(c, v.id, { linkId: it.id })),
    await tx((c) => saved.remove(c, v.id, { linkId: it.id })),
    await tx((c) => saved.toTask(c, v, { linkId: it.id })),
  ]) assert.equal(r.ok, false);
  assert.equal((await tx((c) => saved.search(c, v.id, { query: 'שוקולד' }))).data.links.length, 0);
});

test('to_task makes an ordinary task that carries the link, once', async () => {
  const u = await person();
  const it = (await save(u, { urls: [RECIPE] })).data.saved[0];
  const t = await tx((c) => saved.toTask(c, u, { linkId: it.id }));
  assert.equal(t.ok, true);
  assert.equal(t.data.task, 'לנסות: עוגת שוקולד לילדים');
  const { rows } = await db.pool.query(`SELECT saved_link_id, due_at, archived_at FROM tasks WHERE id = $1`, [t.data.taskId]);
  assert.equal(Number(rows[0].saved_link_id), it.id);
  assert.equal(rows[0].due_at, null, 'a link has no date, and neither does the task made from it');
  const twice = await tx((c) => saved.toTask(c, u, { linkId: it.id }));
  assert.equal(twice.error.code, 'conflict');
  assert.equal((await tx((c) => saved.list(c, u.id, {}))).data.links[0].inTasks, true);
  const unread = (await save(u, { urls: ['https://dead.example.com/page'] }, DOWN)).data.saved[0];
  assert.equal((await tx((c) => saved.toTask(c, u, { linkId: unread.id }))).data.task, 'dead.example.com',
    'with no title, the site');
});

// ---- the tool ---------------------------------------------------------------------
// One tool, eleven actions (tests/tool-schema-budget.test.js says why). The
// save action reaches the network, so it is driven here only up to its
// refusal; every other action runs end to end on links saved with fixtures.
test('saved_links: every action is one door, names itself in the result, and only a change earns a 👍', async () => {
  const { BY_NAME } = require('../src/adapters/mcp/registry');
  const reactions = require('../src/domain/reactions');
  const t = BY_NAME.get('saved_links');
  assert.ok(t, 'registered');
  assert.ok(t.description.length <= 700);
  const call = (u, a) => tx((c) => t.handler(c, u, a));
  const u = await person();
  // Saved on the live clock: the tool's move-with-no-id reads it too.
  const it = (await save(u, { urls: [RECIPE], now: Date.now() })).data.saved[0];

  assert.equal((await call(u, { action: 'save' })).error.code, 'invalid', 'save needs a url');
  assert.match((await call(u, { action: 'fly' })).error.message, /save, move, list/);

  const listed = await call(u, { action: 'list', list: 'מתכונים' });
  assert.equal(listed.data.action, 'list');
  assert.equal(listed.data.links[0].url, RECIPE);
  assert.ok(listed.data.sendLinksVerbatim, 'a row carrying a url says how it reaches them');
  assert.equal((await call(u, { action: 'search', query: 'שוקולד' })).data.links[0].id, it.id);

  // "לחתונה" right after the save, with no id: the latest one moves.
  const moved = await call(u, { action: 'move', list: 'חתונה' });
  assert.deepEqual({ id: moved.data.id, list: moved.data.list, from: moved.data.from }, { id: it.id, list: 'חתונה', from: 'מתכונים' });
  assert.equal((await call(u, { action: 'set_line', link_id: it.id, line: 'לקינוח' })).data.line, 'לקינוח');
  assert.equal((await call(u, { action: 'done', link_id: it.id })).data.done, true);
  assert.equal((await call(u, { action: 'to_task', link_id: it.id })).data.task, 'לנסות: עוגת שוקולד לילדים');
  assert.ok((await call(u, { action: 'lists' })).data.lists.some((l) => l.name === 'חתונה'));
  assert.equal((await call(u, { action: 'rename_list', list: 'חתונה', name: 'החתונה של דנה' })).data.list, 'החתונה של דנה');
  assert.equal((await call(u, { action: 'delete', link_id: it.id })).data.deleted, true);
  assert.equal((await call(u, { action: 'delete_list', list: 'החתונה של דנה' })).data.deleted, true);

  const mark = (action) => reactions.stateFor('saved_links', { ok: true, data: { action } });
  for (const w of ['move', 'set_line', 'done', 'delete', 'rename_list', 'delete_list', 'to_task']) assert.equal(mark(w), 'done', w);
  // Owner, 2026-10-08: a save's reply says what and where; a 👍 beside it is
  // the same thing twice.
  assert.equal(mark('save'), undefined, 'a save is answered in words, not a 👍');
  for (const r of ['list', 'search', 'lists']) assert.equal(mark(r), undefined, `${r} is a read`);
  assert.equal(reactions.stateFor('saved_links', { ok: false, error: {} }), undefined);
});

test('the lists: renamed, refused onto a name in use, deleted with their links and nothing else', async () => {
  const u = await person();
  const a = (await save(u, { urls: [RECIPE] })).data.saved[0];
  await save(u, { urls: [YT] });
  assert.equal((await tx((c) => saved.renameList(c, u.id, { list: 'מתכונים', to: 'אוכל' }))).data.list, 'אוכל');
  assert.equal((await tx((c) => saved.renameList(c, u.id, { list: 'אוכל', to: 'לצפות אחר כך' }))).error.code, 'conflict');
  const del = await tx((c) => saved.deleteList(c, u.id, { list: 'אוכל' }));
  assert.equal(del.data.links, 1);
  const left = await tx((c) => saved.lists(c, u.id));
  assert.deepEqual(left.data.lists.map((l) => l.name), ['לצפות אחר כך']);
  const { rows } = await db.pool.query(`SELECT deleted_at FROM saved_links WHERE id = $1`, [a.id]);
  assert.ok(rows[0].deleted_at);
});

// ---- the shortcut: what it reads -----------------------------------------------------------------
test('a message is the shortcut only when it is links and, at most, a few words', () => {
  assert.deepEqual(saved.parseShortcut(YT), { urls: [YT], rest: null });
  assert.deepEqual(saved.parseShortcut(`${YT} 🔥🔥`), { urls: [YT], rest: null });
  assert.deepEqual(saved.parseShortcut(`לחתונה ${RECIPE}`), { urls: [RECIPE], rest: 'לחתונה' });
  assert.equal(saved.parseShortcut(`${YT} תראי איזה מגניב זה בדיוק מה שדיברנו`), null);
  assert.equal(saved.parseShortcut('אין פה קישור'), null);
  assert.equal(saved.parseShortcut(Array.from({ length: 6 }, (_, i) => `https://e.com/${i}`).join(' ')), null);
  assert.equal(saved.parseShortcut(`${YT} ${'א'.repeat(2100)}`), null);
});

test('the words beside it are a list only when they plainly are one', () => {
  const lists = [{ id: 1, name: 'חתונה' }];
  assert.equal(saved.shortcutHint(null, lists), null);
  assert.equal(saved.shortcutHint('שמרי לי', lists), null, 'asking to save names no list');
  assert.equal(saved.shortcutHint('תודה', lists), null);
  assert.equal(saved.shortcutHint('לחתונה', lists), 'לחתונה');
  assert.equal(saved.shortcutHint('חתונה', lists), 'חתונה', 'a list they have, by its name');
  assert.equal(saved.shortcutHint('מתכונים', lists), 'מתכונים', 'a starter, by its name');
  assert.equal(saved.shortcutHint('לטיול', lists), 'לטיול', 'one word with a ל opens a list');
  assert.equal(saved.shortcutHint('לטיול ביפן', lists), undefined, 'two words are a sentence: the model\'s');
  // Review of PR #802: "link למה?" opened a list called "מה".
  for (const w of ['למה', 'לאן', 'לפני', 'לדעתך', 'לך', 'לגבי']) assert.equal(saved.shortcutHint(w, lists), undefined, w);
  assert.equal(saved.shortcutHint(saved.parseShortcut(`${YT} למה?`).rest, lists), undefined);
  assert.equal(saved.shortcutHint('למה', [{ id: 2, name: 'מתכונים מהירים' }]), undefined, 'not even into a list it is inside');
  assert.equal(saved.shortcutHint('מה דעתך', lists), undefined, 'a sentence is a model turn');
  assert.equal(saved.shortcutHint('לנסות', lists), undefined, 'a verb is not a list');
  assert.equal(saved.shortcutHint('לראות אחר כך', lists), undefined);
});

// Review of PR #802: a message carrying OUR link is about it — their /me, a
// coordination's page — and is never saved, whatever is beside it.
test('a link to our own pages is never the shortcut, and never saved', async () => {
  for (const own of ['https://allma.world/me?t=abc', 'https://allma.world./me', 'https://olmachat.duckdns.org/x',
    'http://157.230.210.233/', 'https://www.allma.world/meetings/5']) {
    assert.equal(saved.parseShortcut(own), null, own);
    assert.equal(saved.parseShortcut(`${YT} ${own}`), null, `${own} beside another link`);
  }
  const u = await person();
  const r = await save(u, { urls: ['https://allma.world/me?t=abc'] });
  assert.equal(r.ok, false);
  const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM saved_links WHERE user_id = $1`, [u.id]);
  assert.equal(rows[0].n, 0);
});

test('a title is never a link or markup inside our sentence', () => {
  assert.equal(saved.cleanTitle('*SALE* _today_ ~50%~ `code`'), 'SALE today 50% code');
  assert.equal(saved.cleanTitle('Win big at https://evil.example/x now'), 'Win big at now');
  assert.equal(saved.cleanTitle('go to www.evil.example today'), 'go to today');
  assert.equal(saved.cleanTitle('see allma.world/me?t=x'), 'see');
  assert.equal(saved.cleanTitle('Example.com'), 'Example.com', 'a bare site name is a name');
  assert.equal(saved.cleanTitle('***'), null);
  const text = saved.shortcutReply([{ list: 'מתכונים', emoji: '🍝', title: '*Best* cake https://x.example/y', createdList: false }], { lang: 'he' });
  assert.equal(text, 'שמרתי ב*מתכונים* 🍝 — Best cake\nאפשר לענות בשם של רשימה אחרת כדי להעביר');
});

test('a mixed message counts only what was saved now, and English says how to move too', () => {
  const items = [
    { list: 'Recipes', title: 'Cake', duplicate: false },
    { list: 'Watch later', title: 'A talk', duplicate: true },
  ];
  assert.equal(saved.shortcutReply(items, { lang: 'en' }),
    'Saved 1 link:\n• *Recipes* — Cake\n• already in *Watch later* — A talk\nReply with another list name to move the last one');
  assert.match(saved.shortcutReply(items.map((i) => ({ ...i, list: i.list === 'Recipes' ? 'מתכונים' : 'לצפות' })), { lang: 'he' }),
    /^שמרתי קישור אחד:\n• ב\*מתכונים\* — Cake\n• כבר שמור ב\*לצפות\* — A talk\n/);
});

test('brokerd past the plugin\'s deadline saves nothing, claims nothing, marks nothing', async () => {
  const marks = [];
  const broker = createBrokerServer({
    pool: db.pool, now: () => now, saveLinks: DEPS,
    placeMark: (o) => { marks.push(o); return { attempted: true }; },
  });
  const u = await person();
  const r = await broker.dispatch({ id: 1, method: 'save_link_shortcut',
    params: { agentId: `u-${u.id}`, body: RECIPE, messageId: '3EB0LATE01', deadline: Date.now() - 1 } });
  assert.equal(r.claim, false);
  const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM saved_links WHERE user_id = $1`, [u.id]);
  assert.equal(rows[0].n, 0, 'the model saves it, once');
  await broker.dispatch({ id: 1, method: 'turn_open', params: { agentId: `u-${u.id}`, messageId: '3EB0LATE01' } });
  assert.equal(broker.pendingCount(), 1, 'the turn that now answers it is left to adopt it');
  assert.ok(!marks.some((m) => m.messageId === '3EB0LATE01' && m.state === 'done'));
});

test('the tool\'s save reads BEFORE the transaction and only writes inside it', async () => {
  const { BY_NAME } = require('../src/adapters/mcp/registry');
  const t = BY_NAME.get('saved_links');
  const u = await person();
  const seen = [];
  const links = { ...DEPS, fetchImpl: fakeFetch(SITES, seen) };
  const prepared = await t.prepare(db.pool, u, { action: 'save', url: RECIPE }, { links });
  assert.equal(seen.length, 1, 'the page was read in prepare');
  const noNet = { ...DEPS, fetchImpl: async () => { throw new Error('the write phase must not fetch'); } };
  const r = await tx((c) => t.handler(c, u, { action: 'save', url: RECIPE }, { prepared, links: noNet }));
  assert.equal(r.ok, true);
  assert.equal(r.data.saved[0].title, 'עוגת שוקולד לילדים');
  assert.equal(await t.prepare(db.pool, u, { action: 'list' }, { links }), undefined, 'only a save prepares');
  const other = await person();
  const r2 = await tx((c) => t.handler(c, other, { action: 'save', url: RECIPE }, { prepared, links: DEPS }));
  assert.equal(r2.data.saved[0].duplicate, false, 'somebody else\'s prepared read is never used');
});

test('when it was saved is said in their clock', () => {
  const t = Date.parse('2026-10-08T21:30:00Z');   // 00:30 on the 9th in Jerusalem
  assert.equal(saved.savedWhen('2026-10-08T21:00:00Z', t, 'Asia/Jerusalem', 'he'), 'היום');
  assert.equal(saved.savedWhen('2026-10-08T12:00:00Z', t, 'Asia/Jerusalem', 'he'), 'אתמול');
  assert.equal(saved.savedWhen('2026-10-03T12:00:00Z', t, 'Asia/Jerusalem', 'he'), 'ה־3.10');
  assert.equal(saved.savedWhen('2026-10-03T12:00:00Z', t, 'Asia/Jerusalem', 'en'), 'on 3.10');
});

// ---- the shortcut: brokerd ------------------------------------------------------------------------
test('brokerd saves, answers in the owner\'s words, and claims the message', async () => {
  const marks = [];
  const broker = createBrokerServer({
    pool: db.pool, now: () => now, saveLinks: DEPS,
    placeMark: (o) => { marks.push(o); return { attempted: true }; },
  });
  const u = await person();
  const ask = (body, messageId) => broker.dispatch({ id: 1, method: 'save_link_shortcut', params: { agentId: `u-${u.id}`, body, messageId } });

  const one = await ask(RECIPE, '3EB0SAVE0001');
  assert.equal(one.claim, true);
  assert.equal(one.text, 'פתחתי רשימה חדשה: *מתכונים* 🍝 — עוגת שוקולד לילדים\nאפשר לענות בשם של רשימה אחרת כדי להעביר');
  const two = await ask(`${YT} לחתונה`, '3EB0SAVE0002');
  assert.match(two.text, /^פתחתי רשימה חדשה: \*חתונה\* — Rick Astley/);
  assert.doesNotMatch(two.text, / \n/, 'an empty emoji leaves no trailing space');
  const dup = await ask(YT, '3EB0SAVE0003');
  assert.equal(dup.text, 'כבר שמור לך ב*חתונה* מהיום');
  const many = await ask(`${FLAT}\nhttps://www.10dakot.co.il/recipe/another/`, '3EB0SAVE0004');
  assert.match(many.text, /^שמרתי 2 קישורים:\n• ב\*דירות\* — דירה, /);

  const again = await ask(`${YT} ${FLAT}`, '3EB0SAVE0005');
  assert.equal(again.text, 'כולם כבר שמורים אצלך:\n• כבר שמור ב*חתונה* — Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)\n'
    + '• כבר שמור ב*דירות* — דירה, הדוגמה 1, רמת אביב ג\', תל אביב יפו', 'all already saved never says "saved N"');

  // No mark at all on a save (owner, 2026-10-08) — and a turn_open landing
  // after the answer puts none on either: not the 👍, not a 👀.
  assert.deepEqual(marks.filter((m) => m.messageId === '3EB0SAVE0001'), []);
  await broker.dispatch({ id: 1, method: 'turn_open', params: { agentId: `u-${u.id}`, messageId: '3EB0SAVE0001' } });
  assert.equal(broker.pendingCount(), 0, 'the hook\'s open is not left waiting for a turn');
  assert.deepEqual(marks.filter((m) => m.messageId === '3EB0SAVE0001'), [], 'no mark, whichever lands first');
  const audit = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'saved_link.shortcut' ORDER BY id`, [u.id]);
  assert.deepEqual(audit.rows.map((r) => r.detail), [
    { links: 1, duplicates: 0, hint: false }, { links: 1, duplicates: 0, hint: true },
    { links: 1, duplicates: 1, hint: false }, { links: 2, duplicates: 0, hint: false },
    { links: 2, duplicates: 2, hint: false },
  ]);
  assert.ok(!JSON.stringify(audit.rows).includes('youtu'), 'the shortcut\'s audit carries no URL');
});

test('brokerd leaves everything else to the model', async () => {
  const broker = createBrokerServer({ pool: db.pool, now: () => now, saveLinks: DEPS, placeMark: () => ({}) });
  const u = await person();
  const ask = (agentId, body) => broker.dispatch({ id: 1, method: 'save_link_shortcut', params: { agentId, body } });
  assert.deepEqual(await ask(`u-${u.id}`, `${YT} מה דעתך`), { ok: true, claim: false });
  assert.deepEqual(await ask(`u-${u.id}`, `${YT} לנסות`), { ok: true, claim: false });
  assert.deepEqual(await ask(`u-${u.id}`, 'שלום'), { ok: true, claim: false });
  assert.deepEqual(await ask('intake', YT), { ok: true, claim: false });
  assert.deepEqual(await ask('g-3', YT), { ok: true, claim: false });
  assert.deepEqual(await ask('u-999999', YT), { ok: true, claim: false });
  const ev = await person();
  await db.pool.query(`UPDATE users SET is_eval = true WHERE id = $1`, [ev.id]);
  assert.deepEqual(await ask(`u-${ev.id}`, YT), { ok: true, claim: false });
  const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM saved_links WHERE user_id = ANY($1)`, [[u.id, ev.id]]);
  assert.equal(rows[0].n, 0, 'nothing declined was saved');
});

test('every sentence the shortcut can say passes the reply gate, whoever is reading', () => {
  const vars = {
    list: 'לצפות אחר כך', emoji: '🎬', about: '— Rick Astley - Never Gonna Give You Up (Official Video)', when: 'אתמול', count: '2',
    lines: '• ב*Wedding* — Rick Astley - Never Gonna Give You Up\n• ב*מתכונים* — עוגת שוקולד',
  };
  for (const base of ['saved_link', 'saved_link_new_list', 'saved_link_dup', 'saved_link_many', 'saved_link_many_dup']) {
    for (const lang of ['he', 'en']) {
      const text = templates.render(templates.keyFor(base, lang), vars, {});
      // An English sentence goes only to somebody whose locale is English, and
      // writesHebrew is never true for them (domain/language.js).
      for (const readerWritesHebrew of lang === 'he' ? [true, false, null] : [false, null]) {
        const v = replyLeak.gateReply(text, { readerWritesHebrew });
        assert.equal(v.action, 'pass', `${base}/${lang} to readerWritesHebrew=${readerWritesHebrew}: ${JSON.stringify(v)}`);
      }
    }
  }
});

// ---- the shortcut: the plugin ----------------------------------------------------------------------
function fakeConnect(reply) {
  const sent = [];
  const connect = () => {
    const h = {};
    const s = {
      on(ev, fn) { h[ev] = fn; return s; },
      write(x) { sent.push(JSON.parse(x)); setTimeout(() => h.data && h.data(JSON.stringify(reply) + '\n'), 0); },
      end() { h.close && h.close(); }, destroy() {},
    };
    setTimeout(() => h.connect && h.connect(), 0);
    return s;
  };
  return { connect, sent };
}
const DM = 'agent:u-3:whatsapp:direct:+972526269826';

test('the plugin claims only an explicit claim, and never carries the link in its trace', async () => {
  const plugin = await import('../gateway-plugin/olma-turn/index.js');
  const log = [];
  const { connect, sent } = fakeConnect({ id: 1, ok: true, claim: true, text: 'שמרתי ב*מתכונים* 🍝' });
  const h = plugin.buildSaveLinkHandler({ connect, log: (o) => log.push(o) });
  assert.deepEqual(await h({ sessionKey: DM, body: RECIPE, messageId: '3EB0X' }, {}), { handled: true, text: 'שמרתי ב*מתכונים* 🍝' });
  assert.equal(sent[0].method, 'save_link_shortcut');
  const { deadline, ...params } = sent[0].params;
  assert.deepEqual(params, { agentId: 'u-3', body: RECIPE, messageId: '3EB0X' });
  assert.ok(deadline > Date.now() && deadline <= Date.now() + 8000, 'the plugin says when it stops waiting');
  assert.ok(!JSON.stringify(log).includes('10dakot'));

  const mk = (reply) => plugin.buildSaveLinkHandler({ connect: fakeConnect(reply).connect, log: () => {} });
  assert.equal(await mk({ id: 1, ok: true, claim: false })({ sessionKey: DM, body: RECIPE }, {}), undefined);
  assert.equal(await mk({ id: 1, ok: true, claim: true })({ sessionKey: DM, body: RECIPE }, {}), undefined, 'no text, no claim');
  assert.equal(await mk({ id: 1, ok: false })({ sessionKey: DM, body: RECIPE }, {}), undefined);
  const never = fakeConnect({ id: 1, ok: true, claim: true, text: 'x' });
  const quiet = plugin.buildSaveLinkHandler({ connect: never.connect, log: () => {} });
  assert.equal(await quiet({ sessionKey: DM, body: 'שלום' }, {}), undefined);
  assert.equal(await quiet({ sessionKey: 'agent:g-3:whatsapp:group:123@g.us', body: RECIPE }, {}), undefined);
  assert.equal(await quiet({ sessionKey: 'agent:intake:whatsapp:direct:+972500000000', body: RECIPE }, {}), undefined);
  assert.equal(await quiet({ sessionKey: DM, body: `${RECIPE} ${'x'.repeat(2100)}` }, {}), undefined);
  assert.equal(never.sent.length, 0, 'none of those reached brokerd');
  const dead = plugin.buildSaveLinkHandler({ connect: () => { throw new Error('no socket'); }, log: () => {} });
  assert.equal(await dead({ sessionKey: DM, body: RECIPE }, {}), undefined, 'a dead socket is the model\'s turn');
});
