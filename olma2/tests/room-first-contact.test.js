'use strict';
// Somebody a room sends to write "היי" in private hears about that room in the
// first reply, and the room's coordination follows without waiting for them to
// write again — at 02:25 too. Dana and ORGETZ each wrote twice before a word
// about "Shabi OG" reached them (2026-09-25, `incidents.md`, "Twice 'היי'
// before a word about the room"). Four pieces, each asserted where it lives:
// the greeter's line (brokerd + plugin), the gate, and the night admission.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const { decide } = require('../src/outbox/gate');
const groups = require('../src/domain/groups');
const groupMeetings = require('../src/domain/group-meetings');
const groupOutbox = require('../src/domain/group-outbox');
const groupsJob = require('../src/jobs/groups');
const intakeRoom = require('../src/domain/intake-room');

let db, broker, plugin;
before(async () => {
  db = await freshDb();
  broker = createBrokerServer({ pool: db.pool, placeMark: () => ({ attempted: true }) });
  plugin = await import('../gateway-plugin/olma-turn/index.js');
});
after(async () => { if (db) await db.teardown(); });

// One clock per moment, computed once. 11:00 UTC is daytime in an Israeli room
// and 00:30 UTC (03:30 there) is not, whatever hour the suite runs; the day
// before carries the room's opening line, so all three happen in order.
const DAY = (() => { const d = new Date(); d.setUTCHours(11, 0, 0, 0); return d; })();
const NIGHT = (() => { const d = new Date(DAY); d.setUTCHours(0, 30, 0, 0); return d; })();
const EVE = new Date(DAY.getTime() - 24 * 3600_000);

let seq = 0;
async function room(subject, { open = true, members = [] } = {}) {
  seq += 1;
  const people = [];
  for (let i = 0; i < 2; i++) {
    const u = await makeUser(db.pool, `+97250${seq}88000${i}`, { firstName: `חבר${i}` });
    await db.pool.query(`UPDATE users SET last_inbound_at = now() - interval '2 days' WHERE id = $1`, [u.id]);
    people.push(u);
  }
  const group = await withTx(db.pool, async (c) => {
    const reg = await groups.registerGroup(c, {
      externalId: `1203635555${String(seq).padStart(4, '0')}@g.us`, subject,
      members: [...people.map((u) => ({ phone: u.phone })), ...members.map((phone) => ({ phone }))],
    });
    const { rows } = await c.query(
      `UPDATE chat_groups SET state = $4, agent_id = $2, identity_token = $3, timezone = 'Asia/Jerusalem'
        WHERE id = $1 RETURNING *`,
      [reg.data.group.id, `g-${reg.data.group.id}`, 'olma_grp_' + String(60 + seq).repeat(16), open ? 'open' : 'locked']);
    return rows[0];
  });
  return { group, people };
}

async function start(group, by) {
  const res = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, by, 'פגישה של הקבוצה'));
  assert.equal(res.ok, true, JSON.stringify(res));
  return Number(res.data.meeting.id);
}

const intakeKey = (phone) => `agent:intake:whatsapp:direct:${phone}`;
const ask = (sessionKey) => broker.dispatch({ id: 1, method: 'intake_context', params: { sessionKey } });

test('the greeter is handed the room, and the line promises the coordination only when there is one to join', async () => {
  const withCo = '+972501770001';
  const noCo = '+972501770002';
  const { group, people } = await room('Shabi OG', { members: [withCo] });
  const meetingId = await start(group, people[0]);
  await room('ערב שישי', { members: [noCo] });

  const a = await ask(intakeKey(withCo));
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.meetingId, meetingId);
  // With a coordination waiting, the short opening REPLACES the owner's
  // (owner, 2026-09-29): who she is, that it is coming, the privacy link.
  assert.ok(a.context.includes('היי, אני עולמה 👋 עוזרת AI\n'
    + 'הגעת מהקבוצה «Shabi OG» — שולחת לך עכשיו את התיאום שפתוח שם.\n'
    + 'מה אני שומרת ואיך מוחקים: https://allma.world/privacy'), a.context);
  assert.match(a.context, /FIRST reply only/);
  assert.match(a.context, /INSTEAD of the opening text/);
  assert.ok(!a.context.includes('תכף אשלח'), 'the old line under the opening is gone');

  const b = await ask(intakeKey(noCo));
  assert.equal(b.meetingId, null);
  assert.ok(b.context.includes('הגעת מהקבוצה «ערב שישי» — שם אני עוזרת לתאם, וכאן אני בשבילך באופן אישי.'), b.context);
  assert.ok(!b.context.includes('תכף אשלח'), 'no coordination, no promise');
  assert.ok(!b.context.includes('INSTEAD'), 'no coordination: the owner\'s opening, with the line under it');

  assert.deepEqual(await ask(intakeKey('+972501770099')), { ok: true, context: null }, 'in no room: nothing');
  assert.equal((await ask('agent:u-3:whatsapp:direct:+972501770001')).ok, false, 'only the greeter key');

  const { rows } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE event = 'intake.room_context_served' ORDER BY id`);
  assert.equal(rows.length, 2);
  assert.ok(!JSON.stringify(rows).includes('+97250177'), 'the number stays out of the ledger');
});

test('a locked room, a coordination in its settle minute, a room they left: no promise, or no line', async () => {
  const locked = '+972501770011';
  const settling = '+972501770012';
  const gone = '+972501770013';
  const l = await room('נעול', { open: false, members: [locked] });
  await db.pool.query(
    `INSERT INTO meetings (initiator_id, title, status, group_id) VALUES ($1, 'x', 'negotiating', $2)`,
    [l.people[0].id, l.group.id]);
  assert.ok(!(await ask(intakeKey(locked))).context.includes('שולחת לך'), 'a locked room lets nobody in');

  const s = await room('מתיישב', { members: [settling] });
  const mid = await start(s.group, s.people[0]);
  await db.pool.query(`UPDATE meetings SET settle_due_at = now() + interval '1 minute' WHERE id = $1`, [mid]);
  assert.ok(!(await ask(intakeKey(settling))).context.includes('שולחת לך'), 'about to be decided: nothing to join');

  const g = await room('עזבתי', { members: [gone] });
  await db.pool.query(`UPDATE chat_group_members SET left_at = now() WHERE group_id = $1 AND phone = $2`, [g.group.id, gone]);
  assert.equal((await ask(intakeKey(gone))).context, null);
});

// The privacy link reaches each person ONCE, ever (owner, 2026-10-01). The
// greeter's session resets daily and it has no database, so somebody it
// opened for yesterday is told so by brokerd, off the stamps on their row.
test('somebody already introduced is not given the opening or the privacy link a second time', async () => {
  const fresh = '+972501770041';
  const opened = await makeUser(db.pool, '+972501770042', { status: 'pending' });
  await db.pool.query(`UPDATE users SET opening_sent_at = now() - interval '1 day' WHERE id = $1`, [opened.id]);
  const onlyLink = await makeUser(db.pool, '+972501770043', { status: 'pending' });
  await db.pool.query(`UPDATE users SET privacy_link_sent_at = now() - interval '1 day' WHERE id = $1`, [onlyLink.id]);
  await makeUser(db.pool, fresh, { status: 'pending' });

  assert.deepEqual(await ask(intakeKey(fresh)), { ok: true, context: null }, 'a row with neither stamp: the old greeting');
  for (const phone of [opened.phone, onlyLink.phone]) {
    const r = await ask(intakeKey(phone));
    assert.equal(r.introduced, true, phone);
    assert.match(r.context, /ALREADY been introduced/);
    assert.match(r.context, /Do NOT say the opening text/);
  }

  // In a room with a coordination: the room is news, its privacy line is not.
  const withCo = await makeUser(db.pool, '+972501770044', { status: 'pending' });
  await db.pool.query(`UPDATE users SET privacy_link_sent_at = now() - interval '1 day' WHERE id = $1`, [withCo.id]);
  const { group, people } = await room('נכנסו אתמול', { members: [withCo.phone] });
  await start(group, people[0]);
  const a = await ask(intakeKey(withCo.phone));
  assert.ok(a.context.includes('הגעת מהקבוצה «נכנסו אתמול» — שולחת לך עכשיו את התיאום שפתוח שם.'), a.context);
  assert.ok(!a.context.includes('https://allma.world/privacy'), 'the short opening lost its privacy line');
  assert.match(a.context, /ALREADY been introduced/);

  // In a room with none: the line stands on its own, not under an opening.
  const plain = await makeUser(db.pool, '+972501770045', { status: 'pending' });
  await db.pool.query(`UPDATE users SET opening_sent_at = now() - interval '1 day' WHERE id = $1`, [plain.id]);
  await room('בלי תיאום', { members: [plain.phone] });
  const b = await ask(intakeKey(plain.phone));
  assert.ok(b.context.includes('הגעת מהקבוצה «בלי תיאום»'), b.context);
  assert.ok(!b.context.includes('directly under the opening text'), b.context);
});

// The room's cold invite already said who she is and promised "reply and I'll
// add you". In "חייב קבוצה לפוקר" every newcomer who replied then read a second
// hello from the greeter a minute later (2026-10-01, `incidents.md`,
// "Introduced twice, by the invite and the greeter").
test('somebody the room\'s cold invite reached is answered with the yes, never a second hello', async () => {
  const reached = await makeUser(db.pool, '+972501770051', { status: 'pending' });
  const dropped = await makeUser(db.pool, '+972501770052', { status: 'pending' });
  const { group, people } = await room('חייב קבוצה לפוקר', { members: [reached.phone, dropped.phone] });
  await start(group, people[0]);
  const invite = (u, holdReason) => db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, idempotency_key, sent_at, hold_reason)
     VALUES ($1, 'room_cold_invite', '{}', $2, now(), $3)`,
    [u.id, `coldinvite:g${group.id}:u${u.id}`, holdReason]);
  await invite(reached, null);
  await invite(dropped, 'quiet');

  const a = await ask(intakeKey(reached.phone));
  assert.equal(a.invited, true, JSON.stringify(a));
  assert.ok(a.context.includes('מעולה, מצרפת אותך ושולחת לך עכשיו את התיאום מ«חייב קבוצה לפוקר» ☺️\n'
    + 'מה אני שומרת ואיך מוחקים: https://allma.world/privacy'), a.context);
  assert.ok(!a.context.includes('היי, אני עולמה'), 'no second hello');
  assert.match(a.context, /INSTEAD of the opening text/);

  // An invite the gate dropped reached nobody: they still get the hello.
  const b = await ask(intakeKey(dropped.phone));
  assert.equal(b.invited, undefined);
  assert.ok(b.context.includes('היי, אני עולמה 👋 עוזרת AI'), b.context);

  // And the yes is still recognised as the room's opening, so it stamps
  // opening_sent_at and the welcome follow-up waits behind the coordination.
  for (const lang of ['he', 'en']) {
    assert.equal(intakeRoom.saidRoomOpening(intakeRoom.INVITED_ANSWER[lang].replace('{subject}', 'x')), true, lang);
  }
});

test('the short opening is recognised by its room line, whatever the subject became', () => {
  const said = intakeRoom.ROOM_OPENING.he.replace('{subject}', 'x'.repeat(40) + '…');
  assert.equal(intakeRoom.saidRoomOpening(said), true);
  assert.equal(intakeRoom.saidRoomOpening(intakeRoom.ROOM_OPENING.en.replace('{subject}', 'Padel').replace("'", '\u2019')), true,
    'a curly apostrophe is the same sentence');
  assert.equal(intakeRoom.saidRoomOpening('הגעת מהקבוצה «x» — שם אני עוזרת לתאם, וכאן אני בשבילך באופן אישי.'), false);
  assert.equal(intakeRoom.saidRoomOpening(null), false);
});

test('a subject is somebody else\'s text: one line, no guillemets of its own, bounded', () => {
  assert.equal(intakeRoom.cleanSubject('a\nb «c»'), 'a b c');
  assert.equal(intakeRoom.cleanSubject('x'.repeat(80)).length, 61);
  assert.equal(intakeRoom.peerOf('agent:intake:whatsapp:direct:+972501234567'), '+972501234567');
  assert.equal(intakeRoom.peerOf('agent:intake:whatsapp:group:1203@g.us'), null);
});

// The plugin side, against a fake socket.
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

test('the plugin prepends the greeter\'s room block, sends only the session key, and fails open', async () => {
  const log = [];
  const { connect, sent } = fakeConnect({ id: 1, ok: true, context: 'Room: …', groupId: 11, meetingId: 49 });
  const handler = plugin.buildHandler({ agents: ['u-3'], connect, log: (o) => log.push(o) });
  const ctx = { agentId: 'intake', sessionKey: 'agent:intake:whatsapp:direct:+972544000000' };
  assert.deepEqual(await handler({ prompt: 'היי' }, ctx), { prependContext: 'Room: …' });
  assert.deepEqual(sent, [{ id: 1, method: 'intake_context', params: { sessionKey: ctx.sessionKey } }]);
  assert.equal(log.at(-1).intake, 'prepended');

  const none = plugin.buildHandler({ agents: [], connect: fakeConnect({ id: 1, ok: true, context: null }).connect, log: (o) => log.push(o) });
  assert.equal(await none({ prompt: 'היי' }, ctx), undefined);
  assert.equal(log.at(-1).intake, 'no-room');
  const dead = plugin.buildHandler({ agents: [], connect: () => { throw new Error('no socket'); }, log: (o) => log.push(o) });
  assert.equal(await dead({ prompt: 'היי' }, ctx), undefined);
  assert.equal(log.at(-1).intake, 'unreachable');
});

test('gate: somebody the greeter just answered is mid-conversation — for a coordination row, and nothing else', () => {
  const night = {
    plan: 'free', blocked: false, window: { start: '09:00', end: '21:00' }, tz: 'Asia/Jerusalem',
    sentToday: 0, budget: 4, now: NIGHT,
  };
  const justGreeted = new Date(NIGHT.getTime() - 2 * 60_000).toISOString();
  const longAgo = new Date(NIGHT.getTime() - 60 * 60_000).toISOString();
  const invite = { kind: 'meeting_invite', urgency: 'normal', expires_at: null, payload: { meetingId: 49 } };
  const checkin = { kind: 'checkin', urgency: 'normal', expires_at: null, payload: {} };
  assert.equal(decide({ ...night, row: invite }).holdReason, 'night');
  assert.equal(decide({ ...night, greetedAt: justGreeted, row: invite }).action, 'deliver');
  assert.equal(decide({ ...night, greetedAt: longAgo, row: invite }).holdReason, 'night');
  assert.equal(decide({ ...night, greetedAt: justGreeted, row: checkin }).holdReason, 'night',
    'the day-one check-ins still wait for the morning');
});

test('at night, only somebody awake is let in — quietly — and the room names them in its morning', async () => {
  const awake = '+972501770021';
  const asleep = '+972501770022';
  const { group, people } = await room('לילה', { members: [awake, asleep] });
  const meetingId = await start(group, people[0]);
  const jid = group.external_id;
  const pass = async (now) => {
    const sent = [];
    await withTx(db.pool, (c) => groupsJob.sweepGroupVoice(c, { now }));
    await groupOutbox.drainOnce(db.pool, {
      now, channelWrittenAt: () => null,
      send: async (to, body) => { if (to === jid) sent.push(body); return 'sent'; },
    });
    return sent;
  };
  assert.equal((await pass(EVE)).length, 1, 'the opening line, the evening before');

  // Both are users by night; one was answered by the greeter two minutes ago,
  // the other wrote to her yesterday and is asleep.
  const link = async (phone, col, at) => {
    const u = await makeUser(db.pool, phone, { firstName: 'חדש' });
    await db.pool.query(`UPDATE users SET ${col} = $2 WHERE id = $1`, [u.id, at]);
    await db.pool.query(`UPDATE chat_group_members SET user_id = $3 WHERE group_id = $1 AND phone = $2`, [group.id, phone, u.id]);
    return u;
  };
  const a = await link(awake, 'opening_sent_at', new Date(NIGHT.getTime() - 2 * 60_000));
  const z = await link(asleep, 'last_inbound_at', new Date(NIGHT.getTime() - 20 * 3600_000));

  assert.deepEqual(await pass(NIGHT), [], 'the room sleeps');
  const inIt = async (id) => (await db.pool.query(
    `SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2`, [meetingId, id])).rowCount === 1;
  assert.equal(await inIt(a.id), true, 'awake: let in now');
  assert.equal(await inIt(z.id), false, 'asleep: not at night');
  const { rows: invites } = await db.pool.query(
    `SELECT user_id FROM outbox WHERE kind = 'meeting_invite' AND (payload->>'meetingId')::bigint = $1 AND user_id = ANY($2)`,
    [meetingId, [a.id, z.id]]);
  assert.deepEqual(invites.map((r) => Number(r.user_id)), [Number(a.id)]);

  // Morning: the sleeper is let in now, and ONE line names both.
  const morning = await pass(DAY);
  assert.equal(morning.length, 1, JSON.stringify(morning));
  assert.ok(morning[0].includes(`@${awake}`) && morning[0].includes(`@${asleep}`), morning[0]);
  assert.equal(await inIt(z.id), true);
  // …and never again.
  assert.deepEqual(await pass(new Date(DAY.getTime() + 5 * 60_000)), []);
});
