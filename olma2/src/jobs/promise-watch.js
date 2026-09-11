'use strict';
// Every day, for everybody: did the moment they asked for get armed?
//
// `jobs/onboarding-review.js` reads a NEW person's first hours and holds what
// Olma said against what was written down. It found Yahav's 19:00 promise
// against an 18:00 reminder three hours into his first evening, which is
// exactly what it was built to do. Then Miron hit the same fault the next
// morning — "תזכיר לי עוד שעתיים" at 11:29, 12:29 armed — and nothing saw it
// for six hours, because he has been a user for weeks and the review only ever
// looks at the first day of a life.
//
// That is the recurring shape in CLAUDE.md wearing a new coat: the detector
// was real, precise and unread, because its window excluded almost everyone it
// was meant to protect. So the same question is asked here of every active
// person, once a day, over the last day of conversation.
//
// It files an ISSUE, not an alert. `BREAKS_USERS` means their tool calls are
// failing right now; a reminder armed for the wrong hour is a dashboard row
// with a name and a face behind it, which is what the issue list already is.
// The title is deterministic and carries the message's own timestamp, so a
// re-read of the same day cannot file the same fault twice.
const issues = require('../domain/issues');
const sessions = require('../channels/sessions-async');
const { checkPromises } = require('../domain/reminder-promise');
const { statedHourMismatch } = require('../domain/stated-hour');

// A day, plus two hours of overlap so nothing can fall between two ticks. The
// dedup key is the message timestamp, so re-reading the overlap is free.
const WINDOW_MS = 26 * 3600_000;
// How far back to read the transcript. A day of a talkative user is well under
// this; the cap is for a runaway, not for the normal case.
const TRANSCRIPT_LIMIT = 120;
// The transcript read is the expensive part (a worker thread per user, over
// the gateway's sqlite). Daily cadence, so a whole roster clears in one tick;
// the cap is a guard against a roster that grows while nobody is looking.
const MAX_USERS_PER_TICK = 40;

// The second half's title. Same contract as titleFor: deterministic, and a
// different fault for the same person produces a different string. Carries the
// task id, so correcting the due_at and getting it wrong AGAIN files a new row
// rather than colliding with the closed one.
function titleForStatedHour(u, m) {
  return `השעה בכותרת לא השעה שנשמרה — ${u.first_name || u.phone} · משימה ${m.taskId} · בכותרת ${m.stated} · נשמר ${m.stored}`;
}

function titleFor(u, f) {
  // Deterministic: the same fault re-read tomorrow produces this same string,
  // and a DIFFERENT fault for the same person produces a different one.
  // CLAUDE.md, "Writing detectors and alarms".
  return `נאמרה שעה שלא נקבעה לה תזכורת — ${u.first_name || u.phone} · ביקש ${f.asked.join(', ')} · נקבע ${f.armed.map((a) => a.at).join(', ')} · ${f.at}`;
}

async function sweepPromiseWatch(client, deps = {}) {
  const now = deps.now || Date.now();
  const since = new Date(now - WINDOW_MS);

  const { rows: users } = await client.query(
    `SELECT id, first_name, phone, agent_id, timezone
       FROM users
      WHERE agent_id IS NOT NULL AND NOT is_eval AND status = 'active'
      ORDER BY id LIMIT $1`,
    [MAX_USERS_PER_TICK]
  );

  const readMessages = deps.readMessages
    || ((agentId, peer) => sessions.readRecentMessages(agentId, TRANSCRIPT_LIMIT, undefined, peer));

  const out = { checked: 0, unreadable: 0, found: [], filed: 0, statedHour: 0 };
  for (const u of users) {
    // Their reminders from the window, with when each was CREATED — that is
    // what ties a reminder to the message it answers.
    const { rows: reminders } = await client.query(
      `SELECT r.id, r.remind_at, r.created_at, r.cancelled_at
         FROM task_reminders r JOIN tasks t ON t.id = r.task_id
        WHERE t.owner_id = $1 AND r.created_at >= $2
        ORDER BY r.created_at`,
      [u.id, since]
    );
    // Nothing was armed all day, so no message in it can be compared against
    // one. Skipping here saves the transcript read, which is the whole cost.
    if (!reminders.length) continue;

    let msgs;
    try {
      msgs = (await readMessages(u.agent_id, u.phone)) || [];
    } catch {
      // Could not READ is never a thing in trouble (CLAUDE.md). Counted, so
      // that a reader who has gone permanently unreadable is visible in the
      // heartbeat rather than looking like a clean day.
      out.unreadable++;
      continue;
    }
    out.checked++;

    const inbound = msgs
      .filter((m) => m.role === 'user' && m.at && Date.parse(m.at) >= now - WINDOW_MS)
      .filter((m) => !/^DELIVERY:/.test(String(m.text || '')))
      .map((m) => ({ at: m.at, text: m.text }));

    const found = checkPromises({
      user: { id: u.id, timezone: u.timezone },
      inbound,
      reminders: reminders.map((r) => ({
        id: Number(r.id),
        remindAt: new Date(r.remind_at).toISOString(),
        createdAt: new Date(r.created_at).toISOString(),
        cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).toISOString() : null,
      })),
    });

    for (const f of found) {
      const title = titleFor(u, f);
      out.found.push({ userId: u.id, asked: f.asked, armed: f.armed.map((a) => a.at) });
      const { rows: seen } = await client.query(
        `SELECT id FROM issues WHERE title = $1 LIMIT 1`, [title]
      );
      if (seen.length) continue;             // already filed, open or closed
      const res = await issues.reportIssue(client, u.id, {
        category: 'bug',
        source: 'agent_detected',
        title,
        detail: JSON.stringify({ asked: f.asked, armed: f.armed, at: f.at, said: f.text }),
        relatedEntityType: 'task_reminder',
        relatedEntityId: f.armed[0] && f.armed[0].id,
      });
      if (res.ok && res.data.issue) out.filed++;
    }
  }
  await sweepStatedHours(client, now, out);
  return out;
}

// The other half of the same question — is the moment we stored the moment
// they meant — asked of the TASK rather than of the reminder.
//
// It is a separate pass and not a branch inside the loop above, because it
// needs no transcript. The reminder half pays a worker thread per user against
// the gateway's sqlite, which is why it is capped at MAX_USERS_PER_TICK and
// skips anyone with nothing armed; this one is a single indexed query over the
// whole roster and can afford to look at everybody, every day.
//
// Only rows that can still reach somebody: open, unarchived, and still ahead.
// A wrong hour on a task that is done, archived or past has already done
// whatever harm it was going to do, and an issue list that fills with those is
// one nobody reads. Both of the real faults this was built from are in that
// state today, which is why a live box files nothing here and the founding
// cases live in the test instead.
async function sweepStatedHours(client, now, out) {
  const { rows } = await client.query(
    `SELECT t.id, t.title, u.id AS user_id, u.first_name, u.phone,
            to_char(t.due_at AT TIME ZONE u.timezone, 'HH24:MI') AS due_local
       FROM tasks t JOIN users u ON u.id = t.owner_id
      WHERE t.due_at IS NOT NULL AND t.due_at > $1
        AND t.status = 'open' AND t.archived_at IS NULL
        AND u.status = 'active' AND NOT u.is_eval
      ORDER BY t.id`,
    [new Date(now)]
  );

  for (const r of rows) {
    const m = statedHourMismatch({ title: r.title, dueLocal: r.due_local });
    if (!m) continue;
    const found = { taskId: Number(r.id), userId: Number(r.user_id), ...m };
    out.found.push({ ...found, kind: 'stated_hour' });
    out.statedHour++;
    const title = titleForStatedHour(r, found);
    const { rows: seen } = await client.query(
      `SELECT id FROM issues WHERE title = $1 LIMIT 1`, [title]
    );
    if (seen.length) continue;
    const res = await issues.reportIssue(client, r.user_id, {
      category: 'bug',
      source: 'agent_detected',
      title,
      detail: JSON.stringify({ taskId: found.taskId, statedInTitle: m.stated, storedAs: m.stored, said: r.title }),
      relatedEntityType: 'task',
      relatedEntityId: found.taskId,
    });
    if (res.ok && res.data.issue) out.filed++;
  }
}

module.exports = {
  sweepPromiseWatch, sweepStatedHours, titleFor, titleForStatedHour,
  WINDOW_MS, TRANSCRIPT_LIMIT, MAX_USERS_PER_TICK,
};
