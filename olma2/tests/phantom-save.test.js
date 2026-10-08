'use strict';
// A reply that says it saved something, on a turn where nothing was saved
// (domain/phantom-save.js). The founding case is nightly eval #91, 2026-09-25:
// "רשמתי לך הכל" to a brain-dump, and no tool call anywhere in the turn.
// Report-only — every test here is about what gets FILED, and the one about
// the gate is that the reply it was reading goes out untouched.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { freshDb, makeUser } = require('./helpers');
const { createBrokerServer } = require('../src/brokerd/server');
const selfInitiated = require('../src/domain/self-initiated');
const phantom = require('../src/domain/phantom-save');
process.env.OLMA_PLUGIN_TRACE = path.join(os.tmpdir(), `phantom-save-plugin-test-${process.pid}.log`);

let db, broker, now, plugin;
before(async () => {
  db = await freshDb();
  now = Date.now();
  broker = createBrokerServer({ pool: db.pool, placeMark: () => ({ attempted: false }), now: () => now });
  plugin = await import('../gateway-plugin/olma-turn/index.js');
});
after(async () => { await db.teardown(); });
beforeEach(() => { selfInitiated._reset(); selfInitiated._setGraceMs(0); });

// ---- the words ------------------------------------------------------------

// Claims, each as it would really be written, and the word that should come back.
const CLAIMS = [
  ['רשמתי לך הכל 👍', 'רשמתי'],
  ['סגור, הוספתי לרשימה', 'הוספתי'],
  ['שמרתי את זה ואזכיר לך מחר', 'שמרתי'],
  ['ורשמתי גם את החלב', 'רשמתי'],
  ['קבעתי תזכורת ל-17:00', 'קבעתי'],
  ['עדכנתי את התאריך ליום שלישי', 'עדכנתי'],
  ["Done — I've added it to your list", 'added'],
  ['I have saved that for you', 'saved'],
  // 2026-10-08: the false claims the weekly reviews found used none of the
  // save words above.
  ['שלחתי להם את ההודעה בקבוצה, הם יקבלו אותה כשזמין', 'שלחתי'],
  ['החברים עודכנו שאתה לא מגיע', 'עודכנו'],
  ['מעולה, סימנתי את שניהם ✅', 'סימנתי'],
  ["I've sent it to the group", 'sent'],
];
// Not claims: a question, a future, another person's verb, a word that only
// CONTAINS one of ours, and an English "I've" about something else.
const NOT_CLAIMS = [
  'להוסיף את זה לרשימה?',
  'אוסיף את זה מחר בבוקר',
  'הוא רשם את זה אצלו',
  'הרשמתי אותך לשיעור',
  'מה לרשום לך?',
  "I've been thinking about your week",
  'אשלח להם את זה מחר',
  'הוא שלח לך הודעה',
  'Let me know if that works',
  '',
];

test('a save claimed in the first person is read, in Hebrew and in English, and nothing else is', () => {
  for (const [text, word] of CLAIMS) assert.equal(phantom.claimedWrite(text), word, text);
  for (const text of NOT_CLAIMS) assert.equal(phantom.claimedWrite(text), null, text);
});

// The plugin's copy is the one that runs, and a port nobody holds against its
// original drifts (.claude/rules/turns-and-replies.md, "The plugin carries a
// PORT of domain/reply-leak.js").
test('the gateway plugin\'s port answers exactly as the domain module does', () => {
  for (const [text] of CLAIMS) assert.equal(plugin.claimedWrite(text), phantom.claimedWrite(text), text);
  for (const text of NOT_CLAIMS) assert.equal(plugin.claimedWrite(text), phantom.claimedWrite(text), text);
});

// ---- the verdict ----------------------------------------------------------

test('the verdict: a tool since the open backs it, none leaves it unbacked, and no open is unknown', () => {
  const t = 1_000_000_000;
  assert.equal(phantom.judge({ opens: [t], lastToolAt: t + 5000, now: t + 9000 }).verdict, 'backed');
  assert.equal(phantom.judge({ opens: [t], lastToolAt: t - 5000, now: t + 9000 }).verdict, 'unbacked');
  assert.equal(phantom.judge({ opens: [t], lastToolAt: null, now: t + 9000 }).verdict, 'unbacked');
  // Nothing on file is a restart or a turn this never saw — never "no tool ran".
  assert.equal(phantom.judge({ opens: [], lastToolAt: null, now: t }).verdict, 'unknown');
  assert.equal(phantom.judge({ opens: [t], now: t + phantom.OPEN_WINDOW_MS + 1 }).verdict, 'unknown');
  // A turn Olma started reports an earlier turn's write; it is not judged.
  assert.equal(phantom.judge({ ourTurn: true, opens: [t], now: t + 1 }).verdict, 'ours');
  // Two messages close together: the reply to the first may go out after the
  // second opened, so a tool since the EARLIEST open is not `unbacked` — but it
  // is not proof either, and says so under its own name.
  assert.equal(phantom.judge({ opens: [t, t + 20_000], lastToolAt: t + 10_000, now: t + 30_000 }).verdict, 'backed_earlier');
  assert.equal(phantom.judge({ opens: [t, t + 20_000], lastToolAt: t + 25_000, now: t + 30_000 }).verdict, 'backed');
});

test('Dov: this turn\'s write FAILED and an earlier turn\'s success is not its backing', () => {
  // 14:18:56 open (pill), 14:19:04 its set_task_reminder ok, 14:19:06 open
  // ("כל צהריים בשבוע הקרוב"), 14:19:11 set_task_reminder refused (past),
  // 14:19:16 "רשמתי — כל צהריים ב-12:00". Filed as `backed` on the day.
  const t = Date.parse('2026-09-27T11:18:56Z');
  const failed = [{ tool: 'set_task_reminder', at: t + 15_000 }];
  const j = phantom.judge({ opens: [t, t + 10_000], lastToolAt: t + 8_000, unresolved: failed, now: t + 20_000 });
  assert.equal(j.verdict, 'failed');
  assert.deepEqual(j.failedTools, ['set_task_reminder']);
  // a failure on an EARLIER turn says nothing about this one
  assert.equal(phantom.judge({ opens: [t, t + 10_000], lastToolAt: t + 12_000, unresolved: [{ tool: 'add_task', at: t + 5_000 }], now: t + 20_000 }).verdict, 'backed');
});

test('u-36 and u-56: a refused write is `failed` even when ANOTHER tool succeeded after it', () => {
  // u-56, 2026-10-01: relay_to_group refused (relay_off), then
  // opt_out_of_meeting succeeded on its fifth try, and "החברים עודכנו" went
  // out. brokerd clears a failure only on a success of the SAME tool, so
  // what reaches judge is the relay alone.
  const t = Date.parse('2026-10-01T18:07:00Z');
  const j = phantom.judge({ opens: [t], lastToolAt: t + 120_000, unresolved: [{ tool: 'relay_to_group', at: t + 45_000 }], now: t + 130_000 });
  assert.equal(j.verdict, 'failed');
  assert.deepEqual(j.failedTools, ['relay_to_group']);
  // …and a reply that already says it did not work is not corrected.
  assert.equal(phantom.judge({ opens: [t], unresolved: [{ tool: 'relay_to_group', at: t + 1 }], admits: true, now: t + 2 }).verdict, 'failed_admitted');
});

test('a READ that failed is not a write that failed', () => {
  for (const name of ['my_calendar_events', 'get_my_profile', 'list_my_connections', 'group_coordination_status', 'food__see_meal_photo', 'render_schedule_card'])
    assert.equal(phantom.isWrite(name), false, name);
  for (const name of ['relay_to_group', 'send_message_to_connection', 'complete_task', 'set_task_reminder', 'opt_out_of_meeting', 'games__start_game_night'])
    assert.equal(phantom.isWrite(name), true, name);
});

// Every honest reply about a failure in three weeks of real traffic said so in
// one of these; the false claims did not — "לא מגיע" is not an admission.
const ADMITS = [
  'הרגע לא זמין לי לחבר יומן, לצערי.',
  'שלחתי כבר בקשה פעילה — המערכת לא נותנת לשלוח שנייה כפולה',
  'הגעתי למגבלה — כבר שלחתי בעבר משפט אחד בשמך לקבוצה',
  'אתם עדיין לא מחוברים אחד לשנייה בעולמה',
  "I couldn't send it to the group",
];
const DOES_NOT_ADMIT = [
  'רשמתי — הורדתי אותך מהפוקר, החברים עודכנו שאתה לא מגיע. 👍',
  'שלחתי להם את ההודעה בקבוצה, הם יקבלו אותה כשזמין 🫡',
  'מעולה, סימנתי את שניהם ✅ הדרייב הוחזר והכרטיס החדש במקומו.',
  "I've sent it to the group",
];

test('an admission is read off the reply, and the plugin\'s port answers the same', () => {
  for (const text of ADMITS) assert.equal(phantom.admitsFailure(text), true, text);
  for (const text of DOES_NOT_ADMIT) assert.equal(phantom.admitsFailure(text), false, text);
  for (const text of [...ADMITS, ...DOES_NOT_ADMIT]) assert.equal(plugin.admitsFailure(text), phantom.admitsFailure(text), text);
});

test('the correction is fixed text: "not sent" for passing words on, "not saved" for the rest, in the reader\'s language', () => {
  assert.equal(phantom.correctionFor(['relay_to_group'], true), phantom.CORRECTIONS.sent.he);
  assert.equal(phantom.correctionFor(['complete_task', 'send_message_to_connection'], true), phantom.CORRECTIONS.sent.he);
  assert.equal(phantom.correctionFor(['complete_task'], true), phantom.CORRECTIONS.saved.he);
  // `null` acts like `false` (writesHebrew is a tri-state)
  assert.equal(phantom.correctionFor(['complete_task'], null), phantom.CORRECTIONS.saved.en);
  assert.equal(phantom.correctionFor([], true), null);
});

// ---- brokerd --------------------------------------------------------------

let seq = 0;
async function agentUser() {
  seq += 1;
  const phone = `+9726430${String(seq).padStart(4, '0')}`;
  const u = await makeUser(db.pool, phone);
  await db.pool.query('UPDATE users SET agent_id = $2 WHERE id = $1', [u.id, `u-${950 + seq}`]);
  return { ...u, agentId: `u-${950 + seq}` };
}
const newTurn = () => ({ userId: null, opened: false, counted: false, quota: null, messageId: null, lastInboundAt: null, marked: null });
const open = (u, id) => broker.dispatch({ id: 1, method: 'turn_open', params: { agentId: u.agentId, messageId: id, kind: 'text' } });
const claim = (u, word = 'רשמתי') => broker.dispatch({ id: 1, method: 'reply_claim', params: { agentId: u.agentId, word } });
const tool = (u, name) => broker.dispatch(
  { id: 1, method: 'tool_call', params: { name, args: { olma_identity: u.identity_token } } }, newTurn());
const filed = async (u) => (await db.pool.query(
  `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'reply.claim' ORDER BY id DESC LIMIT 1`, [u.id])).rows[0];

test('brokerd files a claim with no tool behind it as unbacked, and the word — never the reply', async () => {
  const u = await agentUser();
  await open(u, '3EBPHANTOM01');
  now += 8000;
  assert.deepEqual(await claim(u), { ok: true, verdict: 'unbacked' });
  const row = await filed(u);
  assert.equal(row.detail.verdict, 'unbacked');
  assert.equal(row.detail.word, 'רשמתי');
  assert.equal(row.detail.toolAgoMs, null);
  assert.equal(row.detail.openedAgoMs, 8000);
});

test('a tool that ran on the turn backs the claim; turn_start alone does not', async () => {
  const u = await agentUser();
  await open(u, '3EBPHANTOM02');
  now += 1000;
  await tool(u, 'turn_start');
  now += 1000;
  assert.equal((await claim(u)).verdict, 'unbacked', 'turn_start runs on every message and saves nothing');
  await tool(u, 'list_my_tasks');
  now += 1000;
  assert.equal((await claim(u)).verdict, 'backed');
  // A second message inside the window: a tool after the FIRST open is not
  // `unbacked`, but it is not this turn's either (see the verdict test)…
  now += 60_000;
  await open(u, '3EBPHANTOM03');
  now += 60_000;
  assert.equal((await claim(u)).verdict, 'backed_earlier');
  // …and once the window has moved past that tool, it no longer does.
  now += phantom.OPEN_WINDOW_MS;
  await open(u, '3EBPHANTOM04');
  now += 5000;
  assert.equal((await claim(u)).verdict, 'unbacked');
});

test('a turn Olma started is filed as ours, and a person with no open on file as unknown', async () => {
  const u = await agentUser();
  assert.equal((await claim(u)).verdict, 'unknown', 'a restart that lost the open is not "no tool ran"');
  await open(u, '3EBPHANTOM05');
  selfInitiated.begin(u.id);
  assert.equal((await claim(u)).verdict, 'ours');
  selfInitiated.end(u.id);
  assert.deepEqual(await broker.dispatch({ id: 1, method: 'reply_claim', params: { agentId: 'g-4', word: 'רשמתי' } }),
    { ok: false, error: 'bad agentId' });
});

// ---- the gate -------------------------------------------------------------

function fakeConnect() {
  const sent = [];
  const connect = () => {
    const h = {};
    const s = {
      on(ev, fn) { h[ev] = fn; if (ev === 'connect') setTimeout(() => fn(), 0); return s; },
      write(line) { const m = JSON.parse(line); sent.push(m); setTimeout(() => h.data && h.data(JSON.stringify({ id: 1, ok: true }) + '\n'), 0); },
      end() {}, destroy() {},
    };
    return s;
  };
  return { connect, sent };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('the gate tells brokerd the word, sends the reply untouched, and never asks about a room or a cut paragraph', async () => {
  const { connect, sent } = fakeConnect();
  const handler = plugin.buildReplyGateHandler({ connect, log: () => {} });
  const payload = { text: 'רשמתי לך הכל 👍' };
  // `turn_progress` rides every reply a person gets (the held 👀,
  // tests/eyes-delay.test.js), and `mark_echo` asks about every short one
  // (tests/mark-echo.test.js); this test is about the claim.
  const claims = () => sent.filter((m) => m.method !== 'turn_progress' && m.method !== 'mark_echo');
  assert.equal(await handler({ payload, sessionKey: 'agent:u-3:whatsapp:direct:+972500000000' }, {}), undefined);
  await settle();
  assert.equal(claims().length, 1);
  assert.equal(claims()[0].method, 'reply_claim');
  assert.deepEqual(claims()[0].params, { agentId: 'u-3', word: 'רשמתי', admits: false, writesHebrew: false });
  assert.ok(!JSON.stringify(sent).includes('לך הכל'), 'the reply never leaves the gateway');

  sent.length = 0;
  await handler({ payload, sessionKey: 'agent:g-7:whatsapp:group:120363000000000000@g.us' }, {});
  await handler({ payload: { text: 'אוסיף את זה מחר' }, sessionKey: 'agent:u-3:whatsapp:direct:+972500000000' }, {});
  await settle();
  assert.equal(claims().length, 0);
  // and a room has no held 👀 to drop, nor a 👍 of ours to echo
  assert.deepEqual([...new Set(sent.map((m) => m.params.agentId))], ['u-3']);
  sent.length = 0;
  // A claim inside working-out the gate cancels reaches nobody, so it is not asked about.
  const out = await handler({ payload: { text: 'remind_at שמרתי ל-2026-09-10T10:00:00Z' }, sessionKey: 'agent:u-3:whatsapp:direct:+972500000000' }, {});
  assert.deepEqual(out, { cancel: true, reason: 'olma_reply_leak' });
  await settle();
  // a reply the gate stops reached nobody: no `turn_progress` either
  assert.deepEqual(sent.map((m) => m.method), ['reply_gate']);
});

test('brokerd: a write that FAILED on this turn files `failed`, whatever an earlier turn saved', async () => {
  const u = await agentUser();
  await open(u, '3EBPHANTOM05');
  now += 1000;
  await tool(u, 'list_my_tasks');                 // the previous message's success
  now += 1000;
  await open(u, '3EBPHANTOM06');
  now += 1000;
  const refused = await tool(u, 'set_task_reminder'); // no task, no moment: refused
  assert.match(refused.text, /^ERROR/);
  now += 1000;
  assert.equal((await claim(u)).verdict, 'failed');
  assert.equal((await filed(u)).detail.verdict, 'failed');
});

// ---- 2026-10-08: the correction ---------------------------------------------

const toolWith = (u, name, args) => broker.dispatch(
  { id: 1, method: 'tool_call', params: { name, args: { olma_identity: u.identity_token, ...args } } }, newTurn());
const claimFull = (u, params) => broker.dispatch({ id: 1, method: 'reply_claim', params: { agentId: u.agentId, word: 'סימנתי', ...params } });
const flags = require('../src/domain/flags');

test('brokerd: a refused write stays `failed` past another tool\'s success, and only its own retry clears it', async () => {
  const u = await agentUser();
  await open(u, '3EBPHANTOM10');
  now += 1000;
  const refused = await toolWith(u, 'complete_task', { task_id: 99999999 });
  assert.match(refused.text, /^ERROR/);
  now += 1000;
  const added = await toolWith(u, 'add_task', { title: 'להחזיר את הדרייב' });
  assert.doesNotMatch(added.text, /^ERROR/, added.text);
  now += 1000;
  const res = await claimFull(u, {});
  assert.equal(res.verdict, 'failed', 'u-30, 2026-10-08: "סימנתי את שניהם" after two refused complete_task');
  assert.equal(res.correction, undefined, 'the flag is off: filed, not corrected');
  const row = await filed(u);
  assert.deepEqual(row.detail.failedTools, ['complete_task']);
  assert.equal(row.detail.wouldCorrect, true);
  assert.equal(row.detail.corrected, false);

  // the reply already said it did not work
  assert.equal((await claimFull(u, { admits: true })).verdict, 'failed_admitted');

  // the same tool, retried and succeeding, is a real save
  const body = JSON.parse(added.text.replace(/^OK /, ''));
  const taskId = body.task?.id ?? body.id;
  const done = await toolWith(u, 'complete_task', { task_id: Number(taskId) });
  assert.doesNotMatch(done.text, /^ERROR/, done.text);
  now += 1000;
  assert.equal((await claimFull(u, {})).verdict, 'backed');
});

test('brokerd: with the flag on, a `failed` claim is answered with the fixed line in the reader\'s language', async () => {
  const u = await agentUser();
  await flags.setFlag(db.pool, 'claim_correction_phones', u.phone);
  try {
    await open(u, '3EBPHANTOM11');
    now += 1000;
    await toolWith(u, 'relay_to_group', { meeting_id: 99999999, what: 'אני בא' });
    now += 1000;
    const he = await claimFull(u, { word: 'שלחתי', writesHebrew: true });
    assert.equal(he.correction, phantom.CORRECTIONS.sent.he);
    assert.equal((await filed(u)).detail.corrected, true);
    const en = await claimFull(u, { word: 'sent' });
    assert.equal(en.correction, phantom.CORRECTIONS.sent.en);
    // an admission, or a turn Olma started, is never corrected
    assert.equal((await claimFull(u, { admits: true, writesHebrew: true })).correction, undefined);
    selfInitiated.begin(u.id);
    assert.equal((await claimFull(u, { writesHebrew: true })).correction, undefined);
  } finally {
    await flags.setFlag(db.pool, 'claim_correction_phones', '');
  }
});

function answeringConnect(answer) {
  const sent = [];
  const connect = () => {
    const h = {};
    const s = {
      on(ev, fn) { h[ev] = fn; if (ev === 'connect') setTimeout(() => fn(), 0); return s; },
      write(line) {
        const m = JSON.parse(line); sent.push(m);
        const body = m.method === 'reply_claim' ? { id: 1, ...answer } : { id: 1, ok: true };
        setTimeout(() => h.data && h.data(JSON.stringify(body) + '\n'), 0);
      },
      end() {}, destroy() {},
    };
    return s;
  };
  return { connect, sent };
}

test('the gate adds the line brokerd hands back under the reply, and sends it untouched otherwise', async () => {
  const key = 'agent:u-3:whatsapp:direct:+972500000000';
  const text = 'שלחתי להם את ההודעה בקבוצה, הם יקבלו אותה כשזמין 🫡';
  const fixed = phantom.CORRECTIONS.sent.he;
  const on = answeringConnect({ ok: true, verdict: 'failed', correction: fixed });
  const out = await plugin.buildReplyGateHandler({ connect: on.connect, log: () => {} })({ payload: { text }, sessionKey: key }, {});
  assert.deepEqual(out, { payload: { text: `${text}\n\n${fixed}` } });
  const asked = on.sent.find((m) => m.method === 'reply_claim');
  assert.deepEqual(asked.params, { agentId: 'u-3', word: 'שלחתי', admits: false, writesHebrew: false });

  // a verdict with no correction, and a brokerd that never answers, change nothing
  const off = answeringConnect({ ok: true, verdict: 'failed' });
  assert.equal(await plugin.buildReplyGateHandler({ connect: off.connect, log: () => {} })({ payload: { text }, sessionKey: key }, {}), undefined);
  const dead = () => { throw new Error('ENOENT'); };
  assert.equal(await plugin.buildReplyGateHandler({ connect: dead, log: () => {} })({ payload: { text }, sessionKey: key }, {}), undefined);
});
