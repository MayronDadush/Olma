'use strict';
// Phase B of "the turn opens itself": for the people turn_context_phones
// covers, what turn_start would RETURN reaches the model in the prompt
// (gateway-plugin/olma-turn → brokerd `turn_context`) instead of through a
// tool call. The record side was already the gateway's (turn_open); this is
// the conversation side — directive, locale, the opener, the hints — and the
// rule that a reply with no tool call at all is still a counted, hinted turn.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const flagsDomain = require('../src/domain/flags');
const turnDomain = require('../src/domain/turn');
const selfInitiated = require('../src/domain/self-initiated');
const onboarding = require('../src/domain/onboarding');
const pause = require('../src/domain/pause');
process.env.OLMA_PLUGIN_TRACE = path.join(os.tmpdir(), `turn-context-plugin-test-${process.pid}.log`);

let db, broker, marks, now, plugin;
before(async () => {
  db = await freshDb();
  now = Date.now();
  marks = [];
  broker = createBrokerServer({ pool: db.pool, placeMark: (o) => { marks.push(o); return { attempted: true }; }, now: () => now });
  plugin = await import('../gateway-plugin/olma-turn/index.js');
});
after(async () => { await db.teardown(); });
beforeEach(() => { marks.length = 0; selfInitiated._reset(); selfInitiated._setGraceMs(0); });

const newTurn = () => ({ userId: null, opened: false, counted: false, quota: null, messageId: null, lastInboundAt: null, marked: null });
const call = (user, name, args, turn) => broker.dispatch(
  { id: 1, method: 'tool_call', params: { name, args: { olma_identity: user.identity_token, ...args } } }, turn);
const open = (params) => broker.dispatch({ id: 1, method: 'turn_open', params });
const context = (params) => broker.dispatch({ id: 1, method: 'turn_context', params });
const received = async (id) => (await db.pool.query(
  `SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND event = 'message.received'`, [id])).rows[0].n;
const parse = (ctx) => JSON.parse(ctx.split('\n')[1].replace(/^OK /, ''));

let seq = 0;
async function agentUser(extra = {}) {
  seq += 1;
  const phone = `+9726420${String(seq).padStart(4, '0')}`;
  const u = await makeUser(db.pool, phone, extra);
  await db.pool.query(`UPDATE users SET agent_id = $2 WHERE id = $1`, [u.id, `u-${900 + seq}`]);
  return { ...u, agentId: `u-${900 + seq}` };
}
async function enable(...phones) {
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, turnDomain.CONTEXT_FLAG, phones.join(',')));
}

test('nobody is covered until the flag says so: turn_context answers enabled:false and touches nothing', async () => {
  const u = await agentUser();
  await open({ agentId: u.agentId, messageId: '3EB0CTX0001', kind: 'text' });
  const r = await context({ agentId: u.agentId, sessionKey: `agent:${u.agentId}:whatsapp:direct:${u.phone}` });
  assert.deepEqual(r, { ok: true, enabled: false });
  assert.equal(await received(u.id), 1, 'the open counted it; the context call did not count again');
});

test('a covered person gets the opening in the prompt: directive, locale, counted once, and the pending open is left for the tools', async () => {
  const u = await agentUser();
  await enable(u.phone);
  const before = broker.pendingCount();
  await open({ agentId: u.agentId, messageId: '3EB0CTX0002', kind: 'text', senderName: 'Miron' });
  const r = await context({ agentId: u.agentId, trigger: 'user', messageProvider: 'whatsapp' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.enabled, true);
  assert.equal(r.directive, 'proceed');
  assert.ok(r.context.startsWith(turnDomain.CONTEXT_HEADER), r.context);
  const data = parse(r.context);
  assert.equal(data.directive, 'proceed');
  assert.equal(data.locale, u.locale);
  assert.equal(await received(u.id), 1, 'counted exactly once, by the open');
  assert.equal(broker.pendingCount(), before + 1, 'read, not adopted');
  // the shim's first tool call still adopts it, so the 👍 lands on the same message
  const turn = newTurn();
  const added = await call(u, 'add_task', { title: 'לקנות חלב' }, turn);
  assert.equal(added.ok, true, added.text);
  assert.equal(turn.openedByGateway, true);
  assert.equal(marks.at(-1).state, 'done');
  assert.equal(marks.at(-1).messageId, '3EB0CTX0002');
  assert.equal(await received(u.id), 1);
  assert.equal(broker.pendingCount(), before);
});

test('a reply with no tool call at all is still a counted turn — and the model that calls turn_start anyway is not counted twice', async () => {
  const u = await agentUser();
  await enable(u.phone);
  await open({ agentId: u.agentId, messageId: '3EB0CTX0003', kind: 'text' });
  await context({ agentId: u.agentId });
  assert.equal(await received(u.id), 1);
  const ts = await call(u, 'turn_start', { message_id: '3EB0CTX0003' }, newTurn());
  assert.equal(ts.ok, true, ts.text);
  assert.equal(await received(u.id), 1, 'adopted, not re-counted');
});

test('their first ever message: the opener rides in the context, first_turn_at is stamped once, and a rebuilt prompt does not repeat it', async () => {
  const u = await agentUser({ locale: 'he' });
  await enable(u.phone);
  await open({ agentId: u.agentId, messageId: '3EB0CTX0004', kind: 'text' });
  const first = parse((await context({ agentId: u.agentId })).context);
  assert.equal(first.firstTurn, true);
  assert.equal(first.onboarding.sendVerbatim, onboarding.openingMessage('he'));
  const { rows } = await db.pool.query(`SELECT first_turn_at FROM users WHERE id = $1`, [u.id]);
  assert.ok(rows[0].first_turn_at, 'stamped');
  const again = parse((await context({ agentId: u.agentId })).context);
  assert.equal(again.firstTurn, undefined, 'the same message, rebuilt: the opener was already handed over');
  // the next message is nobody's first
  await open({ agentId: u.agentId, messageId: '3EB0CTX0005', kind: 'text' });
  assert.equal(parse((await context({ agentId: u.agentId })).context).firstTurn, undefined);
});

test('somebody the greeter already welcomed is not welcomed again — on the door production actually uses', async () => {
  // `tests/first-turn.test.js` has asserted this since 2026-09-07 and never
  // stopped passing, because it asks `turn_start`, whose user row is a
  // `SELECT *`. This path resolved its user with a five-column projection
  // that did not name `opening_sent_at`, so the column read `undefined`,
  // `advise` took the nobody-has-greeted-them branch, and the fix for "Two
  // introductions" was dead for everyone the moment the flag went to `all`
  // (2026-09-09). Capish on 2026-09-19 and Sharon on 2026-09-22 each read the
  // owner's opening copy twice, in two voices, exactly as עידן had.
  //
  // So this is the same assertion as `first-turn.test.js`'s, deliberately, put
  // where the other door is: one test per door, because the shared function
  // between them cannot tell which row it was handed.
  const u = await agentUser({ locale: 'he' });
  await enable(u.phone);
  await db.pool.query(`UPDATE users SET opening_sent_at = now() WHERE id = $1`, [u.id]);
  await open({ agentId: u.agentId, messageId: '3EB0CTX0020', kind: 'text' });
  const data = parse((await context({ agentId: u.agentId })).context);
  assert.equal(data.firstTurn, true, 'it is still their first turn on their own agent');
  assert.equal(data.onboarding.sendVerbatim, undefined,
    'the copy they have already read must not be handed out a second time');
  assert.equal(data.onboarding.alreadyOpened, true);
  assert.match(data.onboarding.instruction, /already been greeted/i);
});

test('a projection reaches advise as undefined, not as NULL, so advise refuses one', async () => {
  // The bug above is not "somebody forgot a column", it is that forgetting one
  // is SILENT: `undefined` and NULL are both falsy, so a missing column does
  // not raise, it picks the branch for a person nothing has happened to yet.
  // Throwing is affordable here — the plugin fails open and the doctrine falls
  // back to `turn_start`, so the cost of hitting this on the box is one tool
  // call, while the cost of not hitting it was two introductions for every
  // person who joined in thirteen days.
  const u = await agentUser();
  await assert.rejects(
    () => withTx(db.pool, (c) => turnDomain.advise(c,
      { id: u.id, phone: u.phone, first_name: u.first_name, locale: u.locale, paused_at: null },
      { counted: { data: { blocked: false } }, firstTurn: true, ourTurn: false })),
    /opening_sent_at/,
    'the exact projection that shipped, named by the column it dropped');
});

test('the context answer carries the reader\'s language, because the reply gate has no other way to learn it', async () => {
  // The gate runs in the GATEWAY, which has no database. The only thing that
  // crosses to it per person is this answer, so the `english` tier's whole
  // input is this one field — and the third value has to survive the wire as
  // the absence of an answer, never as `false`.
  const he = await agentUser({ locale: 'he' });
  const en = await agentUser({ locale: 'en' });
  const both = await agentUser({ locale: 'he' });
  await db.pool.query(`UPDATE users SET locale_observed = 'en' WHERE id = $1`, [both.id]);
  await enable(he.phone, en.phone, both.phone);
  for (const [u, expected] of [[he, true], [en, false], [both, null]]) {
    await open({ agentId: u.agentId, messageId: `3EB0LANG${u.id}`, kind: 'text' });
    const r = await context({ agentId: u.agentId });
    assert.equal(r.readerWritesHebrew, expected, `${u.agentId}: ${JSON.stringify(r)}`);
  }
  // And the plugin holds exactly what it was handed, including the forgetting.
  plugin._resetReaders();
  plugin.rememberReader(he.agentId, true);
  plugin.rememberReader(he.agentId, null);
  assert.equal(plugin.readerOf(he.agentId), null, 'a null answer clears, it does not leave the old one');
  plugin._resetReaders();
});

test('what they told the greeter is unanswered, and their first turn is told so — greeted or not', async () => {
  // Sharon Mishayev, 2026-09-22, his first ever words to Olma — sent to the
  // greeter, from a padel room she sits in, answering the question that room
  // had asked him:
  //
  //   היי
  //   אני יכול בשבת אחרי 4 בצהריים
  //   ובאמצע שבוע בימי ראשון ורביעי
  //
  // Provisioning carried all three lines into USER.md, correctly. Then his own
  // agent's first turn read an instruction ending "Your reply is still the copy
  // above and nothing else", and that is what he got — twice, counting the
  // greeter's. His availability reached no coordination and nobody ever
  // answered it.
  //
  // Both branches, because both narrowed the reply to this turn's text: the
  // greeted one to "what they actually wrote", the ungreeted one to the copy.
  const greeted = await agentUser({ locale: 'he' });
  const cold = await agentUser({ locale: 'he' });
  await enable(greeted.phone, cold.phone);
  await db.pool.query(
    `UPDATE users SET intake_note_at = now(), opening_sent_at = now() WHERE id = $1`, [greeted.id]);
  await db.pool.query(`UPDATE users SET intake_note_at = now() WHERE id = $1`, [cold.id]);

  await open({ agentId: greeted.agentId, messageId: '3EB0CTX0021', kind: 'text' });
  const a = parse((await context({ agentId: greeted.agentId })).context).onboarding;
  assert.equal(a.alreadyOpened, true);
  assert.equal(a.pendingNote, true);
  assert.match(a.instruction, /USER.md/, 'it names where the words are');
  assert.match(a.instruction, /מה שכבר שיתפו/, 'by the heading the doctrine wrote');
  assert.match(a.instruction, /Act on it in THIS reply/);
  assert.match(a.instruction, /never ask them to say it again/i);
  assert.doesNotMatch(a.instruction, /Answer what they actually wrote, in one short reply/i,
    'the sentence that threw his availability away');

  await open({ agentId: cold.agentId, messageId: '3EB0CTX0022', kind: 'text' });
  const b = parse((await context({ agentId: cold.agentId })).context).onboarding;
  assert.equal(b.sendVerbatim, onboarding.openingMessage('he'),
    'nobody greeted this one, so the copy is still owed');
  assert.equal(b.pendingNote, true);
  assert.match(b.instruction, /character for character/i, 'and it is still verbatim');
  assert.match(b.instruction, /below the copy/i, 'with the answer under it, in the same reply');
  assert.doesNotMatch(b.instruction, /otherwise stop there/i);
  assert.doesNotMatch(b.instruction, /the copy above and nothing else/i,
    'the line the model quoted back while dropping what he came to say');
  // Neither branch may lose the rules that were already there.
  for (const said of [a.instruction, b.instruction]) {
    assert.match(said, /set_my_name with confirmed: true/);
  }
  assert.match(b.instruction, /no follow-up question/i);
});

test('nothing was carried, so nothing points the first turn at a note that is not there', async () => {
  const u = await agentUser({ locale: 'he' });
  await enable(u.phone);
  await open({ agentId: u.agentId, messageId: '3EB0CTX0023', kind: 'text' });
  const said = parse((await context({ agentId: u.agentId })).context).onboarding;
  assert.equal(said.pendingNote, undefined);
  assert.doesNotMatch(said.instruction, /USER.md/,
    'a note the model cannot find is a paragraph of doubt in the one reply that matters');
  assert.match(said.instruction, /otherwise stop there/i, 'the unchanged behaviour for everyone else');
});

test('the display name the hook saw fills a missing first name, as a guess, exactly as turn_start would', async () => {
  const u = await agentUser();
  await enable(u.phone);
  await db.pool.query(`UPDATE users SET first_name = NULL WHERE id = $1`, [u.id]);
  await open({ agentId: u.agentId, messageId: '3EB0CTX0006', kind: 'text', senderName: 'יובל כהן' });
  await context({ agentId: u.agentId });
  const { rows } = await db.pool.query(`SELECT first_name, name_confirmed FROM users WHERE id = $1`, [u.id]);
  assert.equal(rows[0].first_name, 'יובל');
  assert.equal(rows[0].name_confirmed, false);
});

test('no open on file (a lane, a cron, a hook that misfired): context is null, the reason is recorded, nothing is counted', async () => {
  const u = await agentUser();
  await enable(u.phone);
  const r = await context({ agentId: u.agentId, trigger: 'cron', messageProvider: null });
  assert.deepEqual(r, { ok: true, enabled: true, context: null });
  assert.equal(await received(u.id), 0);
  const { rows } = await db.pool.query(`SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'turn.context_without_open'`, [u.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail.trigger, 'cron');
});

test('a turn Olma started gets a plain proceed with the locale, and is not a message from the person', async () => {
  const u = await agentUser();
  await enable(u.phone);
  const r = await selfInitiated.around(u.id, () => context({ agentId: u.agentId }));
  assert.equal(r.enabled, true);
  const data = parse(r.context);
  assert.equal(data.directive, 'proceed');
  assert.equal(data.locale, u.locale);
  assert.equal(data.firstTurn, undefined);
  assert.equal(await received(u.id), 0);
});

test('the quota block reaches the prompt: send_block_notice with the view once, then silent', async () => {
  const u = await agentUser();
  await enable(u.phone);
  await db.pool.query(`UPDATE users SET quota_override_daily = 1 WHERE id = $1`, [u.id]);
  await open({ agentId: u.agentId, messageId: '3EB0CTX0007', kind: 'text' });
  assert.equal(parse((await context({ agentId: u.agentId })).context).directive, 'proceed');
  await open({ agentId: u.agentId, messageId: '3EB0CTX0008', kind: 'text' });
  const blocked = parse((await context({ agentId: u.agentId })).context);
  assert.equal(blocked.directive, 'send_block_notice');
  assert.ok(blocked.blockView);
  await open({ agentId: u.agentId, messageId: '3EB0CTX0009', kind: 'text' });
  assert.equal(parse((await context({ agentId: u.agentId })).context).directive, 'silent');
});

test('the hints turn_start would give ride along: a reply target, the first message after a pause', async () => {
  const u = await agentUser();
  await enable(u.phone);
  await withTx(db.pool, (c) => pause.pauseUser(c, u.id, {}));
  await open({ agentId: u.agentId, messageId: '3EB0CTX0010', kind: 'text' });
  const data = parse((await context({ agentId: u.agentId, replyTarget: true })).context);
  assert.equal(data.replyTarget, true);
  assert.match(data.hints.replyTarget, /Reply target of current user message/);
  assert.equal(data.offerResume, true);
  assert.match(data.hints.offerResume, /ONE line/);
});

test('a thanks reaches the prompt as a request for silence, and the mark is 🙏', async () => {
  const u = await agentUser();
  await enable(u.phone);
  await open({ agentId: u.agentId, messageId: '3EB0CTXTHX1', kind: 'text', thanks: true });
  assert.equal(marks[0].state, 'thanks');
  const res = await context({ agentId: u.agentId });
  const data = parse(res.context);
  assert.match(data.hints.thanksOnly, /NO_REPLY/,
    'the people whose turn opens in the prompt must get this hint there — it is the only opening they read');
  // And nothing else changes: it is still a counted message from a person.
  assert.equal(await received(u.id), 1);
});

// "מה פתוח לי?" with two undated to-dos and nothing dated today: answered off
// the today block, it came back "הכל נקי" (evals, runs 84/86/87, 2026-09-24).
// The hook's verdict takes the block out of that one turn; the next turn has it.
test('a question about their whole list gets no today block to misread, and is pointed at the list', async () => {
  const tasks = require('../src/domain/tasks');
  const u = await agentUser();
  await enable(u.phone);
  await withTx(db.pool, async (c) => {
    await tasks.addTask(c, u.id, { title: 'לשלם ארנונה', source: 'chat' });
    await tasks.addTask(c, u.id, { title: 'לקבוע תור לרופא שיניים', source: 'chat' });
  });
  await open({ agentId: u.agentId, messageId: '3EB0CTXOPEN1', kind: 'text', openList: true });
  const asked = parse((await context({ agentId: u.agentId })).context);
  assert.equal(asked.today, undefined, 'no empty day on the turn that asked about the list');
  assert.equal(asked.hints.today, undefined);
  assert.match(asked.hints.openList, /list_my_tasks/);
  assert.equal(marks[0].state, 'working', 'an ordinary 👀 — this turn owes an answer');

  // The adopted turn carries it too, so turn_start says the same thing.
  const res = await call(u, 'turn_start', { message_id: '3EB0CTXOPEN1' }, newTurn());
  assert.match(res.text, /openList/);
  assert.doesNotMatch(res.text, /"today"/);

  // Any other message is an ordinary turn, block and undated count included.
  await open({ agentId: u.agentId, messageId: '3EB0CTXOPEN2', kind: 'text' });
  const plain = parse((await context({ agentId: u.agentId })).context);
  assert.equal(plain.today.undated, 2);
  assert.equal(plain.hints.openList, undefined);
});

test('an agent with no active user, or a malformed id, is refused', async () => {
  assert.equal((await context({ agentId: 'u-999999' })).ok, false);
  assert.equal((await context({ agentId: 'main' })).ok, false);
  assert.equal((await context({ agentId: '../x' })).ok, false);
});

// The plugin side, against a fake socket: what it sends, what it returns to
// the gateway, and that every failure is silence rather than a broken turn.
function fakeConnect(reply) {
  const sent = [];
  const connect = () => {
    const h = {};
    const s = { on(ev, fn) { h[ev] = fn; return s; }, write(x) { sent.push(JSON.parse(x)); setTimeout(() => h.data && h.data(JSON.stringify(reply) + '\n'), 0); }, end() { h.close && h.close(); }, destroy() {} };
    setTimeout(() => h.connect && h.connect(), 0);
    return s;
  };
  return { connect, sent };
}

test('the plugin prepends the context for a listed agent, sends no content, and stays silent for everyone else', async () => {
  const log = [];
  const { connect, sent } = fakeConnect({ id: 1, ok: true, enabled: true, context: 'Turn context (…):\nOK {"directive":"proceed","locale":"he"}', directive: 'proceed' });
  const handler = plugin.buildHandler({ agents: ['u-3', 'u-12'], connect, log: (o) => log.push(o) });
  const prompt = 'Conversation info (untrusted metadata):\n```json\n{"sender": "Miron", "message_id": "3EB0X", "reply_to_id": "3EB0Y"}\n```\nסודי';
  const out = await handler({ prompt, messages: [] }, { agentId: 'u-3', sessionKey: 'agent:u-3:whatsapp:direct:+972500000000', trigger: 'user', messageProvider: 'whatsapp' });
  assert.deepEqual(out, { prependContext: 'Turn context (…):\nOK {"directive":"proceed","locale":"he"}' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'turn_context');
  assert.deepEqual(sent[0].params, { agentId: 'u-3', sessionKey: 'agent:u-3:whatsapp:direct:+972500000000', trigger: 'user', messageProvider: 'whatsapp', replyTarget: true });
  assert.ok(!JSON.stringify(sent).includes('סודי'), 'the text never leaves the gateway');
  assert.equal(log.at(-1).outcome, 'prepended');
  // not listed, not a user agent, no session: nothing sent, nothing returned
  assert.equal(await handler({ prompt }, { agentId: 'u-7', sessionKey: 'agent:u-7:whatsapp:direct:+1' }), undefined);
  assert.equal(await handler({ prompt }, { sessionKey: 'agent:main:whatsapp:direct:+1' }), undefined);
  assert.equal(await handler({ prompt }, {}), undefined);
  assert.equal(sent.length, 1);
  // the agent id is read from the session key when the context has none
  assert.deepEqual(await handler({ prompt: 'hi' }, { sessionKey: 'agent:u-12:whatsapp:direct:+1' }), { prependContext: out.prependContext });
  assert.equal(sent[1].params.replyTarget, false);
  // an empty list means every user agent
  const all = plugin.buildHandler({ agents: [], connect, log: () => {} });
  assert.ok(await all({ prompt: 'hi' }, { agentId: 'u-44' }));
});

test('the plugin fails open: not enabled, no open, a refusal, a dead socket, a timeout — the prompt goes out untouched', async () => {
  const log = [];
  const mk = (reply) => plugin.buildHandler({ agents: ['u-3'], connect: fakeConnect(reply).connect, log: (o) => log.push(o) });
  const ctx = { agentId: 'u-3', sessionKey: 'agent:u-3:whatsapp:direct:+1' };
  assert.equal(await mk({ id: 1, ok: true, enabled: false })({ prompt: 'x' }, ctx), undefined);
  assert.equal(await mk({ id: 1, ok: true, enabled: true, context: null })({ prompt: 'x' }, ctx), undefined);
  assert.equal(await mk({ id: 1, ok: false, error: 'no active user for agent' })({ prompt: 'x' }, ctx), undefined);
  assert.deepEqual(log.map((l) => l.outcome), ['not-enabled', 'no-open', 'refused']);
  const dead = () => { const h = {}; const s = { on(ev, fn) { h[ev] = fn; return s; }, write() {}, end() {}, destroy() {} }; setTimeout(() => h.error && h.error(new Error('ECONNREFUSED')), 0); return s; };
  assert.equal(await plugin.buildHandler({ agents: ['u-3'], connect: dead, log: (o) => log.push(o) })({ prompt: 'x' }, ctx), undefined);
  assert.equal(log.at(-1).outcome, 'unreachable');
  const mute = () => { const h = {}; const s = { on(ev, fn) { h[ev] = fn; return s; }, write() {}, end() {}, destroy() { h.close && h.close(); } }; setTimeout(() => h.connect && h.connect(), 0); return s; };
  const t0 = Date.now();
  assert.equal(await plugin.buildHandler({ agents: ['u-3'], connect: mute, timeoutMs: 50, log: (o) => log.push(o) })({ prompt: 'x' }, ctx), undefined);
  assert.ok(Date.now() - t0 < 1000, 'bounded by its own timeout');
  assert.equal(log.at(-1).outcome, 'unreachable');
});

test('the plugin module registers its hooks under its own id and reads the agent list from its config', async () => {
  const on = [];
  const def = plugin.default;
  assert.equal(def.id, 'olma-turn');
  def.register({ pluginConfig: { agents: ['u-3'] }, on: (name, fn) => on.push([name, fn]) });
  // before_prompt_build prepends the opening; llm_input files what the
  // gateway says about a group turn (tests/group-context.test.js);
  // before_dispatch ends an untagged room message before any turn exists
  // (tests/group-untagged.test.js), and a second before_dispatch answers
  // "שלח לי קישור" with no model (tests/link-shortcut.test.js);
  // reply_payload_sending is the delivery gate (tests/reply-leak.test.js).
  assert.deepEqual(on.map(([name]) => name),
    ['before_prompt_build', 'llm_input', 'before_dispatch', 'before_dispatch', 'reply_payload_sending']);
  for (const [, fn] of on) assert.equal(typeof fn, 'function');
  // Registering STAMPS, and on the box this suite runs inside deploy.sh: the
  // stamp must land in the temp home tests/helpers.js chose, never in
  // /opt/olma2/run, where config_guard would read this test's record as the
  // running gateway's (incidents.md, "The test suite stamped the gateway as
  // live").
  const stampFile = process.env.OLMA_PLUGIN_REGISTER_STAMP;
  assert.ok(stampFile && !stampFile.startsWith('/opt/olma2/run/'), `stamp path is isolated: ${stampFile}`);
  const rec = JSON.parse(require('node:fs').readFileSync(stampFile, 'utf8').trim().split('\n').pop());
  assert.equal(rec.pid, process.pid);
  assert.deepEqual(rec.agents, ['u-3']);
  assert.ok(rec.hooks.includes('reply_payload_sending'));
});

test('under the test runner the plugin refuses to write the production stamp or trace', () => {
  // The guard is what makes a file that forgets the env variable red instead
  // of silently overwriting production. Nothing is written: it throws first.
  assert.throws(() => plugin.stampRegistration({ agents: 'all', hooks: [] }, '/opt/olma2/run/turn-context-plugin.registered'), /a test may not write/);
  assert.throws(() => plugin.refuseProductionWrite('/opt/olma2/run/turn-context-plugin.log'), /a test may not write/);
  const saved = process.env.OLMA_PLUGIN_REGISTER_STAMP;
  delete process.env.OLMA_PLUGIN_REGISTER_STAMP;
  try {
    assert.throws(() => plugin.stampRegistration({ agents: 'all', hooks: [] }), /a test may not write/);
  } finally {
    process.env.OLMA_PLUGIN_REGISTER_STAMP = saved;
  }
  plugin.refuseProductionWrite(saved); // the isolated path is fine
});

// Miron, 2026-09-06, "בוצע" quoting the lunch reminder: the context came back
// in its no-reply shape (536 chars, not 990), because the prompt the plugin
// sees is the bare text — the Conversation info block with `reply_to_id` is
// attached after the hook. The turn-open hook sees the WhatsApp quote marker
// and carries the id; the context is built from that.
test('a reply the hook saw becomes the replyTarget hint in the context, with or without the plugin noticing', async () => {
  const u = await agentUser();
  await enable(u.phone);
  await open({ agentId: u.agentId, messageId: '3EB0RPL0001', kind: 'text', replyToId: '3EB0QUOTED01' });
  const r = await context({ agentId: u.agentId, trigger: 'user', messageProvider: 'whatsapp', replyTarget: false });
  assert.equal(r.ok, true, JSON.stringify(r));
  const data = parse(r.context);
  assert.equal(data.replyTarget, true);
  assert.match(data.hints.replyTarget, /Reply target of current user message/);
  // the plain message: no hint
  const u2 = await agentUser();
  await enable(u2.phone);
  await open({ agentId: u2.agentId, messageId: '3EB0RPL0002', kind: 'text' });
  const r2 = await context({ agentId: u2.agentId, trigger: 'user', messageProvider: 'whatsapp' });
  const d2 = parse(r2.context);
  assert.equal(d2.replyTarget, undefined);
  assert.equal(d2.hints && d2.hints.replyTarget, undefined);
  // the plugin's own detection still counts, for a gateway that puts reply_to_id in the prompt
  const u3 = await agentUser();
  await enable(u3.phone);
  await open({ agentId: u3.agentId, messageId: '3EB0RPL0003', kind: 'text' });
  const r3 = await context({ agentId: u3.agentId, trigger: 'user', messageProvider: 'whatsapp', replyTarget: true });
  assert.equal(parse(r3.context).replyTarget, true);
});

// The gateway runs one turn per session at a time (queue mode followup). Two
// messages a few seconds apart: the first turn's prompt is built, its tools
// run, THEN the second turn's prompt is built. Each must get its own opening
// and its own message id, and a turn that ends with no tool call must leave
// nothing for the next turn to adopt by mistake.
test('two quick messages under followup: each prompt gets its own opening, each turn its own marks, and a tool-less turn leaves nothing behind', async () => {
  const u = await agentUser();
  await enable(u.phone);
  const before = broker.pendingCount();
  // message 1 arrives, its prompt is built
  await open({ agentId: u.agentId, messageId: '3EB0FU0001', kind: 'text' });
  const c1 = await context({ agentId: u.agentId, trigger: 'user', messageProvider: 'whatsapp' });
  assert.ok(c1.context);
  // message 2 arrives while turn 1 is still running
  await open({ agentId: u.agentId, messageId: '3EB0FU0002', kind: 'text', replyToId: '3EB0FUQ' });
  assert.equal(broker.pendingCount(), before + 2);
  // turn 1's first tool adopts message 1, not the newer message 2
  const t1 = newTurn();
  await call(u, 'add_task', { title: 'ראשון' }, t1);
  assert.equal(t1.messageId, '3EB0FU0001');
  assert.equal(marks.at(-1).messageId, '3EB0FU0001', 'the 👍 lands on the message this turn answers');
  assert.equal(broker.pendingCount(), before + 1, 'message 2 is still waiting for its own turn');
  // turn 2's prompt is built: its own opening, its own reply target
  const c2 = await context({ agentId: u.agentId, trigger: 'user', messageProvider: 'whatsapp' });
  const d2 = parse(c2.context);
  assert.equal(d2.replyTarget, true, 'the reply belongs to message 2 and reaches its prompt');
  const t2 = newTurn();
  await call(u, 'add_task', { title: 'שני' }, t2);
  assert.equal(t2.messageId, '3EB0FU0002');
  assert.equal(broker.pendingCount(), before);
  assert.equal(await received(u.id), 2, 'two messages, two counts, by their opens');

  // Now a turn that answers with words alone (no tool) followed by one that
  // calls a tool: the second turn's prompt drops the first's leftover open,
  // so its tools adopt their own message.
  await open({ agentId: u.agentId, messageId: '3EB0FU0003', kind: 'text' });
  await context({ agentId: u.agentId, trigger: 'user', messageProvider: 'whatsapp' });
  // ...turn 3 ends with no tool call...
  await open({ agentId: u.agentId, messageId: '3EB0FU0004', kind: 'text' });
  await context({ agentId: u.agentId, trigger: 'user', messageProvider: 'whatsapp' });
  assert.equal(broker.pendingCount(), before + 1, 'the tool-less turn\'s open was dropped when the next prompt was built');
  const t4 = newTurn();
  await call(u, 'add_task', { title: 'רביעי' }, t4);
  assert.equal(t4.messageId, '3EB0FU0004');
  assert.equal(broker.pendingCount(), before);
  assert.equal(await received(u.id), 4);
});

test('a turn Olma started leaves the person\'s pending open alone', async () => {
  const u = await agentUser();
  await enable(u.phone);
  await open({ agentId: u.agentId, messageId: '3EB0SELF01', kind: 'text' });
  selfInitiated.begin(u.id);
  const r = await context({ agentId: u.agentId, trigger: 'user', messageProvider: 'whatsapp' });
  assert.equal(r.ok, true);
  selfInitiated._reset();
  // the person's own prompt still gets a first-class opening afterwards
  const r2 = await context({ agentId: u.agentId, trigger: 'user', messageProvider: 'whatsapp' });
  assert.ok(r2.context, 'the open was not consumed by Olma\'s own turn');
  const t = newTurn();
  await call(u, 'add_task', { title: 'x' }, t);
  assert.equal(t.messageId, '3EB0SELF01');
});
