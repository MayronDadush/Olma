'use strict';
// The three moves a room coordination did not have (owner, 2026-09-28): a
// private nudge to somebody who has answered nothing, the offer to drop it
// when the room has gone quiet, and closing it quietly when nobody took the
// offer up. Chosen by the simulator (`src/sim/coordination-sim.js`, PR #571):
// the offer turned every silent death into a clean ending and talked 1-3% of
// rooms out of a coordination they would have closed; one nudge added 8-11
// points of confirmations at a cost nobody has measured, because Olma has
// never sent one. So both run behind `coordination_policy`, and `shadow` —
// decide, record, send nothing — comes before `live` in any room.
//
// Pure: everything it needs is handed in, and the sweep does the writing.

const HOUR = 3600_000;

const DEFAULTS = {
  // Twelve hours with nothing from anybody, after the chase: the simulator's
  // pick, and the same on every assumption it was stress-tested on.
  dropAfterQuietH: 12,
  // How long the offer stands before the coordination closes by itself. In
  // the room's own hours — the sweep only acts while it may speak.
  dropGraceH: 6,
  // A nudge, once, to somebody whose invite REACHED them this long ago and who
  // has answered nothing.
  nudgeAfterH: 6,
};

// What the flag says for THIS room: off unless it is named, and a room is
// named by its id or its WhatsApp jid.
function modeFor(flag, room) {
  if (!flag || typeof flag !== 'object' || !['shadow', 'live'].includes(flag.mode)) return 'off';
  const rooms = Array.isArray(flag.rooms) ? flag.rooms.map(String) : [];
  if (flag.allRooms === true) return flag.mode;
  return rooms.includes(String(room.id)) || rooms.includes(String(room.external_id)) ? flag.mode : 'off';
}

function paramsOf(flag) {
  const p = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = flag && Number(flag[k]);
    if (Number.isFinite(v) && v > 0) p[k] = v;
  }
  return p;
}

const ms = (t) => (t == null ? null : new Date(t).getTime());

// The next move, or null. `s`:
//   chaseAt          when the room was chased (null: not yet — no offer before it)
//   dropOfferAt      when the offer was said, or null
//   lastActivityAt   the newest answer, table change or member message in the room
//   enough           whether the leading time already has what it needs
//   silent           [{ userId, askedAt }] — asked, delivered, answered nothing
//   nudged           [userId] — already nudged about this coordination
//   earliestStartAt  the first time on the table
function nextMoves(s, nowMs, params = DEFAULTS) {
  const moves = [];
  const quietSince = ms(s.lastActivityAt);
  const offerAt = ms(s.dropOfferAt);

  // The offer stood its grace and nobody answered it: close quietly.
  if (offerAt != null && (quietSince == null || quietSince <= offerAt)
      && nowMs - offerAt >= params.dropGraceH * HOUR) {
    return [{ kind: 'drop_close' }];
  }
  // The offer, once: after the chase, with no direction on the table and
  // nothing from anybody for a while. Somebody answering after it lapses it,
  // and it is never said twice.
  if (offerAt == null && s.chaseAt != null && !s.enough
      && quietSince != null && nowMs - quietSince >= params.dropAfterQuietH * HOUR
      && nowMs - ms(s.chaseAt) >= params.dropAfterQuietH * HOUR) {
    moves.push({ kind: 'drop_offer' });
  }
  const nudged = new Set((s.nudged || []).map(Number));
  const due = (s.silent || []).filter((p) => !nudged.has(Number(p.userId))
    && ms(p.askedAt) != null && nowMs - ms(p.askedAt) >= params.nudgeAfterH * HOUR);
  // Never a nudge about a thing that has already started, and never beside
  // the offer: "shall I drop it?" and "when can you?" in one breath contradict
  // each other, so once the offer is said (or being said) nobody is nudged.
  const started = ms(s.earliestStartAt) != null && ms(s.earliestStartAt) <= nowMs;
  if (due.length && !started && offerAt == null && !moves.length) moves.push({ kind: 'nudge', userIds: due.map((p) => Number(p.userId)) });
  return moves;
}

module.exports = { nextMoves, modeFor, paramsOf, DEFAULTS };
