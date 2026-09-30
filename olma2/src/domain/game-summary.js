'use strict';
// A game night's settlement, sent to the people who played it by CODE
// (games/, 2026-09-30). The owner's first night closed and the model wrote its
// own summary — "מירון → יוסי 25 ₪" — and in a Hebrew line that arrow points at
// מירון, so it read as the wrong person paying. A relay instruction on the
// tool's result (games PR #649) asks the model to copy the text; this makes the
// copy nobody's job: the text gamesd drew goes out on the raw pipe, word for
// word, the way a reminder does (`rules/delivering.md`, "What is the same every
// time is DRAWN").
//
// gamesd draws BOTH languages and this module never composes a word. Which one
// a person reads is decided at delivery off their locale, exactly as
// `proactive-text.localizedKey` decides a template — the language is a fact
// about the reader at the moment of sending, not about the night.
//
// Who hears it: every player row gamesd linked to one of our users, and of
// those only somebody who holds the `games` pack and is active. The pack is
// the same line `identity_resolve` draws for the tools: a person without it
// was never shown a game night, and a settlement is part of the pack, not a
// message of Olma's own. Everyone else at the table reads it on the page.
const crypto = require('crypto');
const { enqueue } = require('../outbox/enqueue');

const KIND = 'game_summary';
const MAX_TEXT = 2000;
const MAX_PLAYERS = 30;       // gamesd's own cap on a night (games/src/store.js LIMITS)
// A settlement held for a quiet day is still the settlement on Sunday
// morning; a week later it is old news the page already carries.
const EXPIRES_MS = 3 * 24 * 3600_000;

// One row per person per SETTLEMENT, not per night: a count that reopens and
// closes again on different numbers is a new settlement and is sent again,
// and the same numbers closing twice are not.
function keyFor(nightId, userId, texts) {
  const h = crypto.createHash('sha256').update(`${texts.he}\n\0${texts.en}`).digest('hex').slice(0, 16);
  return `${KIND}:${nightId}:${userId}:${h}`;
}

// → { ok: false, error } for anything malformed, never a partial queue.
function validate({ nightId, texts, userIds } = {}) {
  const id = Number(nightId);
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: 'bad nightId' };
  const he = texts && typeof texts.he === 'string' ? texts.he : '';
  const en = texts && typeof texts.en === 'string' ? texts.en : '';
  // Both, and never empty: an empty text here would reach the deliverer as a
  // row with no raw text, and that is the MODEL path (rawPipeTextFor → null).
  if (!he.trim() || !en.trim()) return { ok: false, error: 'texts.he and texts.en are both required' };
  if (he.length > MAX_TEXT || en.length > MAX_TEXT) return { ok: false, error: 'text too long' };
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(Number))]
    .filter((u) => Number.isSafeInteger(u) && u > 0);
  if (!ids.length || ids.length > MAX_PLAYERS) return { ok: false, error: 'bad userIds' };
  return { ok: true, nightId: id, texts: { he, en }, userIds: ids };
}

// → { ok, queued: [userId], skipped: [userId] }. `skipped` is a person gamesd
// linked who holds no pack or is not active; a row already queued for the same
// settlement counts as queued, since it is going out.
async function queue(client, params, { now = new Date() } = {}) {
  const v = validate(params);
  if (!v.ok) return v;
  const { rows } = await client.query(
    `SELECT u.id FROM users u
       JOIN user_packs p ON p.user_id = u.id AND p.pack = 'games'
      WHERE u.id = ANY($1::bigint[]) AND u.status = 'active'`, [v.userIds]);
  const holders = new Set(rows.map((r) => Number(r.id)));
  const queued = [];
  for (const userId of v.userIds) {
    if (!holders.has(userId)) continue;
    await enqueue(client, {
      userId, kind: KIND,
      payload: { nightId: v.nightId, texts: v.texts },
      // A RESULT, like a meeting's confirmation: never behind the daily budget.
      urgency: 'urgent',
      expiresAt: new Date(now.getTime() + EXPIRES_MS),
      idempotencyKey: keyFor(v.nightId, userId, v.texts),
    });
    queued.push(userId);
  }
  return { ok: true, queued, skipped: v.userIds.filter((u) => !holders.has(u)) };
}

// The invite a host forwards to their group (domain/game-shortcut.js, stage
// 4א): the second message after "פתחתי את הערב", separate so that forwarding
// it carries nothing meant for the host alone. It rides this module because it
// is the same thing to deliver — both languages drawn at queue time, sent as
// drawn on the raw pipe, the reader's locale choosing — and one list of game
// kinds is what the gate, the worker and the raw pipe each test.
const INVITE_KIND = 'game_invite';
const KINDS = new Set([KIND, INVITE_KIND]);
// An invite is the answer to a message they sent a moment ago; hours later it
// is a stale link to a night that may be over.
const INVITE_EXPIRES_MS = 12 * 3600_000;

async function queueInvite(client, { userId, code, texts }, { now = new Date() } = {}) {
  const he = texts && typeof texts.he === 'string' ? texts.he : '';
  const en = texts && typeof texts.en === 'string' ? texts.en : '';
  if (!he.trim() || !en.trim()) return { ok: false, error: 'texts.he and texts.en are both required' };
  return enqueue(client, {
    userId, kind: INVITE_KIND,
    payload: { code: String(code || ''), texts: { he, en } },
    urgency: 'urgent',
    expiresAt: new Date(now.getTime() + INVITE_EXPIRES_MS),
    idempotencyKey: `${INVITE_KIND}:${String(code || '')}:${userId}`,
  });
}

// The raw pipe's text for a row of either kind (proactive-text.rawPipeTextFor).
function textFor(payload, locale) {
  const t = (payload && payload.texts) || {};
  const en = String(locale || '').trim().toLowerCase().startsWith('en');
  return String((en ? t.en : t.he) || t.he || t.en || '');
}

module.exports = { KIND, INVITE_KIND, KINDS, queue, queueInvite, validate, keyFor, textFor, EXPIRES_MS, INVITE_EXPIRES_MS };
