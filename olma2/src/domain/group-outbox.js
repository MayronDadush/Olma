'use strict';
// The queue for everything Olma says to a ROOM (migration 055).
//
// Three things it does, and it is worth being clear which is which:
//
//   1. ENQUEUE happens inside the caller's transaction, beside the stamp that
//      records the sentence as said. Before this, the stamp was written after
//      the CLI returned — sixteen seconds later on a busy box — and a brokerd
//      restart in that gap said the same line twice (2026-09-07).
//   2. The UNIQUE `idempotency_key` is the real guarantee. Stamps can be lost
//      to a rollback, a bug, a hand-written UPDATE; a key that is already in
//      the table cannot be inserted a second time whatever else went wrong.
//   3. DELIVERY is one sender, claiming a row before it spawns anything, so a
//      process that dies mid-send leaves a row nobody will pick up again.
//
// What it deliberately does NOT do is decide. Whether a room may hear
// something at this hour is `jobs/groups.mayAnnounce`, and it stays with the
// code that knows what the sentence IS — a "there is a direction" line queued
// at 02:00 and released at 09:00 could be about a plan that was settled
// overnight, and the fix for that is to decide at 09:00, not to re-check a
// stale row. So the sweeps enqueue only what they mean to say NOW, and this
// queue's whole job is to say it exactly once.
const templates = require('./message-templates');
const text = require('./proactive-text');

// Rendered at DELIVERY, from the owner's current wording — never at enqueue.
// The same rule the reminder rungs follow: a sentence he rewords while a row
// is queued goes out in the new words.
function renderRow(row, wording) {
  const p = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) || {};
  switch (row.kind) {
    case 'intro': return text.renderGroupIntro(wording);
    case 'opened': return text.renderGroupOpened(wording);
    case 'too_large': return text.renderGroupTooLarge(Number(p.maxMembers) || 25, wording);
    case 'gate_notice': return text.renderGroupGateNotice(
      { kind: p.kind, missing: Array.isArray(p.missing) ? p.missing : [] }, wording);
    case 'coordination': return text.renderGroupCoordination(p.line || {}, wording);
    default: return null;
  }
}

// `idempotencyKey` is not optional in practice — every caller passes one, and
// a row without one is a row that can be written twice. It stays nullable in
// the schema only because a NULL never collides in a UNIQUE index, which is
// the honest behaviour for "this line is deliberately repeatable".
//
// A key already in the table is not an error and not a retry: it is the answer
// "that has already been said", which is exactly what the caller wanted to
// know. `queued: false` says so.
async function enqueue(client, { groupId, kind, payload = {}, replyTo = null, idempotencyKey = null }) {
  if (!groupId || !kind) return { ok: false, error: 'invalid' };
  const { rows } = await client.query(
    `INSERT INTO group_outbox (group_id, kind, payload, reply_to, idempotency_key)
          VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
    [groupId, kind, JSON.stringify(payload || {}), replyTo, idempotencyKey]);
  return { ok: true, data: { row: rows[0] || null, queued: Boolean(rows[0]) } };
}

// Is a sentence of this kind still owed to the room? The gate sweep asks it
// about the introduction: "nice to meet you" and "some of you have not signed
// up" must never arrive together, and since the greeting is now DECIDED one
// pass and DELIVERED by another, "I greeted them just now" is no longer a
// thing a single pass can know on its own.
async function pending(client, groupId, kind) {
  const { rows } = await client.query(
    `SELECT 1 FROM group_outbox
      WHERE group_id = $1 AND kind = $2 AND sent_at IS NULL LIMIT 1`, [groupId, kind]);
  return rows.length > 0;
}

// One row, claimed. `claimed_at IS NULL` in the WHERE is what makes a claim
// final: a row still held is never picked up again, so a sender that died with
// the message already delivered cannot cause a second delivery. The cost of
// that choice is a room that occasionally misses a line, which is the trade
// this whole feature has made everywhere else too.
//
// `attempts` is a separate question — how many times this row has been picked
// up, ever — and only `markFailed` gives a claim back. Keeping the two apart is
// what lets a REFUSED send be retried once while a CRASHED one is never
// retried at all; one counter serving both meanings loses the count on every
// retry, and a row could then be refused for ever.
async function claim(client, id) {
  const { rows } = await client.query(
    `UPDATE group_outbox SET attempts = attempts + 1, claimed_at = now()
      WHERE id = $1 AND sent_at IS NULL AND claimed_at IS NULL
      RETURNING *`, [id]);
  return rows[0] || null;
}

async function markSent(client, id, { unconfirmed = false } = {}) {
  await client.query(
    `UPDATE group_outbox SET sent_at = now(), hold_reason = $2, last_error = NULL WHERE id = $1`,
    [id, unconfirmed ? 'unconfirmed' : null]);
}

// A send that came back a definite failure — the CLI ran and refused. That is
// not the crash case: nothing was delivered, so the row goes back on the queue
// exactly once. The second failure ends it, because a pipe that is broken now
// is broken for the next tick too and a queue that retries for ever is how a
// room gets a week-old sentence when the pipe comes back.
async function markFailed(client, id, error) {
  const { rows } = await client.query(
    `SELECT attempts FROM group_outbox WHERE id = $1`, [id]);
  const attempts = Number(rows[0] && rows[0].attempts) || 0;
  if (attempts >= 2) {
    await client.query(
      `UPDATE group_outbox SET sent_at = now(), hold_reason = 'abandoned', last_error = $2
        WHERE id = $1`, [id, String(error || '').slice(0, 500)]);
    return 'abandoned';
  }
  // The claim goes back, the attempt stays counted.
  await client.query(
    `UPDATE group_outbox SET claimed_at = NULL, last_error = $2 WHERE id = $1`,
    [id, String(error || '').slice(0, 500)]);
  return 'retry';
}

// Rows claimed by a sender that never came back. They are closed, not retried
// — see `claim`. Two minutes is comfortably longer than the CLI's own timeout,
// so this can only catch a process that actually went away.
const STALE_CLAIM_MS = 2 * 60 * 1000;

async function closeStaleClaims(client, now = new Date()) {
  const { rows } = await client.query(
    `UPDATE group_outbox SET sent_at = now(), hold_reason = 'unconfirmed'
      WHERE sent_at IS NULL AND claimed_at IS NOT NULL AND claimed_at < $1
      RETURNING id`, [new Date(now.getTime() - STALE_CLAIM_MS)]);
  return rows.length;
}

// The three states a send can be in, and a boolean for the callers that speak
// one: it went out, we do not know, or it definitely did not. 'unknown' is a
// send that blew the CLI's timeout — the gateway already has the message
// (channels/openclaw.js) — and it counts as SAID, because a room told the same
// thing twice is worse off than a room that missed one line.
function said(result) {
  if (result === 'unknown') return 'unknown';
  return result === true || result === 'sent' ? 'sent' : 'failed';
}

// The sender. `send(jid, body, opts) -> 'sent' | 'unknown' | 'failed' | bool`.
async function drainOnce(pool, deps = {}) {
  const now = deps.now || new Date();
  const out = { sent: 0, unconfirmed: 0, failed: 0, abandoned: 0, stale: 0 };
  out.stale = await closeStaleClaims(pool, now);

  const wording = await templates.load(pool);
  const { rows } = await pool.query(
    `SELECT o.id, o.kind, o.payload, o.reply_to, g.external_id
       FROM group_outbox o JOIN chat_groups g ON g.id = o.group_id
      WHERE o.sent_at IS NULL AND o.claimed_at IS NULL
      ORDER BY o.created_at
      LIMIT 20`);

  for (const row of rows) {
    const claimed = await claim(pool, row.id);
    if (!claimed) continue;
    const body = renderRow(row, wording);
    if (!body) { await markSent(pool, row.id, { unconfirmed: false }); continue; }
    let delivery = 'failed';
    let error = null;
    try {
      delivery = said(await deps.send(row.external_id, body,
        row.reply_to ? { replyTo: row.reply_to } : undefined));
    } catch (e) {
      error = e.message;
    }
    if (delivery === 'sent') { await markSent(pool, row.id); out.sent++; continue; }
    if (delivery === 'unknown') {
      await markSent(pool, row.id, { unconfirmed: true });
      out.unconfirmed++;
      continue;
    }
    const verdict = await markFailed(pool, row.id, error || 'send refused');
    if (verdict === 'abandoned') out.abandoned++; else out.failed++;
  }
  return out;
}

module.exports = {
  enqueue, pending, claim, markSent, markFailed, closeStaleClaims, drainOnce, renderRow, said,
  STALE_CLAIM_MS,
};
