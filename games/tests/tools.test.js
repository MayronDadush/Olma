'use strict';
// Olma's six tools, end to end: a real gamesd on a random port, a real
// database, the box-only POST /api/tool, and — last — the MCP shim itself
// spawned the way the gateway spawns it. brokerd is replaced by `identify`
// and by the `send` under the real close announcement: the two seams
// createServer takes for it.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { freshDb } = require('./helpers');
const { createServer } = require('../src/server');
const { TOOL_DEFS, IDENTITY_PARAM } = require('../src/tool-defs');
const { announceClose } = require('../src/announce');

const TOK = n => 'olma_tok_' + String(n).repeat(32).slice(0, 32);
const PEOPLE = {
  [TOK(1)]: { ok: true, user: { id: 101, name: 'מיכל', timezone: 'Asia/Jerusalem', locale: 'he' }, packs: ['games'] },
  [TOK(2)]: { ok: true, user: { id: 102, name: 'Sam', timezone: 'Europe/London', locale: 'en' }, packs: ['games'] },
  [TOK(3)]: { ok: true, user: { id: 103, name: 'בלי', timezone: null, locale: 'he' }, packs: [] },
};
const identify = async token => PEOPLE[token] || { ok: false, error: { code: 'forbidden', message: 'unknown identity token — re-read AGENTS.md' } };

// brokerd's `game_summary`, as far as gamesd can see it: every call recorded,
// every linked id queued. A test that wants it down passes its own `send`.
const queueAll = async x => ({ ok: true, queued: x.userIds, skipped: [] });

async function boot(t, { send = queueAll, ...opts } = {}) {
  const pool = await freshDb(t);
  const sent = [];
  const announce = (p, nightId, state) => announceClose(p, nightId, state, { send: async x => { sent.push(x); return send(x); } });
  const server = createServer({ pool, publicBase: 'https://allma.test', page: '<!doctype html>', identify, announce, ...opts });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeListeners(); server.close(r); }));
  const port = server.address().port;
  const raw = (name, args, headers = {}) => fetch(`http://127.0.0.1:${port}/api/tool`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ name, args }),
  });
  const call = async (tok, name, args = {}) => {
    const r = await raw(name, { [IDENTITY_PARAM]: tok, ...args });
    assert.equal(r.status, 200);
    return (await r.json()).text;
  };
  const okOf = async (tok, name, args) => {
    const text = await call(tok, name, args);
    assert.match(text, /^OK /, text);
    return JSON.parse(text.slice(3));
  };
  return { pool, port, raw, call, okOf, sent };
}

test('every definition fits Olma\'s limits: identity first and required, under 700 characters, six unique names', () => {
  assert.equal(TOOL_DEFS.length, 6);
  assert.equal(new Set(TOOL_DEFS.map(d => d.name)).size, 6);
  for (const d of TOOL_DEFS) {
    assert.ok(d.description.length <= 700, d.name);
    assert.equal(Object.keys(d.inputSchema.properties)[0], IDENTITY_PARAM, d.name);
    assert.equal(d.inputSchema.required[0], IDENTITY_PARAM, d.name);
  }
});

test('the route is the box\'s alone, and only for somebody brokerd says holds the pack', async t => {
  const { raw, call } = await boot(t);
  assert.equal((await raw('my_game_status', { [IDENTITY_PARAM]: TOK(1) }, { 'X-Forwarded-For': '203.0.113.9' })).status, 404);
  assert.match(await call(TOK(3), 'my_game_status'), /^ERROR forbidden: game nights are not turned on/);
  // the shim self-heals on this exact wording, so it is passed through
  assert.match(await call(TOK(9), 'my_game_status'), /^ERROR forbidden: unknown identity token/);
  assert.match(await call(TOK(1), 'drop_tables'), /^ERROR unknown_tool/);
  assert.match(await call(TOK(1), 'my_game_status'), /^ERROR no_night: /);
});

test('brokerd unreachable is said, never read as a refusal or a pass', async t => {
  const { call } = await boot(t, { identify: async () => { throw new Error('connect ENOENT'); } });
  assert.match(await call(TOK(1), 'my_game_status'), /^ERROR unavailable: .*ENOENT/);
});

test('a whole night through the tools: buy-ins, a cancel, food, a count that is off, then closes', async t => {
  const { pool, call, okOf, sent } = await boot(t);
  const night = await okOf(TOK(1), 'start_game_night', { price: 50, chips: 1000, players: ['יוסי'] });
  assert.match(night.url, /^https:\/\/allma\.test\/night\/[A-Za-z0-9]{22}$/);
  assert.deepEqual(night.players, ['מיכל', 'יוסי'], 'the host sits first, under their own name');
  const linked = (await pool.query(`SELECT name, user_id, linked_via FROM players WHERE user_id IS NOT NULL`)).rows;
  assert.deepEqual(linked, [{ name: 'מיכל', user_id: 101, linked_via: 'host' }]);
  assert.match(await call(TOK(1), 'start_game_night', { price: 50, chips: 1000 }), /^ERROR already_open: .*night_code|^ERROR already_open: .*code/);

  let b = await okOf(TOK(1), 'add_buyin');
  assert.deepEqual([b.player, b.buyins, b.paid], ['מיכל', 1, 50]);
  await okOf(TOK(1), 'add_buyin', { player: ' יוסי ' });
  b = await okOf(TOK(1), 'add_buyin', { player: 'יוסי' });
  assert.equal(b.buyins, 2);
  b = await okOf(TOK(1), 'add_buyin', { player: 'רון', n: 0.5 });
  assert.deepEqual([b.added_to_table, b.buyins], [true, 0.5]);
  b = await okOf(TOK(1), 'add_buyin', { player: 'רון', cancel: true });
  assert.deepEqual([b.cancelled, b.buyins], [true, 0]);
  assert.match(await call(TOK(1), 'add_buyin', { player: 'רון', cancel: true }), /^ERROR nothing_to_cancel/);
  await okOf(TOK(1), 'add_buyin', { player: 'רון' });
  assert.match(await call(TOK(1), 'add_buyin', { n: 2 }), /^ERROR bad_number/);

  const st = await okOf(TOK(1), 'my_game_status');
  assert.deepEqual([st.buyins, st.paid, st.pot, st.players, st.chips_reported], [1, 50, 200, 3, null]);

  const ask = await okOf(TOK(1), 'add_food_order', { what: 'פיצה', amount: 120 });
  assert.deepEqual([ask.saved, ask.players], [false, ['מיכל', 'יוסי', 'רון']], 'no eaters: nothing written, the names to ask about');
  assert.equal((await pool.query('SELECT count(*)::int n FROM food')).rows[0].n, 0);
  assert.match(await call(TOK(1), 'add_food_order', { what: 'פיצה', amount: 120, eaters: ['מיכל', 'דני'] }), /^ERROR not_found: דני is not at the table; players: מיכל, יוסי, רון/);
  const food = await okOf(TOK(1), 'add_food_order', { what: 'פיצה', amount: 120, eaters: ['מיכל', 'יוסי', 'רון'] });
  assert.deepEqual([food.saved, food.each, food.settled], [true, 40, 'with the poker']);

  let r = await okOf(TOK(1), 'report_chips', { chips: 2000 });
  assert.deepEqual(r.waiting_for, ['יוסי', 'רון']);
  await okOf(TOK(1), 'report_chips', { chips: 1000, player: 'יוסי' });
  r = await okOf(TOK(1), 'report_chips', { chips: 999, player: 'רון' });
  assert.deepEqual([r.closed, r.count_off, r.chips], [false, 'missing', 1]);
  assert.equal(sent.length, 0, 'nothing is announced before the count closes');
  r = await okOf(TOK(1), 'report_chips', { chips: 1000, player: 'רון' });
  assert.equal(r.closed, true);
  // The settlement went out as its own message, drawn by code; the model is
  // handed no text to rewrite. The owner's first night came back as the
  // model's own "מירון → יוסי", an arrow that reads backwards in Hebrew.
  assert.equal(r.summary_sent, true);
  assert.ok(!('text' in r) && !('relay' in r), JSON.stringify(r));
  assert.match(r.note, /Do not write out any name, amount or transfer/);
  assert.equal(sent.length, 1);
  const nightId = (await pool.query('SELECT id FROM nights WHERE code = $1', [night.night_code])).rows[0].id;
  assert.deepEqual([sent[0].nightId, sent[0].userIds], [Number(nightId), [101]], 'only the linked player; יוסי and רון are names, not users');
  const { he, en } = sent[0].texts;
  assert.doesNotMatch(he + en, /→/);
  // מיכל +50 poker +80 food, יוסי −50 −40, רון 0 −40
  assert.match(he, /^סיכום ערב פוקר\n/);
  assert.match(he, /מיוסי למיכל: ⁦90 ₪⁩\nמרון למיכל: ⁦40 ₪⁩\n\(כולל האוכל\)$/);
  assert.match(en, /pays ⁨מיכל⁩: ₪90\n/);

  // Asked for afterwards, the same drawing comes back to relay, and asking
  // announces nothing a second time.
  const sum = await okOf(TOK(1), 'game_night_summary', { night_code: night.night_code.toLowerCase() });
  assert.equal(sum.text, he);
  assert.match(sum.relay, /exactly as given/);
  assert.equal(sent.length, 1);

  // Every change is in the page's log, in the page's words, marked as Olma's.
  const log = (await pool.query(`SELECT t FROM log WHERE via = 'olma' ORDER BY at, id`)).rows.map(x => x.t);
  for (const line of ['מיכל + כניסה', 'רון בשולחן', 'רון + חצי כניסה', 'רון − חצי כניסה', "רון: נשארו 1,000 ז'יטונים"]) {
    assert.ok(log.includes(line), `log has "${line}": ${JSON.stringify(log)}`);
  }
  assert.ok(log.some(l => l.startsWith('🍕 פיצה, ⁦120 ₪⁩ · 💳 מיכל')), JSON.stringify(log));
  assert.equal((await pool.query('SELECT count(*)::int n FROM game_results')).rows[0].n, 3, 'a closed count writes results, same as the page');
});

test('a player of somebody else\'s night cannot reach it, two open nights are asked about, and English reads English', async t => {
  const { pool, call, okOf, sent } = await boot(t);
  const a = await okOf(TOK(1), 'start_game_night', { price: 20, chips: 100, name: 'ראשון' });
  assert.match(await call(TOK(2), 'my_game_status'), /^ERROR no_night/, 'Sam holds no seat in it');

  // A second open night for the same person (the page's own next-night button
  // can make one): the tools stop and name both.
  const b = await okOf(TOK(2), 'start_game_night', { price: 20, chips: 100, name: 'Second' });
  await pool.query(
    `INSERT INTO players (night_id, id, name, ord, user_id, linked_at, linked_via)
     SELECT id, 'pmichal', 'מיכל', 1e12, 101, now(), 'invite' FROM nights WHERE code = $1`, [b.night_code]);
  const amb = await call(TOK(1), 'add_buyin');
  assert.match(amb, /^ERROR ambiguous: /);
  assert.ok(amb.includes(a.night_code) && amb.includes(b.night_code), amb);
  assert.equal((await okOf(TOK(1), 'add_buyin', { night_code: a.night_code })).buyins, 1);

  await okOf(TOK(2), 'add_buyin', { night_code: b.night_code });
  await okOf(TOK(1), 'add_buyin', { night_code: b.night_code });
  await okOf(TOK(1), 'report_chips', { night_code: b.night_code, chips: 100 });
  const sam = await okOf(TOK(2), 'report_chips', { night_code: b.night_code, chips: 100 });
  assert.equal(sam.closed, true);
  assert.equal(sam.summary_sent, true);
  assert.deepEqual(sent.at(-1).userIds.sort(), [101, 102]);
  assert.match(sent.at(-1).texts.en, /^Second — settlement\nBuy-in ₪20 = 100 chips\n\nNo transfers$/);
});

test('English transfers are words between isolated names, so a Hebrew name cannot turn the line around', async t => {
  const { pool, okOf, sent } = await boot(t);
  const night = await okOf(TOK(2), 'start_game_night', { price: 20, chips: 100 });
  await pool.query(
    `INSERT INTO players (night_id, id, name, ord, user_id, linked_at, linked_via)
     SELECT id, 'pmichal', 'מיכל', 1e12, 101, now(), 'invite' FROM nights WHERE code = $1`, [night.night_code]);
  await okOf(TOK(2), 'add_buyin');
  await okOf(TOK(1), 'add_buyin');
  await okOf(TOK(1), 'report_chips', { chips: 150 });
  const r = await okOf(TOK(2), 'report_chips', { chips: 50 });
  assert.equal(r.closed, true);
  const en = sent.at(-1).texts.en;
  assert.ok(en.endsWith('\u200E\u2068Sam\u2069 pays \u2068מיכל\u2069: ₪10'), JSON.stringify(en));
});

// A night that closes on a report and nothing reached brokerd: the person
// asking still gets the settlement, as the drawn text to relay.
async function closeOneNight(okOf) {
  await okOf(TOK(1), 'start_game_night', { price: 20, chips: 100, players: ['יוסי'] });
  await okOf(TOK(1), 'add_buyin');
  await okOf(TOK(1), 'add_buyin', { player: 'יוסי' });
  await okOf(TOK(1), 'report_chips', { chips: 150 });
  return okOf(TOK(1), 'report_chips', { chips: 50, player: 'יוסי' });
}

test('brokerd down, or refusing, or not queueing the caller: the text comes back to relay instead', async t => {
  for (const send of [
    async () => { throw new Error('connect ENOENT'); },
    async () => ({ ok: false, error: { code: 'bad_args', message: 'nope' } }),
    async () => ({ ok: true, queued: [], skipped: [101] }),
  ]) {
    const { okOf } = await boot(t, { send });
    const r = await closeOneNight(okOf);
    assert.equal(r.closed, true);
    assert.equal(r.summary_sent, false);
    assert.match(r.relay, /exactly as given/);
    assert.match(r.text, /מיוסי למיכל: ⁦10 ₪⁩$/);
  }
});

test('taking back a buy-in that makes the count close announces it too', async t => {
  const { okOf, sent } = await boot(t);
  await okOf(TOK(1), 'start_game_night', { price: 20, chips: 100, players: ['יוסי'] });
  await okOf(TOK(1), 'add_buyin');
  await okOf(TOK(1), 'add_buyin', { player: 'יוסי' });
  await okOf(TOK(1), 'add_buyin', { player: 'יוסי' });
  await okOf(TOK(1), 'report_chips', { chips: 150 });
  const off = await okOf(TOK(1), 'report_chips', { chips: 50, player: 'יוסי' });
  assert.deepEqual([off.closed, off.count_off], [false, 'missing']);
  const b = await okOf(TOK(1), 'add_buyin', { player: 'יוסי', cancel: true });
  assert.deepEqual([b.closed, b.summary_sent, 'text' in b], [true, true, false]);
  assert.equal(sent.length, 1);
});

test('a night with nobody on Olma at the table asks brokerd nothing', async t => {
  const { pool, okOf, sent } = await boot(t);
  await closeOneNight(okOf);
  assert.equal(sent.length, 1);
  // The same night, its only linked seat let go: announcing it reaches nobody.
  await pool.query('UPDATE players SET user_id = NULL');
  const { id } = (await pool.query('SELECT id FROM nights')).rows[0];
  const out = await announceClose(pool, id, {}, { send: async () => { throw new Error('must not be called'); } });
  assert.deepEqual(out, { ok: true, queued: [], skipped: [] });
});

test('the shim lists the tools without a database and relays a call, repairing a malformed token after one success', async t => {
  const { port } = await boot(t);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'games-mcp.js')], {
    env: { ...process.env, GAMES_PORT: String(port) }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  t.after(() => child.kill());
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', ch => {
    buf += ch;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); }
  });
  let id = 0;
  const rpc = (method, params) => new Promise(r => { id += 1; waiting.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });

  assert.equal((await rpc('initialize', {})).result.serverInfo.name, 'games');
  assert.deepEqual((await rpc('tools/list')).result.tools.map(d => d.name), TOOL_DEFS.map(d => d.name));
  const text = async args => (await rpc('tools/call', { name: 'start_game_night', arguments: args })).result.content[0].text;
  assert.match(await text({ [IDENTITY_PARAM]: 'olma_tok_abc', price: 50, chips: 1000 }), /^ERROR forbidden/, 'nothing proven yet: no repair');
  assert.match(await text({ [IDENTITY_PARAM]: TOK(1), price: 50, chips: 1000 }), /^OK /);
  assert.match(await text({ [IDENTITY_PARAM]: 'olma_tok_abc', price: 50, chips: 1000 }), /^ERROR already_open/, 'repaired to the proven token');
});
