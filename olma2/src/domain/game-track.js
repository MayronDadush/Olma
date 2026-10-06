'use strict';
// The game-only track (owner, 2026-10-06). Somebody who reached Olma by
// sending a game night's code came for the night: the night's messages and
// the welcome reach them, and nothing the check-in ladder decides to say does
// (jobs/checkin.js). On 2026-10-03 three such people heard a day-one question
// in the middle of the game, and the summary, the welcome and a question
// about their country inside four minutes the next morning; none of them has
// written since.
//
// They leave the track by USING her for something that is not the game, and
// that is decided here, in code, never by a model:
//   * a tool that does something for them (LEAVING_TOOLS) ran successfully;
//   * they asked what she can do (the gateway hook's `abilities` verdict);
//   * they wrote anything else while no night of theirs is open or just
//     closed — a thanks, and a message code already answered (a game code,
//     "ערב משחק חדש", "שלח לי קישור"), never count.
// Leaving starts their day one at that moment (`users.game_track_left_at`;
// checkin.eligibleUsers counts from it), so the ladder they skipped is the one
// they get, once they have something for it to be about.
//
// Rooms are not on it (owner, 2026-10-06): a coordination in a room is
// already using her.

// What counts as using her. An allowlist, so a tool added later is "not
// leaving" until somebody decides — the failure is one more quiet week, never
// a sudden day-one ladder for somebody who only played. Reading tools
// (list_my_tasks, get_my_profile), the model's own housekeeping (turn_start,
// set_my_name, set_my_timezone, remember_preference) and a reply to somebody
// ELSE reaching them (respond_to_connection_request) are not on it.
const LEAVING_TOOLS = new Set([
  'add_task', 'add_tasks_bulk', 'set_task_reminder',
  'start_meeting_coordination', 'propose_meeting_slot', 'respond_to_meeting_slot',
  'request_connection', 'send_message_to_connection', 'share_task_with',
  'save_contact', 'import_contacts_file', 'start_contacts_connection',
  'start_calendar_connection', 'start_google_connection', 'create_calendar_event',
  'set_digest_preferences', 'subscribe_live_updates', 'call_me_on_the_phone',
  'render_schedule_card', 'generate_image', 'generate_video',
]);

// A night that closed this recently is still the night: "איך מעבירים לבר?"
// the next morning is about the game. Twelve hours covers a night that ends
// at one and a summary read at nine.
const AFTER_NIGHT_MS = 12 * 3600_000;

function onTrack(u) {
  return Boolean(u && u.game_track_at && !u.game_track_left_at);
}

// Whether a night from gamesd's `mine` (turn.gameNightsOf's shape) is still
// the evening: open, or closed inside AFTER_NIGHT_MS. `null` — gamesd could
// not be read — is treated as a night in progress: an unreadable game is
// never evidence they have moved on.
function nightInProgress(nights, now) {
  if (nights == null) return true;
  return nights.some((n) => n.status === 'open'
    || (n.closedAt && now - new Date(n.closedAt).getTime() < AFTER_NIGHT_MS));
}

// Why this message takes them off the track, or null. Pure: the caller hands
// over the hook's verdicts and the nights it already read.
function leavesOnMessage({ abilities = false, thanks = false, byCode = false, nights = null, now = Date.now() } = {}) {
  if (byCode) return null;
  if (abilities) return 'abilities';
  if (thanks) return null;
  return nightInProgress(nights, now) ? null : 'message';
}

// The same decision with the nights read only when they matter: a question
// about her and a thanks are settled without asking gamesd anything.
async function leavesOnTurn({ abilities = false, thanks = false } = {}, readNights, now = Date.now()) {
  if (abilities) return 'abilities';
  if (thanks) return null;
  return leavesOnMessage({ nights: await readNights(), now });
}

// Their nights from gamesd, or null when it could not be read. Unlike
// turn.gameNightsOf, an empty list stays an empty list: "no night" and "could
// not tell" are the two answers this decision must not confuse.
const NIGHTS_TIMEOUT_MS = 300;
async function nightsOf(userId, mine) {
  try {
    const r = await mine({ userId }, { timeoutMs: NIGHTS_TIMEOUT_MS });
    return r && r.ok && Array.isArray(r.nights) ? r.nights : null;
  } catch {
    return null;
  }
}

function leavesOnTool(name) {
  return LEAVING_TOOLS.has(name) ? 'tool' : null;
}

// Put somebody on the track: the moment a game code made them a person.
// Never somebody already active — a code from an existing user is their own
// path (brokerd handleGameShortcut) and changes nothing about their ladder.
async function enter(client, userId) {
  const { rowCount } = await client.query(
    `UPDATE users SET game_track_at = now()
      WHERE id = $1 AND game_track_at IS NULL AND status = 'pending'`, [userId]);
  return rowCount > 0;
}

// Take them off it. Idempotent: only the first reason is stamped.
async function leave(client, userId, reason, detail = {}) {
  const { rowCount } = await client.query(
    `UPDATE users SET game_track_left_at = now()
      WHERE id = $1 AND game_track_at IS NOT NULL AND game_track_left_at IS NULL`, [userId]);
  if (rowCount) {
    await require('./audit').record(client, userId, 'game_track.left', { reason, ...detail });
  }
  return rowCount > 0;
}

// The one read the callers need, so none of them selects the columns itself.
async function stateOf(client, userId) {
  const { rows: [u] } = await client.query(
    `SELECT game_track_at, game_track_left_at FROM users WHERE id = $1`, [userId]);
  return u || null;
}

module.exports = {
  LEAVING_TOOLS, AFTER_NIGHT_MS,
  onTrack, nightInProgress, leavesOnMessage, leavesOnTurn, leavesOnTool, nightsOf, enter, leave, stateOf,
};
