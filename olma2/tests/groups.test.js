'use strict';
// Group mode. The rule under test, in the owner's words: she is reachable in a
// group only by tag, and she answers nobody there until every member has sent
// her one private message.
//
// The cases that matter are the ones where an implementation would be WRONG in
// the direction of talking: a member the roster string could not be parsed
// for, a member who is a user but has never written, and a newcomer arriving
// after the group opened.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const flags = require('../src/domain/flags');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const JID = (n) => `12036342828212770${n}@g.us`;

// A user who has actually written to Olma — the gate's real predicate.
async function connectedUser(phone, extra = {}) {
  const u = await makeUser(db.pool, phone, extra);
  await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
  return u;
}

test('the roster string is parsed with the name half optional', () => {
  const { members, unparsed } = groups.parseRoster(
    'חיים דדוש (+972501111111), +972502222222, גלי 🌊 (+972 50 333-1111)'
  );
  assert.deepEqual(members, [
    { phone: '+972501111111', displayName: 'חיים דדוש' },
    { phone: '+972502222222', displayName: null },
    { phone: '+972503331111', displayName: 'גלי' },
  ]);
  assert.deepEqual(unparsed, []);
});

// A display name that is really the phone number tells us nothing and looks
// like a name — the same trap captureDisplayName already guards in DMs.
// The first real group, 2026-09-06. The gateway lists her among the members
// of every room she is in: `+972559347282, +972549495254, M&M (+972526269826)`.
// Left in, she is a member who has never written to herself — the group can
// never open, and the nudge asking who is missing tags her own number.
test('she is in every group she is in, and is not a member of it', () => {
  const live = '+972559347282, +972549495254, M&M (+972526269826)';
  const { members, unparsed } = groups.parseRoster(live);
  assert.deepEqual(members.map((m) => m.phone), ['+972549495254', '+972526269826']);
  assert.deepEqual(unparsed, [], 'dropped as herself, never reported as unreadable');
  assert.equal(groups.SELF_PHONE, '+972559347282');
  // and a room of nobody but her is a room with no members at all — the sweep
  // reads that as "no evidence" and leaves it alone, never as an open group
  assert.deepEqual(groups.parseRoster(groups.SELF_PHONE).members, []);
});

test('a numeric display name is dropped, not stored as a name', () => {
  const { members } = groups.parseRoster('972504444444 (+972504444444)');
  assert.deepEqual(members, [{ phone: '+972504444444', displayName: null }]);
});

// The direction of this failure is the whole point: an entry we cannot resolve
// to a phone must never quietly vanish, because a vanished member is a member
// the gate stops waiting for.
test('an unparseable entry is reported, never silently dropped', () => {
  const { members, unparsed } = groups.parseRoster('~Someone, +972505555555');
  assert.deepEqual(members.map((m) => m.phone), ['+972505555555']);
  assert.deepEqual(unparsed, ['~Someone']);
});

test('majority timezone wins, and ties are deterministic', () => {
  assert.equal(
    groups.majorityTimezone(['Asia/Jerusalem', 'Europe/Berlin', 'Asia/Jerusalem']),
    'Asia/Jerusalem'
  );
  // One each: same answer every time, whichever order they arrive in.
  assert.equal(groups.majorityTimezone(['Europe/Berlin', 'Asia/Jerusalem']), 'Asia/Jerusalem');
  assert.equal(groups.majorityTimezone(['Asia/Jerusalem', 'Europe/Berlin']), 'Asia/Jerusalem');
  assert.equal(groups.majorityTimezone([null, undefined]), groups.DEFAULT_TIMEZONE);
});

test('a group of strangers registers nothing at all', async () => {
  const res = await withTx(db.pool, (c) => groups.registerGroup(c, {
    externalId: JID(1),
    subject: 'סתם קבוצה',
    members: [{ phone: '+972509990001' }, { phone: '+972509990002' }],
  }));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'forbidden');
  const row = await withTx(db.pool, (c) => groups.getByExternalId(c, 'whatsapp', JID(1)));
  assert.equal(row, null);
});

test('one known member is enough to register, and registering twice is idempotent', async () => {
  const known = await connectedUser('+972501000001', { firstName: 'מירון' });
  const members = [{ phone: known.phone, displayName: 'מירון' }, { phone: '+972501000002' }];

  const first = await withTx(db.pool, (c) => groups.registerGroup(c, {
    externalId: JID(2), subject: 'תיאום', members,
  }));
  assert.equal(first.ok, true);
  assert.equal(first.data.created, true);
  assert.equal(first.data.group.registered_by_user_id, known.id);
  assert.equal(first.data.group.state, 'locked');

  const again = await withTx(db.pool, (c) => groups.registerGroup(c, {
    externalId: JID(2), subject: 'תיאום', members,
  }));
  assert.equal(again.data.created, false);
  assert.equal(again.data.group.id, first.data.group.id);
});

test('the gate stays locked while one member has never written, then opens', async () => {
  const a = await connectedUser('+972501000010');
  const b = await makeUser(db.pool, '+972501000011');           // a user, but silent
  const reg = await withTx(db.pool, (c) => groups.registerGroup(c, {
    externalId: JID(3), members: [{ phone: a.phone }, { phone: b.phone }],
  }));
  const gid = reg.data.group.id;

  let evald = await withTx(db.pool, (c) => groups.evaluate(c, gid));
  assert.equal(evald.data.state, 'locked');
  assert.deepEqual(evald.data.missing.map((m) => m.phone), [b.phone]);

  // Being provisioned is not the predicate — writing is.
  await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [b.id]);
  evald = await withTx(db.pool, (c) => groups.evaluate(c, gid));
  assert.equal(evald.data.state, 'open');
  assert.deepEqual(evald.data.missing, []);

  const applied = await withTx(db.pool, (c) => groups.applyState(c, gid, 'open'));
  assert.equal(applied.data.changed, true);
  assert.equal(applied.data.firstOpen, true);
  assert.ok(applied.data.group.opened_at);
});

// A member who is in the roster but is nobody we know is the common case while
// a group fills up, and the one an "is this phone a user" check gets wrong.
test('a member who is not a user at all keeps the group locked', async () => {
  const a = await connectedUser('+972501000020');
  const reg = await withTx(db.pool, (c) => groups.registerGroup(c, {
    externalId: JID(4), members: [{ phone: a.phone }, { phone: '+972501000021' }],
  }));
  const evald = await withTx(db.pool, (c) => groups.evaluate(c, reg.data.group.id));
  assert.equal(evald.data.state, 'locked');
  assert.deepEqual(evald.data.missing.map((m) => m.phone), ['+972501000021']);
});

test('a newcomer re-locks an open group, and leaving reopens it', async () => {
  const a = await connectedUser('+972501000030');
  const b = await connectedUser('+972501000031');
  const reg = await withTx(db.pool, (c) => groups.registerGroup(c, {
    externalId: JID(5), members: [{ phone: a.phone }, { phone: b.phone }],
  }));
  const gid = reg.data.group.id;
  await withTx(db.pool, (c) => groups.applyState(c, gid, 'open'));

  await withTx(db.pool, (c) => groups.syncRoster(c, gid, [
    { phone: a.phone }, { phone: b.phone }, { phone: '+972501000032', displayName: 'חדש' },
  ]));
  let evald = await withTx(db.pool, (c) => groups.evaluate(c, gid));
  assert.equal(evald.data.state, 'locked');
  assert.deepEqual(evald.data.missing.map((m) => m.displayName), ['חדש']);

  const relocked = await withTx(db.pool, (c) => groups.applyState(c, gid, 'locked'));
  assert.equal(relocked.data.changed, true);
  // Already opened once — opened_at is history, not a live state bit.
  assert.ok(relocked.data.group.opened_at);

  await withTx(db.pool, (c) => groups.syncRoster(c, gid, [{ phone: a.phone }, { phone: b.phone }]));
  evald = await withTx(db.pool, (c) => groups.evaluate(c, gid));
  assert.equal(evald.data.state, 'open');

  const left = await withTx(db.pool, (c) => groups.listMembers(c, gid, { includeLeft: true }));
  assert.equal(left.length, 3, 'who was here is history — rows are marked, never deleted');
  assert.ok(left.find((m) => m.phone === '+972501000032').left_at);
});

test('a rejoining member comes back live rather than as a second row', async () => {
  const a = await connectedUser('+972501000040');
  const reg = await withTx(db.pool, (c) => groups.registerGroup(c, {
    externalId: JID(6), members: [{ phone: a.phone }, { phone: '+972501000041' }],
  }));
  const gid = reg.data.group.id;
  await withTx(db.pool, (c) => groups.syncRoster(c, gid, [{ phone: a.phone }]));
  const back = await withTx(db.pool, (c) => groups.syncRoster(c, gid, [
    { phone: a.phone }, { phone: '+972501000041' },
  ]));
  assert.deepEqual(back.rejoined, ['+972501000041']);
  const live = await withTx(db.pool, (c) => groups.listMembers(c, gid));
  assert.equal(live.length, 2);
});

test('a group over the cap is too_large, which is not a locked group', async () => {
  const a = await connectedUser('+972501000050');
  const members = [{ phone: a.phone }];
  for (let i = 0; i < 30; i++) members.push({ phone: `+9725010001${String(i).padStart(2, '0')}` });
  const reg = await withTx(db.pool, (c) => groups.registerGroup(c, {
    externalId: JID(7), members,
  }));
  const evald = await withTx(db.pool, (c) => groups.evaluate(c, reg.data.group.id));
  assert.equal(evald.data.state, 'too_large');
  assert.equal(evald.data.memberCount, 31);

  // The cap is a flag, not a constant: raising it changes the answer with no deploy.
  await withTx(db.pool, (c) => flags.setFlag(c, 'group_max_members', 40));
  const after = await withTx(db.pool, (c) => groups.evaluate(c, reg.data.group.id));
  assert.equal(after.data.state, 'locked');
  await withTx(db.pool, (c) => flags.setFlag(c, 'group_max_members', 25));
});

test('the roster tracks people becoming users while the group waits', async () => {
  const a = await connectedUser('+972501000060');
  const reg = await withTx(db.pool, (c) => groups.registerGroup(c, {
    externalId: JID(8), members: [{ phone: a.phone }, { phone: '+972501000061' }],
  }));
  const gid = reg.data.group.id;

  const late = await connectedUser('+972501000061', { firstName: 'מאוחר' });
  // The roster has not changed; re-syncing it is what re-resolves the member.
  await withTx(db.pool, (c) => groups.syncRoster(c, gid, [
    { phone: a.phone }, { phone: late.phone },
  ]));
  const evald = await withTx(db.pool, (c) => groups.evaluate(c, gid));
  assert.equal(evald.data.state, 'open');
});

test('the group timezone follows the majority of its members', async () => {
  const a = await connectedUser('+972501000070', { timezone: 'Europe/Berlin' });
  const b = await connectedUser('+972501000071', { timezone: 'Europe/Berlin' });
  const c3 = await connectedUser('+972501000072', { timezone: 'Asia/Jerusalem' });
  const reg = await withTx(db.pool, (c) => groups.registerGroup(c, {
    externalId: JID(9), members: [{ phone: a.phone }, { phone: b.phone }, { phone: c3.phone }],
  }));
  const sync = await withTx(db.pool, (c) => groups.syncRoster(c, reg.data.group.id, [
    { phone: a.phone }, { phone: b.phone }, { phone: c3.phone },
  ]));
  assert.equal(sync.timezone, 'Europe/Berlin');
  const row = await withTx(db.pool, (c) => groups.getById(c, reg.data.group.id));
  assert.equal(row.timezone, 'Europe/Berlin');
});

// The notice is the only thing a locked group ever hears. Every tag gets one
// — the owner removed the cooldown that used to hold the second tag — and the
// answer shortens after the first, so a room that keeps tagging her hears a
// one-liner rather than the explanation again.
test('the first tag explains, every later tag nudges, and nothing waits on a clock', () => {
  const locked = { state: 'locked', notices_sent: 0, last_notice_at: null };
  assert.equal(groups.decideNotice(locked).kind, 'explain');

  const justTold = { state: 'locked', notices_sent: 1, last_notice_at: new Date(Date.now() - 5_000) };
  assert.equal(groups.decideNotice(justTold).kind, 'nudge', 'five seconds later is still answered');
  assert.equal(groups.decideNotice({ ...justTold, notices_sent: 40 }).kind, 'nudge');

  assert.equal(groups.decideNotice({ state: 'open', notices_sent: 0 }).kind, 'none');
  assert.equal(groups.decideNotice({ state: 'retired', notices_sent: 0 }).kind, 'none');
});

// Nobody in the room can fix being 40 people by writing a message, so saying
// it twice is nagging.
test('too_large is said once and never repeated', () => {
  assert.equal(groups.decideNotice({ state: 'too_large', notices_sent: 0 }).kind, 'too_large');
  assert.equal(groups.decideNotice({ state: 'too_large', notices_sent: 1 }).kind, 'none');
});

test('a retired group never comes back on a stale roster read', async () => {
  const a = await connectedUser('+972501000080');
  const reg = await withTx(db.pool, (c) => groups.registerGroup(c, {
    externalId: JID(0), members: [{ phone: a.phone }],
  }));
  const gid = reg.data.group.id;
  await withTx(db.pool, (c) => groups.applyState(c, gid, 'retired'));
  const back = await withTx(db.pool, (c) => groups.applyState(c, gid, 'open'));
  assert.equal(back.data.changed, false);
  assert.equal(back.data.group.state, 'retired');
});

test('mentions and notices are stamped where the delivery gate can read them', async () => {
  const a = await connectedUser('+972501000090');
  const reg = await withTx(db.pool, (c) => groups.registerGroup(c, {
    externalId: JID(3) + '.x', members: [{ phone: a.phone }],
  }));
  const gid = reg.data.group.id;
  await withTx(db.pool, (c) => groups.noteMention(c, gid));
  await withTx(db.pool, (c) => groups.noteNoticeSent(c, gid));
  const row = await withTx(db.pool, (c) => groups.getById(c, gid));
  assert.ok(row.last_mention_at, 'the gate needs this for its 15-minute grace');
  assert.ok(row.last_notice_at);
  assert.equal(row.notices_sent, 1);
  assert.ok(row.gate_notice_at, 'a notice about somebody missing is what the opening line answers');

  // The other kind of notice. It is still an answer to a tag, so it counts and
  // it stamps the cooldown column — but nobody in that room was ever waiting
  // on a person, and "יש! כולם כאן" would answer a sentence she never said.
  const big = await withTx(db.pool, (c) => groups.registerGroup(c, {
    externalId: JID(3) + '.y', members: [{ phone: a.phone }],
  }));
  await withTx(db.pool, (c) => groups.noteNoticeSent(c, big.data.group.id, { toldOfMissing: false }));
  const other = await withTx(db.pool, (c) => groups.getById(c, big.data.group.id));
  assert.ok(other.last_notice_at);
  assert.equal(other.notices_sent, 1);
  assert.equal(other.gate_notice_at, null);
});
