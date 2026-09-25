'use strict';
// A settled time put back on the table, and the coordination carried on from
// where it stopped (owner, 2026-09-25, פנתרה: "לפתוח מאיפה שעצרו תיאום שכבר
// נקבע — ולהמשיך אותו מאיפה שעצרו"). Three doors — the chat, the room and the
// page — and one fan-out behind them.
//
// What "from where it stopped" has to mean, and what each test pins:
//   · every other time on the table stays, with every answer to it;
//   · the time that was set stays on the table with its answers CLEARED, or
//     the table would settle straight back onto it at the next answer;
//   · the others are told once, privately; the shared calendar event goes;
//   · the room hears one line, and the next "סגור" is not swallowed as a
//     duplicate of the first — every key it keyed on was once per meeting.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, slotStart } = require('./helpers');
const { withTx } = require('../src/db/pool');
const meetings = require('../src/domain/meetings');
const options = require('../src/domain/meeting-options');
const meetingFanout = require('../src/domain/meeting-fanout');
const write = require('../src/domain/user-dashboard-write');
const groups = require('../src/domain/groups');
const groupMeetings = require('../src/domain/group-meetings');
const groupVoice = require('../src/domain/group-voice');
const groupsJob = require('../src/jobs/groups');
const groupOutbox = require('../src/domain/group-outbox');
const proactiveText = require('../src/domain/proactive-text');
const { instructionFor } = require('../src/channels/openclaw');
const { BY_NAME } = require('../src/adapters/mcp/registry');

let db;
const tx = (fn) => withTx(db.pool, fn);
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });
beforeEach(async () => { await db.pool.query('DELETE FROM group_outbox WHERE sent_at IS NULL'); });

let seq = 0;
async function trio() {
  seq++;
  const people = [];
  for (let i = 0; i < 3; i++) {
    people.push(await makeUser(db.pool, `+97253196${String(seq).padStart(2, '0')}0${i}`,
      { firstName: ['Ann', 'Ben', 'Cal'][i] }));
  }
  for (const [x, y] of [[0, 1], [0, 2], [1, 2]]) {
    const { rows } = await db.pool.query(
      `INSERT INTO connections (requester_id, target_id, target_phone, status, responded_at)
       VALUES ($1, $2, $3, 'active', now()) RETURNING id`, [people[x].id, people[y].id, people[y].phone]);
    for (const g of [people[x], people[y]]) {
      await db.pool.query(
        `INSERT INTO connection_feature_grants (connection_id, grantor_id, feature) VALUES ($1, $2, 'meetings')`,
        [rows[0].id, g.id]);
    }
  }
  return people;
}

// Two times on the table; everybody said yes to the first and one person to
// the second; settled on the first. The shape פנתרה was in.
async function settled(people) {
  const [a, b, c] = people;
  const id = Number((await tx((cl) => meetings.startMeeting(cl, a.id, 'שיחת וידאו', [b.id, c.id]))).data.meeting.id);
  const first = slotStart('שבת', { hours: 72 });
  const second = slotStart('ראשון', { hours: 72 });
  await tx((cl) => meetings.proposeSlot(cl, a.id, id, 'שבת 12:00', first));
  await tx((cl) => meetings.proposeSlot(cl, b.id, id, 'ראשון 15:00', second));
  const opts = await tx((cl) => options.list(cl, id));
  const sat = opts.find((o) => o.slotText === 'שבת 12:00');
  const sun = opts.find((o) => o.slotText === 'ראשון 15:00');
  for (const u of [b, c]) await tx((cl) => options.answer(cl, u.id, id, sat.id, 'y'));
  await tx((cl) => options.confirmOn(cl, id, { ...sat, slot_text: sat.slotText, starts_at: sat.startsAt }, a.id));
  return { id, sat, sun };
}

const row = async (id) => (await db.pool.query('SELECT * FROM meetings WHERE id = $1', [id])).rows[0];

test('reopening puts it back to negotiating, keeps the table, and asks only the set time again', async () => {
  const people = await trio();
  const [, b, c] = people;
  const { id, sat, sun } = await settled(people);
  await db.pool.query(`UPDATE meetings SET group_done_at = now(), group_dayof_at = now() WHERE id = $1`, [id]);

  const res = await tx((cl) => meetingFanout.reopenAndTell(cl, c, id));
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.data.was, 'שבת 12:00');

  const m = await row(id);
  assert.equal(m.status, 'negotiating');
  assert.equal(m.confirmed_slot, null);
  assert.equal(m.closed_at, null);
  assert.equal(m.reopened_from, 'שבת 12:00');
  assert.ok(m.reopened_at);
  assert.equal(m.group_done_at, null, 'the next settle is told to the room afresh');
  assert.equal(m.group_dayof_at, null);

  const table = await tx((cl) => options.list(cl, id));
  assert.deepEqual(table.map((o) => o.id).sort(), [sat.id, sun.id].sort(), 'nothing left the table');
  assert.deepEqual(table.find((o) => o.id === sat.id).answers, {}, 'the set time is asked again');
  assert.equal(table.find((o) => o.id === sun.id).answers[String(b.id)], 'y', 'every other answer stands');

  // The others are told once; the person who reopened it is not.
  const { rows: told } = await db.pool.query(
    `SELECT user_id, payload FROM outbox WHERE kind = 'meeting_reopened'
      AND (payload->>'meetingId')::bigint = $1 ORDER BY user_id`, [id]);
  assert.deepEqual(told.map((r) => Number(r.user_id)), [people[0].id, b.id]);
  assert.equal(told[0].payload.was, 'שבת 12:00');
  assert.equal(told[0].payload.byName, 'Cal');

  // One answer to something else no longer settles it straight back.
  await tx((cl) => options.answer(cl, people[0].id, id, sun.id, 'y'));
  assert.equal((await row(id)).settle_due_at, null);
});

test('it can settle a second time, and that confirmation is not taken for the first', async () => {
  const people = await trio();
  const [a, b, c] = people;
  const { id, sun } = await settled(people);
  await tx((cl) => meetingFanout.afterSettled(cl, id, { ok: true, data: { slot: 'שבת 12:00' } }, { actor: a }));
  await tx((cl) => meetingFanout.reopenAndTell(cl, a, id));
  for (const u of [a, c]) await tx((cl) => options.answer(cl, u.id, id, sun.id, 'y'));
  const opt = (await tx((cl) => options.list(cl, id))).find((o) => o.id === sun.id);
  await tx((cl) => options.confirmOn(cl, id, { ...opt, slot_text: opt.slotText, starts_at: opt.startsAt }, a.id));
  await tx((cl) => meetingFanout.afterSettled(cl, id, { ok: true, data: { slot: 'ראשון 15:00' } }, { actor: a }));
  const { rows } = await db.pool.query(
    `SELECT payload->>'slot' AS slot FROM outbox WHERE kind = 'meeting_confirmed' AND user_id = $1
      AND (payload->>'meetingId')::bigint = $2 ORDER BY id`, [b.id, id]);
  // The first confirmation was superseded by the reopening; the second is a row of its own.
  assert.deepEqual(rows.map((r) => r.slot), ['שבת 12:00', 'ראשון 15:00']);
});

test('only a settled one that has not started, and only by somebody still in it', async () => {
  const people = await trio();
  const [a, b, c] = people;
  const { id } = await settled(people);
  const stranger = await makeUser(db.pool, '+972531969999', { firstName: 'Zed' });
  assert.equal((await tx((cl) => meetingFanout.reopenAndTell(cl, stranger, id))).error.code, 'not_found');

  await db.pool.query(`UPDATE meeting_participants SET state = 'opted_out' WHERE meeting_id = $1 AND user_id = $2`, [id, c.id]);
  assert.equal((await tx((cl) => meetingFanout.reopenAndTell(cl, c, id))).error.code, 'not_found',
    'somebody who left may not reopen it');

  await db.pool.query(`UPDATE meetings SET confirmed_start_at = now() - interval '1 hour' WHERE id = $1`, [id]);
  const started = await tx((cl) => meetingFanout.reopenAndTell(cl, b, id));
  assert.equal(started.error.reason, 'started');

  const open = Number((await tx((cl) => meetings.startMeeting(cl, a.id, 'x', [b.id]))).data.meeting.id);
  const r = await tx((cl) => meetingFanout.reopenAndTell(cl, a, open));
  assert.equal(r.error.reason, 'not_confirmed');
});

test('the chat tool and the page reach the same door', async () => {
  const people = await trio();
  const [a, b] = people;
  const one = await settled(people);
  const viaTool = await tx((cl) => BY_NAME.get('reopen_meeting').handler(cl, a, { meeting_id: one.id }));
  assert.ok(viaTool.ok, JSON.stringify(viaTool));
  assert.equal((await row(one.id)).status, 'negotiating');

  const two = await settled(await trio());
  const [, b2] = (await db.pool.query(
    'SELECT user_id FROM meeting_participants WHERE meeting_id = $1 ORDER BY user_id', [two.id])).rows.map((r) => r.user_id);
  const viaPage = await tx((cl) => write.perform(cl, Number(b2), 'reopenMeeting', { meetingId: two.id }));
  assert.ok(viaPage.ok, JSON.stringify(viaPage));
  assert.equal((await row(two.id)).status, 'negotiating');
  assert.ok(b);
});

test('the private message says what was set, asks the table again, and carries the page', () => {
  const body = instructionFor({ kind: 'meeting_reopened', payload: {
    meetingId: 7, title: 'שיחת וידאו', byName: 'Ann', was: 'שבת 12:00', calendarCleanup: 'auto',
  } }, 'https://allma.world/me/x');
  assert.match(body, /Ann reopened <<<שיחת וידאו>>>/);
  assert.match(body, /<<<שבת 12:00>>>/);
  assert.match(body, /get_meeting_status \(meeting_id=7\)/);
  assert.match(body, /already removed/);
  assert.ok(body.includes('https://allma.world/me/x'));
});

// ---- the room -------------------------------------------------------------

const DAY = (() => { const d = new Date(); d.setUTCHours(11, 0, 0, 0); return d; })();

async function pass(group, sent) {
  await tx((cl) => groupsJob.sweepGroupVoice(cl, { now: DAY }));
  await groupOutbox.drainOnce(db.pool, {
    now: DAY, channelWrittenAt: () => null,
    send: async (jid, body) => { if (jid === group.external_id) sent.push(body); return 'sent'; },
  });
}

test('the room hears it once, and then hears the next "סגור" as a new line', async () => {
  const people = [];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(db.pool, `+97260788800${i}`, { firstName: ['דני', 'דנה', 'יובל'][i] });
    await db.pool.query('UPDATE users SET last_inbound_at = now() WHERE id = $1', [u.id]);
    people.push(u);
  }
  const group = await tx(async (cl) => {
    const reg = await groups.registerGroup(cl, {
      externalId: '120363299999990001@g.us', subject: 'פנתרה', members: people.map((u) => ({ phone: u.phone })),
    });
    const { rows } = await cl.query(
      `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3, timezone = 'Asia/Jerusalem'
        WHERE id = $1 RETURNING *`, [reg.data.group.id, `g-${reg.data.group.id}`, 'olma_grp_' + '77'.repeat(16)]);
    return rows[0];
  });
  const [a, b, c] = people;
  const id = Number((await tx((cl) => groupMeetings.startCoordination(cl, group, a, 'שיחה'))).data.meeting.id);
  await db.pool.query('UPDATE meetings SET created_at = $2 WHERE id = $1', [id, DAY]);
  await db.pool.query(`UPDATE outbox SET sent_at = now() WHERE kind = 'meeting_invite'`);
  const when = slotStart('שבת', { hours: 72 });
  const later = slotStart('ראשון', { hours: 72 });
  const opt = (await tx((cl) => options.add(cl, a.id, id, 'שבת 12:00', when))).data.option;
  const opt2 = (await tx((cl) => options.add(cl, b.id, id, 'ראשון 15:00', later))).data.option;
  for (const u of [b, c]) await tx((cl) => options.answer(cl, u.id, id, opt.id, 'y'));
  await tx((cl) => options.confirmOn(cl, id, { ...opt, slot_text: opt.slotText, starts_at: opt.startsAt }, a.id));

  const sent = [];
  await pass(group, sent);                       // started
  await pass(group, sent);                       // done
  assert.ok(sent.some((s) => /סגור/.test(s)), sent.join('\n---\n'));
  const before = sent.length;

  await tx((cl) => meetingFanout.reopenAndTell(cl, c, id));
  await pass(group, sent);
  assert.equal(sent.length, before + 1);
  assert.match(sent[before], /התיאום \*שיחה\* נפתח מחדש — \*שבת 12:00\* כבר לא סגור/);
  await pass(group, sent);
  assert.equal(sent.length, before + 1, 'said once');

  for (const u of [a, c]) await tx((cl) => options.answer(cl, u.id, id, opt2.id, 'y'));
  const o2 = (await tx((cl) => options.list(cl, id))).find((o) => o.id === opt2.id);
  await tx((cl) => options.confirmOn(cl, id, { ...o2, slot_text: o2.slotText, starts_at: o2.startsAt }, a.id));
  await pass(group, sent);
  assert.equal(sent.length, before + 2);
  assert.match(sent[before + 1], /סגור/, 'the second settle is said, not swallowed by the first one\'s key');
  assert.match(sent[before + 1], /ראשון 15:00/);
});

test('reopened IN the room is not said to the room a second time by the sweep', async () => {
  const line = groupVoice.decideGroupLine({ status: 'negotiating', title: 'x', participants: 3, options: [] },
    { saidStarted: true, reopenedAt: new Date(), reopenedFrom: 'שבת 12:00', saidReopened: true, nowMs: Date.now() });
  assert.notEqual(line.kind, 'reopened');
  const said = groupVoice.decideGroupLine({ status: 'negotiating', title: 'x', participants: 3, options: [] },
    { saidStarted: true, reopenedAt: new Date(), reopenedFrom: 'שבת 12:00', saidReopened: false, nowMs: Date.now() });
  assert.equal(said.kind, 'reopened');
  assert.match(proactiveText.renderGroupCoordination(said), /נפתח מחדש/);
});
