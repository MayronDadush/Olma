'use strict';
// "מה כתבתי בעצמי" — the log of proactive messages the owner writes by hand,
// kept so the two of us can read them back and find the moments Olma should
// have noticed on her own (owner, 2026-09-24; migration 089).
//
// What these hold open: the log outlives the outbox row it came from, what
// Olma actually wrote is read from the transcript and kept, and a transcript
// that could not be read (null) is never written down as "nothing was said".
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { enqueue } = require('../src/outbox/enqueue');
const ownerMessages = require('../src/domain/owner-messages');
const { renderOwnerLogAt } = require('../src/adapters/http/admin/sections/owner-log');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// A moment computed once, far from any hour boundary that matters here.
const NOW = new Date('2026-09-24T12:00:00Z');
const HOUR = 3600 * 1000;

async function writeOne(userId, instruction, { sentAt = null, hold = null } = {}) {
  return withTx(db.pool, async (c) => {
    const q = await enqueue(c, {
      userId, kind: 'checkin', payload: { checkinInstruction: instruction, rung: 'admin' },
    });
    await ownerMessages.record(c, { userId, outboxId: q.data.outboxId, instruction, urgency: 'normal' });
    if (sentAt) {
      await c.query(`UPDATE outbox SET sent_at = $2, hold_reason = $3 WHERE id = $1`,
        [q.data.outboxId, sentAt, hold]);
    }
    return q.data.outboxId;
  });
}

const row = async (instruction) => (await db.pool.query(
  `SELECT * FROM owner_messages WHERE instruction = $1`, [instruction])).rows[0];

test('the four states read true, and an unreadable transcript is not written down as silence', async () => {
  const a = await makeUser(db.pool, '+972611000951', { firstName: 'Avi' });
  const b = await makeUser(db.pool, '+972611000952', { firstName: 'Ben' });
  await db.pool.query(`UPDATE users SET agent_id = 'u-' || id WHERE id IN ($1, $2)`, [a.id, b.id]);

  const sentAt = new Date(NOW.getTime() - 2 * HOUR);
  await writeOne(a.id, 'queued, not yet out');
  await writeOne(a.id, 'out and answered', { sentAt });
  await writeOne(b.id, 'out, transcript unreadable', { sentAt });
  await writeOne(a.id, 'cancelled', { sentAt, hold: 'cancelled_by_admin' });
  await db.pool.query(
    `INSERT INTO audit_log (actor_id, event, detail, created_at) VALUES ($1, 'message.received', '{}', $2)`,
    [a.id, new Date(sentAt.getTime() + 20 * 60 * 1000)]);

  const t = sentAt.getTime();
  const scan = async (agentId) => (agentId === `u-${a.id}`
    ? [{ at: t - 5000, text: 'from before it went out' },
      { at: t + 2000, text: 'NO_REPLY' },
      { at: t + 4000, text: 'היי אבי, איך הלך הראיון?' }]
    : null);

  const html = await withTx(db.pool, (c) => renderOwnerLogAt(c, { scan, now: NOW }));

  const answered = await row('out and answered');
  assert.equal(answered.sent_text, 'היי אבי, איך הלך הראיון?', 'the first real sentence after the send, not NO_REPLY and not one from before');
  assert.ok(answered.replied_at, 'his next message is the reply');
  assert.match(html, /ענה אחרי 20 דק׳/);

  const unreadable = await row('out, transcript unreadable');
  assert.ok(unreadable.sent_at);
  assert.equal(unreadable.sent_text, null, 'null from the transcript means "could not tell", so nothing is stored');
  assert.match(html, /הטקסט לא נמצא בתמליל/);

  assert.equal((await row('cancelled')).sent_at, null, 'a cancelled row was stamped sent and went nowhere');
  assert.match(html, /בוטל לפני שיצא/);
  assert.match(html, /עוד בתור/);
});

test('the log outlives its outbox row, and goes with the person', async () => {
  const u = await makeUser(db.pool, '+972611000953', { firstName: 'Dan' });
  const outboxId = await writeOne(u.id, 'outlives the outbox', { sentAt: new Date(NOW.getTime() - HOUR) });
  await withTx(db.pool, (c) => ownerMessages.fillOutcomes(c, { scan: async () => null, now: NOW }));
  await db.pool.query(`DELETE FROM outbox WHERE id = $1`, [outboxId]); // what retention does
  const html = await withTx(db.pool, (c) => renderOwnerLogAt(c, { scan: async () => null, now: NOW }));
  assert.match(html, /outlives the outbox/);
  assert.ok((await row('outlives the outbox')).sent_at, 'sent_at was copied while the row still existed');

  await db.pool.query(`DELETE FROM users WHERE id = $1`, [u.id]);
  assert.equal(await row('outlives the outbox'), undefined, 'deleting a person deletes what was written to them');
});

test('an insight and an idea are the owner\'s own words, and a bad form changes nothing', async () => {
  const u = await makeUser(db.pool, '+972611000954', { firstName: 'Eli' });
  await writeOne(u.id, 'the pill one');
  const msg = await row('the pill one');

  const ideaId = await withTx(db.pool, (c) => ownerMessages.saveIdea(c, { title: 'תרופה חד־פעמית → להציע קבועה' }));
  await withTx(db.pool, (c) => ownerMessages.setNote(c, msg.id, { insight: 'ענה תוך דקה', ideaId }));
  let got = await row('the pill one');
  assert.equal(got.insight, 'ענה תוך דקה');
  assert.equal(String(got.idea_id), String(ideaId));

  // an idea id that does not exist links to nothing rather than failing the save
  await withTx(db.pool, (c) => ownerMessages.setNote(c, msg.id, { insight: 'still saved', ideaId: 999999 }));
  got = await row('the pill one');
  assert.equal(got.insight, 'still saved');
  assert.equal(got.idea_id, null);
  await withTx(db.pool, (c) => ownerMessages.setNote(c, msg.id, { insight: 'ענה תוך דקה', ideaId }));

  // an empty title or an unknown status never blanks a row
  assert.equal(await withTx(db.pool, (c) => ownerMessages.saveIdea(c, { title: '   ' })), null);
  await withTx(db.pool, (c) => ownerMessages.saveIdea(c, { id: ideaId, title: '', status: 'built' }));
  await withTx(db.pool, (c) => ownerMessages.saveIdea(c, { id: ideaId, title: 'תרופה חד־פעמית → להציע קבועה', status: 'shipped!' }));
  const { rows: [idea] } = await db.pool.query(`SELECT * FROM feature_ideas WHERE id = $1`, [ideaId]);
  assert.equal(idea.title, 'תרופה חד־פעמית → להציע קבועה');
  assert.equal(idea.status, 'open', 'a status outside the list keeps the one it had');

  const html = await withTx(db.pool, (c) => renderOwnerLogAt(c, { scan: async () => null, now: NOW, csrf: 'tok' }));
  assert.match(html, /פיצ'רים אפשריים[\s\S]*תרופה חד־פעמית[\s\S]*1 הודעות מאחוריו/, 'the idea counts the messages behind it');
  assert.match(html, /<option value="\d+" selected>תרופה חד־פעמית/, 'the row shows the idea it was linked to');

  // dropping an idea keeps the message and its insight
  await db.pool.query(`DELETE FROM feature_ideas WHERE id = $1`, [ideaId]);
  got = await row('the pill one');
  assert.equal(got.insight, 'ענה תוך דקה');
  assert.equal(got.idea_id, null);
});
