'use strict';
// The per-user POST handlers and the redirect validator.
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const { GROUPS, SECTIONS } = require('./sections/index');
const { CANCELLED_BY_ADMIN } = require('./sections/planned');
const prefsDomain = require('../../../domain/preferences');
const factsDomain = require('../../../domain/facts');
const auditDomain = require('../../../domain/audit');
const { enqueue } = require('../../../outbox/enqueue');
const pauseDomain = require('../../../domain/pause');

// Only ever back to a user page this dashboard itself renders. `back` arrives
// inside a form body, so without this check any admin action could be turned
// into an open redirect by anyone who can get the operator to submit a form.
function safeBack(value) {
  const v = value || '';
  if (/^\/user\?id=\d+$/.test(v)) return v;
  // A save from a section lands back on that section (the page reloads with
  // only the first group open; a #fragment opens the enclosing group). Only
  // ids this page actually renders — never an arbitrary fragment.
  const m = /^\/#([a-z-]+)$/.exec(v);
  if (m && (SECTIONS.some((x) => x.id === m[1]) || GROUPS.some((g) => 'g-' + g.id === m[1]))) return v;
  return '/';
}

const LOCAL_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const localDt = (v) => (LOCAL_DT.test(v || '') ? v : null);

// Every per-user admin edit lives here. Returns the id of the user whose
// USER.md now needs rewriting, or null when the edit cannot have changed it.
//
// Writes go through the domain functions wherever one exists rather than
// straight SQL, so an operator's change is validated exactly like the agent's
// and lands in the same audit trail. The extra admin.* row on top records who
// the change came from, which the domain call alone would not show.
async function handleUserEdit(client, pathname, body) {
  const id = Number(body.id) || 0;

  if (pathname === '/outbox/cancel') {
    // Never DELETE. The row carries the idempotency_key that stops the sweep
    // which produced it from producing it again; removing the row would simply
    // bring the message back on the next tick. Marking it handled is what
    // actually cancels it.
    const { rows } = await client.query(
      `UPDATE outbox SET sent_at = now(), hold_reason = $2
        WHERE id = $1 AND sent_at IS NULL RETURNING user_id, kind`,
      [id, CANCELLED_BY_ADMIN]);
    if (rows[0]) {
      await auditDomain.record(client, rows[0].user_id, 'admin.outbox.cancelled',
        { outboxId: id, kind: rows[0].kind });
    }
    return null;
  }

  if (pathname === '/outbox/reschedule') {
    const release = localDt(body.release_after);
    const expires = localDt(body.expires_at);
    // The operator typed a wall-clock time in the PERSON's timezone. Postgres
    // does the conversion in both directions, so there is no offset arithmetic
    // here to get wrong when the clocks change.
    const { rows } = await client.query(
      `UPDATE outbox o SET
          release_after = ($2::timestamp AT TIME ZONE COALESCE(u.timezone, 'UTC')),
          expires_at    = ($3::timestamp AT TIME ZONE COALESCE(u.timezone, 'UTC')),
          -- clearing the hold puts it back in front of the gate: a row held for
          -- budget is skipped forever otherwise, so rescheduling it would look
          -- like it worked and change nothing.
          hold_reason = NULL
        FROM users u
        WHERE o.id = $1 AND o.user_id = u.id AND o.sent_at IS NULL
        RETURNING o.user_id`,
      [id, release, expires]);
    if (rows[0]) {
      await auditDomain.record(client, rows[0].user_id, 'admin.outbox.rescheduled',
        { outboxId: id, releaseAfter: release, expiresAt: expires });
    }
    return null;
  }

  if (pathname === '/outbox/new') {
    const userId = Number(body.user_id) || 0;
    const instruction = String(body.instruction || '').trim().slice(0, 500);
    if (!userId || !instruction) return null;
    const release = localDt(body.release_after);
    const { rows: tz } = await client.query(
      `SELECT COALESCE(timezone, 'UTC') AS tz FROM users WHERE id = $1`, [userId]);
    if (!tz[0]) return null;
    const { rows: when } = await client.query(
      `SELECT ($1::timestamp AT TIME ZONE $2) AS at`, [release, tz[0].tz]);
    // No idempotencyKey: this is a one-off an operator wrote, not a sweep's
    // output, so there is nothing for a key to deduplicate against — and a
    // fixed one would silently swallow the second message they meant to send.
    await enqueue(client, {
      userId, kind: 'checkin',
      payload: { checkinInstruction: instruction, rung: 'admin' },
      urgency: body.urgency === 'urgent' ? 'urgent' : 'normal',
      releaseAfter: when[0].at,
    });
    await auditDomain.record(client, userId, 'admin.outbox.queued',
      { urgency: body.urgency === 'urgent' ? 'urgent' : 'normal', releaseAfter: release });
    return null;
  }

  const userId = Number(body.user_id) || 0;
  if (!userId) return null;

  if (pathname === '/users/resume') {
    // Deliberately one-way from here: an operator can bring someone BACK (they
    // asked, through some channel that is not their own agent), but cannot
    // pause them. Pausing is the person's own decision, made in their own
    // conversation; an admin button for it would be a way to silence a user
    // without their say.
    const res = await pauseDomain.resumeUser(client, userId);
    if (!res.ok) return null;
    await auditDomain.record(client, userId, 'admin.user_resumed', {
      remindersRearmed: res.data.rearmed.length,
    });
    return userId;
  }

  if (pathname === '/prefs/set') {
    const res = await prefsDomain.remember(client, userId, String(body.key || '').trim(), body.value);
    if (!res.ok) return null;
    await auditDomain.record(client, userId, 'admin.preference.set', { key: res.data.key });
    return userId;
  }

  if (pathname === '/prefs/delete') {
    const res = await prefsDomain.forget(client, userId, String(body.key || '').trim());
    if (!res.ok) return null;
    await auditDomain.record(client, userId, 'admin.preference.deleted', { key: res.data.key });
    return userId;
  }

  if (pathname === '/facts/add') {
    const res = await factsDomain.rememberFact(client, userId, {
      category: body.category,
      fact: body.fact,
      importance: Number(body.importance) || 1,
      expiresAt: DATE_ONLY.test(body.expires_at || '') ? `${body.expires_at}T00:00:00Z` : null,
      // Not 'user_stated': the person did not say this, an operator decided it.
      source: 'admin',
    });
    if (!res.ok) return null;
    await auditDomain.record(client, userId, 'admin.fact.added',
      { factId: Number(res.data.fact.id), category: res.data.fact.category });
    return userId;
  }

  if (pathname === '/facts/delete') {
    // Soft delete through the domain, so a correction stays on the record.
    const res = await factsDomain.forgetFact(client, userId, id);
    if (!res.ok) return null;
    await auditDomain.record(client, userId, 'admin.fact.deleted', { factId: id });
    return userId;
  }

  return null;
}

// ---- page + server ----------------------------------------------------------

module.exports = { safeBack, LOCAL_DT, DATE_ONLY, localDt, handleUserEdit };
