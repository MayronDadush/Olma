'use strict';
// People Olma has only ever SEEN, on a WhatsApp room's member list, do not stay
// on file for ever (compliance review 2026-09-28; the privacy page states it).
//
// Since 2026-09-25 `groups.ensureRosterUsers` mints a `users` row
// (`status = 'pending'`) from a number on a roster, so a room can ask them. They
// never agreed to anything, and nothing aged those rows out. Two rules, both
// run daily from the retention sweep:
//
//   1. A roster-born row is deleted once the person is in no room any more
//      (every membership left more than `leftDays` ago), or once it is
//      `pendingDays` old and they still have not written. The delete cascades
//      to everything hung on the row (an unanswered cold invite, a participant
//      row they could never answer through); `chat_group_members.user_id` is
//      SET NULL.
//   2. A member row for somebody who left, and who is nobody Olma talks to
//      (no user, or a pending one), is deleted `leftDays` after they left.
//
// And `ensureRosterUsers` does not mint the row again for somebody the room has
// seen for longer than `pendingDays` (`mintable`), or rule 1 would delete a row
// the next ten-second pass puts straight back. The member row itself stays
// while they are IN the room: it is the room's own list, the one every member
// can see, and the room's coordination counts it.
//
// "Roster-born" is structural, never a guess from a missing column: pending,
// never wrote by either door (`last_inbound_at`, `opening_sent_at`), never
// provisioned, no connection on either side and no `invited_by_connection_id`
// (which is how `invites.ensurePendingUser`'s invited strangers look), and at
// least one member row. An invited stranger who is also in a room keeps their
// row: somebody asked for them by name.
const flags = require('./flags');
const audit = require('./audit');

const DEFAULT_PENDING_DAYS = 60;
const DEFAULT_LEFT_DAYS = 7;

async function daysFlag(client, key, fallback) {
  const v = Number(await flags.getFlag(client, key) ?? fallback);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

async function limits(client) {
  return {
    pendingDays: await daysFlag(client, 'roster_pending_days', DEFAULT_PENDING_DAYS),
    leftDays: await daysFlag(client, 'roster_left_days', DEFAULT_LEFT_DAYS),
  };
}

const ROSTER_BORN = `
  u.status = 'pending' AND NOT u.is_eval
  AND u.last_inbound_at IS NULL AND u.opening_sent_at IS NULL
  AND u.agent_id IS NULL AND u.onboarded_at IS NULL
  AND u.invited_by_connection_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM connections c WHERE c.target_id = u.id OR c.requester_id = u.id)
  AND EXISTS (SELECT 1 FROM chat_group_members m WHERE m.user_id = u.id)`;

async function expireRoster(client) {
  const { pendingDays, leftDays } = await limits(client);
  const users = await client.query(
    `DELETE FROM users u
      WHERE ${ROSTER_BORN}
        AND (u.created_at < now() - make_interval(days => $1)
             OR NOT EXISTS (SELECT 1 FROM chat_group_members m
                             WHERE m.user_id = u.id
                               AND (m.left_at IS NULL OR m.left_at >= now() - make_interval(days => $2))))
      RETURNING u.id`,
    [pendingDays, leftDays]);
  const members = await client.query(
    `DELETE FROM chat_group_members m
      WHERE m.left_at < now() - make_interval(days => $1)
        AND (m.user_id IS NULL
             OR EXISTS (SELECT 1 FROM users u WHERE u.id = m.user_id AND u.status = 'pending'))
      RETURNING m.phone`,
    [leftDays]);
  // Counts only: the point is that the numbers are gone. Actor null, as in
  // ensureRosterUsers: nobody did this.
  if (users.rowCount || members.rowCount) {
    await audit.record(client, null, 'group.roster_expired',
      { users: users.rowCount, members: members.rowCount });
  }
  return { rosterUsersExpired: users.rowCount, rosterMembersExpired: members.rowCount };
}

// Whether `ensureRosterUsers` may mint a row for this phone off THIS room: not
// once the room has seen them for `pendingDays` without a word. Reads the room's
// own member row, so a first sighting (no row yet) is always mintable.
async function unmintable(client, groupId, phones) {
  if (!phones.length) return new Set();
  const { pendingDays } = await limits(client);
  const { rows } = await client.query(
    `SELECT phone FROM chat_group_members
      WHERE group_id = $1 AND phone = ANY($2)
        AND first_seen_at < now() - make_interval(days => $3)`,
    [groupId, phones, pendingDays]);
  return new Set(rows.map((r) => r.phone));
}

module.exports = { expireRoster, unmintable, DEFAULT_PENDING_DAYS, DEFAULT_LEFT_DAYS };
