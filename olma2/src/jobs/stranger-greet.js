'use strict';
// The repair half of `config_guard.checkUnansweredStrangers`.
//
// On 2026-10-07 three new people wrote to Olma inside twenty minutes and two
// of them heard nothing at all: the WhatsApp plugin accepted each first
// message and completed it 10-20ms later without handing it to anything, so
// no session was ever opened and no greeter ever saw them. The guard named
// them — half an hour later, on a dashboard, to the owner — and the person
// themselves was left with a message read by nobody (`incidents.md`, "The
// first message that reached nobody").
//
// So a lane with no session is ANSWERED here, on the raw pipe, with ONE
// sentence: who is writing (an AI, as the opening says on its first line) and
// that their message did not arrive. It is a repair job and is built to be the
// most sceptical thing on its path (`.claude/rules/turns-and-replies.md`):
//
//   - It reads the same two stores the guard reads, and either one unreadable
//     is a skipped tick, never "nobody has a session".
//   - The SESSION is the discriminator, as in the guard: a stranger the
//     greeter answered has one and no user row. The session list is read a
//     SECOND time right before the sends, so a greeter turn that opened while
//     this tick was reading `users` is never talked over.
//   - A `users` row skips unless it is a `pending` row nobody has ever spoken
//     to. Pending rows come from two very different places: ones WE wrote
//     first (an invite's intro, the waitlist's "we are open", a room's cold
//     invite — all outbox kinds in `outbox/gate.PENDING_USER_KINDS`; a game
//     code's answer, which stamps `opening_sent_at`), whose lane may be only
//     our own echo; and `groups.ensureRosterUsers`, which mints a row from a
//     number merely SEEN in a group. The second kind never heard from us, so
//     a lane on that number is them writing — and somebody who found Olma
//     through a group she is in is exactly the joiner this exists for.
//   - Only a lane FIRST heard inside `WINDOW_MS`. This is a repair for now,
//     not a sweep of history — the store holds lanes from weeks ago — and it
//     is also what keeps the people greeted by hand before this shipped out.
//   - Only once the lane has been quiet `SETTLE_MS`, so a greeter turn that is
//     simply slow to open its session is never raced.
//   - NOT the owner's opening. When they write again the greeter answers in a
//     brand-new conversation and opens with that copy, as it does for
//     everybody (`intake/intake-workspace.js`); sending it here too was a
//     second introduction a minute apart (`incidents.md`, "Two
//     introductions"). The privacy line and `opening_sent_at` therefore stay
//     the greeter's, on the path that already stamps them.
//   - Whatever `registration_open` says. The sentence promises nothing but
//     that we are listening; with registration closed the greeter answers
//     their resend with the waitlist, which is still an answer.
//   - Once per number for ever. The claim row is INSERTed and COMMITTED
//     before the send, so a restart mid-send greets nobody twice; a failed
//     send is left failed, not retried, and the guard goes on reporting them.
const { isRealPhone, lookupTimezone } = require('../domain/phone-timezone');
const templates = require('../domain/message-templates');
const { PENDING_USER_KINDS } = require('../outbox/gate');
const audit = require('../domain/audit');

const WINDOW_MS = 60 * 60 * 1000;
const SETTLE_MS = 3 * 60 * 1000;

const digitsOf = (phone) => String(phone || '').replace(/[^\d]/g, '');

// In the language their number suggests: the greeter answers a text-less
// message in English, and a dropped message is exactly that, so the dialling
// code is the only evidence of language there is.
function greetingFor(phone, overrides) {
  const lang = (lookupTimezone(phone) || {}).lang || 'en';
  return templates.textFor(templates.keyFor('lost_first_message', lang), overrides);
}

// Digits of every `users` row that is NOT a stranger: anybody past pending,
// and a pending row we have already said something to (see the header).
async function knownPhones(pool) {
  const { rows } = await pool.query(
    `SELECT u.phone FROM users u
      WHERE u.phone IS NOT NULL
        AND (u.status <> 'pending'
             OR u.opening_sent_at IS NOT NULL
             OR u.privacy_link_sent_at IS NOT NULL
             OR EXISTS (SELECT 1 FROM outbox o
                         WHERE o.user_id = u.id AND o.kind = ANY($1::text[])))`,
    [[...PENDING_USER_KINDS]]);
  return new Set(rows.map((r) => digitsOf(r.phone)));
}

const sessionPeers = (seen) => {
  const out = new Set();
  for (const s of seen) if (s && s.peer) out.add(digitsOf(s.peer));
  return out;
};

// Pure: which peers are owed a greeting. `known` holds the digits of every
// `users` row, `withSession` every peer that has a gateway session.
function candidates(peers, { withSession, known, greeted, now }) {
  const out = [];
  for (const p of peers) {
    if (!p || !p.phone || !isRealPhone(p.phone)) continue;
    const digits = digitsOf(p.phone);
    if (!(p.firstAt > 0) || now - p.firstAt > WINDOW_MS) continue;
    if (!(p.lastAt > 0) || now - p.lastAt < SETTLE_MS) continue;
    if (withSession.has(digits) || known.has(digits) || greeted.has(digits)) continue;
    out.push({ phone: `+${digits}`, firstAt: p.firstAt });
  }
  return out;
}

// deps: { listInboundPeers, listSessions, send, now } — the first two are the
// worker facade in production (registry.js), stubs in tests.
async function run(pool, deps) {
  const now = (deps.now || new Date()).getTime();
  const peers = await deps.listInboundPeers();
  if (!peers) return { skipped: 'gateway ingress store unreadable' };
  const fresh = peers.filter((p) => p && p.firstAt > 0 && now - p.firstAt <= WINDOW_MS);
  if (!fresh.length) return { greeted: 0 };

  const seen = await deps.listSessions();
  if (!seen) return { skipped: 'gateway session stores unreadable' };
  const withSession = sessionPeers(seen);

  const known = await knownPhones(pool);
  const prior = await pool.query('SELECT phone FROM stranger_greetings');
  const greeted = new Set(prior.rows.map((r) => digitsOf(r.phone)));

  let owed = candidates(fresh, { withSession, known, greeted, now });
  if (!owed.length) return { greeted: 0 };

  // Read again, now that there is somebody to write to: a session that opened
  // since the first read means the greeter has them, and the tick stands down
  // for that number. Unreadable now is the same skipped tick as before.
  const again = await deps.listSessions();
  if (!again) return { skipped: 'gateway session stores unreadable' };
  const late = sessionPeers(again);
  owed = owed.filter((c) => !late.has(digitsOf(c.phone)));
  if (!owed.length) return { greeted: 0 };

  const overrides = await templates.load(pool);
  const results = { greeted: 0, timedOut: 0, failed: 0 };
  for (const c of owed) {
    // The claim, committed on its own (pool.query autocommits) before the send.
    const claim = await pool.query(
      `INSERT INTO stranger_greetings (phone, lane_first_at) VALUES ($1, $2)
       ON CONFLICT (phone) DO NOTHING RETURNING phone`,
      [c.phone, new Date(c.firstAt)]);
    if (!claim.rows.length) continue;

    let res;
    try { res = await deps.send(c.phone, greetingFor(c.phone, overrides)); } catch (err) {
      res = { ok: false, error: String((err && err.message) || err) };
    }
    // A send that timed out has very likely gone out (rules/delivering.md), so
    // it is booked as said and never retried.
    const result = res && res.ok ? 'sent' : res && res.timedOut ? 'timed_out' : 'failed';
    await pool.query(
      `UPDATE stranger_greetings SET result = $2,
         sent_at = CASE WHEN $2 = 'failed' THEN NULL ELSE now() END
       WHERE phone = $1`, [c.phone, result]);
    await audit.record(pool, null, 'stranger.greeted', {
      phone: c.phone, result, error: result === 'failed' ? (res && res.error) || null : undefined,
    });
    if (result === 'sent') results.greeted += 1;
    else if (result === 'timed_out') results.timedOut += 1;
    else results.failed += 1;
  }
  return results;
}

module.exports = { run, candidates, greetingFor, WINDOW_MS, SETTLE_MS };
