'use strict';
// The minute-cadence sweeps that feed the outbox: due reminders, scheduled
// digests, lapsed quota blocks. All idempotent (keys), all run inside
// brokerd's loop — no crontab sprawl, one heartbeat each.
const { enqueue, collectHeld } = require('../outbox/enqueue');
const reminders = require('../domain/reminders');
const audit = require('../domain/audit');
const meetings = require('../domain/meetings');
const meetingFanout = require('../domain/meeting-fanout');
const groupMeetings = require('../domain/group-meetings');
const tasks = require('../domain/tasks');
const quota = require('../domain/quota');
const flags = require('../domain/flags');
const quietFacts = require('../domain/quiet-facts');
const preferences = require('../domain/preferences');
const { minutesInTz, parseHHMM } = require('../outbox/gate');

// ---- reminders --------------------------------------------------------------
// A reminder gets up to three rungs (domain/reminders.dueForSending owns which
// are due). A rung expires 2h past ITS OWN moment: past that it is "עבר זמנה",
// never a live nag.
// Arming the next occurrence of a repeating reminder. ONE function, because
// there are three paths to it now — the ordinary send, the nudge a digest
// carried (reminders.ridesDigest), and a chase asking a moment early whether
// this is its last one — and a second copy of this is a second place for the
// quiet-day rule to be forgotten. It was, for exactly as long as it took to
// rebase the two branches onto each other.
//
// WHERE the next occurrence lands, or null when there is not going to be one.
// Split out of the arming because the SEND needs the same answer a moment
// earlier: "is this the last one" is the difference between "בוצע?" and "זו
// התזכורת האחרונה", and a second copy of this arithmetic is a second place for
// the two to disagree about one series.
async function nextOccurrenceMoment(client, r) {
  // Day zero is the evening occurrence that exists only because the day they
  // asked counts (reminders.startChase). The series proper starts the next
  // morning at THEIR hour, so this one occurrence re-anchors instead of adding
  // a day to 19:00 — otherwise the hour they happened to ask at becomes the
  // hour of the whole arrangement.
  const next = Number(r.repeat_seq) === 0 && reminders.isChase(r)
    ? reminders.chaseReanchor(r.remind_at, reminders.chaseHour({
      digestTimes: r.digest_times,
      windowStart: ((await preferences.availabilityWindow(client, r.user_id)).data.window || {}).start,
    }), r.timezone)
    : reminders.nextOccurrence(r.remind_at, r.repeat_rule, r.timezone);
  if (!next) return null;
  // A chase ends at its deadline, and the check is here rather than in the
  // sweep's WHERE clause because this is the only place that knows where the
  // NEXT one would land. Nothing is written, so the series simply stops having
  // a successor — and the occurrence that goes out now says it was the last.
  const until = r.repeat_until ? new Date(r.repeat_until) : null;
  if (until && next.getTime() > until.getTime()) return null;
  // A BARE 'weekly' that lands on a day they keep quiet is armed for the next
  // day they do not, at the same local hour (owner, 2026-09-22). Every other
  // shape arrives on the day it lands on — a pill at seven is a pill on
  // Saturday too; reminders.movesOffQuietDay carries his two carve-outs and
  // the reasoning behind them.
  //
  // Here rather than in the gate, and the reason is not style: the gate's
  // order is paused → eval → EXPIRY → … → quiet day, and a repeating reminder
  // is always rung 1, whose row expires at `remind_at + 2h`. A hold over
  // Shabbat would come back on Sunday morning, meet the expiry check first and
  // DELETE the message. Moving the moment a week early is the only place this
  // decision is safe.
  const kept = reminders.movesOffQuietDay(r.repeat_rule, { until })
    ? await quietFacts.keptMomentFor(
      client, { id: r.user_id, timezone: r.timezone, locale: r.locale }, next)
    : { at: next, movedFrom: null, reason: null };
  // …and again after the move, which for a chase is a SKIP: Saturday's
  // occurrence lands on Sunday, and if the deadline was Saturday there is
  // nothing left to arm at all.
  if (until && kept.at.getTime() > until.getTime()) return null;
  return kept;
}

async function armNextOccurrence(client, r, precomputed) {
  const kept = precomputed === undefined ? await nextOccurrenceMoment(client, r) : precomputed;
  if (!kept) return;
  const until = r.repeat_until ? new Date(r.repeat_until) : null;
  const ins = await client.query(
    `INSERT INTO task_reminders (task_id, remind_at, repeat_rule, user_id, repeat_until, repeat_seq)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [r.task_id, kept.at, reminders.normalizeRepeatRule(r.repeat_rule), r.user_id,
      // Day zero (0) and the first occurrence (1) are both the FIRST message
      // somebody reads, and nothing may be the first thing twice — so the
      // successor of day zero is 2, not 1. The number is the position in what
      // they hear, which is the only thing anything downstream reads it for.
      until, (Number(r.repeat_seq) === 0 ? 1 : (Number(r.repeat_seq) || 1)) + 1]
  );
  // The move is the only thing about a repeating reminder somebody could
  // notice and not be able to explain, so it is on the record — and the row
  // itself only ever shows where it landed.
  if (kept.movedFrom) {
    await audit.record(client, r.user_id, 'reminder.moved_off_quiet_day', {
      taskId: Number(r.task_id), reminderId: Number(ins.rows[0].id),
      from: kept.movedFrom.toISOString(), to: kept.at.toISOString(), reason: kept.reason,
    });
  }
}

async function sweepReminders(client, nowIso) {
  const now = nowIso || new Date().toISOString();
  const maxAttempts = Number(await flags.getFlag(client, 'reminder_escalation_max'))
    || reminders.ESCALATION_MAX_ATTEMPTS;
  const gapHours = Number(await flags.getFlag(client, 'reminder_escalation_gap_hours'))
    || reminders.ESCALATION_GAP_HOURS;
  const due = await reminders.dueForSending(client, now, { maxAttempts, gapHours });
  // `out` is the ids that became a MESSAGE, and it stays exactly that — a
  // nudge the digest carried interrupted nobody and does not belong in a count
  // of sends. That it happened at all is not left to a log line either: every
  // carry writes `reminder.carried_by_digest`, which is the durable record and
  // the thing to query when somebody asks why no reminder went out.
  const out = [];
  for (const r of due.data.due) {
    const attempt = Number(r.attempts) + 1;
    // A repeating reminder never climbs — its own rule already brings it back,
    // so it retires on the first send exactly as before.
    const repeats = Boolean(reminders.normalizeRepeatRule(r.repeat_rule));
    // How many rungs THIS reminder gets is a property of the reminder now
    // (reminders.RUNGS, rule 5) and the query already applied it — so it comes
    // back on the row rather than being re-derived here, where a second copy
    // would drift and say "זו התזכורת האחרונה" a rung early or late.
    const rungCap = Number(r.rung_cap) || maxAttempts;
    const finalAttempt = repeats || attempt >= rungCap;
    // A CHASE says a different sentence on each of its three positions, and
    // they are the three rung templates it already has: the first is a plain
    // reminder, the ones in the middle ask "בוצע?" and say how to stop it —
    // which a daily series has to carry, or the doctrine's promise that a
    // reminder can always be ended is false for a week — and the last one says
    // it is the last. `chaseNext` is computed BEFORE the send for exactly that
    // third case, and handed to the arming so one answer serves both.
    const chase = reminders.isChase(r);
    // 0 is day zero — the evening they asked — and says the same plain first
    // sentence 1 does, which is why this may not collapse into `|| 1`.
    const chaseSeq = Number.isFinite(Number(r.repeat_seq)) ? Number(r.repeat_seq) : 1;
    const chaseNext = chase ? await nextOccurrenceMoment(client, r) : undefined;
    // `attempt` drives the WORDING (proactive-text.reminderTemplateKey) and
    // `rung` drives the quiet hours; a chase splits them deliberately. Only its
    // first occurrence is a moment the person chose by asking — every one after
    // it is an hour Olma picked on a day Olma picked, which is the same line
    // the escalation ladder draws between rung 1 and the rungs above it.
    const chaseRung = chase && chaseSeq > 1 ? 2 : 1;
    const chaseWording = chase && chaseSeq > 1
      ? { attempt: 2, finalAttempt: !chaseNext } : {};
    // The previous rung never left our side (dueForSending: expired after failed
    // delivery attempts). This rung REPLACES it rather than following it up:
    // the plain reminder text, since nothing was delivered to follow up on,
    // and the urgency of the rung it stands in for.
    const redo = Boolean(r.prev_failed);
    // The owner's rule, 2026-09-20: a standing nudge whose hour is the hour
    // they already hear from Olma in the morning arrives WITH the morning
    // picture, not as a second message a minute behind it. The digest draws it
    // (domain/digest-block.js) rather than a model weaving it in, so the one
    // sentence they asked for still reaches them as written — which is the
    // whole reason a reminder may not be merged into a composed turn.
    //
    // Only when the digest row is really there and really still waiting. The
    // sweeps run digests-first for exactly this check (jobs/registry.js): a
    // nudge handed to a digest that has already gone out reaches nobody, and
    // it would do so silently, which is the worst shape this repo has.
    if (attempt === 1 && reminders.ridesDigest({
      dueAt: r.due_at, repeatRule: r.repeat_rule, remindAt: r.remind_at,
      timezone: r.timezone, digestTimes: r.digest_times, repeatUntil: r.repeat_until,
    })) {
      const { rows: waiting } = await client.query(
        `SELECT id FROM outbox
          WHERE user_id = $1 AND kind = 'digest' AND sent_at IS NULL
          ORDER BY id DESC LIMIT 1`,
        [r.user_id]
      );
      if (waiting[0]) {
        await reminders.markCarried(client, r.reminder_id, waiting[0].id, new Date(now));
        await audit.record(client, r.user_id, 'reminder.carried_by_digest', {
          taskId: Number(r.task_id), reminderId: Number(r.reminder_id),
          outboxId: Number(waiting[0].id),
        });
        await armNextOccurrence(client, r, chaseNext);
        continue;
      }
    }
    const res = await enqueue(client, {
      // the person the reminder is FOR — on a shared task not necessarily the
      // task's owner (reminders.dueForSending resolves it)
      userId: r.user_id,
      kind: 'reminder',
      // Only the moment THEY chose is urgent enough to skip the daily budget.
      // A follow-up is Olma's own idea and queues like everything else Olma
      // decided to say — otherwise three rungs per reminder would be a way to
      // spend an unlimited proactive budget by setting enough reminders.
      urgency: (attempt === 1 && chaseRung === 1) || (redo && attempt === 2) ? 'urgent' : 'normal',
      payload: {
        taskId: Number(r.task_id), title: r.title, remindAt: r.remind_at,
        // Which rung this is, always — the gate reads it to decide whether the
        // moment is THEIRS or OURS, and it must be able to tell that for a redo
        // too, which carries no `attempt`. Kept separate from `attempt` for
        // exactly that reason: `attempt` drives the WORDING and a redo
        // deliberately uses rung 1's plain text, while this drives the QUIET
        // HOURS and a redo is still Olma choosing the moment.
        rung: chase ? chaseRung : attempt,
        // Whether the model inferred this reminder from a due date (true) or
        // the person asked for it in words (false). The gate's quiet rule
        // reads it: once somebody has stopped answering, only rung 1 of a
        // reminder they asked for still goes out.
        auto: Boolean(r.auto),
        ...(redo ? { redo: true } : attempt > 1 ? { attempt, finalAttempt } : chaseWording),
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
      // The moment THEY chose has now been said. A task chases through ONE
      // ladder — the one behind the latest reminder they asked for — so any
      // sibling already climbing retires here (reminders.retireSiblingLadders).
      if (attempt === 1 && !repeats) {
        await reminders.retireSiblingLadders(client, r.user_id, r.task_id, r.reminder_id, new Date(now));
      }
      // Spawn the next occurrence. The rule vocabulary lives in one place —
      // this used to compare against the literals 'daily'/'weekly' while the
      // model was storing 'FREQ=DAILY', so every repeating reminder silently
      // fired exactly once. See reminders.normalizeRepeatRule.
      await armNextOccurrence(client, r, chaseNext);
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
  // `last_digest_at` is what decides whether this morning may ask anything.
  // Only rows that were really delivered count: a cancelled or expired row
  // carries sent_at too (that is how cancelling stops its producer), and
  // treating one as a digest the person ignored would silence the next
  // morning over a message they never saw.
  const { rows } = await client.query(
    `SELECT u.id, u.digest_times, u.digest_scope, u.timezone, u.last_inbound_at,
            (SELECT max(o.sent_at) FROM outbox o
              WHERE o.user_id = u.id AND o.kind = 'digest'
                AND o.sent_at IS NOT NULL AND o.hold_reason IS NULL) AS last_digest_at
       FROM users u
      WHERE u.status = 'active' AND u.onboarded_at IS NOT NULL AND u.digest_times IS NOT NULL
        AND u.paused_at IS NULL AND NOT u.is_eval`
  );
  // `digest_card_min_items` used to be read here and stamped onto every row,
  // so that an in-flight digest could not change threshold underneath itself.
  // It is read by get_my_digest instead now, and by nothing else. One reader:
  // stamping it here left the delivery instruction quoting one number while the
  // tool applied another, which is how a turn was told a card replaces the
  // block and then handed the block to send as well (2026-09-10, Miron's
  // evening at 18:01 and again at 18:02). An operator moving the flag while a
  // digest sits in the queue now reaches that digest — a smaller price than two
  // readers of one threshold, and the reason is written down rather than
  // rediscovered.
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
    // "Nobody is asked a question they have already not answered once" was
    // enforced in the check-in ladder and nowhere else, so the digest kept its
    // own counter of nothing: Sarah was asked "did the brunch and the moving
    // happen?" on four consecutive mornings (02, 04, 05, 06 September) and
    // answered none of them, because each morning the model looked for a real
    // gap, found the same one, and asked again. Silence to yesterday's digest
    // is the answer to today's question.
    //
    // Absent, not false, when they have never had a digest: an old row still
    // in flight carries no `mayAsk` and keeps the wording it was enqueued
    // with, the same way `cardMinItems` is treated.
    const mayAsk = !u.last_digest_at
      || (u.last_inbound_at && new Date(u.last_inbound_at) > new Date(u.last_digest_at));
    const res = await enqueue(client, {
      userId: u.id, kind: 'digest',
      payload: { scope: u.digest_scope || 'summary', folded: [], mayAsk: Boolean(mayAsk) },
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
// other half is telling people, once, so a plan that quietly died does not
// just vanish. That used to be a message to the opener alone; since
// 2026-09-23 nobody manages a coordination, and the owner chose that it is
// never a message of its own — it rides the next digest of everybody still in
// it (digest.closedMeetings, keyed on `closed_at`, which this stamps).
async function sweepStaleMeetings(client, nowMs) {
  const closed = await meetings.expireStaleMeetings(client, nowMs || Date.now());
  return closed.map((m) => ({ meetingId: Number(m.id) }));
}

// ---- meetings whose grace has run out ---------------------------------------
// The other half of the settle grace (domain/meeting-options.js). Unanimity
// arms a meeting; this closes it a minute later, and tells everybody once.
//
// Nothing here decides anything: `settleDue` re-asks whether the option is
// still unanimous and simply disarms the ones that are not, so a mind changed
// inside the minute costs a row in this sweep and no message at all. There is
// no actor — this is the system agreeing with itself — so every participant
// gets an outbox row, including the person whose yes started the clock.
// ---- paused room members who never answered -------------------------------
// The day-later half of a paused person's one coordination message; the rule
// and the reasons live in domain/group-meetings.js, where the exit is.
async function sweepSilentPausedMembers(client, nowMs) {
  return groupMeetings.sweepSilentPausedMembers(client, nowMs || Date.now());
}

async function sweepSettlingMeetings(client) {
  const settled = await meetings.options.settleDue(client);
  const out = [];
  for (const s of settled) {
    await meetingFanout.afterSettled(client, s.meetingId, { ok: true, data: s }, { actor: null });
    out.push({ meetingId: s.meetingId, slot: s.slot });
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
// **The opening is a REPLY, so "they have not replied" is never the whole
// truth.** `first_turn_at` is stamped during their first turn, and that turn
// is opened by their own first message — so this fires at somebody who wrote
// exactly once and then stopped, which is a real state worth a nudge, and NOT
// at somebody who has been silent toward us (that person has no first turn and
// is invisible here). Measured 2026-09-07: it had fired at 4 of 4 people who
// ever reached a first turn, and every one of them had written first.
//
// That is why the wording below no longer says where the name came from. It
// said "most likely from their WhatsApp profile"; עידן's came from Miron's
// Google contacts (`user.name_prefilled_from_contacts`), and his one message
// was "קוראים לי עידן" — so Olma asked him to confirm a name he had just
// typed. A sweep may say what is in the columns and nothing else. The real
// repair for his case is upstream, in turn_start's first-turn instruction,
// which now saves a name given in that first message; this rung is the net
// under it, and `name_confirmed` is what stops it once the name is real.
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
      ? `They wrote once, about a minute ago, and nothing since. The name on `
        + `file is "${u.first_name}" and nobody has heard it from them — it may `
        + `be from their WhatsApp profile, or from someone else's address book, `
        + `and this system does not know which. FIRST read what they actually `
        + `wrote: if they already said what to call them, call set_my_name and `
        + `answer whatever else was in that message — never ask them to confirm `
        + `a name they just gave you. Only if their message says nothing about `
        + `their name, ask in one short warm line whether "${u.first_name}" is `
        + `right, and what to call them if not. One emoji, nothing else this `
        + `turn — no feature tour, no second question.`
      : `They wrote once, about a minute ago, and nothing since, and there is `
        + `no name on file. If what they wrote already says what to call them, `
        + `call set_my_name instead of asking. Otherwise ask, in one short warm `
        + `line, what you should call them. One emoji, nothing else this turn.`;
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

  // A repeating reminder with NO END makes a task standing — doing it once
  // does not finish it, and completeTask refuses to close it for exactly that
  // reason. Sweeping it would be the same mistake made from the other side. A
  // CHASE is not that: it ends at the event's own date, and the event closing
  // when it passes is what closes the chase with it (migration 081).
  const { rows: expired } = await client.query(
    `SELECT t.id, t.owner_id, t.title
       FROM tasks t JOIN users u ON u.id = t.owner_id
      WHERE t.kind = 'event' AND t.status = 'open' AND t.archived_at IS NULL
        AND t.due_at IS NOT NULL AND COALESCE(t.ends_at, t.due_at) < $1
        AND u.status = 'active' AND u.is_eval = false
        AND NOT EXISTS (SELECT 1 FROM task_reminders r
                         WHERE r.task_id = t.id AND r.repeat_rule IS NOT NULL
                           AND r.repeat_until IS NULL
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
  sweepReminders, sweepDigests, sweepUnblocks, sweepStaleMeetings, sweepSettlingMeetings,
  sweepSilentPausedMembers,
  sweepMediaJobs, sweepNameConfirm, sweepFinishedTasks,
};
