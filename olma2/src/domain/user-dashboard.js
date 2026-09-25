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
//   * Other people appear by first name and chosen character only. This payload is
//     shipped to a browser, so a phone number in it is a phone number
//     published — the same projection calendar.listEvents makes about
//     attendees and mail makes about recipient lists.
const { ok, err } = require('./results');
// `meetingsDomain`, not `meetings`: loadMeetings below binds a local
// `meetings` for its own rows, and a module-level shadow of that name is a
// TDZ ReferenceError inside the one function that needs this.
const meetingsDomain = require('./meetings');
const optionMoment = require('./meeting-option-moment');
const meetingTime = require('./meeting-time');
const mail = require('./mail');
const voice = require('./voice');
const preferences = require('./preferences');
const holidays = require('./holidays');
const factPrompts = require('./fact-prompts');
const suggestions = require('./task-suggestions');

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

// The gates read `role` and `phone`, and neither belongs in loadUser's row:
// that row is the payload's own source, and the whole discipline there is that
// no phone number can reach a browser from it. Fetching the two fields into a
// throwaway object keeps them out of anything that gets serialised, and makes
// it obvious at the call site that this is the only thing they are for.
//
// Reading them at all is not optional — requireMailAccess answers "admin, or
// on the allowlist, or no". Handed a row without the columns it consults, it
// would answer "no" for everybody and be quietly wrong for exactly the people
// the allowlist exists for.
async function gateIdentity(client, userId) {
  const { rows } = await client.query(
    `SELECT id, role, phone, voice_more_requested_at FROM users WHERE id = $1`, [userId]);
  return rows[0] || { id: userId };
}

// `is_eval = false` for the same reason every user-selecting sweep carries it:
// that row is structurally sealed off, its phone is fake, and a page rendered
// for it could only ever be a way to look at the test fixtures.
async function loadUser(client, userId) {
  const { rows } = await client.query(
    `SELECT id, first_name, last_name, assistant_name, assistant_gender, timezone, timezone_confirmed,
            locale, paused_at IS NOT NULL AS paused, digest_scope, digest_times, calendar_sync_tasks,
            reminder_nudge,
            gender, to_char(birth_date, 'YYYY-MM-DD') AS birth_date,
            to_char(created_at AT TIME ZONE COALESCE(timezone, 'UTC'), 'YYYY-MM-DD') AS joined_on,
            nest_tip_seen_at IS NOT NULL AS nest_tip_seen,
            avatar
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
            t.kind, t.location,
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
            -- who started it, by first name only: on a task somebody shared
            -- WITH this person the owner is on no share row, so without this
            -- the list could draw every face on it except the one who shared
            ow.first_name AS owner_name, ow.avatar AS owner_avatar,
            -- they took the pin off this one (migration 066); pinned is the
            -- default, and it only means anything while the task is shared
            up.task_id IS NOT NULL AS unpinned
     FROM tasks t
     JOIN users ow ON ow.id = t.owner_id
     LEFT JOIN shares sh
            ON sh.task_id = t.id AND sh.viewer_id = $1 AND sh.status = 'active'
     LEFT JOIN task_unpins up
            ON up.task_id = t.id AND up.user_id = $1
     -- where THIS person dragged it (migration 069), per viewer like the pin
     LEFT JOIN task_order tord
            ON tord.task_id = t.id AND tord.user_id = $1
     WHERE t.parent_id IS NULL
       AND (t.owner_id = $1 OR sh.id IS NOT NULL)
     -- Open first, then the finished ones newest-first: the archive shows the
     -- last eight and says how many it is hiding, so "last" has to mean when
     -- it was finished, not when it had been due. Open rows are all NULL on
     -- the second key and fall through to their own order: where the person
     -- dragged them, and only then by date. The page never sorts — it files
     -- this order into its groups — so one rank serves the category view and
     -- the time view alike, and a row nobody dragged sits after the dragged
     -- ones in date order, as it always did.
     ORDER BY (t.archived_at IS NOT NULL OR t.status = 'done'),
              COALESCE(t.completed_at, t.archived_at) DESC NULLS LAST,
              tord.position NULLS LAST,
              t.due_at NULLS LAST, t.id`,
    [userId, zone]
  );
  if (!tasks.length) return { open: [], archived: [] };

  const ids = tasks.map((t) => t.id);
  const { rows: items } = await client.query(
    `SELECT id, parent_id, title, status FROM tasks
     WHERE parent_id = ANY($1::bigint[]) AND archived_at IS NULL ORDER BY id`,
    [ids]
  );
  // Only a reminder that has not finished its escalation ladder counts as
  // pending — `sent_at IS NULL` stopped meaning "has not gone out" when the
  // ladder shipped, and three readers told somebody the wrong thing before
  // that was noticed. `attempts = 0` is the question to ask.
  // THIS person's reminders only: on a shared task each participant has their
  // own (migration 073), and the switch on the sheet is about theirs.
  const { rows: rems } = await client.query(
    `SELECT r.id, r.task_id, r.remind_at, r.repeat_rule, r.repeat_until
     FROM task_reminders r JOIN tasks t ON t.id = r.task_id
     WHERE r.task_id = ANY($1::bigint[]) AND COALESCE(r.user_id, t.owner_id) = $2
       AND r.cancelled_at IS NULL AND r.attempts = 0
     ORDER BY r.task_id, r.remind_at`,
    [ids, userId]
  );
  // Everyone actively on a shared task, the owner included — the page needs
  // the whole set to know when removing the last person makes it private
  // again, and it needs the owner to know whether this viewer may manage it.
  const { rows: shares } = await client.query(
    `SELECT s.id AS share_id, s.task_id, s.viewer_id, u.first_name, u.avatar
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
    shareByTask.get(s.task_id).push({ id: s.viewer_id, name: s.first_name, avatar: s.avatar, shareId: s.share_id });
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
      // A moment they will be AT, or a job until it is done. The page lists
      // the calendar before the to-dos on the strength of this; a row that
      // predates the column (NULL) is a job, which is the safe reading.
      kind: t.kind === 'event' ? 'event' : 'todo',
      location: t.location || null,
      done: t.status === 'done',
      // The archive lists what was finished and when; nothing else reads it.
      completedAt: t.completed_at,
      // The id travels with it because switching the reminder off cancels one
      // specific row, and (task, time) is not an identity — a task can carry
      // more than one pending reminder and the page must not guess which.
      // `until` is what makes a daily rule a CHASE rather than a rhythm —
      // the sheet draws "כל יום עד התאריך" off it, never off the rule alone.
      reminder: rem ? { id: rem.id, at: rem.remind_at, repeat: rem.repeat_rule, until: rem.repeat_until || null } : null,
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
      ownerName: String(t.owner_id) !== String(userId) ? (t.owner_name || '') : null,
      ownerAvatar: String(t.owner_id) !== String(userId) ? (t.owner_avatar || null) : null,
      who,
      // Sits at the top of their list: shared with somebody right now, and
      // they have not taken the pin off. A task that stops being shared drops
      // back to its place without anyone touching it.
      pinned: (who.length > 0 || String(t.owner_id) !== String(userId)) && !t.unpinned,
      unpinned: Boolean(t.unpinned),
      source: src,
      // Shipped alongside the task rather than looked up by the page, so a
      // capability change on the server takes effect without a redeploy of
      // the HTML.
      caps: src ? SOURCE_CAPS[src] : null,
    };
    // Finished is finished, however it got there. This asked `archived_at`
    // alone until 2026-09-05, and `complete_task` — the ordinary way a task
    // ends, from chat — only ever sets `status = 'done'`. So every task
    // anybody had ever completed by talking to Olma came back in the OPEN
    // list, ticked, and every control on it was refused: the tick because
    // completeTask guards on `status = 'open'`, the row's own count because
    // it was counted as outstanding. Gali reported it as three tasks stuck
    // in "באיחור" that would not clear; five users held twenty such rows.
    //
    // The chat side never saw it — `list_my_tasks` filters on status, which
    // is exactly why it survived: the two faces disagreed about what "open"
    // meant, and only one of them was ever looked at.
    (t.archived || t.status === 'done' ? out.archived : out.open).push(row);
  }
  return out;
}

// Friends, and what each of them may do. A grant row's PRESENCE is the grant;
// absence is off, which is the same default the tools enforce.
async function loadFriends(client, userId) {
  const { rows } = await client.query(
    `SELECT c.id AS connection_id,
            CASE WHEN c.requester_id = $1 THEN c.target_id ELSE c.requester_id END AS friend_id,
            u.first_name, u.avatar, u.timezone, c.responded_at,
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
    avatar: r.avatar,
    timezone: r.timezone,
    // When this became a friendship. The page shows it under the name; it is
    // the only date in the payload that is about the RELATIONSHIP rather than
    // about a task, so it is not converted into anyone's wall clock.
    since: r.responded_at,
    features: r.features,
  }));
}

// The WhatsApp rooms this person shares with Olma, each already carrying the
// people in it — the room arrives here as a group they can coordinate with,
// with the name it has in WhatsApp, rather than as a list they have to
// assemble out of their friends one by one (owner's ask, 2026-09-09).
//
// Two things are deliberately absent. No phone numbers: everyone in the room
// can see them in WhatsApp, and this payload is bound for a browser, so it
// keeps the same line every other person on this page is behind — first name
// and nothing else. And no `identity_token`, which lives on `chat_groups` and
// is the room's door: a group tool may not return that row, and neither may
// this one.
//
// Members who are not on Olma are listed by the display name the room already
// shows, flagged `onOlma: false`, because a room drawn with half its people
// missing reads as the wrong room. They cannot be put in a coordination — the
// page shows them and cannot select them.
async function loadGroups(client, userId) {
  const { rows } = await client.query(
    `SELECT g.id, g.subject, g.state, g.kind, g.timezone,
            m2.user_id, m2.display_name, u.first_name
       FROM chat_group_members me
       JOIN chat_groups g ON g.id = me.group_id
       JOIN chat_group_members m2 ON m2.group_id = g.id AND m2.left_at IS NULL
       LEFT JOIN users u ON u.id = m2.user_id
      WHERE me.user_id = $1 AND me.left_at IS NULL
      ORDER BY g.id, u.first_name NULLS LAST, m2.phone`,
    [userId]
  );
  const byGroup = new Map();
  for (const r of rows) {
    const id = Number(r.id);
    let g = byGroup.get(id);
    if (!g) {
      g = { id, name: r.subject, state: r.state, kind: r.kind, timezone: r.timezone, members: [] };
      byGroup.set(id, g);
    }
    const onOlma = Boolean(r.user_id);
    g.members.push({
      id: onOlma ? Number(r.user_id) : null,
      name: onOlma ? r.first_name : (r.display_name || null),
      onOlma,
      // The page draws the viewer differently ("you"), and working that out in
      // the browser means shipping the viewer's id twice.
      self: onOlma && Number(r.user_id) === Number(userId),
    });
  }
  return [...byGroup.values()];
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

// A meeting's time for somebody whose page is in ENGLISH. The stored words
// are Hebrew whenever the page or Olma wrote them, and the page printed them
// verbatim under an English screen. The option row the words came from says
// whether it was a clock, a daypart or a whole day; with no row, the stored
// instant is used only when the words themselves name a clock, so nothing
// here ever turns "בערב" into an hour. Null for a Hebrew page — the words ARE
// its language — and for anything that cannot be said honestly, in which case
// the page keeps the words.
async function slotReaderLabel(client, meetingId, slot, startsAt, zone, locale) {
  if (!slot || !String(locale || '').trim().toLowerCase().startsWith('en')) return null;
  const { slotMoment } = require('./meeting-fanout');
  const mo = await slotMoment(client, meetingId, slot);
  const at = mo.startsAtUtc || (startsAt ? new Date(startsAt).toISOString() : null);
  if (!at) return null;
  return meetingTime.readerLabel(
    { startsAt: at, allDay: mo.allDay, daypart: mo.daypart, slot }, zone, mo.authorTz, locale);
}

// Meetings still being negotiated, with each participant's answer state. What
// somebody MARKED is availability and nothing more — the page must be able to
// tell "has not answered" from "answered, nothing suits", so an unanswered
// participant is `answered: false` rather than an empty option list.
async function loadMeetings(client, userId, zone, locale) {
  const { rows: meetings } = await client.query(
    `SELECT m.id, m.title, m.initiator_id, m.status, m.quorum_min,
            m.proposed_slot, m.proposed_start_at, m.confirmed_start_at,
            m.confirmed_slot, m.settling_option_id, m.settled_by,
            -- Seconds left of the settle grace, not the instant it ends: the
            -- page counts down, and a clock on a phone that is four minutes
            -- fast would otherwise count down to the wrong thing. Negative or
            -- zero means the sweep simply has not run yet.
            CASE WHEN m.settle_due_at IS NULL THEN NULL
                 ELSE greatest(0, ceil(extract(epoch FROM (m.settle_due_at - now()))))::int
            END AS settle_in,
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
       AND (m.status = 'negotiating'
            -- A settled meeting is "active" only until it has happened. One
            -- from 2026-08-20 sat on a user's list on 2026-09-05 reading "no
            -- time proposed yet": confirmed, dated only in its slot TEXT (it
            -- predates start times), and never expiring because expiry covers
            -- negotiations. Past or text-only settled meetings are archive.
            OR (m.status = 'confirmed'
                AND ((m.confirmed_start_at IS NOT NULL AND m.confirmed_start_at > now() - interval '6 hours')
                     OR (m.confirmed_start_at IS NULL AND m.updated_at > now() - interval '3 days'))))
     ORDER BY m.id DESC`,
    [userId, zone]
  );
  if (!meetings.length) return [];
  const ids = meetings.map((m) => m.id);
  // Everyone, INCLUDING the people who left. They are still shown and counted
  // in nothing — the group has to be able to see why the tally dropped, and a
  // silently shorter list reads as somebody never having been asked.
  const { rows: parts } = await client.query(
    `SELECT p.meeting_id, p.user_id, p.state, p.constraints, u.first_name, u.avatar
     FROM meeting_participants p JOIN users u ON u.id = p.user_id
     WHERE p.meeting_id = ANY($1::bigint[])
     ORDER BY p.meeting_id, p.user_id`,
    [ids]
  );
  // Every candidate time, in the page's own terms: a day offset from THIS
  // person's today and a clock time or daypart, with everyone's answers. What
  // is on the table is the whole story since 2026-09-09 — a time somebody
  // removed is gone for everybody, and there is no longer any option that
  // exists for one reader and not another.
  const { rows: optRows } = await client.query(
    `SELECT o.id, o.meeting_id, o.slot_text, o.starts_at, o.all_day, o.daypart, o.added_by, o.status,
            coalesce(json_object_agg(a.user_id, a.answer) FILTER (WHERE a.user_id IS NOT NULL), '{}'::json) AS answers
       FROM meeting_options o LEFT JOIN meeting_option_answers a ON a.option_id = o.id
      WHERE o.meeting_id = ANY($1::bigint[]) AND o.status = 'active'
      GROUP BY o.id ORDER BY o.id`, [ids]);
  const optionsBy = new Map();
  for (const o of optRows) {
    if (!optionsBy.has(o.meeting_id)) optionsBy.set(o.meeting_id, []);
    const pick = optionMoment.pickFor(zone, o.starts_at);
    optionsBy.get(o.meeting_id).push({
      id: Number(o.id), day: pick.day, time: o.all_day || o.daypart ? null : pick.time,
      part: o.daypart || null, allDay: Boolean(o.all_day),
      by: o.added_by === null ? null : Number(o.added_by), slot: o.slot_text, startsAt: o.starts_at,
      answers: o.answers || {},
    });
  }
  const byMeeting = new Map();
  for (const p of parts) {
    if (!byMeeting.has(p.meeting_id)) byMeeting.set(p.meeting_id, []);
    // What this person has actually said about when they can make it. Their
    // OWN constraints come back whole, including the private ones — they wrote
    // them; anybody else's are filtered to what they agreed to share, the same
    // projection meetings.getStatus makes. This page must not be the one place
    // a private note leaks out of.
    const said = String(p.user_id) === String(userId)
      ? meetingsDomain.constraintTexts(p.constraints)
      : meetingsDomain.shareableTexts(p.constraints);
    byMeeting.get(p.meeting_id).push({
      id: p.user_id,
      name: p.first_name,
      avatar: p.avatar,
      // Three values, never two. "Has not answered" must stay distinguishable
      // from "answered, cannot make it", or the confirm gate reads silence as
      // a refusal — which is the one mistake this whole screen is built to
      // avoid making out loud.
      answer: p.state === 'confirmed_current' ? 'y'
        : p.state === 'declined_current' ? 'n' : '',
      left: p.state === 'opted_out',
      // A fourth thing the tri-state cannot hold: answered, and neither yes
      // nor no. She said "not free until 22:00 — after that I can", and every
      // field above rendered her identical to somebody who never replied, so
      // the screen reported silence from a person who had spoken. `said` is
      // the sentence; `answered` is the bit the page needs to stop drawing
      // her as waiting. An empty array is "nothing said", never "not read" —
      // the two are different rows here and must stay different values.
      said,
      answered: p.state === 'confirmed_current' || p.state === 'declined_current'
        || said.length > 0,
    });
  }
  // The proposer's words stay the words (they are what everybody else read),
  // and a reader on another clock gets their own hour BESIDE them — "יום שבת
  // 26.9 20:00" was 10:00 for the man in Los Angeles, and nothing on this page
  // said so (`incidents.md`, "פנתרה: one time, four clocks"). `null` whenever
  // the clocks agree, the author's clock is unknown, or the words name no hour.
  const { slotMoment } = require('./meeting-fanout');
  const localOf = async (meetingId, slot) => {
    if (!slot) return null;
    const mo = await slotMoment(client, meetingId, slot);
    const local = meetingTime.readerSlot(
      { startsAt: mo.startsAtUtc, allDay: mo.allDay, daypart: mo.daypart, slot }, zone, mo.authorTz);
    return local ? local.short : null;
  };
  const locals = new Map();
  for (const m of meetings) {
    locals.set(m.id, {
      slot: await localOf(m.id, m.proposed_slot),
      confirmed: await localOf(m.id, m.confirmed_slot),
      slotReader: await slotReaderLabel(client, m.id, m.proposed_slot, m.proposed_start_at, zone, locale),
      confirmedReader: await slotReaderLabel(client, m.id, m.confirmed_slot, m.confirmed_start_at, zone, locale),
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
    slotLocal: locals.get(m.id).slot,
    confirmedLocal: locals.get(m.id).confirmed,
    // The same two moments in the words of an ENGLISH page (null for Hebrew,
    // and null whenever the words name no clock) — see slotReaderLabel.
    slotReader: locals.get(m.id).slotReader,
    confirmedReader: locals.get(m.id).confirmedReader,
    confirmedStartAt: m.confirmed_start_at,
    confirmedTime: m.confirmed_time,
    confirmedDay: m.confirmed_day === null ? null : Number(m.confirmed_day),
    // The minute between the last yes and the meeting being over. `settleIn`
    // is what is LEFT of it; `settlingOptionId` says which row is counting
    // down, so the page marks that one rather than guessing from the tally.
    settleIn: m.settle_in === null ? null : Number(m.settle_in),
    settlingOptionId: m.settling_option_id === null ? null : Number(m.settling_option_id),
    settledBy: m.settled_by === null ? null : Number(m.settled_by),
    // Whether this person may end it by hand. The same question the domain
    // asks, asked here only so the page knows whether to draw the control —
    // `settleNow` re-asks it whatever the page drew. Anybody in it may since
    // 2026-09-23 (nobody manages a coordination), and this list holds only
    // the ones they are in.
    canSettle: m.status === 'negotiating',
    // How many yeses this coordination calls enough, copied off the group when
    // it opened (migration 064) and its own ever since. `null` is no minimum,
    // which is every coordination in production today — the page draws no mark
    // for it rather than inventing one from the head count.
    quorumMin: m.quorum_min === null ? null : Number(m.quorum_min),
    participants: byMeeting.get(m.id) || [],
    options: optionsBy.get(m.id) || [],
    maxOptions: meetingsDomain.options.MAX_ACTIVE,
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
async function loadLeftMeetings(client, userId, zone, locale) {
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
  const left = rows.map((m) => ({ id: Number(m.id), title: m.title, youLeft: true }));
  // Settled meetings that have happened (or, for the text-only rows that
  // predate start times, settled a while ago). The mirror image of the
  // active-list rule in loadMeetings: what leaves there arrives here, so a
  // coordination never simply vanishes. Title and the words of the slot, no
  // tally and no way back in — it is over.
  const { rows: done } = await client.query(
    `SELECT m.id, m.title, m.confirmed_slot, m.confirmed_start_at
       FROM meetings m
       JOIN meeting_participants p ON p.meeting_id = m.id
      WHERE p.user_id = $1 AND p.state <> 'opted_out'
        AND m.status = 'confirmed'
        AND ((m.confirmed_start_at IS NOT NULL AND m.confirmed_start_at <= now() - interval '6 hours')
             OR (m.confirmed_start_at IS NULL AND m.updated_at <= now() - interval '3 days'))
      ORDER BY m.id DESC
      LIMIT 20`,
    [userId]
  );
  const out = left;
  for (const m of done) {
    // Only when there is one — a Hebrew page's row is exactly what it was.
    const slotReader = await slotReaderLabel(client, m.id, m.confirmed_slot, m.confirmed_start_at, zone, locale);
    out.push({
      id: Number(m.id), title: m.title, youLeft: false, settled: true, slot: m.confirmed_slot || '',
      ...(slotReader ? { slotReader } : {}),
    });
  }
  return out;
}

// When Olma may write, as the gate will actually read it — the same two domain
// calls the outbox worker makes, so the page cannot show a window or a quiet
// day the gate does not keep. `source` tells the page whether it is looking at
// something they chose or a default they were handed.
async function loadSchedule(client, user) {
  const win = await preferences.availabilityWindow(client, user.id);
  const quiet = await preferences.quietDays(client, user.id, { locale: user.locale, timezone: user.timezone });
  return {
    availability: { ...win.data.window, source: win.data.source },
    defaultWindow: preferences.DEFAULT_WINDOW,
    quietDays: quiet.data.days,
    quietDaysSource: quiet.data.source,
    holidaysQuiet: quiet.data.holidays,
    calendar: quiet.data.calendar,
    // Saturday in an Israeli zone is candle-lighting to havdalah, not a
    // calendar day (outbox/worker.js) — worth saying beside the chip.
    shabbatWindow: holidays.isIsrael(user.timezone),
  };
}

// What Olma knows about them: every active fact, newest first. The card holds
// the top ten; this page holds all of them, because it is where they come to
// see what is on file and take something off it.
async function loadFacts(client, userId) {
  const { rows } = await client.query(
    `SELECT id, category, fact, source, learned_at, prompt_key
       FROM user_facts
      WHERE user_id = $1 AND active = true AND (expires_at IS NULL OR expires_at > now())
      ORDER BY learned_at DESC, id DESC`, [userId]);
  return rows.map((r) => ({
    id: Number(r.id), category: r.category, fact: r.fact, source: r.source,
    learnedAt: r.learned_at, promptKey: r.prompt_key,
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
  const tasks = await loadTasks(client, userId, zone, user.calendar_sync_tasks);
  const friends = await loadFriends(client, userId);
  const integrations = await loadIntegrations(client, userId);
  // What the page may OFFER, as distinct from what is already connected. Only
  // one entry so far and it earns its place: connecting a mailbox is behind an
  // allowlist (mail.requireMailAccess), so for almost everybody Gmail is a
  // service on a connected account that still cannot be switched on. Without
  // this the page would draw it as available and find out only on the tap.
  // One read, two gates: mail is an allowlist, and so is ringing from this
  // page. Neither field it fetches ever reaches the payload below.
  const gateUser = await gateIdentity(client, userId);
  const mailGate = await mail.requireMailAccess(client, gateUser);
  const callAllowed = await voice.pageCallAllowed(client, gateUser);
  const callAttempts = callAllowed ? await voice.attemptsRemaining(client, gateUser.id) : null;
  const channels = await loadChannels(client, userId);
  const contacts = await loadContacts(client, userId);
  const groups = await loadGroups(client, userId);
  const meetings = await loadMeetings(client, userId, zone, user.locale);
  const liveSuggestions = await suggestions.liveFor(client, userId);
  const meetingsLeft = await loadLeftMeetings(client, userId, zone, user.locale);
  const schedule = await loadSchedule(client, user);
  const knownFacts = await loadFacts(client, userId);
  const prompts = await factPrompts.pending(client, userId, user.locale);
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
      // Whether Olma chases a reminder they did not answer. Off for everybody
      // until they say otherwise (migration 072).
      reminderNudge: user.reminder_nudge === true,
      // Migration 068. NULL is "not said", and the page shows it as unset
      // rather than guessing a form of address for them.
      gender: user.gender,
      birthDate: user.birth_date,
      assistantGender: user.assistant_gender,
      joinedOn: user.joined_on,
      digestTimes: user.digest_times ? user.digest_times.split(',') : [],
      // Told once what dropping a task onto another does (migration 069).
      nestTipSeen: Boolean(user.nest_tip_seen),
      // The character they picked (migration 094); NULL draws the seed.
      avatar: user.avatar || null,
    },
    schedule,
    facts: knownFacts,
    factPrompts: prompts,
    channels,
    contacts,
    groups,
    tasks: tasks.open,
    archived: tasks.archived,
    // One concrete proposal about their own list, or null — and null is the
    // usual answer. The page renders nothing at all for null, which is the
    // owner's rule for this feature: no filler, no forced suggestion. Read
    // only; the pass that WRITES these is a job (domain/task-suggestions.js),
    // because this function reads and nothing else.
    suggestion: liveSuggestions[0] || null,
    // …and the rest of what is ready, at most MAX_LIVE (3). ONE is still
    // shown; this is what the "הצעת Ai" button moves through, and it is here
    // rather than behind an action because three rows are cheaper to send
    // than a round trip is to build.
    suggestions: liveSuggestions,
    friends,
    integrations,
    available: {
      mail: mailGate.ok,
      call: {
        allowed: callAllowed,
        attemptsUsed: callAttempts ? callAttempts.used : 0,
        attemptsLimit: voice.CALL_ATTEMPTS_LIMIT,
        requested: callAllowed ? Boolean(gateUser.voice_more_requested_at) : false,
      },
    },
    meetings,
    meetingsLeft,
  });
}

module.exports = { load, SOURCE_CAPS, KNOWN_CATEGORIES };
