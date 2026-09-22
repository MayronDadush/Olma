'use strict';
// Reminders are always children of a task (the v2 unification). Several per
// task allowed. "Give me everything due in the next hour" is one indexed
// query — the original goal of the merge, kept.
const { ok, err } = require('./results');
const audit = require('./audit');
const dt = require('./datetime');
const quietFacts = require('./quiet-facts');
const { autoReminderAt } = require('./auto-reminder');
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


// Does a quiet day move this repeat, or does it arrive on it?
//
// The owner's rule went through two passes and the second is the one that
// matters (2026-09-22). The first was "a repeat that is not specifically for
// Saturday should not arrive on one". Then he read it against his own list and
// carved out the two shapes that were actually in it:
//
//   "כל יום ב7 צריך להיות כולל שבת (כי זה יכול להיות תרופה או משהו חשוב)"
//   "כנ״ל כל ה16 בחודש שאם זה נופל על שבת שיהיה על שבת"
//
// His own live rows are why: the two `daily` reminders on the box are "לקחת
// כדור לבלוטה" and "לשלוח החזרים לקופה", and the `monthly:16` is "לקחת כדור
// ריבה". A routine somebody set for every day, or for a date, is a commitment
// they made — and skipping Saturday breaks the routine rather than sparing
// them a message.
//
// So what is left is ONE shape, and the line is whether the rule PINS
// anything:
//
//   daily        — pins every day. Arrives.
//   weekly:SA    — pins the weekday, Saturday included. Arrives, and that is
//                  the whole point of naming it.
//   monthly:16   — pins a date. Arrives, wherever the 16th lands.
//   monthly:last — pins a date. Arrives.
//   weekly       — pins NOTHING. "כל שבוע" said on a Saturday is a
//                  coincidence of when they said it, and it is the only rule
//                  whose quiet day nobody chose. It moves.
//
// There is no column that separates a pill from a nag — `nudge` is false on
// every live repeating row and `due_at` is null on six of the seven — so the
// shape of the rule is the only honest signal, and this is where it stops.
function movesOffQuietDay(rule) {
  return normalizeRepeatRule(rule) === 'weekly';
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

// ---- a moment already gone --------------------------------------------------
//
// Vered, 2026-09-06: a reminder written at 23:02 was armed for 20:02 the same
// evening — valid ISO, correct offset, three hours gone. It fired on the spot,
// its outbox row expired undelivered, and on the way in it cancelled the 08:00
// she had just been promised in the same breath.
//
// This is a predicate, not a guard inside setReminder, and the layer matters.
// Arming a reminder in the past is a legitimate thing for our own code to do —
// most of the suite does it to make a reminder due and then drive the sweep,
// and a repair script rearming a missed row needs it too. The mistake is
// specifically **the model asking for one**, so the refusal lives at the tool
// boundary where that request arrives (adapters/mcp/tools/reminders.js) and
// where refusing costs nothing else. Refused rather than clamped: clamping
// fires it the instant it is stored, which is the outcome to prevent, not the
// one to settle for. The grace absorbs the seconds between the model composing
// the moment and the tool reaching the database; three hours is not that.
const PAST_GRACE_MS = 2 * 60_000;

function momentIsPast(remindAt, now = new Date()) {
  const when = new Date(remindAt);
  if (Number.isNaN(when.getTime())) return false;
  return when.getTime() < new Date(now).getTime() - PAST_GRACE_MS;
}

// Which local day a moment falls on, in the person's own zone. Used to decide
// whether an explicit reminder is REPLACING the automatic one or standing
// beside it — see setReminder.
const pad = (n) => String(n).padStart(2, '0');

function localDayKey(value, tz) {
  const p = dt.partsInZone(tz, new Date(value));
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

// Who a reminder reaches. A reminder is one PERSON's — on a shared task each
// participant has their own (migration 073, `task_reminders.user_id`). Rows
// written before that column carry NULL, and for them the recipient is the
// task's owner, which is what every reader assumed until then. Every query
// here that asks "whose" asks it this way, with `r` the reminder and `t` the
// task, so a row the old code inserts during a deploy still routes right.
const RECIPIENT = 'COALESCE(r.user_id, t.owner_id)';

// A task the person may set a reminder on: their own, or one shared with them
// (the task itself or the list it is an item of). Same shape as
// shares.shareCovering, inlined because shares.js requires tasks.js which
// requires this file.
const TASK_THEY_ARE_ON = `(t.owner_id = $2 OR EXISTS (
  SELECT 1 FROM shares s WHERE s.viewer_id = $2 AND s.status = 'active'
    AND (s.task_id = t.id OR s.task_id = t.parent_id)))`;

async function setReminder(client, userId, taskId, remindAt, repeatRule, { nudge = false } = {}) {
  if (!remindAt) return err('invalid', 'remind_at required');
  if (!hasOffset(remindAt)) return badTime('remind_at', remindAt);
  // The zone is the PERSON's, not the task owner's: "every month on the 16th"
  // is a promise in the clock of whoever asked for it.
  const { rows } = await client.query(
    `SELECT t.id, t.status, u.timezone, u.locale FROM tasks t JOIN users u ON u.id = $2
      WHERE t.id = $1 AND t.archived_at IS NULL AND ${TASK_THEY_ARE_ON}`,
    [taskId, userId]
  );
  if (!rows[0]) return err('not_found', 'task not found');
  if (rows[0].status !== 'open') return err('invalid', 'cannot set a reminder on a completed task');
  const tz = rows[0].timezone || 'Asia/Jerusalem';
  // "every month" has to be pinned to a day, and this is the only place that
  // knows both the moment and the zone to read it in. Stored as the concrete
  // day so the rule can never re-derive itself from a clamped occurrence and
  // walk backwards month by month.
  const rule = resolveMonthlyAnchor(normalizeRepeatRule(repeatRule), remindAt, rows[0].timezone);
  // The FIRST occurrence gets the same treatment the sweep gives every one
  // after it (owner, 2026-09-22), and `movesOffQuietDay` is the whole test:
  // only a bare 'weekly' pins nothing, so only a bare 'weekly' moves.
  //
  // A ONE-OFF is untouched either way. "תזכירי לי בשבת ב-10" is a moment they
  // chose in words with that day in front of them — the exemption the gate has
  // always granted (gate.askedForInWords), which this rule narrows by exactly
  // one rule shape and not one step further.
  let at = remindAt;
  let movedOff = null;
  if (movesOffQuietDay(rule)) {
    const kept = await quietFacts.keptMomentFor(
      client, { id: userId, timezone: rows[0].timezone, locale: rows[0].locale }, remindAt
    );
    if (kept.movedFrom) { at = kept.at.toISOString(); movedOff = kept.reason; }
  }
  // An asked-for reminder supersedes the one Olma inferred from the due date.
  // Without this, "תזכירי לי בשמונה" on a task that already carries an auto
  // reminder produces two messages about one thing — and the person never
  // asked for the first, so it is ours to withdraw. Only PENDING auto rows go:
  // one that already fired is a thing that happened, not a plan to revise.
  //
  // ...but only on the SAME local day. Replacing is what "at eight, not
  // whenever you were going to" means, and both moments are then about
  // catching the same thing at its due date. A reminder on a DIFFERENT day is
  // a second job, and cancelling the first is silent data loss: Vered asked
  // for one "בעוד דקה" — the word was נוספת, additional — and lost the 08:00
  // she had for the next morning (2026-09-06). Same day replaces; another day
  // stands beside it. `attempts = 0`, not `sent_at IS NULL`: since the
  // escalation ladder a delivered row keeps a null `sent_at` for up to a day,
  // and a reminder that already reached her is not a plan to revise.
  // Judged on the day they ASKED about, never on the day a quiet-day shift
  // moved it to. "at eight, not whenever you were going to" is about the day
  // they were looking at, and the auto row on that day is the one being
  // replaced — it would otherwise survive, be held over the quiet day itself,
  // and land in the same morning as the reminder that replaced it.
  const newDay = localDayKey(remindAt, tz);
  // Only THEIR auto row: the one Olma inferred is the owner's, and a
  // participant asking for their own hour withdraws nothing of the owner's.
  const superseded = await client.query(
    `UPDATE task_reminders r SET cancelled_at = now()
       FROM tasks t
      WHERE r.task_id = $1 AND t.id = r.task_id AND ${RECIPIENT} = $4
        AND r.auto AND r.attempts = 0 AND r.cancelled_at IS NULL
        AND to_char(r.remind_at AT TIME ZONE $2, 'YYYY-MM-DD') = $3
      RETURNING r.id`,
    [taskId, tz, newDay, userId]
  );
  // `nudge` is the one thing on this row nobody can infer later: "תזכירי לי עד
  // שאעשה את זה" and "תזכירי לי ב-9" produce the same row otherwise, and the
  // ladder default (RUNGS) says one message for both. It is stamped only when
  // they ASKED — a model that passes it by reflex is the drum this replaced.
  const ins = await client.query(
    `INSERT INTO task_reminders (task_id, remind_at, repeat_rule, auto, nudge, user_id)
     VALUES ($1, $2, $3, false, $4, $5) RETURNING *`,
    [taskId, at, rule, nudge === true, userId]
  );
  await audit.record(client, userId, 'reminder.created', {
    taskId, reminderId: ins.rows[0].id,
    ...(nudge === true ? { nudge: true } : {}),
    ...(movedOff ? { movedOffQuietDay: movedOff, askedFor: remindAt } : {}),
    ...(superseded.rowCount ? { supersededAuto: superseded.rows.map((r) => Number(r.id)) } : {}),
  });
  return ok({ reminder: ins.rows[0], supersededAuto: superseded.rowCount });
}

// One ladder per task. Maya asked for a reminder at 16:00 AND one at 16:15
// for the same call (2026-09-03); each was a reminder of its own, so each
// climbed — "בוצע?" twice, fifteen minutes apart, that evening, and "זו
// התזכורת האחרונה" twice the next afternoon, about a call she had had the day
// before (incidents.md, "Two ladders for one phone call"). Both first rungs
// are hers and both go out. But once the LATER one has said its piece, the
// earlier one's chase is answered: whatever the second reminder was for, it
// was not "chase me twice more about the first". So when rung 1 of a one-off
// reminder goes out, every other one-off reminder on the task that is already
// climbing is retired (`sent_at`, never cancelled — nothing they asked for is
// withdrawn) and every queued FOLLOW-UP rung of a sibling is withdrawn as
// 'superseded'. A sibling's rung 1 is never touched: that is a moment they
// chose, and it may still be sitting in the outbox held for the night.
// Siblings are THIS person's other reminders on the task: on a shared task
// somebody else's ladder is their own arrangement and is not answered by
// what this one said.
async function retireSiblingLadders(client, userId, taskId, reminderId, now = new Date()) {
  const { rows: retired } = await client.query(
    `UPDATE task_reminders r SET sent_at = $3
       FROM tasks t
      WHERE r.task_id = $1 AND t.id = r.task_id AND ${RECIPIENT} = $4
        AND r.id <> $2 AND r.sent_at IS NULL AND r.cancelled_at IS NULL
        AND r.repeat_rule IS NULL AND r.attempts >= 1
      RETURNING r.id`, [taskId, reminderId, now, userId]);
  // Every sibling's queued follow-ups, not only those retired just now — a
  // ladder that already reached its last rung is retired on the row while its
  // final message may still be held in the outbox (retireForMovedTask has the
  // same sentence, from Vered's r164).
  const { rows: siblings } = await client.query(
    `SELECT r.id FROM task_reminders r JOIN tasks t ON t.id = r.task_id
      WHERE r.task_id = $1 AND r.id <> $2 AND r.repeat_rule IS NULL AND ${RECIPIENT} = $3`,
    [taskId, reminderId, userId]);
  let withdrawn = [];
  if (siblings.length) {
    ({ rows: withdrawn } = await client.query(
      `UPDATE outbox SET sent_at = now(), hold_reason = 'superseded'
        WHERE user_id = $1 AND kind = 'reminder' AND sent_at IS NULL
          AND idempotency_key LIKE ANY($2::text[])
        RETURNING id`, [userId, siblings.map((r) => `reminder:${r.id}:%`)]));
  }
  const out = { retired: retired.map((r) => Number(r.id)), withdrawn: withdrawn.map((r) => Number(r.id)) };
  if (out.retired.length || out.withdrawn.length) {
    await audit.record(client, userId, 'reminder.ladder_superseded', {
      taskId: Number(taskId), by: Number(reminderId), ...out,
    });
  }
  return out;
}

// The reminder Olma attaches by itself when a task arrives carrying a moment.
// Separate from setReminder on purpose: this one is allowed to decline (it
// returns null for "no reminder was warranted"), it never overrides an
// explicit reminder that is already there, and it is the only writer of
// `auto = true`. The WHEN lives in domain/auto-reminder.js, which is pure.
//
// Returns the created row, or null. Null is a real answer — a task with no due
// date, a moment already past, one too far out — and callers must treat it as
// one rather than as a failure worth mentioning to anybody.
async function attachAutoReminder(client, ownerId, task, timezone, now = new Date()) {
  const at = autoReminderAt(task.due_at, timezone, now);
  if (!at) return null;
  // Never a second reminder on a task that already has a live one OF THEIRS:
  // a person who asked for their own has said what they want, and a repeat
  // of this call (a retried tool, a re-run sweep) must not stack. Somebody
  // else's reminder on a shared task says nothing about what this person
  // wants to hear.
  const { rows: existing } = await client.query(
    `SELECT 1 FROM task_reminders r JOIN tasks t ON t.id = r.task_id
      WHERE r.task_id = $1 AND ${RECIPIENT} = $2
        AND r.sent_at IS NULL AND r.cancelled_at IS NULL LIMIT 1`,
    [task.id, ownerId]
  );
  if (existing.length) return null;
  const { rows } = await client.query(
    `INSERT INTO task_reminders (task_id, remind_at, auto, user_id)
     VALUES ($1, $2, true, $3) RETURNING *`,
    [task.id, at, ownerId]
  );
  await audit.record(client, ownerId, 'reminder.auto_created', {
    taskId: Number(task.id), reminderId: Number(rows[0].id), remindAt: at,
  });
  return rows[0];
}

// Cancelling a reminder answers half a question. "בטלי את התזכורת לאיסוף
// ילדים" and "בטלי את האיסוף" are the same sentence in most people's heads,
// and the person who said the first one walks away believing the second one
// happened — which is exactly what one did, then reported the surviving task
// as a bug. Olma happened to say "the task itself stays" that time; nothing
// made her, because the result was `{reminderId}` and the sentence came out
// of the model's memory rather than out of the system.
//
// So the result carries the other half. `taskStillOpen` is not a suggestion to
// delete anything — it is the fact that this person now has a live task with
// nothing left to raise it, which is the one moment worth one short question.
async function cancelReminder(client, userId, reminderId) {
  const { rows } = await client.query(
    `UPDATE task_reminders r SET cancelled_at = now()
     FROM tasks t
     WHERE r.id = $1 AND r.task_id = t.id AND ${RECIPIENT} = $2
       AND r.sent_at IS NULL AND r.cancelled_at IS NULL
     RETURNING r.id AS reminder_id, t.id AS task_id, t.title,
               t.status, t.archived_at`,
    [reminderId, userId]
  );
  if (!rows[0]) return err('not_found', 'pending reminder not found');
  const t = rows[0];
  // Cancelling stops the LADDER — dueForSending filters on cancelled_at, so no
  // further rung is ever scheduled — but a rung already sitting in the outbox
  // is a message the worker will still deliver, and "I cancelled it" followed
  // by the reminder is the same broken promise as never cancelling at all. The
  // gate holds a follow-up rung all night (it is Olma's moment, not theirs),
  // so the window where one is queued and unsent is hours wide, not seconds.
  // Same sentence as retireForMovedTask and retireSiblingLadders, for the same
  // reason: the reminder row and its queued rungs have to go down together.
  const { rows: withdrawn } = await client.query(
    `UPDATE outbox SET sent_at = now(), hold_reason = 'cancelled'
      WHERE user_id = $1 AND kind = 'reminder' AND sent_at IS NULL
        AND (idempotency_key = $2 OR idempotency_key LIKE $3)
      RETURNING id`,
    [userId, `reminder:${reminderId}`, `reminder:${reminderId}:%`]
  );
  await audit.record(client, userId, 'reminder.cancelled', {
    reminderId,
    ...(withdrawn.length ? { outboxWithdrawn: withdrawn.map((r) => Number(r.id)) } : {}),
  });
  // Another pending reminder OF THEIRS on the same task means nothing was
  // orphaned — they trimmed one of several and the task is still going to be
  // raised with them.
  const { rows: left } = await client.query(
    `SELECT count(*)::int AS n FROM task_reminders r JOIN tasks t ON t.id = r.task_id
      WHERE r.task_id = $1 AND ${RECIPIENT} = $2
        AND r.sent_at IS NULL AND r.cancelled_at IS NULL`,
    [t.task_id, userId]
  );
  const remaining = left[0].n;
  const orphaned = t.status === 'open' && !t.archived_at && remaining === 0;
  return ok({
    reminderId,
    task: { id: Number(t.task_id), title: t.title, status: t.status },
    remainingReminders: remaining,
    ...(orphaned ? { taskStillOpen: true } : {}),
  });
}

// Pending means `attempts = 0`, and this asked neither half of that. It
// filtered on `cancelled_at` alone, so a RETIRED reminder — the hour came, the
// message went out, the row was stamped — came back as one still to come; and
// since the escalation ladder a row that delivered rung 1 keeps `sent_at` NULL
// for up to two days while `remind_at` sits in the past. Measured on the live
// database the day this was fixed: 105 rows returned for real users, 13 of
// them actually pending. The tool's own description says "pending reminders",
// so every one of the other 92 was an hour Olma could promise somebody twice.
//
// `attempts = 0` stays exactly where it is — but it answers "an hour Olma may
// promise", and there is a SECOND question with a different answer: what is
// still going to reach this person. A one-off mid-ladder has delivered rung 1
// and will send two more messages on its own, and it was in neither list. So
// somebody who replied "stop reminding me about this" was asking about the one
// row the model could not name, in this tool or in any other: it cancelled
// what it could see, on other tasks, and the ladder it was asked to stop
// climbed on (incidents.md, "The reminder that would not stop").
//
// They are returned APART and never merged: `reminders` is what may be said
// out loud as a coming hour, `chasing` is what may be stopped. Merging them is
// how a wall-clock hour already in the past gets read back as the next time
// Olma will raise something — the "hundred and five pending reminders" bug,
// which this must not reopen.
// The wall clock in their zone, added to each row. One users read for the
// whole list rather than one per row, and skipped entirely when there is
// nothing to stamp.
async function withLocalHour(client, ownerId, rows) {
  const { rows: u } = await client.query(`SELECT timezone FROM users WHERE id = $1`, [ownerId]);
  const tz = (u[0] && u[0].timezone) || 'UTC';
  const pad = (n) => String(n).padStart(2, '0');
  return rows.map((r) => {
    const p = dt.partsInZone(tz, new Date(r.remind_at));
    return { ...r, at: `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mi)}` };
  });
}

async function listReminders(client, userId, taskId) {
  // `t.title` is joined on and it is not decoration: without it this answered
  // "reminder 41 at 2026-09-11T16:00:00Z" and nothing else, so anything that
  // wanted to SAY what a reminder was about had to go and fetch the tasks and
  // match them up by id — or say the hour with no thing attached to it. The
  // hour goes out in their own zone beside the instant, for the same reason
  // `listTasks` does it: a UTC instant sitting next to a local one is how the
  // wrong one gets picked.
  const { rows } = await client.query(
    `SELECT r.*, t.title FROM task_reminders r JOIN tasks t ON t.id = r.task_id
     WHERE ${RECIPIENT} = $1 AND ($2::bigint IS NULL OR r.task_id = $2)
       AND r.cancelled_at IS NULL AND r.sent_at IS NULL AND r.attempts = 0
     ORDER BY r.remind_at`,
    [userId, taskId || null]
  );
  const { rows: chasing } = await client.query(
    `SELECT r.id, r.task_id, r.remind_at, r.attempts, t.title
       FROM task_reminders r JOIN tasks t ON t.id = r.task_id
      WHERE ${RECIPIENT} = $1 AND ($2::bigint IS NULL OR r.task_id = $2)
        AND r.cancelled_at IS NULL AND r.sent_at IS NULL AND r.attempts > 0
        AND r.repeat_rule IS NULL
        AND t.status = 'open' AND t.archived_at IS NULL
      ORDER BY r.remind_at`,
    [userId, taskId || null]
  );
  return ok({
    reminders: rows.length ? await withLocalHour(client, userId, rows) : rows,
    ...(chasing.length ? {
      chasing: chasing.map((r) => ({
        id: Number(r.id),
        taskId: Number(r.task_id),
        title: r.title,
        // The moment they originally chose. NOT when the next rung lands —
        // that depends on when the last one was delivered, and a guessed hour
        // said out loud is the fault this whole area keeps producing.
        askedFor: new Date(r.remind_at).toISOString(),
        rungsSent: Number(r.attempts),
      })),
    } : {}),
  });
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
//    delivered, not merely enqueued — OR died on OUR side of the wire (the
//    worker tried, failed every time, and the row expired). The second case
//    is a redo, not a chase: it goes out at once with the plain wording, and
//    it still spends a rung so a broken pipe cannot loop for ever. This is the check-in bug's lesson: that
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
// 5. HOW MANY rungs is a property of the reminder, not of the system, and the
//    default is quiet. Measured over 45 days on the box (2026-09-17) — what
//    happened in the three hours after each rung actually delivered:
//
//      rung 1  103 sent  11 done (11%)   9 cancelled
//      rung 2   69 sent  15 done (22%)  24 cancelled (35%)
//      rung 3   25 sent   6 done (24%)   0 cancelled
//
//    So a follow-up the SAME day earns its place, and the next-day rung earns
//    it for exactly one person (5 of מירון's 10; 1 of the other 15). Against
//    that, a third of every follow-up ends with somebody cancelling the
//    reminder — and מאיה's evening is what a fourth message about a hospital
//    bag she had already packed reads like (incidents.md, "התיק לבית חולים").
//    The split that survives the reading is who chose the HOUR:
//
//      - They named it (`auto = false`): ONE message, at their moment, and
//        nothing after it. They asked for a reminder, not for a chase.
//      - Olma inferred it from a due date (`auto = true`): one follow-up the
//        same day. Nobody promised them anything at 08:00, so a second try is
//        Olma doing her job rather than nagging about a time they picked.
//      - Either, once they ASK to be nudged: the full three rungs.
//
//    Never a rung after the local day of `due_at` has ended (RUNGS.nudging
//    included): "did you pack the bag?" the morning after the hospital is a
//    message about nothing. An overdue task is already in the digest.
const ESCALATION_MAX_ATTEMPTS = 3;
const ESCALATION_GAP_HOURS = 3;

// The per-reminder cap, by who chose the hour. `nudging` is the ceiling a
// person opts into; the flag `reminder_escalation_max` still bounds all three
// from above, so one number can still turn every ladder off in an incident.
const RUNGS = { explicit: 1, auto: 2, nudging: 3 };

async function dueForSending(client, now, opts = {}) {
  const maxAttempts = Number.isFinite(Number(opts.maxAttempts)) && Number(opts.maxAttempts) > 0
    ? Math.floor(Number(opts.maxAttempts)) : ESCALATION_MAX_ATTEMPTS;
  const gapHours = Number.isFinite(Number(opts.gapHours)) && Number(opts.gapHours) > 0
    ? Number(opts.gapHours) : ESCALATION_GAP_HOURS;
  // The two caps of rule 5. Overridable per call for the same reason
  // `maxAttempts` is: a test that wants a three-rung ladder should say so in
  // the call rather than by moving a production default.
  const cap = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : fallback);
  const autoRungs = cap(opts.autoRungs, RUNGS.auto);
  const explicitRungs = cap(opts.explicitRungs, RUNGS.explicit);
  const nudgingRungs = cap(opts.nudgingRungs, RUNGS.nudging);
  const { rows } = await client.query(
    `SELECT r.id AS reminder_id, r.task_id, r.remind_at, r.repeat_rule, r.attempts, r.auto,
            -- who it reaches — the person who set it, and only for rows older
            -- than migration 073 the task's owner
            ${RECIPIENT} AS user_id, t.title, t.due_at, u.timezone, u.digest_times, u.locale,
            -- How many rungs THIS reminder gets (rule 5 above), never more than
            -- the flag allows. Returned so the sweep can say "last one" off the
            -- same number the WHERE clause stopped on: a cap the caller derives
            -- for itself is the second copy that drifts.
            least($2::int, CASE WHEN r.nudge OR u.reminder_nudge THEN $6::int
                                WHEN r.auto THEN $4::int ELSE $5::int END) AS rung_cap,
            -- true when the previous rung was OURS to lose: the pipe failed on
            -- every try and the row expired with nothing delivered.
            (prev.hold_reason = 'expired' AND prev.attempts > 0 AND prev.last_error IS NOT NULL) AS prev_failed
     FROM task_reminders r
     JOIN tasks t ON t.id = r.task_id
     JOIN users u ON u.id = ${RECIPIENT}
     -- The outbox row of the rung before this one (none for rung 1).
     LEFT JOIN LATERAL (
       SELECT o.sent_at, o.hold_reason, o.attempts, o.last_error FROM outbox o
        WHERE r.attempts >= 1 AND o.user_id = ${RECIPIENT}
          AND o.idempotency_key = CASE WHEN r.attempts = 1
                THEN 'reminder:' || r.id
                ELSE 'reminder:' || r.id || ':' || r.attempts END
        ORDER BY o.id DESC LIMIT 1
     ) prev ON true
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
         (r.attempts BETWEEN 1 AND least($2::int, CASE WHEN r.nudge OR u.reminder_nudge THEN $6::int
                                                       WHEN r.auto THEN $4::int ELSE $5::int END) - 1
          AND r.repeat_rule IS NULL
          -- Never a follow-up once the day the THING is on has ended. A rung
          -- chases an action whose moment is still ahead; the morning after
          -- the hospital, "did you pack the bag?" is a message about nothing,
          -- and the task is in the digest either way.
          AND (t.due_at IS NULL
               OR ($1::timestamptz AT TIME ZONE COALESCE(u.timezone, 'UTC'))::date
                  <= (t.due_at AT TIME ZONE COALESCE(u.timezone, 'UTC'))::date)
          AND (
            -- The previous rung died on OUR side: the worker tried, every try
            -- failed (attempts > 0, an error recorded) and the row expired.
            -- The person got nothing and it was not their doing, so the next
            -- rung goes now — not after the gap, and not next day. A row the
            -- GATE held or dropped never gets here: it has no attempts and no
            -- error, and chasing it is the check-in ladder's documented bug.
            (prev.hold_reason = 'expired' AND prev.attempts > 0 AND prev.last_error IS NOT NULL)
            OR
            -- The previous rung LANDED. hold_reason IS NULL is what separates
            -- delivered from dropped/expired/cancelled — a row the gate stamped
            -- on the way to the bin carries a reason and does not count.
            (prev.sent_at IS NOT NULL AND prev.hold_reason IS NULL
             AND prev.sent_at <= $1::timestamptz - ($3::double precision * interval '1 hour')
             -- Rung 3 is "next day at the hour they chose", not "gap hours after
             -- rung 2" — computed through their own timezone so the wall-clock
             -- hour survives a DST boundary instead of drifting by one.
             AND (r.attempts <> 2
                  OR (r.remind_at AT TIME ZONE COALESCE(u.timezone, 'UTC') + interval '1 day')
                       AT TIME ZONE COALESCE(u.timezone, 'UTC') <= $1::timestamptz))
          )
         )
       )
     -- Then by id: two reminders at the SAME moment are rung 1 in the same tick,
     -- and the later one must be the one that retires the other's ladder.
     ORDER BY r.remind_at, r.id`,
    [now, maxAttempts, gapHours, autoRungs, explicitRungs, nudgingRungs]
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
// A task whose date the PERSON moved has answered every rung that was chasing
// it: "בוצע?" about Monday has no meaning once they said "Tuesday". Vered
// (2026-09-07) moved five tasks to the next morning at 09:00 and, had this not
// existed, would have been told "זו התזכורת האחרונה" about all of them at 08:00
// — the rung 3 of the ladders that rung 1 and 2 had already climbed on the OLD
// date — an hour before the reminders she had just asked for (`incidents.md`,
// "Eighteen messages, no answer").
//
// Three things, and each is a different sentence:
// - A rung already climbing (attempts >= 1, one-off) is RETIRED, `sent_at`,
//   not cancelled: they answered it, by moving the thing. Its queued outbox
//   row, if the sweep already made one (night-held, say), is withdrawn under
//   its own reason so the worker cannot deliver it at dawn.
// - A pending AUTOMATIC reminder for the old date (attempts = 0, `auto`) is
//   Olma's own inference from a date that no longer exists: cancelled, and
//   armed again for the new date by the only writer of `auto = true`. An
//   explicit reminder they set for the same task (`auto = false`) stops that
//   re-arm exactly as it would on add_task — they named a moment.
// - A repeating reminder is its own cadence and is left alone.
async function retireForMovedTask(client, ownerId, task, { timezone, now = new Date() } = {}) {
  const { rows: retired } = await client.query(
    `UPDATE task_reminders SET sent_at = $2
      WHERE task_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL
        AND repeat_rule IS NULL AND attempts >= 1
      RETURNING id`, [task.id, now]);
  const retiredIds = retired.map((r) => Number(r.id));
  // Every queued rung of every one-off reminder on the task, not only of the
  // ones retired just now. A ladder that has already climbed to its last rung
  // is retired on the reminder row (`sent_at` set, attempts exhausted) while
  // its final message still sits in the outbox, held for the night — Vered's
  // r164 (2026-09-07): the rung nobody could retire because the reminder was
  // already over, due at 08:00 about a task she had moved to 09:00.
  // Everybody's: a moved date answers every rung chasing the old one, whoever
  // it was reaching. A reminder id names one row, so the keys alone are the
  // whole address and no recipient filter is needed.
  const { rows: all } = await client.query(
    `SELECT id FROM task_reminders WHERE task_id = $1 AND repeat_rule IS NULL`, [task.id]);
  let withdrawn = [];
  if (all.length) {
    const keys = all.flatMap((r) => [`reminder:${r.id}`, `reminder:${r.id}:%`]);
    ({ rows: withdrawn } = await client.query(
      `UPDATE outbox SET sent_at = now(), hold_reason = 'moved'
        WHERE kind = 'reminder' AND sent_at IS NULL
          AND idempotency_key LIKE ANY($1::text[])
        RETURNING id`, [keys]));
  }
  const { rows: stale } = await client.query(
    `UPDATE task_reminders SET cancelled_at = $2
      WHERE task_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL
        AND repeat_rule IS NULL AND attempts = 0 AND auto
      RETURNING id`, [task.id, now]);
  const rearmed = task.due_at ? await attachAutoReminder(client, ownerId, task, timezone, now) : null;
  if (retiredIds.length || withdrawn.length || stale.length || rearmed) {
    await audit.record(client, ownerId, 'reminder.moved_with_task', {
      taskId: Number(task.id),
      retired: retiredIds,
      outboxWithdrawn: withdrawn.map((r) => Number(r.id)),
      autoCancelled: stale.map((r) => Number(r.id)),
      rearmed: rearmed ? Number(rearmed.id) : null,
    });
  }
  return { retired: retiredIds, withdrawn: withdrawn.length, autoCancelled: stale.map((r) => Number(r.id)), reminder: rearmed };
}

// ---- "להפסיק להזכיר" --------------------------------------------------------
//
// מאיה, 2026-09-16 11:02, after four messages about a hospital bag: "להפסיק
// להזכיר". What she got back was a question — "מה להפסיק? 1. התזכורת על
// לארוז 2. שתיהן 3. לדחות" — and nothing was cancelled, so an hour later
// another rung landed and the morning after that, two more.
//
// Two ladders were chasing her and the model could name both, which is exactly
// why it asked. That question is the bug: "stop" is not ambiguous to the person
// saying it, and the cost of getting it wrong in either direction is not
// symmetric — stopping one reminder too many costs a reminder they can set
// again in a sentence, while asking costs the thing they asked for.
//
// So the answer is a WRITE, made here, before the model sees the turn: every
// ladder that has actually spoken to them recently stops, and brokerd puts a 👍
// on the message instead of the 👀 that promises a reply. Same argument as
// markPlaced — an instruction in a prompt is a request, one at the boundary is
// a rule (.claude/rules/doctrine.md).
//
// What it does NOT touch, and each for its own reason:
//   - a reminder that has not fired yet (attempts = 0): they have never heard
//     it, so "stop reminding" cannot be about it. It is also the hour they may
//     still be promised, and cancelling it silently would be the opposite
//     failure — a reminder they asked for, gone without a word.
//   - a repeating reminder: that cadence IS theirs, and ending it is a decision
//     about a standing arrangement, not about the last few messages. The model
//     still has cancel_reminder for it, with words.
//   - the TASK: stopping the reminders is not doing the thing or dropping it
//     (cancel_reminder's own taskStillOpen hint, and the pause doctrine).
const STOP_WINDOW_HOURS = 24;

async function stopRecentLadders(client, userId, { now = new Date(), windowHours = STOP_WINDOW_HOURS } = {}) {
  // Reminders of theirs that have actually REACHED them inside the window:
  // a delivered outbox row (`sent_at` set, no hold_reason) whose key names the
  // reminder. A rung the gate held reached nobody and is not what "stop" is
  // answering — and it is withdrawn below anyway, where withdrawing is free.
  const { rows: reached } = await client.query(
    `SELECT DISTINCT r.id, r.sent_at IS NULL AS climbing
       FROM task_reminders r
       JOIN tasks t ON t.id = r.task_id
       JOIN outbox o ON o.user_id = $1 AND o.kind = 'reminder'
        AND substring(o.idempotency_key from '^reminder:([0-9]+)')::bigint = r.id
      WHERE ${RECIPIENT} = $1 AND r.repeat_rule IS NULL AND r.cancelled_at IS NULL
        AND r.attempts >= 1
        AND o.sent_at IS NOT NULL AND o.hold_reason IS NULL
        AND o.sent_at > $2::timestamptz - ($3::double precision * interval '1 hour')`,
    [userId, now, windowHours]
  );
  if (!reached.length) return { stopped: [], withdrawn: 0 };
  const ids = reached.map((r) => Number(r.id));
  // Retired, never cancelled — they answered it. `sent_at` is what takes the
  // row out of the pending set for good, and it is the same verb
  // retireSiblingLadders and retireForMovedTask use for the same reason.
  const { rows: stopped } = await client.query(
    `UPDATE task_reminders SET sent_at = $2
      WHERE id = ANY($1::bigint[]) AND sent_at IS NULL AND cancelled_at IS NULL
      RETURNING id`, [ids, now]);
  // And the rung already sitting in the queue — the one held for the night is
  // the whole reason cancelling used to be a lie for hours (incidents.md, "The
  // reminder that would not stop"). Withdrawn for every id in the window,
  // including a ladder that had already ended and still has a message waiting.
  const keys = ids.flatMap((id) => [`reminder:${id}`, `reminder:${id}:%`]);
  const { rows: withdrawn } = await client.query(
    `UPDATE outbox SET sent_at = now(), hold_reason = 'stopped'
      WHERE user_id = $1 AND kind = 'reminder' AND sent_at IS NULL
        AND idempotency_key LIKE ANY($2::text[])
      RETURNING id`, [userId, keys]);
  const stoppedIds = stopped.map((r) => Number(r.id));
  if (stoppedIds.length || withdrawn.length) {
    await audit.record(client, userId, 'reminder.ladder_stopped', {
      stopped: stoppedIds, outboxWithdrawn: withdrawn.map((r) => Number(r.id)),
    });
  }
  return { stopped: stoppedIds, withdrawn: withdrawn.length };
}

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

// ---- riding the morning picture --------------------------------------------
//
// The owner's rule, 2026-09-20: a standing nudge on a dateless task defaults to
// the hour that person already hears from Olma in the morning, and when it does
// it arrives WITH the morning picture rather than as a second interruption.
//
// This is the one predicate both sweeps ask, because they run one after the
// other in the same tick (jobs/registry.js) and a disagreement between them is
// either a nudge nobody gets or a nudge they get twice. It is deliberately
// narrow — the hour has to be one of their digest hours EXACTLY, not near it:
// somebody who moved their nudge to 18:00 asked for a message at 18:00, and a
// digest at 09:35 is not it.
//
// Only a dateless, REPEATING nudge rides. A dated task's reminder is about a
// moment, and the whole point of a moment is that it arrives at it; a one-off
// is a moment they named, for the same reason.
function ridesDigest({ dueAt, repeatRule, remindAt, timezone, digestTimes }) {
  if (dueAt) return false;
  if (!normalizeRepeatRule(repeatRule)) return false;
  const times = Array.isArray(digestTimes)
    ? digestTimes
    : String(digestTimes || '').split(',');
  const wanted = times.map((t) => String(t).trim()).filter(Boolean);
  if (!wanted.length) return false;
  const at = new Date(remindAt);
  if (Number.isNaN(at.getTime())) return false;
  const p = dt.partsInZone(timezone || 'UTC', at);
  const hhmm = `${String(p.hh).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
  return wanted.includes(hhmm);
}

// What the digest draws: the occurrences handed to a digest row that is STILL
// WAITING to go out. Not "carried in the last N minutes" — the model composes
// the turn some seconds after the sweep, and a time window would be a second
// clock to get wrong in a file whose whole subject is getting clocks right.
// Tied to the row instead, it self-clears: once that digest is delivered the
// nudge stops being drawn, because the message that carried it has landed.
async function carriedForDigest(client, userId) {
  const { rows } = await client.query(
    `SELECT r.id, r.task_id, t.title, r.remind_at, r.repeat_rule
       FROM task_reminders r
       JOIN tasks t ON t.id = r.task_id
       JOIN outbox o ON o.id = r.carried_outbox_id
      WHERE COALESCE(r.user_id, t.owner_id) = $1
        AND o.sent_at IS NULL
      ORDER BY r.carried_at, r.id`,
    [userId]
  );
  return rows.map((r) => ({
    reminderId: Number(r.id), taskId: Number(r.task_id), title: r.title,
    remindAt: r.remind_at, repeatRule: r.repeat_rule,
  }));
}

// Stamped INSTEAD of enqueuing a message of its own. The occurrence is retired
// the way a delivered one is — a repeating reminder never climbs a ladder, so
// there is nothing to follow — and the digest row is what says where it went.
async function markCarried(client, reminderId, outboxId, now = new Date()) {
  await client.query(
    `UPDATE task_reminders
        SET carried_at = $3, carried_outbox_id = $2, sent_at = COALESCE(sent_at, $3)
      WHERE id = $1`,
    [reminderId, outboxId, new Date(now).toISOString()]
  );
  return ok({ reminderId: Number(reminderId), outboxId: Number(outboxId) });
}

module.exports = {
  setReminder, attachAutoReminder, retireSiblingLadders, cancelReminder, listReminders, dueForSending, markSent,
  retireForMovedTask, stopRecentLadders, STOP_WINDOW_HOURS, momentIsPast, PAST_GRACE_MS,
  normalizeRepeatRule, nextOccurrence, resolveMonthlyAnchor, movesOffQuietDay,
  recordAttempt, attemptKey, ESCALATION_MAX_ATTEMPTS, ESCALATION_GAP_HOURS, RUNGS,
  ridesDigest, carriedForDigest, markCarried,
};
