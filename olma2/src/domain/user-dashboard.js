'use strict';
// The read model behind the personal dashboard page (the design lives in
// olma2/docs/design/user-dashboard.html). One function, one query set, one
// object — everything that page shows, assembled server-side under the
// viewer's own identity.
//
// Four rules it is built on, each of which this repo already learned the hard
// way somewhere else:
//
//   * The viewer id comes from the caller, never from the page. Every query
//     below is filtered on it. A page that could name its own user id would
//     be a way to read anybody's tasks by guessing an integer.
//   * It reads, and nothing else. Writes get their own module with their own
//     validation, so a bug in rendering can never mutate anything.
//   * A person's timezone decides every wall clock here, converted in
//     Postgres. Formatting an instant against the server's zone is the
//     "משמרת 15:00 stored as Z" incident, and it is one AT TIME ZONE away.
//   * Other people appear by first name and avatar seed only. This payload is
//     shipped to a browser, so a phone number in it is a phone number
//     published — the same projection calendar.listEvents makes about
//     attendees and mail makes about recipient lists.
const { ok, err } = require('./results');

// A task's own category vocabulary is closed server-side (tasks.category is
// validated as a closed set, not free text), so the page can rely on it —
// but an UNKNOWN value must render rather than disappear, or a category added
// on the server silently empties somebody's list on an older page.
const KNOWN_CATEGORIES = ['home', 'work', 'family', 'health', 'money', 'errands'];
const category = (c) => (KNOWN_CATEGORIES.includes(c) ? c : 'none');

// What each connected platform can actually express, in OUR field names. The
// page greys a field the source cannot hold and must keep it unwritable — so
// this map is the authority for both halves, and it lives here rather than in
// the page for exactly that reason: the browser copy is a hint, this one is
// the rule.
const SOURCE_CAPS = {
  monday: ['date', 'time', 'category', 'share', 'items'],
  slack: ['date', 'share'],
  google_tasks: ['date', 'time', 'repeat', 'items'],
};
// `source` is a free-text column with 'chat' as its default, so anything that
// is not a known import is the person's own writing.
const importSource = (src) => (Object.hasOwn(SOURCE_CAPS, src) ? src : null);

// `is_eval = false` for the same reason every user-selecting sweep carries it:
// that row is structurally sealed off, its phone is fake, and a page rendered
// for it could only ever be a way to look at the test fixtures.
async function loadUser(client, userId) {
  const { rows } = await client.query(
    `SELECT id, first_name, timezone, timezone_confirmed, locale,
            paused_at IS NOT NULL AS paused, digest_scope
     FROM users WHERE id = $1 AND status != 'blocked' AND is_eval = false`,
    [userId]
  );
  return rows[0] || null;
}

// Tasks, their checklist children, their reminder and who else is on them —
// four queries rather than one join, because a join across children AND
// viewers multiplies rows and the de-duplication is more code than the extra
// round trips are worth.
async function loadTasks(client, userId, zone) {
  const { rows: tasks } = await client.query(
    `SELECT t.id, t.title, t.category, t.source, t.status, t.parent_id,
            t.archived_at IS NOT NULL AS archived, t.completed_at,
            t.due_at,
            -- the wall clock the person actually chose, resolved in THEIR zone
            to_char(t.due_at AT TIME ZONE $2, 'YYYY-MM-DD') AS due_date,
            to_char(t.due_at AT TIME ZONE $2, 'HH24:MI')    AS due_time,
            -- a due_at at exactly local midnight is an all-day task: that is
            -- what add_task stores when no time was given
            (t.due_at IS NOT NULL AND
             (t.due_at AT TIME ZONE $2)::time = '00:00') AS all_day
     FROM tasks t
     WHERE t.owner_id = $1 AND t.parent_id IS NULL
     ORDER BY t.archived_at NULLS FIRST, t.due_at NULLS LAST, t.id`,
    [userId, zone]
  );
  if (!tasks.length) return { open: [], archived: [] };

  const ids = tasks.map((t) => t.id);
  const { rows: items } = await client.query(
    `SELECT id, parent_id, title, status FROM tasks
     WHERE parent_id = ANY($1::bigint[]) ORDER BY id`,
    [ids]
  );
  // Only a reminder that has not finished its escalation ladder counts as
  // pending — `sent_at IS NULL` stopped meaning "has not gone out" when the
  // ladder shipped, and three readers told somebody the wrong thing before
  // that was noticed. `attempts = 0` is the question to ask.
  const { rows: rems } = await client.query(
    `SELECT r.task_id, r.remind_at, r.repeat_rule
     FROM task_reminders r
     WHERE r.task_id = ANY($1::bigint[])
       AND r.cancelled_at IS NULL AND r.sent_at IS NULL
     ORDER BY r.task_id, r.remind_at`,
    [ids]
  );
  // Everyone actively on a shared task, the owner included — the page needs
  // the whole set to know when removing the last person makes it private
  // again, and it needs the owner to know whether this viewer may manage it.
  const { rows: shares } = await client.query(
    `SELECT s.task_id, s.viewer_id, u.first_name
     FROM shares s JOIN users u ON u.id = s.viewer_id
     WHERE s.task_id = ANY($1::bigint[]) AND s.status = 'active'
     ORDER BY s.task_id, s.viewer_id`,
    [ids]
  );

  const byParent = new Map();
  for (const i of items) {
    if (!byParent.has(i.parent_id)) byParent.set(i.parent_id, []);
    byParent.get(i.parent_id).push({ id: i.id, title: i.title, done: i.status === 'done' });
  }
  const remByTask = new Map();
  for (const r of rems) if (!remByTask.has(r.task_id)) remByTask.set(r.task_id, r);
  const shareByTask = new Map();
  for (const s of shares) {
    if (!shareByTask.has(s.task_id)) shareByTask.set(s.task_id, []);
    shareByTask.get(s.task_id).push({ id: s.viewer_id, name: s.first_name });
  }

  const out = { open: [], archived: [] };
  for (const t of tasks) {
    const rem = remByTask.get(t.id) || null;
    const who = shareByTask.get(t.id) || [];
    const src = importSource(t.source);
    const row = {
      id: t.id,
      title: t.title,
      category: category(t.category),
      date: t.due_date,
      time: t.all_day ? null : t.due_time,
      allDay: t.all_day,
      done: t.status === 'done',
      reminder: rem ? { at: rem.remind_at, repeat: rem.repeat_rule } : null,
      items: byParent.get(t.id) || [],
      // `owner` is this viewer's own id when they own it, which is what the
      // page checks before offering to manage the sharing at all.
      owner: who.length ? userId : null,
      who,
      source: src,
      // Shipped alongside the task rather than looked up by the page, so a
      // capability change on the server takes effect without a redeploy of
      // the HTML.
      caps: src ? SOURCE_CAPS[src] : null,
    };
    (t.archived ? out.archived : out.open).push(row);
  }
  return out;
}

// Friends, and what each of them may do. A grant row's PRESENCE is the grant;
// absence is off, which is the same default the tools enforce.
async function loadFriends(client, userId) {
  const { rows } = await client.query(
    `SELECT c.id AS connection_id,
            CASE WHEN c.requester_id = $1 THEN c.target_id ELSE c.requester_id END AS friend_id,
            u.first_name, u.timezone,
            COALESCE(
              (SELECT array_agg(g.feature ORDER BY g.feature)
               FROM connection_feature_grants g
               WHERE g.connection_id = c.id AND g.grantor_id = $1),
              '{}'
            ) AS features
     FROM connections c
     JOIN users u ON u.id = CASE WHEN c.requester_id = $1 THEN c.target_id ELSE c.requester_id END
     WHERE c.status = 'active' AND (c.requester_id = $1 OR c.target_id = $1)
     ORDER BY u.first_name NULLS LAST, u.id`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.friend_id,
    connectionId: r.connection_id,
    name: r.first_name,
    timezone: r.timezone,
    features: r.features,
  }));
}

// Integrations, one row per provider, with the scope the person granted. The
// credential columns are never selected — this object is bound for a browser.
async function loadIntegrations(client, userId) {
  const { rows } = await client.query(
    `SELECT provider, status, access_level, account_label
     FROM integrations WHERE user_id = $1 ORDER BY provider`,
    [userId]
  );
  return rows.map((r) => ({
    provider: r.provider,
    connected: r.status === 'connected',
    needsReauth: r.status === 'needs_reauth',
    // `access_level` is the half that says what we may DO; `scopes` is the raw
    // grant string Google returned and is never shown to anyone.
    access: r.access_level,
    account: r.account_label,
  }));
}

// Meetings still being negotiated, with each participant's answer state. What
// somebody MARKED is availability and nothing more — the page must be able to
// tell "has not answered" from "answered, nothing suits", so an unanswered
// participant is `answered: false` rather than an empty option list.
async function loadMeetings(client, userId) {
  const { rows: meetings } = await client.query(
    `SELECT m.id, m.title, m.initiator_id, m.status,
            m.proposed_slot, m.proposed_start_at, m.confirmed_start_at
     FROM meetings m
     JOIN meeting_participants p ON p.meeting_id = m.id
     WHERE p.user_id = $1 AND p.state != 'opted_out'
       AND m.status IN ('negotiating', 'confirmed')
     ORDER BY m.id DESC`,
    [userId]
  );
  if (!meetings.length) return [];
  const ids = meetings.map((m) => m.id);
  const { rows: parts } = await client.query(
    `SELECT p.meeting_id, p.user_id, p.state, u.first_name
     FROM meeting_participants p JOIN users u ON u.id = p.user_id
     WHERE p.meeting_id = ANY($1::bigint[]) AND p.state != 'opted_out'
     ORDER BY p.meeting_id, p.user_id`,
    [ids]
  );
  const byMeeting = new Map();
  for (const p of parts) {
    if (!byMeeting.has(p.meeting_id)) byMeeting.set(p.meeting_id, []);
    byMeeting.get(p.meeting_id).push({
      id: p.user_id,
      name: p.first_name,
      answered: p.state === 'confirmed_current' || p.state === 'declined_current',
    });
  }
  return meetings.map((m) => ({
    id: m.id,
    title: m.title,
    mine: m.initiator_id === userId,
    status: m.status,
    slot: m.proposed_slot,
    proposedStartAt: m.proposed_start_at,
    confirmedStartAt: m.confirmed_start_at,
    participants: byMeeting.get(m.id) || [],
  }));
}

// The whole page, in one object. A missing or blocked user is `not_found` and
// not an empty dashboard: an empty one reads as "you have nothing", which is a
// statement about them rather than about the link.
async function load(client, userId) {
  const user = await loadUser(client, userId);
  if (!user) return err('not_found', 'no such user');
  const zone = user.timezone || 'UTC';
  // Sequential, not Promise.all: this is ONE client inside one transaction, and
  // pg serialises concurrent queries on a single client anyway — while warning
  // that it will stop doing so in pg@9. Overlapping them buys nothing here and
  // would break on that upgrade.
  const tasks = await loadTasks(client, userId, zone);
  const friends = await loadFriends(client, userId);
  const integrations = await loadIntegrations(client, userId);
  const meetings = await loadMeetings(client, userId);
  return ok({
    user: {
      id: user.id,
      firstName: user.first_name,
      timezone: zone,
      timezoneConfirmed: user.timezone_confirmed,
      // Rendered in whatever language they have been writing in — it is not a
      // setting and there is no switcher, so this is a fact about them rather
      // than a preference they chose here. `locale` is the column's real name.
      locale: user.locale || 'he',
      paused: user.paused,
      digestScope: user.digest_scope,
    },
    tasks: tasks.open,
    archived: tasks.archived,
    friends,
    integrations,
    meetings,
  });
}

module.exports = { load, SOURCE_CAPS, KNOWN_CATEGORIES };
