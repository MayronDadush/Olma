'use strict';
// The minute-cadence sweeps that feed the outbox: due reminders, scheduled
// digests, lapsed quota blocks. All idempotent (keys), all run inside
// brokerd's loop — no crontab sprawl, one heartbeat each.
const { enqueue, collectHeld } = require('../outbox/enqueue');
const reminders = require('../domain/reminders');
const meetings = require('../domain/meetings');
const tasks = require('../domain/tasks');
const quota = require('../domain/quota');
const flags = require('../domain/flags');
const { minutesInTz, parseHHMM } = require('../outbox/gate');

// ---- reminders --------------------------------------------------------------
// A reminder gets up to three rungs (domain/reminders.dueForSending owns which
// are due). A rung expires 2h past ITS OWN moment: past that it is "עבר זמנה",
// never a live nag.
async function sweepReminders(client, nowIso) {
  const now = nowIso || new Date().toISOString();
  const maxAttempts = Number(await flags.getFlag(client, 'reminder_escalation_max'))
    || reminders.ESCALATION_MAX_ATTEMPTS;
  const gapHours = Number(await flags.getFlag(client, 'reminder_escalation_gap_hours'))
    || reminders.ESCALATION_GAP_HOURS;
  const due = await reminders.dueForSending(client, now, { maxAttempts, gapHours });
  const out = [];
  for (const r of due.data.due) {
    const attempt = Number(r.attempts) + 1;
    // A repeating reminder never climbs — its own rule already brings it back,
    // so it retires on the first send exactly as before.
    const repeats = Boolean(reminders.normalizeRepeatRule(r.repeat_rule));
    const finalAttempt = repeats || attempt >= maxAttempts;
    // The previous rung never left our side (dueForSending: expired after failed
    // delivery attempts). This rung REPLACES it rather than following it up:
    // the plain reminder text, since nothing was delivered to follow up on,
    // and the urgency of the rung it stands in for.
    const redo = Boolean(r.prev_failed);
    const res = await enqueue(client, {
      userId: r.owner_id,
      kind: 'reminder',
      // Only the moment THEY chose is urgent enough to skip the daily budget.
      // A follow-up is Olma's own idea and queues like everything else Olma
      // decided to say — otherwise three rungs per reminder would be a way to
      // spend an unlimited proactive budget by setting enough reminders.
      urgency: attempt === 1 || (redo && attempt === 2) ? 'urgent' : 'normal',
      payload: {
        taskId: Number(r.task_id), title: r.title, remindAt: r.remind_at,
        ...(redo ? { redo: true } : attempt > 1 ? { attempt, finalAttempt } : {}),
      },
      // Rung 1 keeps the original 2h-past-the-moment window. A later rung is
      // measured from now: remind_at is hours or a day behind and would make
      // the row expire before it was ever looked at.
      expiresAt: new Date(
        (attempt === 1 ? new Date(r.remind_at).getTime() : new Date(now).getTime())
        + 2 * 3600_000
      ),
      idempotencyKey: reminders.attemptKey(r.reminder_id, attempt),
    });
    if (res.data.enqueued) {
      await reminders.recordAttempt(client, r.reminder_id, { retire: finalAttempt });
      // Spawn the next occurrence. The rule vocabulary lives in one place —
      // this used to compare against the literals 'daily'/'weekly' while the
      // model was storing 'FREQ=DAILY', so every repeating reminder silently
      // fired exactly once. See reminders.normalizeRepeatRule.
      // In THEIR zone: "the 16th" and "08:00" are both local promises, and a
      // flat interval breaks each of them (see reminders.nextOccurrence).
      const next = reminders.nextOccurrence(r.remind_at, r.repeat_rule, r.timezone);
      if (next) {
        await client.query(
          `INSERT INTO task_reminders (task_id, remind_at, repeat_rule) VALUES ($1, $2, $3)`,
          [r.task_id, next, reminders.normalizeRepeatRule(r.repeat_rule)]
        );
      }
      out.push(r.reminder_id);
    }
  }

  // Retire a ladder that can no longer climb. A rung is only scheduled once
  // the previous one was DELIVERED, so a reminder whose rung the gate held,
  // dropped or expired correctly stops climbing — and would then sit pending
  // for ever, showing up in list_my_reminders as though it had never fired.
  // The last rung is next-day-at-the-original-hour, so nothing can still be
  // due two days on. Before escalation this could not happen: the row retired
  // on enqueue, whether or not anything reached anyone.
  await client.query(
    `UPDATE task_reminders SET sent_at = now()
      WHERE sent_at IS NULL AND cancelled_at IS NULL AND attempts > 0
        AND remind_at < $1::timestamptz - interval '2 days'`,
    [now]
  );
  return out;
}

// ---- digests ----------------------------------------------------------------
// Fires when a user's local HH:MM matches one of their digest_times (±2min
// tolerance so a slow tick can't skip a slot). Budget-held rows fold in here.
async function sweepDigests(client, now = new Date()) {
  const { rows } = await client.query(
    `SELECT id, digest_times, digest_scope, timezone FROM users
     WHERE status = 'active' AND onboarded_at IS NOT NULL AND digest_times IS NOT NULL
       AND paused_at IS NULL AND NOT is_eval`
  );
  // Read once for the whole sweep, not per user: it is one operator setting,
  // and a flag that changed mid-loop would give two users different mornings
  // for no reason anyone could later explain.
  const cardMinItems = Number(await flags.getFlag(client, 'digest_card_min_items'));
  const out = [];
  for (const u of rows) {
    const localMin = minutesInTz(u.timezone, now);
    const times = String(u.digest_times).split(',').map((s) => s.trim()).filter(Boolean);
    const slot = times.find((t) => {
      const d = localMin - parseHHMM(t);
      return d >= 0 && d <= 2;
    });
    if (!slot) continue;
    const day = now.toISOString().slice(0, 10);
    // Enqueue FIRST, fold second. collectHeld marks the rows it returns as
    // sent, so collecting before the insert threw them away whenever the
    // insert lost to its own idempotency key (the ±2min tolerance means this
    // sweep visits the same slot on two or three consecutive ticks): the held
    // messages were stamped delivered and rode along with nothing.
    const res = await enqueue(client, {
      userId: u.id, kind: 'digest',
      payload: { scope: u.digest_scope || 'summary', cardMinItems, folded: [] },
      idempotencyKey: `digest:${u.id}:${day}:${slot}`,
    });
    if (!res.data.enqueued) continue;
    const folded = await collectHeld(client, u.id, ['budget']);
    if (folded.length) {
      await client.query(
        `UPDATE outbox SET payload = jsonb_set(payload, '{folded}', $2::jsonb) WHERE id = $1`,
        [res.data.outboxId, JSON.stringify(folded.map((f) => ({ kind: f.kind, payload: f.payload })))]
      );
    }
    out.push({ userId: u.id, slot, folded: folded.length });
  }
  return out;
}

// ---- unblock ----------------------------------------------------------------
// A lapsed block turns into ONE consolidated catch-up (respectfully timed by
// the gate), carrying everything held during the block — stale items marked.
async function sweepUnblocks(client, nowIso) {
  const now = nowIso || new Date().toISOString();
  const lapsed = await quota.lapsedBlocks(client, now);
  const out = [];
  for (const u of lapsed.data.users) {
    const held = await collectHeld(client, u.id, ['blocked']);
    const stale = held.filter((h) => h.expires_at && new Date(h.expires_at) <= new Date(now));
    const fresh = held.filter((h) => !h.expires_at || new Date(h.expires_at) > new Date(now));
    await quota.clearBlock(client, u.id);
    await enqueue(client, {
      userId: u.id, kind: 'unblock_summary',
      payload: {
        accumulated: fresh.map((h) => ({ kind: h.kind, payload: h.payload })),
        expired: stale.map((h) => ({ kind: h.kind, payload: h.payload })),
      },
      idempotencyKey: `unblock:${u.id}:${new Date(now).toISOString().slice(0, 13)}`,
    });
    out.push(u.id);
  }
  return out;
}

// ---- stale meetings ---------------------------------------------------------
// Nothing ever closed a negotiation whose moment had passed, so an unanswered
// proposal stayed open forever and the check-in ladder kept asking about it —
// a Saturday nudge about Friday's poker game. Closing it is half the fix; the
// other half is telling the person, once, so a plan that quietly died does not
// just vanish. Only the initiator hears: they are the one who can restart it.
async function sweepStaleMeetings(client, nowMs) {
  const closed = await meetings.expireStaleMeetings(client, nowMs || Date.now());
  const out = [];
  for (const m of closed) {
    const res = await enqueue(client, {
      userId: Number(m.initiator_id), kind: 'meeting_expired',
      payload: { meetingId: Number(m.id), title: m.title || 'meeting', slot: m.proposed_slot },
      urgency: 'normal',
      idempotencyKey: `mexpired:${m.id}`,
    });
    out.push({ meetingId: Number(m.id), notified: res.data.enqueued });
  }
  return out;
}

// ---- media jobs -------------------------------------------------------------
// Poll videos OpenRouter is still rendering, download the finished ones into
// the requester's workspace, and enqueue the delivery. Lives in domain/media
// (it is mostly domain logic); ticked here so it needs no sweeper of its own.
async function sweepMediaJobs(client) {
  return require('../domain/media').sweepMediaJobs(client, {});
}

// ---- the 60-second name check ------------------------------------------------
// Miron's own ask, walking his onboarding on 2026-09-04: if someone goes
// silent right after the opening message, don't wait for the day-one ladder's
// first rung (15 minutes) — ask about their name within a minute, because
// that is the one thing that is both cheap to ask and useful the instant it
// lands (a name confirmed is a name USER.md can trust; the WhatsApp display
// name is only ever an unconfirmed guess until then).
//
// Anchored on `first_turn_at`, not `onboarded_at`: that column is stamped by
// turn_start in the exact statement that hands the model the opening copy
// (registry.js), so it is the true "when did we say hello" moment — a person
// can be provisioned by intake well before they write their first word.
// `last_inbound_at = first_turn_at` is the silence test: both are written by
// the SAME transaction inside turn_start (Postgres's `now()` is constant for
// a whole transaction), so they can only still be equal if no later message
// has moved `last_inbound_at` on its own. The moment they reply — with a name
// or with anything else — this stops matching and the nudge never queues.
//
// Capped at 10 minutes past first_turn_at for the reason every other rung in
// this file caps itself: a sweep that was down for a while must not surface a
// pile of "haven't heard from you in a minute" nudges hours late.
async function sweepNameConfirm(client, nowIso) {
  const now = nowIso || new Date().toISOString();
  const { rows } = await client.query(
    `SELECT id, first_name, name_confirmed FROM users
      WHERE first_turn_at IS NOT NULL
        AND last_inbound_at = first_turn_at
        AND $1::timestamptz - first_turn_at >= interval '60 seconds'
        AND $1::timestamptz - first_turn_at < interval '10 minutes'
        AND (first_name IS NULL OR name_confirmed = false)
        AND paused_at IS NULL`,
    [now]);
  const out = [];
  for (const u of rows) {
    // An unconfirmed guess (WhatsApp display name, or one seen in passing)
    // gets checked by name; nothing yet just gets asked. Either way this is
    // the ONE thing to ask — no feature tour riding along with it.
    const instruction = u.first_name
      ? `They have not replied since your opening message, about a minute ago. `
        + `You have an unconfirmed guess at their name — "${u.first_name}", most `
        + `likely from their WhatsApp profile. Ask, in one short warm line: is `
        + `that their name? And if not, what should you call them? One emoji, `
        + `nothing else this turn — no feature tour, no second question.`
      : `They have not replied since your opening message, about a minute ago. `
        + `You do not have a name for them yet. Ask, in one short warm line, `
        + `what you should call them. One emoji, nothing else this turn.`;
    const res = await enqueue(client, {
      userId: u.id, kind: 'checkin',
      payload: { checkinInstruction: instruction, rung: 'name_confirm_1m' },
      urgency: 'normal',
      expiresAt: new Date(new Date(now).getTime() + 9 * 60_000),
      idempotencyKey: `name_confirm_1m:${u.id}`,
    });
    if (res.data.enqueued) out.push(u.id);
  }
  return out;
}

// ---- tasks that are over ------------------------------------------------------
// Two ways a task stops being a task, neither of which anybody was telling it
// about.
//
// 1. AN APPOINTMENT WHOSE MOMENT PASSED. `תור רופא` at 09:00 is over by noon —
//    it happened or it didn't, and either way it is not something to do. It sat
//    in the overdue list for ever, next to `לקבוע תור לרופא`, which genuinely
//    IS still worth doing late. `tasks.kind` (domain/task-kind.js) is what
//    finally separates them, and only 'event' is ever swept: a NULL kind is a
//    row nothing has judged, and it is left alone.
//
// 2. A LIST WITH EVERY BOX TICKED. `סופר` sat open in production with six of
//    six subtasks done. `completeTask` closes a drained project from now on,
//    but rows finished before that, or by any path that did not go through it,
//    need somebody to come round.
//
// Both end the same way: completed, archived, and SAID OUT LOUD. Something
// that leaves a person's list on its own without telling them is indis-
// tinguishable from something we lost, and the person is the only one who
// knows whether we got it right — so the message names what went and the agent
// can put any of it back.
async function sweepFinishedTasks(client, nowIso) {
  const now = nowIso ? new Date(nowIso) : new Date();
  const graceHours = Number(await flags.getFlag(client, 'task_auto_archive_grace_hours'));
  const grace = Number.isFinite(graceHours) && graceHours >= 0 ? graceHours : 3;
  const cutoff = new Date(now.getTime() - grace * 3600_000).toISOString();

  // A repeating reminder makes a task standing — doing it once does not finish
  // it, and completeTask refuses to close it for exactly that reason. Sweeping
  // it would be the same mistake made from the other side.
  const { rows: expired } = await client.query(
    `SELECT t.id, t.owner_id, t.title
       FROM tasks t JOIN users u ON u.id = t.owner_id
      WHERE t.kind = 'event' AND t.status = 'open' AND t.archived_at IS NULL
        AND t.due_at IS NOT NULL AND COALESCE(t.ends_at, t.due_at) < $1
        AND u.status = 'active' AND u.is_eval = false
        AND NOT EXISTS (SELECT 1 FROM task_reminders r
                         WHERE r.task_id = t.id AND r.repeat_rule IS NOT NULL
                           AND r.sent_at IS NULL AND r.cancelled_at IS NULL)
      ORDER BY t.owner_id, t.id
      LIMIT 200`,
    [cutoff]
  );

  const { rows: drained } = await client.query(
    `SELECT p.id, p.owner_id, p.title
       FROM tasks p JOIN users u ON u.id = p.owner_id
      WHERE p.status = 'open' AND p.archived_at IS NULL AND p.parent_id IS NULL
        AND u.status = 'active' AND u.is_eval = false
        AND EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = p.id AND c.archived_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM tasks c
                         WHERE c.parent_id = p.id AND c.archived_at IS NULL AND c.status <> 'done')
      ORDER BY p.owner_id, p.id
      LIMIT 200`
  );

  // Grouped per person, because one message listing three things is one
  // interruption and three messages are three.
  const byUser = new Map();
  const add = (row, why) => {
    if (!byUser.has(row.owner_id)) byUser.set(row.owner_id, []);
    byUser.get(row.owner_id).push({ id: Number(row.id), title: row.title, why });
  };
  for (const t of expired) add(t, 'passed');
  for (const t of drained) add(t, 'finished');

  const out = [];
  for (const [userId, items] of byUser) {
    const done = [];
    for (const item of items) {
      const res = await tasks.completeTask(client, userId, item.id);
      // Not an error worth stopping for: a task completed or archived by the
      // person between the SELECT above and this line is exactly the outcome
      // we wanted, arrived at without us.
      if (!res.ok || res.data.recurring) continue;
      const arch = await tasks.archiveTask(client, userId, item.id);
      if (!arch.ok) continue;
      done.push(item);
    }
    if (!done.length) continue;
    const res = await enqueue(client, {
      userId,
      kind: 'tasks_auto_archived',
      // Olma's own housekeeping, not a moment they chose — it queues like
      // everything else Olma decided to say rather than skipping the budget.
      urgency: 'normal',
      payload: { tasks: done },
      idempotencyKey: `autoarc:${userId}:${done[0].id}`,
    });
    if (res.data.enqueued) out.push({ userId, count: done.length });
  }
  return { users: out.length, tasks: out.reduce((n, r) => n + r.count, 0) };
}

module.exports = {
  sweepReminders, sweepDigests, sweepUnblocks, sweepStaleMeetings, sweepMediaJobs,
  sweepNameConfirm, sweepFinishedTasks,
};
