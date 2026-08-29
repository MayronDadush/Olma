'use strict';
// The minute-cadence sweeps that feed the outbox: due reminders, scheduled
// digests, lapsed quota blocks. All idempotent (keys), all run inside
// brokerd's loop — no crontab sprawl, one heartbeat each.
const { enqueue, collectHeld } = require('../outbox/enqueue');
const reminders = require('../domain/reminders');
const meetings = require('../domain/meetings');
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
    const res = await enqueue(client, {
      userId: r.owner_id,
      kind: 'reminder',
      // Only the moment THEY chose is urgent enough to skip the daily budget.
      // A follow-up is Olma's own idea and queues like everything else Olma
      // decided to say — otherwise three rungs per reminder would be a way to
      // spend an unlimited proactive budget by setting enough reminders.
      urgency: attempt === 1 ? 'urgent' : 'normal',
      payload: {
        taskId: Number(r.task_id), title: r.title, remindAt: r.remind_at,
        ...(attempt > 1 ? { attempt, finalAttempt } : {}),
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
      const next = reminders.nextOccurrence(r.remind_at, r.repeat_rule);
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
      payload: { scope: u.digest_scope || 'summary', folded: [] },
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

module.exports = { sweepReminders, sweepDigests, sweepUnblocks, sweepStaleMeetings, sweepMediaJobs };
