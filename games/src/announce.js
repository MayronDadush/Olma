'use strict';
// A night's count just closed: tell brokerd, which sends each linked player
// who holds the pack the settlement as drawn (olma2 domain/game-summary.js).
// The owner's first night was summarized by the model instead, and its arrow
// read backwards in Hebrew; since then the text nobody may rewrite is sent by
// code, and the model is told it went.
//
// It fires on the CLOSE, whichever door closed it — Olma's tools or a tap on
// the page — and never on a write to a night already closed. A count that
// reopens and closes on new numbers is a new settlement and goes again;
// brokerd's key is per settlement, so the same numbers twice are one message.
const { sendSummary } = require('./identity');
const { textsOf } = require('./summary');

// → brokerd's answer ({ ok, queued, skipped }), or { ok: true, queued: [] }
// when nobody at the table is one of Olma's users. Rejects if brokerd cannot
// be reached; the caller decides what that costs.
async function announceClose(pool, nightId, state, { send = sendSummary } = {}) {
  const { rows } = await pool.query(
    'SELECT DISTINCT user_id FROM players WHERE night_id = $1 AND user_id IS NOT NULL', [nightId]);
  if (!rows.length) return { ok: true, queued: [], skipped: [] };
  return send({ nightId, userIds: rows.map(r => Number(r.user_id)), texts: textsOf(state) });
}

module.exports = { announceClose };
