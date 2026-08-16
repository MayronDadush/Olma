'use strict';
// The minute-cadence sweeps that feed the outbox: due reminders, scheduled
// digests, lapsed quota blocks. All idempotent (keys), all run inside
// brokerd's loop — no crontab sprawl, one heartbeat each.
const { enqueue, collectHeld } = require('../outbox/enqueue');
const reminders = require('../domain/reminders');
const quota = require('../domain/quota');
const { minutesInTz, parseHHMM } = require('../outbox/gate');

// ---- reminders --------------------------------------------------------------
// Enqueue each due reminder as urgent (the user picked the time). A reminder
// expires 2h past its moment: past that it is "עבר זמנה", never a live nag.
async function sweepReminders(client, nowIso) {
  const now = nowIso || new Date().toISOString();
  const due = await reminders.dueForSending(client, now);
  const out = [];
  for (const r of due.data.due) {
    const res = await enqueue(client, {
      userId: r.owner_id, kind: 'reminder', urgency: 'urgent',
      payload: { taskId: Number(r.task_id), title: r.title, remindAt: r.remind_at },
      expiresAt: new Date(new Date(r.remind_at).getTime() + 2 * 3600_000),
      idempotencyKey: `reminder:${r.reminder_id}`,
    });
    if (res.data.enqueued) {
      await reminders.markSent(client, r.reminder_id);
      // simple repeat support: daily / weekly spawn the next occurrence
      if (r.repeat_rule === 'daily' || r.repeat_rule === 'weekly') {
        const next = new Date(new Date(r.remind_at).getTime() + (r.repeat_rule === 'daily' ? 1 : 7) * 24 * 3600_000);
        await client.query(
          `INSERT INTO task_reminders (task_id, remind_at, repeat_rule) VALUES ($1, $2, $3)`,
          [r.task_id, next, r.repeat_rule]
        );
      }
      out.push(r.reminder_id);
    }
  }
  return out;
}

// ---- digests ----------------------------------------------------------------
// Fires when a user's local HH:MM matches one of their digest_times (±2min
// tolerance so a slow tick can't skip a slot). Budget-held rows fold in here.
async function sweepDigests(client, now = new Date()) {
  const { rows } = await client.query(
    `SELECT id, digest_times, digest_scope, timezone FROM users
     WHERE status = 'active' AND onboarded_at IS NOT NULL AND digest_times IS NOT NULL`
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
    const folded = await collectHeld(client, u.id, ['budget']);
    const res = await enqueue(client, {
      userId: u.id, kind: 'digest',
      payload: { scope: u.digest_scope || 'summary', folded: folded.map((f) => ({ kind: f.kind, payload: f.payload })) },
      idempotencyKey: `digest:${u.id}:${day}:${slot}`,
    });
    if (res.data.enqueued) out.push({ userId: u.id, slot, folded: folded.length });
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

module.exports = { sweepReminders, sweepDigests, sweepUnblocks };
