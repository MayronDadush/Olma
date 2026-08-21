'use strict';
// Operator repair for the failure written up in CLAUDE.md, "A goal said out
// loud left no trace anywhere". The code changes stop it happening again; they
// do nothing for the person it already happened to, whose goal is still
// nowhere and who is still waiting for an answer nobody is going to send.
//
// This goes back for them, in two moves, and invents nothing:
//
//   1. Re-open the read-back. Clearing last_fact_extraction_at makes the next
//      fact-extraction tick re-read their recent conversation — now with the
//      commitments pass — so the goal is saved in THEIR words and split the way
//      THEY said it, never in words an operator typed into a flag here.
//   2. Ask Olma to come back to them. One outbox check-in row, which the
//      delivery gate holds until their own availability window opens: a repair
//      run at midnight reaches them when they wake up, not at midnight.
//
// Nothing else about them is touched, and re-running it the same day is a
// no-op (the idempotency key), so an operator can safely run it twice.
const { ok, err } = require('./results');
const audit = require('./audit');
const { enqueue } = require('../outbox/enqueue');

// Long enough that the fact-extraction tick (every 10 minutes) has a chance to
// land the goal on their list before the agent is asked to open with it. Not
// load-bearing: the instruction tells the agent to save it either way, because
// a repair that depends on two jobs racing in the right order is not a repair.
const EXTRACTION_GRACE_MS = 15 * 60_000;

// Operators have the number in whatever form it reaches them — "0505404255",
// "050-540-4255", "+972505404255". Rather than guess a country for a national
// number (the mistake domain/contacts.js documents at length), match on the
// trailing digits and refuse anything ambiguous: a repair aimed at the wrong
// person messages a stranger about a goal they never had.
async function findUserByPhoneFragment(client, raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length < 6) return err('invalid', 'give at least 6 digits of their number');
  const { rows } = await client.query(
    `SELECT id, phone, first_name, agent_id, timezone, checkin_misses,
            last_inbound_at, last_fact_extraction_at, status
       FROM users
      WHERE regexp_replace(phone, '\\D', '', 'g') LIKE '%' || $1
      ORDER BY id`,
    [digits]
  );
  if (!rows.length) return err('not_found', `no user whose number ends with ${digits}`);
  if (rows.length > 1) {
    return err('invalid', 'that fragment matches more than one person', {
      candidates: rows.map((u) => `${u.id} ${u.phone}`),
    });
  }
  return ok({ user: rows[0] });
}

// The message Olma will be asked to send. The goal text came from an operator,
// so it goes in as quoted data on the same terms as any other text this system
// did not write itself.
function buildInstruction(note) {
  return [
    `They told you a while ago about something they need to do — <<<${note}>>> — and`,
    'nothing was ever done with it: it was not saved, nobody offered to help with it,',
    'and you never came back to it. That is on us, not on them.',
    '',
    'Open with it. Say plainly that it stayed with you and you want to pick it up now —',
    'one short line, an acknowledgement rather than an apology, and do not explain any',
    'of the machinery behind why it was missed.',
    '',
    'If it is not already on their task list, save it THIS TURN before you send',
    'anything, and if it has obvious parts (a count, clear stages) save the goal and',
    'then its parts under it in one add_tasks_bulk call with parent_task_id.',
    '',
    'Then ONE question, and only one: whichever actually moves it forward — a date you',
    'could put on it, or the single thing that decides the first step. Not both, not a',
    'list, and no status check. Do not recite the rest of their tasks in this message.',
  ].join('\n');
}

// What the repair would do, without doing it.
async function previewGoalRepair(client, phoneFragment) {
  const found = await findUserByPhoneFragment(client, phoneFragment);
  if (!found.ok) return found;
  const u = found.data.user;
  const { rows: openTasks } = await client.query(
    `SELECT count(*)::int AS n FROM tasks
      WHERE owner_id = $1 AND status = 'open' AND archived_at IS NULL`, [u.id]);
  return ok({ user: u, openTasks: openTasks[0].n });
}

// deps.now lets tests pin the clock; production passes nothing.
async function repairMissedGoal(client, userId, { note, now = Date.now() } = {}) {
  if (!note || !String(note).trim()) {
    return err('invalid', 'say what the goal was — it is what the message opens with');
  }
  const { rows } = await client.query(
    `SELECT id, status FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) return err('not_found', 'no such user');
  if (rows[0].status !== 'active') return err('invalid', 'user is not active');

  // 1. The read-back reads their recent conversation again, commitments pass
  // included. NULL rather than a computed timestamp: it re-reads the whole
  // window the job looks at, and both halves of that job already refuse to
  // record anything the person's list or fact card already holds.
  await client.query(
    `UPDATE users SET last_fact_extraction_at = NULL WHERE id = $1`, [userId]);

  // 2. ...and someone actually comes back to them. checkin_misses is reset
  // because it counts messages they ignored, and a ladder that had backed off
  // to weekly (or given up at 4) would swallow this: the thing they ignored was
  // never the thing they cared about.
  const day = new Date(now).toISOString().slice(0, 10);
  const queued = await enqueue(client, {
    userId, kind: 'checkin',
    payload: {
      checkinInstruction: buildInstruction(String(note).trim()),
      rung: 'missed_goal_repair',
    },
    urgency: 'normal',
    idempotencyKey: `repair-goal:${userId}:${day}`,
    releaseAfter: new Date(now + EXTRACTION_GRACE_MS),
  });
  if (queued.data.enqueued) {
    // Same bookkeeping run() does, so today's ladder does not also fire a
    // second, unrelated check-in on top of this one.
    await client.query(
      `UPDATE users SET last_checkin_at = now(), checkin_misses = 0 WHERE id = $1`, [userId]);
  }

  await audit.record(client, userId, 'admin.goal_repair', {
    enqueued: queued.data.enqueued, outboxId: queued.data.outboxId,
  });
  return ok({
    enqueued: queued.data.enqueued,
    outboxId: queued.data.outboxId,
    releaseAfter: new Date(now + EXTRACTION_GRACE_MS).toISOString(),
  });
}

module.exports = {
  findUserByPhoneFragment, previewGoalRepair, repairMissedGoal, buildInstruction,
  EXTRACTION_GRACE_MS,
};
