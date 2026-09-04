'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../src/domain/reactions');

test('reactions: one emoji per state, and no state shares one', () => {
  const emoji = Object.values(r.REACTION_STATES);
  assert.equal(new Set(emoji).size, emoji.length,
    'two states sharing a mark makes the mark unreadable — the whole value here is that a glance is unambiguous');
  // Pinned by name so a future "let us make it livelier" edit has to argue with
  // a test rather than quietly turn the vocabulary into decoration.
  assert.deepEqual(Object.keys(r.REACTION_STATES).sort(),
    ['done', 'failed', 'needs_input', 'scheduled', 'working']);
});

test('reactions: builds a real openclaw argv for a capable channel', () => {
  const args = r.buildReactArgs({
    channel: 'whatsapp', target: '+972500000000', messageId: '3EB0ABCDEF', state: 'working',
  });
  assert.deepEqual(args, [
    'message', 'react',
    '--channel', 'whatsapp',
    '--target', '+972500000000',
    '--message-id', '3EB0ABCDEF',
    '--emoji', '👀',
  ]);
  // The transition is a plain second call: WhatsApp replaces a sender's own
  // previous reaction, so nothing has to be removed in between.
  const done = r.buildReactArgs({
    channel: 'whatsapp', target: '+972500000000', messageId: '3EB0ABCDEF', state: 'done',
  });
  assert.equal(done[done.length - 1], '👍');
  assert.ok(r.buildReactArgs({
    channel: 'whatsapp', target: '+9725', messageId: 'x', state: 'done', remove: true,
  }).includes('--remove'));
});

test('reactions: every missing precondition returns null rather than a broken call', () => {
  const base = { channel: 'whatsapp', target: '+9725', messageId: '3EB0', state: 'working' };
  // No message id is the one that matters most: there is no sane fallback,
  // because reacting to the wrong message asserts something about a message we
  // never processed. Silence is the correct output, not a guess.
  assert.equal(r.buildReactArgs({ ...base, messageId: undefined }), null);
  assert.equal(r.buildReactArgs({ ...base, target: undefined }), null);
  assert.equal(r.buildReactArgs({ ...base, state: 'thinking' }), null, 'an unknown state is silence, not a crash');
  assert.equal(r.buildReactArgs(), null);
});

test('reactions: an unverified channel is silent, not attempted', () => {
  // The gateway accepts --channel for ~25 providers; that is not evidence any
  // of them delivers a reaction. An unverified channel must degrade to sending
  // nothing — never to a failed CLI call on every inbound message.
  assert.equal(r.isReactionCapable('whatsapp'), true);
  assert.equal(r.isReactionCapable('imessage'), false);
  assert.equal(r.isReactionCapable('nostr'), false);
  assert.equal(r.isReactionCapable(undefined), false);
  assert.equal(r.buildReactArgs({
    channel: 'imessage', target: 'x@y', messageId: '1', state: 'done',
  }), null);
  // Case is the gateway's, not ours, and must not decide behaviour.
  assert.equal(r.isReactionCapable('WhatsApp'), true);
});

test('reactions: the live window is the delivery gate\'s, not a second number', () => {
  // If these two ever drift, a reaction becomes reachable at a moment the gate
  // would refuse a message — which is the whole thing this window prevents.
  const gate = require('../src/outbox/gate');
  assert.equal(r.LIVE_WINDOW_MS, gate.CONVERSATION_GRACE_MS);
});

test('reactions: a mark is only ever placed while the person is still there', () => {
  const now = Date.UTC(2026, 8, 4, 12, 0, 0);
  const min = (n) => new Date(now - n * 60_000).toISOString();
  assert.equal(r.isLive(min(1), now), true);
  assert.equal(r.isLive(min(14), now), true);
  // A reaction IS a notification. One arriving about yesterday afternoon's
  // message is outreach however small it looks, and outreach has a gate.
  assert.equal(r.isLive(min(16), now), false);
  assert.equal(r.isLive(min(60 * 20), now), false);
  assert.equal(r.isLive(null, now), false);
  assert.equal(r.isLive('not a date', now), false);
  // A clock that ran backwards is not a fresh message.
  assert.equal(r.isLive(new Date(now + 60_000).toISOString(), now), false);
});

test('reactions: the id is bounded before it is ever used', () => {
  assert.equal(r.cleanMessageId('3EB0ABCDEF1234'), '3EB0ABCDEF1234');
  assert.equal(r.cleanMessageId('  3EB0ABCDEF1234  '), '3EB0ABCDEF1234');
  assert.equal(r.cleanMessageId(''), null);
  assert.equal(r.cleanMessageId('abc'), null, 'too short to be an id');
  assert.equal(r.cleanMessageId('3EB0 ABCD'), null, 'a paraphrase, not an id');
  assert.equal(r.cleanMessageId('3EB0\nABCD'), null);
  assert.equal(r.cleanMessageId('x'.repeat(201)), null);
  assert.equal(r.cleanMessageId(undefined), null);
  assert.equal(r.cleanMessageId(12345), null, 'the block is text; a number is the model improvising');
});

test('reactions: markFor refuses everything it cannot stand behind', () => {
  const now = Date.UTC(2026, 8, 4, 12, 0, 0);
  // A fresh turn per assertion: markFor stamps what it has handed out, so
  // reusing one object here would silently be testing the dedup instead.
  const fresh = () => ({ messageId: '3EB0ABCD', lastInboundAt: new Date(now - 60_000).toISOString() });
  const turn = fresh();
  const ok = { ok: true };
  assert.equal(r.markFor('turn_start', ok, fresh(), now), 'working');
  assert.equal(r.markFor('complete_task', ok, fresh(), now), 'done');
  // ⏰ is armed-and-will-speak-to-you, and ONLY set_task_reminder does that.
  assert.equal(r.markFor('set_task_reminder', ok, fresh(), now), 'scheduled');
  // The calendar write is the request in hand, not a thing that will call out
  // later — Miron's slow calendar turn ends 👍, not ⏰.
  assert.equal(r.markFor('create_calendar_event', ok, fresh(), now), 'done');
  assert.equal(r.markFor('add_task', ok, fresh(), now), 'done');
  assert.equal(r.markFor('add_tasks_bulk', ok, fresh(), now), 'done');

  assert.equal(r.markFor('list_my_tasks', ok, turn, now), null, 'reading is not doing');
  // A failed call earns no mark at all rather than ⚠️: Olma explains the
  // failure in words, and a warning beside a good explanation reads as a
  // second, worse failure.
  assert.equal(r.markFor('complete_task', { ok: false }, turn, now), null);
  assert.equal(r.markFor('complete_task', null, turn, now), null);
  // No id is silence. This is the common case, not the edge one — every turn
  // where the model omitted the field, and every implicitly-recovered turn.
  assert.equal(r.markFor('complete_task', ok, { ...turn, messageId: null }, now), null);
  assert.equal(r.markFor('complete_task', ok, null, now), null);
  assert.equal(r.markFor('complete_task', ok, { ...turn, lastInboundAt: new Date(now - 3600_000).toISOString() }, now), null);
});

test('reactions: the same mark twice in one turn is asked for once', () => {
  const now = Date.UTC(2026, 8, 4, 12, 0, 0);
  const turn = { messageId: '3A0AEC8B', lastInboundAt: new Date(now - 60_000).toISOString() };
  const ok = { ok: true };

  // The production shape: a model that calls turn_start twice in one turn.
  assert.equal(r.markFor('turn_start', ok, turn, now), 'working');
  assert.equal(r.markFor('turn_start', ok, turn, now), null, 'the repeat buys nothing');

  // ...but a genuine progression on the SAME message still gets through, which
  // is the whole reason the key carries the state and not just the message.
  assert.equal(r.markFor('add_task', ok, turn, now), 'done');
  assert.equal(r.markFor('set_task_reminder', ok, turn, now), 'scheduled');
  assert.equal(r.markFor('add_task', ok, turn, now), null);

  // A different message in the same connection is a different mark. Without
  // this the second person to write on a reused connection gets nothing.
  turn.messageId = '3EB0FFFF';
  assert.equal(r.markFor('turn_start', ok, turn, now), 'working');
});

test('reactions: placeMark is detached, unref\'d, and never claims delivery', () => {
  const calls = [];
  const child = { on() {}, unref() { child.unrefd = true; } };
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return child; };

  const out = r.placeMark({
    channel: 'whatsapp', target: '+972500000000', messageId: '3EB0ABCD', state: 'done',
  }, { spawn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'openclaw');
  assert.deepEqual(calls[0].opts, { detached: true, stdio: 'ignore' },
    'an attached child dies with its parent while reporting success — the MCP-shim rule');
  assert.equal(child.unrefd, true);
  assert.ok(calls[0].args.includes('👍'));
  // `attempted`, never `sent`. There is no exit code to read, so there is no
  // claim to make — and nothing user-visible may depend on the mark landing.
  assert.deepEqual(out, { attempted: true, state: 'done', emoji: '👍' });
  assert.equal(out.sent, undefined);

  // Not applicable is not an attempt, and it must not spawn anything.
  const before = calls.length;
  assert.equal(r.placeMark({ channel: 'whatsapp', target: '+9725', state: 'done' }, { spawn }).attempted, false);
  assert.equal(calls.length, before, 'a missing id must not reach the CLI at all');

  // A box without the CLI throws synchronously on spawn. Decoration may never
  // take down a tool call, let alone the daemon.
  const boom = () => { throw new Error('ENOENT'); };
  assert.deepEqual(
    r.placeMark({ channel: 'whatsapp', target: '+9725', messageId: '3EB0ABCD', state: 'done' }, { spawn: boom }),
    { attempted: false, reason: 'spawn_failed' });
});

test('reactions: every marked tool exists, and the table is the only list', () => {
  const { TOOLS } = require('../src/adapters/mcp/registry');
  const names = new Set(TOOLS.map((t) => t.name));
  for (const name of Object.keys(r.TOOL_MARKS)) {
    assert.ok(names.has(name), `TOOL_MARKS names a tool that does not exist: ${name}`);
    assert.ok(r.REACTION_STATES[r.TOOL_MARKS[name]], `unknown state for ${name}`);
  }
  // turn_start is the one that must be there: it is where the id arrives and
  // the only mark that fires before the work starts.
  assert.equal(r.TOOL_MARKS.turn_start, 'working');
});

test('reactions: turn_start asks for the id, and by the gateway\'s own field name', () => {
  const { TOOLS } = require('../src/adapters/mcp/registry');
  const ts = TOOLS.find((t) => t.name === 'turn_start');
  // `message_id` is verbatim the key in the gateway's "Conversation info"
  // block. Renaming it here would silently end the feature: the model copies
  // the field it is shown, and nothing would ever fail.
  assert.ok(ts.inputSchema.properties.message_id, 'turn_start must accept message_id');
  assert.match(ts.inputSchema.properties.message_id.description, /Conversation info/);
  assert.ok(!ts.inputSchema.required.includes('message_id'),
    'a turn whose block carries no id must still open normally');
});

test('reactions: the outcome mark ranks by what it asks of the reader', () => {
  assert.equal(r.outcomeState({ failed: true, needsInput: true, scheduled: true }), 'failed');
  assert.equal(r.outcomeState({ needsInput: true, scheduled: true }), 'needs_input');
  // scheduled is deliberately not done: "written down for later" and "finished"
  // are different promises, and collapsing them is how somebody comes to
  // believe a reminder has already fired.
  assert.equal(r.outcomeState({ scheduled: true }), 'scheduled');
  assert.equal(r.outcomeState({}), 'done');
  assert.equal(r.outcomeState(), 'done');
});

// ── End to end, through the real dispatcher ──────────────────────────────────
// Everything above is pure. This is the test that would have caught the feature
// silently doing nothing: a real user, real tool calls, the real turn object
// threaded through brokerd, and only the spawn stubbed.
const { freshDb, makeUser } = require('./helpers');
const { createBrokerServer } = require('../src/brokerd/server');

test('reactions: a real turn marks the message 👀 and then upgrades it', async (t) => {
  const db = await freshDb();
  t.after(() => db.teardown());
  const marks = [];
  const broker = createBrokerServer({
    pool: db.pool,
    placeMark: (opts) => { marks.push(opts); return { attempted: true }; },
  });
  const user = await makeUser(db.pool, '+972500000901', { firstName: 'Gali' });
  const newTurn = () => ({ userId: null, opened: false, counted: false, quota: null, messageId: null, lastInboundAt: null });
  const call = (name, args, turn) => broker.dispatch(
    { id: 1, method: 'tool_call', params: { name, args: { identity_token: user.identity_token, ...args } } }, turn);

  const turn = newTurn();
  await call('turn_start', { message_id: '3EB0ACKTEST01' }, turn);
  assert.equal(marks.length, 1, 'the 👀 must land on the tool call the doctrine already makes first');
  assert.deepEqual(marks[0], {
    channel: 'whatsapp', target: user.phone, messageId: '3EB0ACKTEST01', state: 'working',
  });

  // Gali's actual case: she wrote "בוצע" and got a question back instead of an
  // acknowledgement. Capturing it now marks her own message 👍, which replaces
  // the 👀 in place — one mark, no second notification, nothing to un-send.
  const added = await call('add_task', { title: 'לנצל את הנקודות' }, turn);
  assert.ok(added.ok);
  assert.equal(marks.length, 2, 'the capture earns its own mark');
  assert.equal(marks[1].state, 'done');
  assert.equal(marks[1].messageId, '3EB0ACKTEST01',
    'every mark in a turn goes on the one message that opened it');

  // Completing it in the same turn wants the SAME 👍 on the SAME message, and
  // the person is already looking at one. This is the repeat measured in
  // production on the afternoon of 2026-09-04, and it now costs nothing.
  const { rows } = await db.pool.query(
    `SELECT id FROM tasks WHERE owner_id = $1 ORDER BY id DESC LIMIT 1`, [user.id]);
  const finished = await call('complete_task', { task_id: rows[0].id }, turn);
  assert.ok(finished.ok, 'the tool still runs — only the duplicate mark is dropped');
  assert.equal(marks.length, 2, 'no second identical mark was asked for');

  // A turn that never handed over an id gets no marks at all — silently, and
  // without failing anything. This is the majority case on day one.
  const blind = newTurn();
  await call('turn_start', {}, blind);
  const before = marks.length;
  await call('add_task', { title: 'ללא מזהה' }, blind);
  assert.equal(marks.length, before, 'no id, no guess');

  // And a second person on the same connection never inherits the first one's
  // message id — the reset in newTurn()'s user-change branch, which is the one
  // way this feature could have reached across users.
  const other = await makeUser(db.pool, '+972500000902', { firstName: 'Miron' });
  const shared = newTurn();
  await call('turn_start', { message_id: '3EB0ACKTEST02' }, shared);
  const n = marks.length;
  await broker.dispatch({ id: 2, method: 'tool_call', params: {
    name: 'add_task', args: { identity_token: other.identity_token, title: 'x' } } }, shared);
  assert.equal(marks.length, n, "a new user on the connection starts with no message id, not the last one's");
});
