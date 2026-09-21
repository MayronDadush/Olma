'use strict';
// The hand triage, made a feature (owner, 2026-09-19). His own list was
// sorted with him on the live page — 38 open tasks down to 20 — and what made
// that work was that every row arrived as ONE concrete proposal carrying its
// reason, not as a report to read. So this module answers exactly one
// question, "is there something honest to propose to this person right now",
// and its most important answer is **nothing**.
//
// Three rules it is built on, and the third is the whole feature:
//
//   * A suggestion NEVER sets a date and never sets a reminder (owner's
//     decision the same day). The only thing it proposes is taking something
//     off the list, which is reversible — `restore_task` brings it back — and
//     which is what the triage actually consisted of.
//   * One ACTION for every kind. Whatever the reason, accepting archives what
//     the suggestion named and skipping leaves it alone, so there is one thing
//     to learn and no kind where the buttons mean something else. Since
//     2026-09-22 the WORD on the button is per kind ("להוריד", "להוריד את
//     זו") — which is the same action said in that kind's own terms, and is
//     the only thing a label may ever do here. A verb naming something the
//     code does not do ("מזג", over an archive that copies nothing across) is
//     a promise, and this module does not make those.
//   * Nothing to say means NO row, and the page renders nothing at all. This
//     is `rules/detectors.md` applied to a person instead of an operator: a
//     hint that fires on ordinary input is worse than no hint, and here the
//     cost is paid by somebody who came to look at their own tasks.
//
// What the detectors are was decided by MEASURING them against the live box
// (2026-09-19; 47 open top-level tasks, 12 people) rather than by argument —
// and one of the four the owner picked was rejected on those numbers. See
// REJECTED at the bottom.
const { ok, err } = require('./results');
const audit = require('./audit');
const tasksDomain = require('./tasks');
const similarity = require('./task-similarity');

// How long a person goes between passes. The owner asked for once a week
// ("פעם בשבוע כרגע"), and the job ticks far more often than that — the gap is
// per PERSON, checked off `users.suggested_at`, so the cadence is a property
// of what they experience rather than of how often the sweep happens to run.
const EVERY_MS = 7 * 24 * 60 * 60 * 1000;

// Three ready, one shown. His words: "שיהיה לו 3 הצעות, אבל כל פעם תהיה
// מוצגת רק אחת". More than three is a backlog nobody asked for, and a backlog
// is how this stops being a suggestion and starts being a queue.
const MAX_LIVE = 3;

// A task nobody has touched for this long, carrying no date and no reminder,
// is not waiting for anything — it is just sitting there. Measured on the box
// with every exemption below applied, 2026-09-19: 14 days catches 6 tasks
// across 2 people, 21 days catches 5 across 1, and 30 days catches 3 across 1.
// Fourteen is the only one of the three that still has something to say to
// more than one person.
const STUCK_DAYS = 14;

// A date that has passed and a task still open. One day is too eager — a
// person who has not opened the page yet is not behind on anything — and
// thirty finds nobody (measured the same day, same exemptions: 11 tasks past 1
// day, 9 past 7, 0 past 30). A week is where "this did not happen" stops being
// a guess.
const OVERDUE_DAYS = 7;

const KINDS = ['stuck', 'overdue', 'duplicate'];

const keyFor = (kind, ids) => `${kind}:${ids.map(Number).sort((a, b) => a - b).join(',')}`;

// A row with open items under it is a LIST, and a list is not a stalled task —
// it is the place somebody keeps things. Archiving one takes its items with it,
// so proposing that is proposing something much larger than the row reads as.
//
// This was found by running the detectors against the live box BEFORE they
// shipped: on Miron's own list the stuck query returned seven rows, and two of
// them were "רעיונות לשיפור אולמה" with 11 open items under it and "קניות
// לבית" with 2. Both are old, dateless and unreminded, because that is what a
// list looks like. Five is the honest answer (`incidents.md`, "The triage he
// did by hand").
const NOT_A_LIST = `NOT EXISTS (SELECT 1 FROM tasks c
   WHERE c.parent_id = t.id AND c.status = 'open' AND c.archived_at IS NULL)`;

// ---- the detectors ----------------------------------------------------------
//
// Each returns candidates, newest problem first, and each is a plain query
// over rows this person owns. None of them writes anything.

async function stuckTasks(client, userId, now) {
  const { rows } = await client.query(
    `SELECT t.id, t.title,
            floor(extract(epoch FROM ($2::timestamptz - t.created_at)) / 86400)::int AS days
       FROM tasks t
      WHERE t.owner_id = $1 AND t.status = 'open' AND t.archived_at IS NULL
        AND t.parent_id IS NULL AND t.due_at IS NULL
        AND t.kind IS DISTINCT FROM 'event'
        AND t.created_at < $2::timestamptz - ($3 || ' days')::interval
        -- a reminder IS the thing that would have moved it along, so a task
        -- carrying one is being chased already and is nobody's to tidy
        AND NOT EXISTS (SELECT 1 FROM task_reminders r
                         WHERE r.task_id = t.id AND r.sent_at IS NULL AND r.cancelled_at IS NULL)
        -- never a task somebody else is also on: archiving it is a decision
        -- about their list too, and this feature does not get to make one
        AND NOT EXISTS (SELECT 1 FROM shares s
                         WHERE s.task_id = t.id AND s.status = 'active')
        AND ${NOT_A_LIST}
      ORDER BY t.created_at`,
    [userId, now, STUCK_DAYS]
  );
  return rows.map((r) => ({
    kind: 'stuck', taskIds: [Number(r.id)], detail: { title: r.title, days: r.days },
  }));
}

async function overdueTasks(client, userId, now) {
  const { rows } = await client.query(
    `SELECT t.id, t.title,
            floor(extract(epoch FROM ($2::timestamptz - t.due_at)) / 86400)::int AS days
       FROM tasks t
      WHERE t.owner_id = $1 AND t.status = 'open' AND t.archived_at IS NULL
        AND t.parent_id IS NULL AND t.due_at IS NOT NULL
        AND t.kind IS DISTINCT FROM 'event'
        AND t.due_at < $2::timestamptz - ($3 || ' days')::interval
        -- a repeating reminder means the date is a rhythm, not a deadline
        AND NOT EXISTS (SELECT 1 FROM task_reminders r
                         WHERE r.task_id = t.id AND r.repeat_rule IS NOT NULL
                           AND r.cancelled_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM shares s
                         WHERE s.task_id = t.id AND s.status = 'active')
        AND ${NOT_A_LIST}
      ORDER BY t.due_at`,
    [userId, now, OVERDUE_DAYS]
  );
  return rows.map((r) => ({
    kind: 'overdue', taskIds: [Number(r.id)], detail: { title: r.title, days: r.days },
  }));
}

// Two open tasks that say the same thing in different words. The comparison is
// `task-similarity.compare`, the one this repo already calibrated against 86
// hand-labelled pairs — not a second opinion written here, which would drift
// from it the first time either changed.
//
// Exact-title duplicates are NOT what this finds, because `tasks.addTask`
// already refuses those at the write: measured on the box, zero pairs of open
// tasks share a normalised title. What is left is the reworded kind, and there
// was exactly one of those live (a packing list saved twice, once as itself
// and once as the sentence asking to be reminded about it). One hit for one
// person is the right size for this — a detector that fires rarely and is
// right is the only kind worth putting in front of somebody.
async function duplicateTasks(client, userId) {
  const { rows } = await client.query(
    `SELECT t.id, t.title, t.created_at FROM tasks t
      WHERE t.owner_id = $1 AND t.status = 'open' AND t.archived_at IS NULL AND t.parent_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM shares s WHERE s.task_id = t.id AND s.status = 'active')
        AND ${NOT_A_LIST}
      ORDER BY t.id`,
    [userId]
  );
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const c = similarity.compare(rows[i].title, rows[j].title);
      if (!c || c.same !== true) continue;      // 'disagree' and 'different' are a no
      // The older row is the one that stays: it is the one they have been
      // looking at, and the newer is the accident.
      out.push({
        kind: 'duplicate',
        taskIds: [Number(rows[j].id)],
        detail: { title: rows[j].title, keepTitle: rows[i].title, keepId: Number(rows[i].id) },
      });
    }
  }
  return out;
}

// One from each kind before a second from any — a person with four stale tasks
// should not meet four suggestions about stale tasks. Ordered so the most
// concrete comes first: a duplicate is a fact, an overdue date is a fact, and
// "nothing has happened here" is a judgement.
const ORDER = ['duplicate', 'overdue', 'stuck'];

function interleave(groups) {
  const out = [];
  for (let round = 0; out.length < MAX_LIVE; round++) {
    let added = false;
    for (const kind of ORDER) {
      const list = groups[kind] || [];
      if (list[round]) { out.push(list[round]); added = true; }
      if (out.length >= MAX_LIVE) break;
    }
    if (!added) break;
  }
  return out;
}

// ---- the pass ---------------------------------------------------------------

// Everything that is still open for this person. `stale` is how a suggestion
// dies without being answered: the task was archived, finished or dated in the
// meantime, so the question no longer means anything and asking it would make
// Olma look like she had not been watching.
async function retireStale(client, userId, now) {
  const { rows } = await client.query(
    `UPDATE task_suggestions s SET decided_at = $2, decision = 'stale'
      WHERE s.user_id = $1 AND s.decided_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
           WHERE t.id = ANY(s.task_ids) AND t.status = 'open' AND t.archived_at IS NULL)
      RETURNING id`,
    [userId, now]
  );
  return rows.length;
}

// Run the pass for one person if their week is up. Returns what it did rather
// than a boolean, because "ran and found nothing" and "did not run" are
// different answers and this module is the one place that can still tell them
// apart.
async function refresh(client, userId, { now = new Date(), force = false } = {}) {
  const { rows: [u] } = await client.query(
    `SELECT id, suggested_at, paused_at, status FROM users WHERE id = $1`, [userId]);
  if (!u) return err('not_found', 'user not found');
  if (u.status !== 'active') return ok({ ran: false, reason: 'not_active', added: 0 });

  await retireStale(client, userId, now);

  const due = force || !u.suggested_at
    || (now.getTime() - new Date(u.suggested_at).getTime()) >= EVERY_MS;
  if (!due) return ok({ ran: false, reason: 'too_soon', added: 0 });

  const { rows: [{ n: live }] } = await client.query(
    `SELECT count(*)::int AS n FROM task_suggestions WHERE user_id = $1 AND decided_at IS NULL`,
    [userId]
  );
  // The stamp moves whether or not anything was found — that is the whole
  // reason `users.suggested_at` exists rather than being derived from the
  // newest row. A week with nothing to say still costs its week.
  await client.query(`UPDATE users SET suggested_at = $2 WHERE id = $1`, [userId, now]);
  if (live >= MAX_LIVE) return ok({ ran: true, reason: 'full', added: 0 });

  const groups = {
    stuck: await stuckTasks(client, userId, now),
    overdue: await overdueTasks(client, userId, now),
    duplicate: await duplicateTasks(client, userId),
  };
  const candidates = interleave(groups).slice(0, MAX_LIVE - live);

  let added = 0;
  for (const c of candidates) {
    // ON CONFLICT DO NOTHING is the "never twice" rule: the unique index
    // carries every suggestion this person has already answered, skipped ones
    // included, so a condition they have declined stays declined.
    const ins = await client.query(
      `INSERT INTO task_suggestions (user_id, kind, task_ids, dedup_key, detail)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, dedup_key) DO NOTHING RETURNING id`,
      [userId, c.kind, c.taskIds, keyFor(c.kind, c.taskIds), JSON.stringify(c.detail)]
    );
    if (ins.rows[0]) added += 1;
  }
  if (added) await audit.record(client, userId, 'suggestions.offered', { added });
  return ok({ ran: true, reason: 'ran', added });
}

// Everything ready for this person, oldest first, so a suggestion made a week
// ago is offered before one made today rather than being buried by it. At
// most `MAX_LIVE`, which is why the page can hold the whole set: the "הצעת
// Ai" button (owner, 2026-09-22) moves between them in the browser with no
// second round trip and no new action on the write surface.
//
// Sending three is NOT a change to the rule that one is SHOWN. Which one is
// on screen stays the page's business, and nothing here decides it.
async function liveFor(client, userId, limit = MAX_LIVE) {
  const { rows } = await client.query(
    `SELECT s.id, s.kind, s.task_ids, s.detail, s.created_at
       FROM task_suggestions s
      WHERE s.user_id = $1 AND s.decided_at IS NULL
        AND EXISTS (SELECT 1 FROM tasks t
                     WHERE t.id = ANY(s.task_ids) AND t.status = 'open' AND t.archived_at IS NULL)
      ORDER BY s.id LIMIT $2`,
    [userId, Math.max(1, Number(limit) || MAX_LIVE)]
  );
  return rows.map((s) => ({
    id: Number(s.id),
    kind: s.kind,
    taskIds: s.task_ids.map(Number),
    // the person's own words, which the page shows back to them
    title: s.detail.title || null,
    days: s.detail.days ?? null,
    keepTitle: s.detail.keepTitle || null,
  }));
}

// The one the page opens on.
async function nextFor(client, userId) {
  const [first] = await liveFor(client, userId, 1);
  return first || null;
}

// אשר or דלג. Accepting archives — reversibly, through the same
// `tasks.archiveTask` the person's own button calls, so the audit trail and
// every invariant are the ones they already have. Nothing here writes a date
// or a reminder, by the owner's decision.
async function decide(client, userId, suggestionId, decision, { now = new Date() } = {}) {
  if (!['accept', 'skip'].includes(decision)) return err('invalid', 'decision must be accept|skip');
  const id = Number(suggestionId);
  if (!Number.isSafeInteger(id) || id <= 0) return err('invalid', 'suggestionId required');
  const { rows } = await client.query(
    `SELECT id, kind, task_ids FROM task_suggestions
      WHERE id = $1 AND user_id = $2 AND decided_at IS NULL`,
    [id, userId]
  );
  if (!rows[0]) return err('not_found', 'suggestion not found');
  const s = rows[0];

  let archived = [];
  if (decision === 'accept') {
    for (const taskId of s.task_ids) {
      const res = await tasksDomain.archiveTask(client, userId, Number(taskId));
      // A task that has already gone is not a failure of the suggestion — it
      // is the outcome the suggestion wanted, reached another way.
      if (res.ok) archived.push(Number(taskId));
      else if (res.error.code !== 'not_found') return res;
    }
  }
  await client.query(
    `UPDATE task_suggestions SET decided_at = $2, decision = $3 WHERE id = $1`,
    [id, now, decision === 'accept' ? 'accepted' : 'skipped']
  );
  await audit.record(client, userId, `suggestion.${decision === 'accept' ? 'accepted' : 'skipped'}`, {
    suggestionId: id, kind: s.kind, ...(archived.length ? { archivedTaskIds: archived } : {}),
  });
  return ok({ suggestionId: id, decision, archived });
}

// Every active person whose week is up. The job calls this; the loader never
// does, because `user-dashboard.js` reads and nothing else.
async function sweepSuggestions(client, { now = new Date() } = {}) {
  const { rows } = await client.query(
    `SELECT id FROM users
      WHERE status = 'active' AND is_eval = false AND paused_at IS NULL
        AND (suggested_at IS NULL OR suggested_at < $1::timestamptz - ($2 || ' milliseconds')::interval)
      ORDER BY id`,
    [now, EVERY_MS]
  );
  let people = 0; let added = 0;
  for (const u of rows) {
    const res = await refresh(client, u.id, { now });
    if (res.ok && res.data.ran) { people += 1; added += res.data.added; }
  }
  return { people, added };
}

// ---- what was measured and REJECTED -----------------------------------------
//
// The owner picked four detectors; three shipped. The fourth — "several tasks
// that want to be one list with items" — was measured against the live box on
// 2026-09-19 and thrown away, because grouping open tasks by a shared word
// produced three groups across three people and all three were wrong:
//
//   "לעשות למאיה תיאום מס" / "דברים שצריך לעשות ביחד עם מאיה" /
//   "לעשות פתיח ספק בעיריית כפר סבא"        — shared word: the verb לעשות
//   "סדר בבית" / "לארוז תיק לבית חולים" /
//   "להזכיר לי מחר בבוקר ב-9 עם רשימת האריזה לתיק לבית חולים"
//                                            — shared word: בית, two different בתים
//   "לבדוק על שחיינים ששחו בעבר" / "לבדוק משימות למרוץ" /
//   "לבדוק משימות נוספות שיש לי"             — shared word: the verb לבדוק
//
// Grouping by `category` instead is no better: it is a closed vocabulary of
// six, so "family ×5" says only that five tasks are about family. Both
// readings fire on ordinary input, which is the one thing a suggestion may
// never do — see `rules/detectors.md`. The rows above are in the test, so
// anybody who builds this detector has to beat them first.
module.exports = {
  refresh, nextFor, liveFor, decide, sweepSuggestions,
  stuckTasks, overdueTasks, duplicateTasks,
  EVERY_MS, MAX_LIVE, STUCK_DAYS, OVERDUE_DAYS, KINDS,
};
