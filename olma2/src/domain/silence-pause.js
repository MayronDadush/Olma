'use strict';
// Somebody who has gone quiet for days is paused, on a clock (owner,
// 2026-10-07: "משתמשים שלא כותבים לה כלום כמה ימים הם כנראה פחות בעניין").
//
// Saar wrote last on 2026-10-05 and was on `daily_once_phones`. Every evening
// at 20:00 he got one message that carried nothing new, and nothing would ever
// have stopped it: the once-a-day rule DROPS a check-in (gate.js, "once a
// day"), so not one rung of the ladder ever reached him, `checkin_misses`
// stayed 0, and the ladder's own pause — three misses — could not come. The
// ladder measures silence in questions that reached somebody; anything that
// keeps the questions from going out keeps the silence from being measured.
//
// So this measures it in TIME, and from the person's side only. The last sign
// of life is the newest of: their onboarding, a message to her
// (`last_inbound_at`), a write from their own page (`last_dashboard_at`), a
// word to her in a room (`chat_group_members.last_wrote_at`), an answer in a
// coordination (`meeting_option_answers.answered_at`), and a resume — a pause
// that ended starts the clock again, or an admin's resume would be undone on
// the next tick. Nothing Olma sent counts.
//
// How long depends on what they hold (owner's choice, 2026-10-07): somebody
// with no open task has nothing of theirs waiting and is paused after
// `silence_pause_days_empty` days (2); somebody with one is given
// `silence_pause_days_holding` (5). 0 turns that half off.
//
// Somebody with a reminder they ASKED for in words that has not reached them
// yet is never paused here: a pause stops every reminder (sweepReminders skips
// a paused person), and a reminder they set is a moment they chose, not Olma's
// idea. The check-in ladder still handles them the way it always did.
//
// The pause itself is the ladder's (`pause.quietPause`, `paused_reason =
// 'quiet_ladder'`), so everything already built for it holds: nothing on their
// record is cancelled, their first message ends it (`pause.resumeOnWrite`),
// and the gate lets through exactly one message per coordination somebody
// opens with them (outbox/worker.js, `pausedRoomInvite`).
const flags = require('./flags');
const pause = require('./pause');

const DAY_MS = 86_400_000;

function daysFlag(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Who is due, with the facts that made them due. Pure read — `sweep` acts.
async function due(client, now = new Date()) {
  const emptyDays = daysFlag(await flags.getFlag(client, 'silence_pause_days_empty'), 2);
  const holdingDays = daysFlag(await flags.getFlag(client, 'silence_pause_days_holding'), 5);
  if (!emptyDays && !holdingDays) return [];
  const { rows } = await client.query(
    `SELECT u.id,
            GREATEST(u.onboarded_at, u.last_inbound_at, u.last_dashboard_at,
              (SELECT max(m.last_wrote_at) FROM chat_group_members m WHERE m.user_id = u.id),
              (SELECT max(a.answered_at) FROM meeting_option_answers a WHERE a.user_id = u.id),
              (SELECT max(l.created_at) FROM audit_log l
                WHERE l.actor_id = u.id AND l.event = 'user.resumed')) AS last_life,
            EXISTS (SELECT 1 FROM tasks t
                     WHERE t.owner_id = u.id AND t.status = 'open' AND t.archived_at IS NULL) AS holds,
            EXISTS (SELECT 1 FROM task_reminders r JOIN tasks t ON t.id = r.task_id
                     WHERE COALESCE(r.user_id, t.owner_id) = u.id
                       AND r.sent_at IS NULL AND r.cancelled_at IS NULL AND r.auto = false
                       AND r.attempts = 0) AS asked_reminder
       FROM users u
      WHERE u.status = 'active' AND u.onboarded_at IS NOT NULL
        AND u.paused_at IS NULL AND NOT u.is_eval`);
  const out = [];
  for (const r of rows) {
    if (r.asked_reminder) continue;
    const days = r.holds ? holdingDays : emptyDays;
    if (!days || !r.last_life) continue;
    const silentMs = now.getTime() - new Date(r.last_life).getTime();
    if (silentMs < days * DAY_MS) continue;
    out.push({ userId: Number(r.id), holds: r.holds, days, silentDays: Math.floor(silentMs / DAY_MS) });
  }
  return out;
}

async function sweep(client, now = new Date()) {
  const out = [];
  for (const d of await due(client, now)) {
    const res = await pause.quietPause(client, d.userId, {
      note: 'silence_days', detail: { holds: d.holds, days: d.days, silentDays: d.silentDays },
    });
    if (res.ok && res.data.paused) out.push(d);
  }
  return out;
}

module.exports = { due, sweep, DAY_MS };
