'use strict';
// ── How many pictures Olma may start in a day ───────────────────────────────
//
// The owner's rule (2026-10-06), once every scheduled digest became a card
// whenever the list is long enough: at most TWO cards a day that Olma decided
// to send, at least THREE hours apart, so a person is never met by a stream of
// images. Past the budget the same list goes out as the drawn text block.
//
// It binds only a turn Olma started (`self-initiated`). A person who asks for
// their week has asked, and refusing to draw an answer would be the assistant
// arguing with them about what they wanted to see — the same carve-out the
// repeat guard makes.
//
// The ledger is `audit_log` (`card.drawn`), written by the one tool that draws
// a card, so a restart forgets nothing (the repeat guard is in-process and
// cannot). The window is a rolling 24 hours rather than a calendar day: it needs
// no timezone, and it cannot be gamed by the clock rolling over at midnight.
const audit = require('./audit');

const EVENT = 'card.drawn';
const MAX_PER_DAY = 2;
const MIN_GAP_MS = 3 * 3600_000;
const WINDOW_MS = 24 * 3600_000;

// Returns { ok: true } or { ok: false, reason: 'daily_cap' | 'too_soon', ... }.
async function check(client, userId, now = Date.now()) {
  const { rows } = await client.query(
    `SELECT created_at FROM audit_log
      WHERE actor_id = $1 AND event = $2 AND created_at > $3
      ORDER BY created_at DESC`,
    [userId, EVENT, new Date(now - WINDOW_MS)]
  );
  if (rows.length >= MAX_PER_DAY) return { ok: false, reason: 'daily_cap', drawn: rows.length };
  if (rows.length) {
    const age = now - new Date(rows[0].created_at).getTime();
    if (age < MIN_GAP_MS) return { ok: false, reason: 'too_soon', minutesAgo: Math.round(age / 60_000) };
  }
  return { ok: true };
}

// Only called once a card really exists on disk, for a turn Olma started.
function record(client, userId) {
  return audit.record(client, userId, EVENT, null);
}

module.exports = { check, record, EVENT, MAX_PER_DAY, MIN_GAP_MS, WINDOW_MS };
