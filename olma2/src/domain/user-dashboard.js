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
const mail = require('./mail');

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

// The gate reads `role` and `phone`, and neither belongs in loadUser's row:
// that row is the payload's own source, and the whole discipline there is that
// no phone number can reach a browser from it. Fetching the two fields into a
// throwaway object keeps them out of anything that gets serialised, and makes
// it obvious at the call site that this is the only thing they are for.
//
// Reading them at all is not optional — requireMailAccess answers "admin, or
// on the allowlist, or no". Handed a row without the columns it consults, it
// would answer "no" for everybody and be quietly wrong for exactly the people
// the allowlist exists for.
async function mailIdentity(client, userId) {
  const { rows } = await client.query(
    `SELECT id, role, phone FROM users WHERE id = $1`, [userId]);
  return rows[0] || { id: userId };
}

// `is_eval = false` for the same reason every user-selecting sweep carries it:
// that row is structurally sealed off, its phone is fake, and a page rendered
// for it could only ever be a way to look at the test fixtures.
async function loadUser(client, userId) {
  const { rows } = await client.query(
    `SELECT id, first_name, last_name, assistant_name, timezone, timezone_confirmed,
            locale, paused_at IS NOT NULL AS paused, digest_scope, calendar_sync_tasks
     FROM users WHERE id = $1 AND status != 'blocked' AND is_eval = false`,
    [userId]
  );
  return rows[0] || null;
}

// Tasks, their checklist children, their reminder and who else is on them —
// four queries rather than one join, because a join across children AND
// viewers multiplies rows and the de-duplication is more code than the extra
// round trips are worth.
async function loadTasks(client, userId, zone, calendarSyncTasks) {
  // Their own list AND the tasks other people share with them. A shared task
  // is not a copy or a notification — it is the same row, appearing on both
  // lists, which is the whole point of sharing one. Leaving it out would have
  // made "משימות משותפות" a section that only ever showed the ones this person
  // shared OUT, i.e. exactly half the feature, silently.
  const { rows: tasks } = await client.query(
    `SELECT t.id, t.title, t.category, t.category_auto, t.source, t.status, t.parent_id, t.ends_at,
            t.archived_at IS NOT NULL AS archived, t.completed_at,
            t.due_at, t.owner_id,
            -- the wall clock the person actually chose, resolved in THEIR zone
            to_char(t.due_at AT TIME ZONE $2, 'YYYY-MM-DD') AS due_date,
            to_char(t.due_at AT TIME ZONE $2, 'HH24:MI')    AS due_time,
            to_char(t.ends_at AT TIME ZONE $2, 'HH24:MI')   AS end_time,
            -- a due_at at exactly local midnight is an all-day task: that is
            -- what add_task stores when no time was given
            (t.due_at IS NOT NULL AND
             (t.due_at AT TIME ZONE $2)::time = '00:00') AS all_day,
            -- the task's own answer to "put this on my calendar", or NULL for
            -- "whatever the standing switch says" (migration 029)
            t.calendar_opt_in,
            -- and whether it is actually there yet: the sweep runs every five
            -- minutes, so wanting it and having it are two different facts and
            -- the page has to be able to tell them apart
            t.calendar_event_id IS NOT NULL AS in_calendar,
            sh.role AS shared_role
     FROM tasks t
     LEFT JOIN shares sh
            ON sh.task_id = t.id AND sh.viewer_id = $1 AND sh.status = 'active'
     WHERE t.parent_id IS NULL
       AND (t.owner_id = $1 OR sh.id IS NOT NULL)
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
    `SELECT r.id, r.task_id, r.remind_at, r.repeat_rule
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
    `SELECT s.id AS share_id, s.task_id, s.viewer_id, u.first_name
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
    // The share id travels with the person, because taking somebody off a
    // task — or taking yourself off one — revokes a specific share row, and a
    // page that only knows (task, viewer) would have to be given a second
    // lookup to do the one thing this list exists for.
    shareByTask.get(s.task_id).push({ id: s.viewer_id, name: s.first_name, shareId: s.share_id });
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
      // Whether Olma chose it, so the sheet can say so and the person knows
      // the field is a guess they are free to correct — the page has carried
      // that affordance (`עולמה בחרה`) since it was designed.
      catAuto: Boolean(t.category_auto) && KNOWN_CATEGORIES.includes(t.category),
      date: t.due_date,
      time: t.all_day ? null : t.due_time,
      // The other end of a range, when there is one. A shift is `משמרת`
      // 12:00–19:00 rather than a title with the hours typed into it, and the
      // day view can only draw the block if it is told where it stops.
      endTime: t.all_day ? null : (t.end_time || null),
      allDay: t.all_day,
      done: t.status === 'done',
      // The archive lists what was finished and when; nothing else reads it.
      completedAt: t.completed_at,
      // The id travels with it because switching the reminder off cancels one
      // specific row, and (task, time) is not an identity — a task can carry
      // more than one pending reminder and the page must not guess which.
      reminder: rem ? { id: rem.id, at: rem.remind_at, repeat: rem.repeat_rule } : null,
      // The EFFECTIVE answer, resolved here rather than in the browser: the
      // page draws one switch and the precedence rule belongs on the side that
      // enforces it. `inCalendar` is the separate question of whether the
      // sweep has caught up yet.
      calendar: t.calendar_opt_in ?? Boolean(calendarSyncTasks),
      inCalendar: t.in_calendar,
      items: byParent.get(t.id) || [],
      // Who owns this, and therefore who may manage its sharing. `mine` is the
      // question the page actually asks; `owner` carries the id so a task
      // somebody else shared can be attributed to them by name.
      mine: String(t.owner_id) === String(userId),
      owner: who.length || String(t.owner_id) !== String(userId) ? t.owner_id : null,
      who,
      // Only set on a task somebody shared WITH this person: 'viewer' or
      // 'editor'. Their own rows carry null, not 'editor' — owning something
      // is not a role granted to you.
      sharedRole: t.shared_role || null,
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
            u.first_name, u.timezone, c.responded_at,
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
    // When this became a friendship. The page shows it under the name; it is
    // the only date in the payload that is about the RELATIONSHIP rather than
    // about a task, so it is not converted into anyone's wall clock.
    since: r.responded_at,
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

// The person's own address book — the people they might invite, as opposed to
// the people they are already connected to. `user_contacts` is theirs: rows
// they shared as contact cards or imported from an account of their own, so
// the phone number travels here where it deliberately does not for a friend.
// Showing somebody their own address book is not publishing anybody's number;
// it is the same list already open in the app next door, and the invite button
// is unusable without it.
//
// Anyone already connected is filtered out here rather than in the browser: it
// is one join, and it keeps a stale page from offering to invite a person who
// accepted an hour ago.
async function loadContacts(client, userId) {
  const { rows } = await client.query(
    `SELECT c.id, c.display_name, c.phone, c.source
       FROM user_contacts c
      WHERE c.user_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM connections k
           JOIN users u ON u.id = CASE WHEN k.requester_id = $1 THEN k.target_id ELSE k.requester_id END
           WHERE k.status = 'active' AND (k.requester_id = $1 OR k.target_id = $1)
             AND u.phone = c.phone)
        -- and not somebody they have already asked: the button would offer to
        -- ask again, which sends a second intro to a person still deciding
        AND NOT EXISTS (
          SELECT 1 FROM connections k
           WHERE k.requester_id = $1 AND k.target_phone = c.phone
             AND k.status IN ('invited', 'pending_target'))
      ORDER BY c.display_name`,
    [userId]
  );
  return rows.map((r) => ({
    id: Number(r.id), name: r.display_name, phone: r.phone, source: r.source,
  }));
}

// Where Olma can actually reach this person. One WhatsApp row each today, and
// the schema has always allowed a second identity to join the same user — so
// this is a LIST, and the page draws its choices from it rather than from a
// hard-coded pair.
//
// The identifier itself never leaves the server. It is a phone number, and the
// page has no use for one: it needs to know which channels exist and which is
// the standing one, not how to dial them.
async function loadChannels(client, userId) {
  const { rows } = await client.query(
    `SELECT channel_type, is_primary FROM user_channels
      WHERE user_id = $1 ORDER BY is_primary DESC, channel_type`,
    [userId]
  );
  return rows.map((r) => ({ type: r.channel_type, primary: r.is_primary }));
}

// Meetings still being negotiated, with each participant's answer state. What
// somebody MARKED is availability and nothing more — the page must be able to
// tell "has not answered" from "answered, nothing suits", so an unanswered
// participant is `answered: false` rather than an empty option list.
async function loadMeetings(client, userId, zone) {
  const { rows: meetings } = await client.query(
    `SELECT m.id, m.title, m.initiator_id, m.status,
            m.proposed_slot, m.proposed_start_at, m.confirmed_start_at,
            m.confirmed_slot,
            -- The proposed moment as the wall clock THIS person reads it, and
            -- as a day offset from their today. The page thinks in offsets
            -- because its grid does; converting here is the same rule every
            -- other time on this payload follows.
            to_char(m.proposed_start_at AT TIME ZONE $2, 'HH24:MI') AS proposed_time,
            ((m.proposed_start_at AT TIME ZONE $2)::date
              - (now() AT TIME ZONE $2)::date) AS proposed_day,
            to_char(m.confirmed_start_at AT TIME ZONE $2, 'HH24:MI') AS confirmed_time,
            ((m.confirmed_start_at AT TIME ZONE $2)::date
              - (now() AT TIME ZONE $2)::date) AS confirmed_day
     FROM meetings m
     JOIN meeting_participants p ON p.meeting_id = m.id
     WHERE p.user_id = $1 AND p.state != 'opted_out'
       AND m.status IN ('negotiating', 'confirmed')
     ORDER BY m.id DESC`,
    [userId, zone]
  );
  if (!meetings.length) return [];
  const ids = meetings.map((m) => m.id);
  // Everyone, INCLUDING the people who left. They are still shown and counted
  // in nothing — the group has to be able to see why the tally dropped, and a
  // silently shorter list reads as somebody never having been asked.
  const { rows: parts } = await client.query(
    `SELECT p.meeting_id, p.user_id, p.state, u.first_name
     FROM meeting_participants p JOIN users u ON u.id = p.user_id
     WHERE p.meeting_id = ANY($1::bigint[])
     ORDER BY p.meeting_id, p.user_id`,
    [ids]
  );
  const byMeeting = new Map();
  for (const p of parts) {
    if (!byMeeting.has(p.meeting_id)) byMeeting.set(p.meeting_id, []);
    byMeeting.get(p.meeting_id).push({
      id: p.user_id,
      name: p.first_name,
      // Three values, never two. "Has not answered" must stay distinguishable
      // from "answered, cannot make it", or the confirm gate reads silence as
      // a refusal — which is the one mistake this whole screen is built to
      // avoid making out loud.
      answer: p.state === 'confirmed_current' ? 'y'
        : p.state === 'declined_current' ? 'n' : '',
      left: p.state === 'opted_out',
    });
  }
  return meetings.map((m) => ({
    id: m.id,
    title: m.title,
    mine: String(m.initiator_id) === String(userId),
    // Named rather than inferred: the page shows "X proposed", and picking the
    // first participant in the list would eventually name the wrong person.
    initiatorId: Number(m.initiator_id),
    status: m.status,
    slot: m.proposed_slot,
    proposedStartAt: m.proposed_start_at,
    proposedTime: m.proposed_time,
    proposedDay: m.proposed_day === null ? null : Number(m.proposed_day),
    confirmedSlot: m.confirmed_slot,
    confirmedStartAt: m.confirmed_start_at,
    confirmedTime: m.confirmed_time,
    confirmedDay: m.confirmed_day === null ? null : Number(m.confirmed_day),
    participants: byMeeting.get(m.id) || [],
  }));
}

// Coordinations this person LEFT and could still walk back into. They are the
// contents of the meetings archive, and they carry almost nothing on purpose:
// an id and a title is everything "put me back in" needs, and anything more
// would be a live feed of a negotiation somebody deliberately stepped out of.
// Watching the others answer after you have left is not a feature.
//
// Bounded by what `meetings.rejoin` will actually accept, so the button is
// never drawn over a refusal: still negotiating or confirmed, and not already
// started. A coordination that closed when you left is gone from here too.
async function loadLeftMeetings(client, userId) {
  const { rows } = await client.query(
    `SELECT m.id, m.title
       FROM meetings m
       JOIN meeting_participants p ON p.meeting_id = m.id
      WHERE p.user_id = $1 AND p.state = 'opted_out'
        AND m.status IN ('negotiating', 'confirmed')
        AND (m.confirmed_start_at IS NULL OR m.confirmed_start_at > now())
      ORDER BY m.id DESC
      LIMIT 20`,
    [userId]
  );
  return rows.map((m) => ({ id: Number(m.id), title: m.title, youLeft: true }));
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
  const tasks = await loadTasks(client, userId, zone, user.calendar_sync_tasks);
  const friends = await loadFriends(client, userId);
  const integrations = await loadIntegrations(client, userId);
  // What the page may OFFER, as distinct from what is already connected. Only
  // one entry so far and it earns its place: connecting a mailbox is behind an
  // allowlist (mail.requireMailAccess), so for almost everybody Gmail is a
  // service on a connected account that still cannot be switched on. Without
  // this the page would draw it as available and find out only on the tap.
  const mailGate = await mail.requireMailAccess(client, await mailIdentity(client, userId));
  const channels = await loadChannels(client, userId);
  const contacts = await loadContacts(client, userId);
  const meetings = await loadMeetings(client, userId, zone);
  const meetingsLeft = await loadLeftMeetings(client, userId);
  return ok({
    user: {
      id: user.id,
      firstName: user.first_name,
      // Both halves, and Olma's own name. The page keeps a seeded profile for
      // the design copy and re-reads it on every render, so a payload that
      // omits these leaves a real person looking at the fixture's name.
      lastName: user.last_name,
      assistantName: user.assistant_name,
      timezone: zone,
      timezoneConfirmed: user.timezone_confirmed,
      // Rendered in whatever language they have been writing in — it is not a
      // setting and there is no switcher, so this is a fact about them rather
      // than a preference they chose here. `locale` is the column's real name.
      locale: user.locale || 'he',
      paused: user.paused,
      digestScope: user.digest_scope,
      // The standing switch behind every task's own calendar row. A task that
      // says nothing follows this one.
      calendarSyncTasks: user.calendar_sync_tasks,
    },
    channels,
    contacts,
    tasks: tasks.open,
    archived: tasks.archived,
    friends,
    integrations,
    available: { mail: mailGate.ok },
    meetings,
    meetingsLeft,
  });
}

module.exports = { load, SOURCE_CAPS, KNOWN_CATEGORIES };
