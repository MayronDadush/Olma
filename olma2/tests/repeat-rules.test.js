'use strict';
// The bug these cover: a repeating reminder that fires exactly once. It was
// silent — no error, no failed job, just a person who stopped being reminded.
const test = require('node:test');
const assert = require('node:assert');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const reminders = require('../src/domain/reminders');
const sweeps = require('../src/jobs/sweeps');

const { normalizeRepeatRule: norm, nextOccurrence: next } = reminders;

test('normalizes the vocabularies the model actually writes', () => {
  assert.equal(norm('daily'), 'daily');
  assert.equal(norm('FREQ=DAILY'), 'daily');            // the live failure
  assert.equal(norm('freq=daily'), 'daily');
  assert.equal(norm('Every day'), 'daily');
  assert.equal(norm('weekly'), 'weekly');
  assert.equal(norm('FREQ=WEEKLY'), 'weekly');
  assert.equal(norm('FREQ=WEEKLY;BYDAY=MO,TH'), 'weekly:MO,TH');
  assert.equal(norm('weekly:MO,TH'), 'weekly:MO,TH');
});

test('an unrecognised rule becomes a one-off, never a guessed cadence', () => {
  assert.equal(norm('FREQ=MONTHLY'), null);
  assert.equal(norm('every other tuesday'), null);
  assert.equal(norm(''), null);
  assert.equal(norm(null), null);
});

test('nextOccurrence advances by the right interval', () => {
  const base = new Date('2026-08-17T16:00:00Z');   // a Monday
  assert.equal(next(base, 'FREQ=DAILY').toISOString(), '2026-08-18T16:00:00.000Z');
  assert.equal(next(base, 'weekly').toISOString(), '2026-08-24T16:00:00.000Z');
  // MO,TH from a Monday → the coming Thursday, not a week later
  assert.equal(next(base, 'FREQ=WEEKLY;BYDAY=MO,TH').toISOString(), '2026-08-20T16:00:00.000Z');
  // ...and from that Thursday → back round to Monday
  assert.equal(next(new Date('2026-08-20T16:00:00Z'), 'weekly:MO,TH').toISOString(),
               '2026-08-24T16:00:00.000Z');
  assert.equal(next(base, null), null);
});

test('a daily reminder written as FREQ=DAILY keeps firing', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const user = await makeUser(pool, '+972500000001');

  await withTx(pool, async (c) => {
    const task = await require('../src/domain/tasks')
      .addTask(c, user.id, { title: 'כדורים' });
    // exactly what the agent stored in production
    await reminders.setReminder(c, user.id, task.data.task.id, '2026-08-17T16:00:00Z', 'FREQ=DAILY');
  });

  // stored canonically, so the sweep can recognise it
  const before = await pool.query(`SELECT repeat_rule FROM task_reminders`);
  assert.equal(before.rows[0].repeat_rule, 'daily');

  const sent = await withTx(pool, (c) => sweeps.sweepReminders(c, '2026-08-17T16:01:00Z'));
  assert.equal(sent.length, 1);

  // the whole point: a successor exists
  const after = await pool.query(
    `SELECT remind_at, repeat_rule FROM task_reminders WHERE sent_at IS NULL AND cancelled_at IS NULL`);
  assert.equal(after.rows.length, 1, 'a daily reminder must schedule its next occurrence');
  assert.equal(after.rows[0].repeat_rule, 'daily');
  assert.equal(new Date(after.rows[0].remind_at).toISOString(), '2026-08-18T16:00:00.000Z');
});

// This used to assert nothing was left pending at all, which stopped being the
// invariant when reminders gained an escalation ladder: the ONE row stays
// pending so it can be followed up (see reminder-escalation.test.js). What it
// was really protecting — a one-off must not manufacture a second reminder —
// is unchanged and is what it checks now.
test('a one-off reminder does not spawn a successor', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const user = await makeUser(pool, '+972500000002');
  await withTx(pool, async (c) => {
    const task = await require('../src/domain/tasks').addTask(c, user.id, { title: 'מלון' });
    await reminders.setReminder(c, user.id, task.data.task.id, '2026-08-17T16:00:00Z', null);
  });
  await withTx(pool, (c) => sweeps.sweepReminders(c, '2026-08-17T16:01:00Z'));
  const all = await pool.query(`SELECT remind_at, attempts FROM task_reminders`);
  assert.equal(all.rows.length, 1, 'no successor row for a one-off');
  assert.equal(new Date(all.rows[0].remind_at).toISOString(), '2026-08-17T16:00:00.000Z',
    'and the original moment is not rewritten by the send');
  assert.equal(all.rows[0].attempts, 1);
});
