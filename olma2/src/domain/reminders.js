'use strict';
// Reminders are always children of a task (the v2 unification). Several per
// task allowed. "Give me everything due in the next hour" is one indexed
// query — the original goal of the merge, kept.
const { ok, err } = require('./results');
const audit = require('./audit');
const dt = require('./datetime');
const { hasOffset, badTime } = dt;

// ---- repeat rules -----------------------------------------------------------
//
// The tool takes freeform text and the model writes whatever reads like a
// repeat rule, so this accepts both vocabularies and stores ONE of them.
// Getting this wrong is silent and expensive: sweeps.js used to compare against
// the literals 'daily'/'weekly' only, while the model was writing RRULE-style
// 'FREQ=DAILY'. No error anywhere — the reminder fired once, no next occurrence
// was ever created, and a person who asked for a daily medication reminder got
// exactly one. Found live 2026-08-18 on four of five reminders in the database.
//
// Canonical forms stored:
//   'daily' | 'weekly' | 'weekly:MO,TH' | 'monthly:16' | 'monthly:last' | null
//
// The bare form 'monthly' is accepted on the way IN and resolved to a concrete
// day by setReminder, which is the only place that knows both the moment and
// the person's timezone. Nothing should be stored as bare 'monthly'.
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function normalizeRepeatRule(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const up = s.toUpperCase();

  // plain words, in either language the model tends to reach for
  if (/^(DAILY|EVERY ?DAY|YOM|יומי)$/.test(up)) return 'daily';
  if (/^(WEEKLY|EVERY ?WEEK|שבועי)$/.test(up)) return 'weekly';
  // "end of every month" is its own rule, not a day number: someone who says
  // it on the 15th means the 30th, and no day number can express "whatever the
  // last one happens to be".
  if (/^(MONTHLY:LAST|LAST ?DAY( OF (THE )?MONTH)?|END ?OF ?MONTH|סוף ?חודש|סוף ?כל ?חודש)$/.test(up)) return 'monthly:last';
  if (/^(MONTHLY|EVERY ?MONTH|חודשי|כל ?חודש)$/.test(up)) return 'monthly';

  // RRULE-ish: FREQ=DAILY / FREQ=WEEKLY[;BYDAY=MO,TH] / FREQ=MONTHLY[;BYMONTHDAY=16]
  const freq = /FREQ=([A-Z]+)/.exec(up);
  if (freq) {
    if (freq[1] === 'DAILY') return 'daily';
    if (freq[1] === 'WEEKLY') {
      const byday = /BYDAY=([A-Z,]+)/.exec(up);
      if (!byday) return 'weekly';
      const days = byday[1].split(',').map((d) => d.trim()).filter((d) => DAYS.includes(d));
      return days.length ? `weekly:${days.join(',')}` : 'weekly';
    }
    if (freq[1] === 'MONTHLY') {
      const byday = /BYMONTHDAY=(-?\d+)/.exec(up);
      if (!byday) return 'monthly';
      const n = Number(byday[1]);
      if (n === -1) return 'monthly:last';   // RRULE's own way of saying it
      return n >= 1 && n <= 31 ? `monthly:${n}` : null;
    }
    return null; // YEARLY is not supported; better null than a lie
  }

  if (/^WEEKLY:/.test(up)) {
    const days = up.slice(7).split(',').map((d) => d.trim()).filter((d) => DAYS.includes(d));
    return days.length ? `weekly:${days.join(',')}` : 'weekly';
  }
  const monthDay = /^MONTHLY:(\d{1,2})$/.exec(up);
  if (monthDay) {
    const n = Number(monthDay[1]);
    return n >= 1 && n <= 31 ? `monthly:${n}` : null;
  }
  return null; // unrecognised → a one-off, never a wrong cadence
}


// Bare 'monthly' carries no day. Pin it to the day the reminder itself falls
// on, read in the person's own zone — and to 'monthly:last' when that IS the
// last day, so someone who sets it on the 31st keeps landing on month ends
// rather than on the 31st of the months that happen to have one.
function resolveMonthlyAnchor(rule, remindAt, tz) {
  if (rule !== 'monthly') return rule;
  const at = new Date(remindAt);
  if (Number.isNaN(at.getTime())) return 'monthly';
  const p = dt.partsInZone(tz || 'UTC', at);
  return p.d === dt.daysInMonth(p.y, p.m) ? 'monthly:last' : `monthly:${p.d}`;
}

// The next time this rule should fire after `from`. Returns null for a
// non-repeating rule, which is what stops the sweep spawning a successor.
//
// Everything is computed as WALL-CLOCK time in the person's zone and converted
// back once. Flat millisecond arithmetic gets two things wrong: adding 24h
// across a DST boundary moves an 08:00 reminder to 07:00, and "the 16th" read
// off a UTC clock is the 15th for anyone whose reminder sits before ~02:00
// local. `tz` defaults to UTC, where both reduce to the old behaviour exactly.
function nextOccurrence(from, rule, tz = 'UTC') {
  const norm = normalizeRepeatRule(rule);
  if (!norm) return null;
  const base = new Date(from);
  if (Number.isNaN(base.getTime())) return null;
  const zone = tz || 'UTC';
  const p = dt.partsInZone(zone, base);
  const at = (y, m, d) => dt.instantInZone(zone, { y, m, d, hh: p.hh, mi: p.mi, ss: p.ss });

  if (norm === 'daily') return at(p.y, p.m, p.d + 1);
  if (norm === 'weekly') return at(p.y, p.m, p.d + 7);

  if (norm.startsWith('monthly')) {
    // The day comes from the RULE, never from the previous occurrence, so a
    // clamp cannot compound: 'monthly:31' is Jan 31 → Feb 28 → Mar 31, not
    // Mar 28. Clamping rather than skipping is deliberate — a medication
    // reminder must not vanish for a month because February is short.
    const spec = norm.slice('monthly'.length + 1);   // '' | 'last' | '16'
    const day = spec === 'last' ? 'last' : (Number(spec) || p.d);
    for (let step = 0; step <= 2; step++) {
      const y = p.y + Math.floor((p.m - 1 + step) / 12);
      const m = ((p.m - 1 + step) % 12) + 1;
      const dim = dt.daysInMonth(y, m);
      const cand = at(y, m, day === 'last' ? dim : Math.min(day, dim));
      if (cand.getTime() > base.getTime()) return cand;
    }
    return null;
  }

  // weekly:MO,TH — the soonest listed weekday strictly after `from`, judged on
  // the LOCAL calendar date rather than the UTC one.
  const wanted = norm.slice(7).split(',').map((d) => DAYS.indexOf(d)).filter((i) => i >= 0);
  if (!wanted.length) return at(p.y, p.m, p.d + 7);
  for (let step = 1; step <= 7; step++) {
    const cand = { y: p.y, m: p.m, d: p.d + step };
    if (wanted.includes(dt.weekdayOfParts(cand))) return at(cand.y, cand.m, cand.d);
  }
  return at(p.y, p.m, p.d + 7);
}

async function setReminder(client, ownerId, taskId, remindAt, repeatRule) {
  if (!remindAt) return err('invalid', 'remind_at required');
  if (!hasOffset(remindAt)) return badTime('remind_at', remindAt);
  const { rows } = await client.query(
    `SELECT t.id, t.status, u.timezone FROM tasks t JOIN users u ON u.id = t.owner_id
      WHERE t.id = $1 AND t.owner_id = $2 AND t.archived_at IS NULL`,
    [taskId, ownerId]
  );
  if (!rows[0]) return err('not_found', 'task not found');
  if (rows[0].status !== 'open') return err('invalid', 'cannot set a reminder on a completed task');
  // "every month" has to be pinned to a day, and this is the only place that
  // knows both the moment and the zone to read it in. Stored as the concrete
  // day so the rule can never re-derive itself from a clamped occurrence and
  // walk backwards month by month.
  const rule = resolveMonthlyAnchor(normalizeRepeatRule(repeatRule), remindAt, rows[0].timezone);
  const ins = await client.query(
    `INSERT INTO task_reminders (task_id, remind_at, repeat_rule)
     VALUES ($1, $2, $3) RETURNING *`,
    [taskId, remindAt, rule]
  );
  await audit.record(client, ownerId, 'reminder.created', { taskId, reminderId: ins.rows[0].id });
  return ok({ reminder: ins.rows[0] });
}

async function cancelReminder(client, ownerId, reminderId) {
  const { rows } = await client.query(
    `UPDATE task_reminders r SET cancelled_at = now()
     FROM tasks t
     WHERE r.id = $1 AND r.task_id = t.id AND t.owner_id = $2
       AND r.sent_at IS NULL AND r.cancelled_at IS NULL
     RETURNING r.id`,
    [reminderId, ownerId]
  );
  if (!rows[0]) return err('not_found', 'pending reminder not found');
  await audit.record(client, ownerId, 'reminder.cancelled', { reminderId });
  return ok({ reminderId });
}

async function listReminders(client, ownerId, taskId) {
  const { rows } = await client.query(
    `SELECT r.* FROM task_reminders r JOIN tasks t ON t.id = r.task_id
     WHERE t.owner_id = $1 AND ($2::bigint IS NULL OR r.task_id = $2)
       AND r.cancelled_at IS NULL
     ORDER BY r.remind_at`,
    [ownerId, taskId || null]
  );
  return ok({ reminders: rows });
}

// The sweep query the whole design leans on: everything due for sending now,
// across all users, one indexed scan. Caller (outbox enqueue job) marks
// sent_at only after the outbox row is durably written.
// ---- the escalation ladder --------------------------------------------------
//
// A reminder used to fire exactly once. Three rungs now: the moment they
// chose, a few hours later, and the next day at the same hour. Four rules hold
// it to that and no further.
//
// 1. A rung is only scheduled once the PREVIOUS one actually reached them —
//    delivered, not merely enqueued. This is the check-in bug's lesson: that
//    ladder counted messages that died inside quiet hours as ignores and backed
//    off to weekly on people who had never been sent anything. A reminder held
//    all night and expired must not burn a rung the person never saw.
// 2. Repeating reminders never escalate. A repeat rule IS the person's own
//    chosen cadence; chasing it as well would be two drums on one task, and the
//    successor row already brings it back tomorrow.
// 3. The ladder dies the moment the task is completed or the reminder is
//    cancelled — both already write to the columns this query filters on, so
//    "done" and "stop reminding me" need no new plumbing at all.
// 4. Only the FIRST rung is urgent. That moment is the user's; a follow-up is
//    Olma's own idea and queues behind the daily proactive budget like every
//    other thing Olma decided to say (that split lives in the sweep).
const ESCALATION_MAX_ATTEMPTS = 3;
const ESCALATION_GAP_HOURS = 3;

async function dueForSending(client, now, opts = {}) {
  const maxAttempts = Number.isFinite(Number(opts.maxAttempts)) && Number(opts.maxAttempts) > 0
    ? Math.floor(Number(opts.maxAttempts)) : ESCALATION_MAX_ATTEMPTS;
  const gapHours = Number.isFinite(Number(opts.gapHours)) && Number(opts.gapHours) > 0
    ? Number(opts.gapHours) : ESCALATION_GAP_HOURS;
  const { rows } = await client.query(
    `SELECT r.id AS reminder_id, r.task_id, r.remind_at, r.repeat_rule, r.attempts,
            t.owner_id, t.title, t.due_at, u.timezone
     FROM task_reminders r
     JOIN tasks t ON t.id = r.task_id
     JOIN users u ON u.id = t.owner_id
     WHERE r.sent_at IS NULL AND r.cancelled_at IS NULL
       AND t.status = 'open' AND t.archived_at IS NULL
       -- A paused user's reminders are already cancelled by pauseUser; this is
       -- the belt to that braces, and it also stops the sweep writing SUCCESSOR
       -- rows (which happens per send, so an unguarded paused user would grow a
       -- fresh reminder every day they were away).
       AND u.paused_at IS NULL AND NOT u.is_eval
       AND (
         -- Rung 1: the moment they picked. Unchanged.
         (r.attempts = 0 AND r.remind_at <= $1::timestamptz)
         OR
         (r.attempts BETWEEN 1 AND $2::int - 1
          AND r.repeat_rule IS NULL
          -- The previous rung has to have LANDED. hold_reason IS NULL is what
          -- separates delivered from dropped/expired/cancelled — a row the gate
          -- stamped on the way to the bin carries a reason and does not count.
          AND EXISTS (
            SELECT 1 FROM outbox o
             WHERE o.user_id = t.owner_id
               AND o.idempotency_key = CASE WHEN r.attempts = 1
                     THEN 'reminder:' || r.id
                     ELSE 'reminder:' || r.id || ':' || r.attempts END
               AND o.sent_at IS NOT NULL AND o.hold_reason IS NULL
               AND o.sent_at <= $1::timestamptz - ($3::double precision * interval '1 hour')
          )
          -- Rung 3 is "next day at the hour they chose", not "gap hours after
          -- rung 2" — computed through their own timezone so the wall-clock
          -- hour survives a DST boundary instead of drifting by one.
          AND (r.attempts <> 2
               OR (r.remind_at AT TIME ZONE COALESCE(u.timezone, 'UTC') + interval '1 day')
                    AT TIME ZONE COALESCE(u.timezone, 'UTC') <= $1::timestamptz)
         )
       )
     ORDER BY r.remind_at`,
    [now, maxAttempts, gapHours]
  );
  return ok({ due: rows });
}

// The idempotency key for a rung. Rung 1 deliberately keeps the ORIGINAL
// unsuffixed key: rows enqueued before this shipped carry it, and a rename
// would let the sweep re-enqueue them as brand new — a duplicate reminder is
// the one outcome worse than a missed one.
function attemptKey(reminderId, attempt) {
  return attempt === 1 ? `reminder:${reminderId}` : `reminder:${reminderId}:${attempt}`;
}

// Record that a rung went on the wire. `retire` stamps sent_at, which is what
// takes the reminder out of the pending set for good.
async function recordAttempt(client, reminderId, { retire } = {}) {
  await client.query(
    `UPDATE task_reminders
        SET attempts = attempts + 1,
            sent_at = CASE WHEN $2 THEN now() ELSE sent_at END
      WHERE id = $1`,
    [reminderId, Boolean(retire)]
  );
  return ok({ reminderId });
}

async function markSent(client, reminderId) {
  await client.query(`UPDATE task_reminders SET sent_at = now() WHERE id = $1`, [reminderId]);
  return ok({ reminderId });
}

module.exports = {
  setReminder, cancelReminder, listReminders, dueForSending, markSent,
  normalizeRepeatRule, nextOccurrence, resolveMonthlyAnchor,
  recordAttempt, attemptKey, ESCALATION_MAX_ATTEMPTS, ESCALATION_GAP_HOURS,
};
