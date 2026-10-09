'use strict';
// Stopping, without deleting.
//
// A user wrote "אני רוצה להפסיק את השירות", was asked "בטוח?", answered "זהו",
// and got a warm goodbye — followed by a proactive check-in the next morning
// and a medication reminder still armed for that evening. The agent had handled
// the conversation exactly right and then called nothing, because there was
// nothing to call: no tool, no dashboard control, and `checkin_enabled` was a
// column one query read and nothing on earth wrote.
//
// The design rule here is that pausing is REVERSIBLE and never destructive.
// Someone who is done with a product is not asking to be erased, and treating
// "stop messaging me" as "delete my account" would be a second thing done to
// them that they did not ask for. Their tasks, facts, preferences and history
// all stay exactly where they are. If they come back, everything is still
// theirs.
//
// What pause actually means: **Olma never initiates again.** Every proactive
// path — check-ins, reminders, digests, and another user's fan-out landing on
// them — is off. Replying when they write is not initiating, and stays on: a
// person who writes wants something, and answering them is not the thing they
// asked us to stop.
//
// ONE exception, and it is the owner's (2026-09-13): a paused person standing
// in a WhatsApp room where a coordination starts hears about it once per
// pause (`users.room_invite_sent_at`, migration 067) — and since 2026-09-27
// only a pause OLMA took because they went quiet (`quiet_ladder`). Somebody who
// paused her THEMSELVES hears nothing at all: Gal wrote "dont send me messages"
// because of one room's coordination and the room's next one reached him
// anyway (`incidents.md`, "The pause the room's invite walked through"). Being in the room is
// not something the pause can see, and silently counting them in — as the
// room did to Kapish — is worse than one message. Their first message after
// it, whenever it comes, ends the pause (resumeAfterRoomInvite); a day of
// silence takes them out of that coordination and every later one until then
// (group-meetings.sweepSilentPausedMembers).
const { ok, err } = require('./results');
const audit = require('./audit');
const reminders = require('./reminders');

// A repeating reminder cancelled by a pause has to come back at the right
// time, not the time it was frozen at. Walking the rule forward from its own
// last occurrence — rather than just adding the interval to `now` — is what
// keeps "18:00 every day" landing at 18:00 rather than at whatever hour the
// person happened to press resume.
// users.paused_reason for a pause the check-in ladder made (migration 049).
const QUIET_LADDER = 'quiet_ladder';

// …and for a pause taken the MOMENT somebody said stop, before they have
// confirmed anything (owner, 2026-09-22). Gal wrote "dont send me messages
// bye", was asked "בטוח?", never answered — and because the doctrine paused
// only on a yes, nothing on his record ever said he had asked. Four urgent
// coordination messages were dispatched to his agent over the next hour and
// three of them reached him.
//
// So the order is inverted: comply first, ask second. The pause does
// everything a confirmed one does — the gate is the chokepoint, the queue is
// cancelled, the reminders come down — and differs in exactly one way: their
// next message ends it (`stopResume`, from openRecord's `wake`), because the
// owner's rule is that somebody who writes again about anything else has
// come back. A confirmed stop (reason NULL) is ended only by them or by an
// admin, which is why the answer to "בטוח?" is a SECOND pause_olma call and
// not a no-op.
//
// The failure mode this trades into is one extra "stop" from somebody who
// says it twice; the one it trades away is a person who asked to be left
// alone being messaged anyway. Both are recoverable, only one is a betrayal.
const SAID_STOP = 'said_stop';

// …and for a stop nobody answered (owner, 2026-10-09). They said stop, were
// asked "בטוח?", and said nothing for a day. Silence is not a yes, so this is
// not the pause they would have confirmed. The owner's names, so the four
// states can be told apart in conversation:
//   השהייה שקטה  — QUIET_LADDER: Olma paused them because they stopped answering
//   עצירה ממתינה — SAID_STOP: said stop, the question still open (first day)
//   השהייה רכה   — STOP_UNANSWERED: said stop, never confirmed
//   השהייה מלאה  — reason NULL: confirmed
// A soft pause hears each coordination opened with them ONCE, as a quiet
// pause does (one invite, a day of silence takes them out, never a nudge),
// and on top of that the people errands (gate.PEER_KINDS). Nothing of Olma's
// own. The first message of their day carries one fixed line saying they can
// stop her completely (`SOFT_PAUSE_FOOTER`). Their next message ends it, as it
// ends a said_stop.
const STOP_UNANSWERED = 'stop_unanswered';

// How long the question waits before silence turns a said_stop into the
// softer pause. The owner's number.
const STOP_ANSWER_MS = 24 * 3600_000;

// Stops said before this rule existed keep the pause they were promised
// (owner, 2026-10-09: Gal, Matan and מעיין stay fully paused). Only a
// said_stop taken at or after this moment softens.
const SOFT_PAUSE_SINCE = new Date('2026-10-09T00:00:00Z');

// The line a soft-paused person reads once a day, word for word. No grammatical
// gender: "שרוצים" is impersonal, and "לי"/"אשלח" are hers.
const SOFT_PAUSE_FOOTER = {
  he: 'אפשר לכתוב לי בכל שלב שרוצים להפסיק, ואז לא אשלח יותר שום הודעה.',
  en: 'You can tell me at any point that you want to stop, and then I won\'t send you anything at all.',
};

function softPauseFooter(locale) {
  return String(locale || '').toLowerCase().startsWith('he') ? SOFT_PAUSE_FOOTER.he : SOFT_PAUSE_FOOTER.en;
}

// Is this the soft pause? Reads `paused_at` and `paused_reason`.
function softPaused(row) {
  return Boolean(row && row.paused_at) && row.paused_reason === STOP_UNANSWERED;
}

// How long a paused person's one coordination message keeps them in that
// coordination with no answer, and how long after answering a "leave me
// paused" still counts as the answer to it.
const ROOM_INVITE_ANSWER_MS = 24 * 3600_000;

// Has this pause already spent its one coordination message? Read off any row
// carrying both columns (users, or groups.listMembers).
function roomInviteSpent(row) {
  if (!row || !row.paused_at || !row.room_invite_sent_at) return false;
  return new Date(row.room_invite_sent_at).getTime() >= new Date(row.paused_at).getTime();
}

// The same allowance, for somebody who is NOT paused but has stopped answering
// — `checkin_misses >= 1`, the gate's other silence (owner, 2026-09-22). There
// is no `paused_at` to anchor "this run of silence" to, so the anchor is their
// last word: a stamp older than that was spent during a silence that has since
// ended, and writing or marking something on their page resets the counter
// anyway, so the allowance re-arms itself exactly when the silence does. Both
// columns, because the page is the DM's equal here as it is in the gate.
// Never spoken at all and a stamp on the row means spent — the allowance is
// one per silence, not one per coordination.
function quietRoomInviteSpent(row) {
  if (!row || !row.room_invite_sent_at) return false;
  const spent = new Date(row.room_invite_sent_at).getTime();
  const spoke = Math.max(
    row.last_inbound_at ? new Date(row.last_inbound_at).getTime() : 0,
    row.last_dashboard_at ? new Date(row.last_dashboard_at).getTime() : 0,
  );
  return spent >= spoke;
}

// A pause THEY asked for — confirmed (reason NULL) or said a moment ago
// (`said_stop`) — against the one the ladder took for them. The owner's line
// (2026-09-27): somebody who is merely less active still hears one invite from
// a room; somebody who paused her hears nothing from her, and a room does not
// count them, wait on them or tag them.
//
// A stop nobody confirmed for a day (`STOP_UNANSWERED`) is NOT one, since
// 2026-10-09: a room counts them, asks them and tags them like anybody else.
function pausedByRequest(row) {
  return Boolean(row && row.paused_at)
    && row.paused_reason !== QUIET_LADDER && row.paused_reason !== STOP_UNANSWERED;
}

// Is this member left out of a room's coordination — never invited, never
// swept in, never counted? Anybody who paused her themselves. A quiet pause
// is NOT, since 2026-10-07: the owner's rule is one message about EACH
// coordination opened with them ("חוץ מהודעה אחת על כל תיאום שנפתח איתם"),
// so somebody the ladder or the silence clock paused is swept into every new
// one, hears its invite once (outbox/worker.js), and a day of silence takes
// them out of THAT one (group-meetings.sweepSilentPausedMembers). Until then
// one invite per pause kept them out of every later coordination too. Needs
// `paused_at` and `paused_reason` on the row (users, or groups.listMembers).
function keptOutOfRooms(row) {
  return pausedByRequest(row);
}

const MAX_CATCHUP_STEPS = 800; // ~2 years of daily; a guard, never a limit in practice

function nextOccurrenceAfter(from, rule, notBefore, tz) {
  let cursor = new Date(from);
  for (let i = 0; i < MAX_CATCHUP_STEPS; i++) {
    const next = reminders.nextOccurrence(cursor, rule, tz);
    if (!next) return null; // one-off: nothing to re-arm
    if (next > notBefore) return next;
    cursor = next;
  }
  return null;
}

async function isPaused(client, userId) {
  const { rows } = await client.query(`SELECT paused_at FROM users WHERE id = $1`, [userId]);
  return Boolean(rows[0] && rows[0].paused_at);
}

// note: what they actually said, stored on the audit row only. It is their
// words about our product, so it belongs in the trail an operator reads — not
// on their card, where it would become something the agent brings up.
// paused_at comes from Postgres `now()`, never from a JS Date, and that is
// load-bearing rather than stylistic. resumeUser finds what to put back with
// `cancelled_at >= paused_at`, and cancelReminder stamps cancelled_at with
// now() — the TRANSACTION timestamp, fixed at BEGIN. A JS `new Date()` taken
// here is read after BEGIN, so under load it lands a few milliseconds LATER
// than the cancellations it is supposed to bracket, the filter matches
// nothing, and resume silently brings nothing back. It failed about one run in
// thirty, only ever with the whole suite running in parallel. One clock, one
// transaction timestamp, and the two are now exactly equal.
async function pauseUser(client, userId, { note = null, confirmed = true } = {}) {
  // paused_reason = NULL: this pause is THEIRS (or the admin's), so a ladder
  // pause already in place is taken over and stops ending on its own.
  // `confirmed: false` is the same pause under SAID_STOP — see the constant.
  // A confirmed call LANDS ON an unconfirmed one and clears the reason, which
  // is the whole point of asking: "בטוח?" → "כן" makes it permanent.
  const reason = confirmed ? null : SAID_STOP;
  //
  // Both room-invite stamps are carried forward when they answered their one
  // coordination message in the last 24 hours. Writing ended the pause
  // (resumeAfterRoomInvite) and "leave me paused" brings them here. Without
  // this the fresh paused_at is a fresh allowance, so the next coordination
  // reaches them again; and answered_at at the same moment is what keeps
  // their NEXT message from ending this pause too.
  //
  // …and an unconfirmed call never lands on a CONFIRMED one: somebody already
  // paused for good who says "stop" again is asked nothing and stays paused,
  // rather than being turned back into a stop their next message ends.
  const { rows } = await client.query(
    `UPDATE users SET paused_at = COALESCE(paused_at, now()),
            paused_reason = CASE WHEN paused_at IS NOT NULL AND paused_reason IS NULL THEN NULL ELSE $3 END,
            room_invite_sent_at = CASE WHEN room_invite_answered_at > now() - ($2::bigint * interval '1 millisecond')
              THEN now() ELSE room_invite_sent_at END,
            room_invite_answered_at = CASE WHEN room_invite_answered_at > now() - ($2::bigint * interval '1 millisecond')
              THEN now() ELSE room_invite_answered_at END
      WHERE id = $1
      RETURNING id, paused_at, paused_reason`, [userId, ROOM_INVITE_ANSWER_MS, reason]);
  if (!rows[0]) return err('not_found', 'no such user');
  const kept = rows[0].paused_reason;

  // Everything already armed against them. Cancelling rather than leaving them
  // to be filtered at send time is deliberate: a pause that shows five pending
  // reminders on the dashboard has not visibly stopped anything, and the rows
  // keep their repeat_rule, which is what resume reads to put them back.
  const pending = (await client.query(
    `SELECT r.id FROM task_reminders r JOIN tasks t ON t.id = r.task_id
      WHERE COALESCE(r.user_id, t.owner_id) = $1
        AND r.sent_at IS NULL AND r.cancelled_at IS NULL`, [userId])).rows;
  for (const r of pending) await reminders.cancelReminder(client, userId, r.id);

  // Queued messages are cancelled the way the dashboard cancels one: an UPDATE
  // carrying the idempotency key, never a DELETE, or the sweep that produced
  // the row simply produces it again on the next tick.
  const queued = (await client.query(
    `UPDATE outbox SET sent_at = now(), hold_reason = 'paused'
      WHERE user_id = $1 AND sent_at IS NULL RETURNING id`, [userId])).rows;

  await audit.record(client, userId, 'user.paused', {
    note: note ? String(note).slice(0, 500) : null,
    reason: kept,
    remindersCancelled: pending.map((r) => Number(r.id)),
    outboxCancelled: queued.map((r) => Number(r.id)),
    dataDeleted: false,
  });
  return ok({
    pausedAt: rows[0].paused_at,
    confirmed: kept === null,
    remindersCancelled: pending.length,
    outboxCancelled: queued.length,
  });
}

// What the person is asked before a pause lasts, drawn rather than composed
// (Eden, 2026-10-05). He said "stop" half as a joke, the model skipped the
// question and paused him for good, told him "one message brings it all
// back" — which is true only of an unconfirmed stop — and his coordination
// went on without him while he could not see why. A person who knows what a
// pause DOES either means it or says so; the model's own "בטוח?" told him
// nothing. Gender-neutral as written: לך and ענית are spelled the same for
// both.
//
// Reworded 2026-10-09 with the soft pause: a yes is now the only way to stop
// coordinations other people start, so the question says that is what it
// costs. "אליך" is spelled the same for both genders.
const CONFIRM_QUESTION = {
  he: 'רק לוודא — השהייה אומרת שאני מפסיקה לגמרי: בלי תזכורות, בלי הודעות ממני, '
    + 'ולא יגיעו אליך יותר תיאומי פגישות מאף אחד. שום דבר לא נמחק. להשהות?',
  en: 'Just to check — a pause means I stop completely: no reminders, no messages from me, '
    + 'and no more meeting coordinations from anyone. Nothing is deleted. Pause?',
};

// How long the question stays open. The answer is their next message, and
// stopResume has already ended the unconfirmed pause by the time the model
// hears it — so the record of having ASKED is the audit row, not the column.
const CONFIRM_WINDOW_MS = 2 * 3600_000;

// Was the stop heard, and has the person written since? Only then is a
// confirmed=true their answer to the question rather than the model skipping
// it. A said_stop and a confirm in the SAME turn has no message between them
// and is refused, which is the point. The other way in is the paused room
// invite: a person answering their one coordination message with "leave me
// paused" has already said yes (channels/openclaw.js, PAUSED_ROOM_INVITE).
async function stopAskedAndAnswered(client, userId) {
  const { rows } = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM users WHERE id = $1
          AND room_invite_answered_at > now() - ($4::bigint * interval '1 millisecond'))
     OR EXISTS (
       SELECT 1 FROM audit_log s
        WHERE s.actor_id = $1 AND s.event = 'user.paused' AND s.detail->>'reason' = $2
          AND s.created_at > now() - ($3::bigint * interval '1 millisecond')
          AND EXISTS (SELECT 1 FROM audit_log m
                       WHERE m.actor_id = $1 AND m.event = 'message.received'
                         AND m.created_at > s.created_at)) AS answered`,
    [userId, SAID_STOP, CONFIRM_WINDOW_MS, ROOM_INVITE_ANSWER_MS]);
  return rows[0].answered;
}

// pause_olma's door. A lasting pause needs the question to have been asked
// and answered; otherwise this is the unconfirmed stop, and the result hands
// the model the question to ask, in their language.
async function requestPause(client, user, { note = null, confirmed = false } = {}) {
  const asked = confirmed === true && await stopAskedAndAnswered(client, user.id);
  const res = await pauseUser(client, user.id, { note, confirmed: asked });
  if (!res.ok || res.data.confirmed) return res;
  const he = String(user.locale || '').toLowerCase().startsWith('he');
  return ok({
    ...res.data,
    ...(confirmed === true ? { notConfirmed: 'they have not been asked yet' } : {}),
    askThem: he ? CONFIRM_QUESTION.he : CONFIRM_QUESTION.en,
    nextStep: 'Paused until their next message. Ask askThem verbatim'
      + (he ? '' : ' (in their language)')
      + ' as the only question in your reply. On their yes, call pause_olma with confirmed=true.',
  });
}

// The coordinations the pause took them out of (`group-meetings.
// sweepSilentPausedMembers`) are part of what it took down, and come back
// with it, answers included (`meetings.restorePauseExits`). Required here,
// not at the top: meetings sits above this module in the domain graph.
async function restoreMeetings(client, userId) {
  return require('./meetings').restorePauseExits(client, userId);
}

// Puts back what the pause took down, and nothing else. Reminders return at
// their own next real occurrence; a one-off whose moment passed while they were
// away is NOT resurrected, because firing it now would be a notification about
// a time that is already gone.
async function resumeUser(client, userId, { now = new Date(), reason = null } = {}) {
  const { rows } = await client.query(
    `SELECT id, paused_at FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) return err('not_found', 'no such user');
  if (!rows[0].paused_at) return err('invalid', 'they are not paused', { reason: 'not_paused' });
  const pausedAt = rows[0].paused_at;

  // Only what THIS pause took down, and only one row per task — a task whose
  // reminder was cancelled and re-cancelled across two pauses must not come
  // back twice.
  const frozen = (await client.query(
    `SELECT DISTINCT ON (r.task_id) r.task_id, r.remind_at, r.repeat_rule, r.repeat_until,
            r.repeat_seq, r.nudge, r.rungs, r.nudge_capped, u.timezone
       FROM task_reminders r JOIN tasks t ON t.id = r.task_id
       JOIN users u ON u.id = $1
      WHERE COALESCE(r.user_id, t.owner_id) = $1 AND r.cancelled_at >= $2
        AND r.repeat_rule IS NOT NULL
        AND t.status = 'open' AND t.archived_at IS NULL
      ORDER BY r.task_id, r.cancelled_at DESC`, [userId, pausedAt])).rows;

  const rearmed = [];
  for (const f of frozen) {
    // A chase the pause caught before its first message ever went out has
    // nothing worth preserving about its moment: that moment was "the evening
    // of the day they asked", and that day is over. Starting it again is the
    // one path that re-derives the hour, the first moment and the end together
    // — and it declines outright if the deadline went by while they were away.
    if (Number(f.repeat_seq) === 0 && f.repeat_until) {
      // Its end passed while they were away: the day it was about is gone, and
      // startChase would read the past deadline as none and start a new nudge.
      if (new Date(f.repeat_until).getTime() <= new Date(now).getTime()) continue;
      const again = await reminders.startChase(client, userId, f.task_id,
        { now, until: f.nudge_capped ? null : f.repeat_until });
      if (again && again.ok) {
        rearmed.push({ taskId: Number(f.task_id), remindAt: new Date(again.data.reminder.remind_at).toISOString() });
      }
      continue;
    }
    const next = nextOccurrenceAfter(f.remind_at, f.repeat_rule, now, f.timezone);
    if (!next) continue;
    // A chase comes back as the chase it was, end included. Re-arming it
    // without `until` would leave a daily nag with nothing to stop it, which is
    // the one shape the end date exists to prevent; and a chase whose deadline
    // passed during the pause is not resurrected at all, for the same reason
    // the one-off above is not — the day it was about is gone.
    const until = f.repeat_until ? new Date(f.repeat_until) : null;
    if (until && next.getTime() > until.getTime()) continue;
    const res = await reminders.setReminder(client, userId, f.task_id, next, f.repeat_rule,
      { until, seq: Number(f.repeat_seq) || 1, nudge: f.nudge === true && Boolean(until),
        rungs: f.rungs === null || f.rungs === undefined ? null : Number(f.rungs), capped: f.nudge_capped === true });
    if (res.ok) rearmed.push({ taskId: Number(f.task_id), remindAt: next.toISOString() });
  }

  await client.query(`UPDATE users SET paused_at = NULL, paused_reason = NULL WHERE id = $1`, [userId]);
  const meetingsBack = await restoreMeetings(client, userId);
  await audit.record(client, userId, 'user.resumed', {
    pausedAt, remindersRearmed: rearmed.map((r) => r.taskId),
    ...(meetingsBack.length ? { meetingsRestored: meetingsBack.map((m) => m.meetingId) } : {}),
    ...(reason ? { reason } : {}),
  });
  return ok({ rearmed, meetingsRestored: meetingsBack });
}

// The pause the check-in ladder makes after three unanswered check-ins. It
// is NOT pauseUser: nothing on their record is cancelled — not a reminder,
// not a queued row — because the owner's rule for somebody who has stopped
// answering is "stop it arriving, cancel nothing". paused_at alone does the
// stopping: the gate drops every row for a paused person, dueForSending and
// the sweeps skip them, and the dashboard says so. A pause already in place
// (theirs) is left exactly as it is, reason included.
//
// Two callers take it: the ladder's third miss (jobs/checkin.js) and the
// silence clock (domain/silence-pause.js, 2026-10-07), which says which one it
// was in `note` so the trail can tell them apart. Same reason column for both,
// on purpose — everything that ends, counts or invites a quiet pause reads
// `quiet_ladder`, and a second reason would be a second set of readers.
async function quietPause(client, userId, { note = QUIET_LADDER, detail = null } = {}) {
  const { rows } = await client.query(
    `UPDATE users SET paused_at = now(), paused_reason = $2
      WHERE id = $1 AND paused_at IS NULL RETURNING paused_at`, [userId, QUIET_LADDER]);
  if (!rows[0]) return ok({ paused: false });
  await audit.record(client, userId, 'user.paused', {
    note, reason: QUIET_LADDER, ...(detail || {}),
    remindersCancelled: [], outboxCancelled: [], dataDeleted: false,
  });
  return ok({ paused: true, pausedAt: rows[0].paused_at });
}

// Ends a ladder pause, and ONLY a ladder pause, on evidence that the person
// wrote. A pause they asked for is ended by them or by the admin, never here.
// Nothing to re-arm: quietPause took nothing down.
async function quietResume(client, userId) {
  const { rows } = await client.query(
    `UPDATE users SET paused_at = NULL, paused_reason = NULL
      WHERE id = $1 AND paused_reason = $2 RETURNING id`, [userId, QUIET_LADDER]);
  if (!rows[0]) return ok({ resumed: false });
  await restoreMeetings(client, userId);
  await audit.record(client, userId, 'user.resumed', { reason: QUIET_LADDER, remindersRearmed: [] });
  return ok({ resumed: true });
}

// Their next message ends an UNCONFIRMED stop. Unlike quietResume this goes
// through resumeUser rather than clearing the columns: an unconfirmed pause
// takes the queue and the reminders down like any other, so coming back has
// to put them up again, each at its own next real occurrence.
//
// It runs ahead of the model, from openRecord's `wake`, and that is the
// point — the owner's rule is that Olma comes back on when they write, not
// when a model decides she may. If the message turns out to be another stop,
// the model pauses again in the same turn; the queue it would re-arm was
// cancelled at the first pause and a sweep has one turn to produce a new row.
//
// The soft pause a said_stop turns into ends the same way, and through the
// same door: it was never confirmed either.
async function stopResume(client, userId, { now = new Date() } = {}) {
  const { rows } = await client.query(
    `SELECT paused_reason FROM users WHERE id = $1 AND paused_reason IN ($2, $3)`,
    [userId, SAID_STOP, STOP_UNANSWERED]);
  if (!rows[0]) return ok({ resumed: false });
  return resumeUser(client, userId, { now, reason: rows[0].paused_reason });
}

// A said_stop nobody answered for STOP_ANSWER_MS becomes the soft pause. The
// minute sweep runs it (jobs/registry.js). Nothing is re-armed: the
// reminders stay down, because the reminders are Olma's own voice and the
// soft pause keeps her quiet. `paused_at` is left alone, so a later resume
// still finds everything this pause took down.
async function softenUnansweredStops(client, now = new Date()) {
  const { rows } = await client.query(
    `UPDATE users SET paused_reason = $1
      WHERE paused_reason = $2 AND paused_at IS NOT NULL
        AND paused_at <= $3::timestamptz - ($4::bigint * interval '1 millisecond')
        AND paused_at >= $5::timestamptz
      RETURNING id, paused_at`,
    [STOP_UNANSWERED, SAID_STOP, now, STOP_ANSWER_MS, SOFT_PAUSE_SINCE]);
  for (const r of rows) {
    await audit.record(client, Number(r.id), 'user.pause_softened', {
      from: SAID_STOP, to: STOP_UNANSWERED, pausedAt: r.paused_at,
    });
  }
  return rows.map((r) => Number(r.id));
}

// They wrote, for the first time since the one coordination message their
// pause allows — whenever that is (owner, 2026-09-14: "until he writes
// again"). The owner's rule is that anything they say then — other than asking
// to stay paused — means they are interested, so the pause ends in full,
// whichever kind it was: a ladder pause the way quietResume ends one, their
// own the way resume_olma does (their repeating reminders come back). "Leave
// me paused" is the model's to hear, and pause_olma puts it back with the
// allowance still spent (pauseUser above).
//
// Called from openRecord({ wake: true }) only: a turn that merely happened on
// their agent is not them answering.
async function resumeAfterRoomInvite(client, userId, { now = new Date() } = {}) {
  const { rows } = await client.query(
    `SELECT paused_at, paused_reason, room_invite_sent_at, room_invite_answered_at FROM users WHERE id = $1`,
    [userId]);
  const u = rows[0];
  if (!u || !roomInviteSpent(u)) return ok({ resumed: false });
  // Already answered: this pause is the one they asked to keep after it.
  if (u.room_invite_answered_at
      && new Date(u.room_invite_answered_at).getTime() >= new Date(u.room_invite_sent_at).getTime()) {
    return ok({ resumed: false });
  }
  await client.query(`UPDATE users SET room_invite_answered_at = now() WHERE id = $1`, [userId]);
  if (u.paused_reason === QUIET_LADDER) {
    await client.query(`UPDATE users SET paused_at = NULL, paused_reason = NULL WHERE id = $1`, [userId]);
    await restoreMeetings(client, userId);
    await audit.record(client, userId, 'user.resumed', {
      reason: 'room_invite_answered', remindersRearmed: [],
    });
    return ok({ resumed: true });
  }
  const res = await resumeUser(client, userId, { now, reason: 'room_invite_answered' });
  return res.ok ? ok({ resumed: true, rearmed: res.data.rearmed }) : res;
}

// Everything their own writing ends, in the order openRecord has always run
// it. One function because there are now two doors a person writes through —
// their own chat (turn.openRecord) and a tag in a room (brokerd
// group_room_write) — and a pause that one door ends and the other does not
// is the drift this repo keeps paying for.
async function resumeOnWrite(client, userId) {
  await resumeAfterRoomInvite(client, userId);
  await quietResume(client, userId);
  await stopResume(client, userId);
}

// Would a message from them end their pause? The predicate behind the group
// sender gate: somebody whose next word would bring them back may be heard in
// a room, because hearing them IS them coming back; somebody whose pause only
// they or the admin can end stays unheard there, as in their own chat. Reads
// `paused_at`, `paused_reason` and the two room-invite stamps.
function endsOnWrite(row) {
  if (!row) return false;
  if (!row.paused_at) return true;
  if (row.paused_reason === QUIET_LADDER || row.paused_reason === SAID_STOP
    || row.paused_reason === STOP_UNANSWERED) return true;
  if (!roomInviteSpent(row)) return false;
  return !(row.room_invite_answered_at
    && new Date(row.room_invite_answered_at).getTime() >= new Date(row.room_invite_sent_at).getTime());
}

module.exports = {
  pauseUser, requestPause, resumeUser, quietPause, quietResume, stopResume, resumeAfterRoomInvite,
  resumeOnWrite, endsOnWrite, softenUnansweredStops, softPaused, softPauseFooter,
  roomInviteSpent, quietRoomInviteSpent, pausedByRequest, keptOutOfRooms,
  isPaused, nextOccurrenceAfter, QUIET_LADDER, SAID_STOP, STOP_UNANSWERED, ROOM_INVITE_ANSWER_MS,
  CONFIRM_QUESTION, CONFIRM_WINDOW_MS, STOP_ANSWER_MS, SOFT_PAUSE_SINCE, SOFT_PAUSE_FOOTER,
};
