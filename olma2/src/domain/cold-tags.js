'use strict';

// How often a room may TAG somebody who has never written to Olma (owner,
// 2026-10-02, the poker room). Three of its thirteen had never written: the
// opening line tagged them and each had one private invite, and then the chase
// — which names only people she has written to — left them out, so a room one
// short of its five never reminded the three people who could have made it.
//
// A tag in the room is a friend asking "are you coming?", which is the thing
// that works; tagged on every line in every room, somebody who never asked for
// her reads it as spam. So, across EVERY room:
//
//   * at most one tag per person every three days, and
//   * after three tags without a word from them, none at all.
//
// "Until they write" needs no column: the moment they write they are connected
// (groups.isConnected), drop out of `outsidePhones`, and this rule no longer
// reads them. Keyed by the phone, because a LID never becomes a `users` row.
//
// A tag the rule holds back is never a line held back: the line still goes
// out, and still COUNTS them ("ועוד N"); it only does not notify them.

const EVERY_MS = 3 * 24 * 3600_000;
const MAX_UNANSWERED = 3;

// The subset of `phones` that may be tagged at `now`. An empty input asks
// nothing of the database.
async function allowed(client, phones, now = new Date()) {
  const list = [...new Set((phones || []).filter(Boolean))];
  if (!list.length) return new Set();
  const { rows } = await client.query(
    `SELECT phone, count(*)::int AS n, max(tagged_at) AS last
       FROM room_cold_tags WHERE phone = ANY($1::text[]) GROUP BY phone`, [list]);
  const seen = new Map(rows.map((r) => [r.phone, r]));
  return new Set(list.filter((p) => {
    const r = seen.get(p);
    if (!r) return true;
    return r.n < MAX_UNANSWERED && now.getTime() - new Date(r.last).getTime() >= EVERY_MS;
  }));
}

async function record(client, { phones, groupId, meetingId, lineKind, now = new Date() }) {
  const list = [...new Set((phones || []).filter(Boolean))];
  for (const phone of list) {
    await client.query(
      `INSERT INTO room_cold_tags (phone, group_id, meeting_id, line_kind, tagged_at)
       VALUES ($1, $2, $3, $4, $5)`, [phone, groupId, meetingId || null, lineKind, now]);
  }
  return list.length;
}

module.exports = { allowed, record, EVERY_MS, MAX_UNANSWERED };
