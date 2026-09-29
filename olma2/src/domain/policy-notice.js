'use strict';
// Telling the people Olma already serves that the privacy policy and the terms
// changed (compliance review 2026-09-28). A new policy binds nobody who was
// never shown it, and every person here joined before this one existed.
//
// Built the way the intro video is (domain/intro-video.js): one outbox row per
// person, queued by a script the owner runs, delivered by the gate in each
// person's hours, idempotent per person per version. Unlike the video it has
// words, and they are the owner's fixed words on the raw pipe
// (`proactive-text.rawPipeTextFor`, template `policy_update`), never a model's:
// a notice whose wording a model chose is not the notice that was approved.
//
// Same audience as the video, and the same gate treatment: the paused are left
// out (a pause means nothing at all), somebody with a missed check-in or two
// still gets it. Whether a legal notice should reach a paused person anyway is
// the owner's call and a lawyer's question, and is not made here.
const { enqueue } = require('../outbox/enqueue');

const KIND = 'policy_update';
// One id per published version of the pages. A later change is a new id and a
// new row per person, never a re-send of this one.
const VERSIONS = { '2026-09-28': { url: 'https://allma.world/privacy' } };

const AUDIENCE = `status = 'active' AND onboarded_at IS NOT NULL AND paused_at IS NULL AND NOT is_eval`;

async function audience(client) {
  const { rows } = await client.query(
    `SELECT count(*) FILTER (WHERE ${AUDIENCE})::int AS eligible,
            count(*) FILTER (WHERE ${AUDIENCE} AND lower(coalesce(locale, '')) LIKE 'he%')::int AS he,
            count(*) FILTER (WHERE status = 'active' AND onboarded_at IS NOT NULL AND paused_at IS NOT NULL AND NOT is_eval)::int AS paused
       FROM users`);
  const r = rows[0];
  return { eligible: r.eligible, he: r.he, en: r.eligible - r.he, paused: r.paused };
}

// Urgent, as the video is: the daily budget would otherwise fold it into a
// digest, where a model would paraphrase it.
async function enqueueAll(client, version) {
  const v = VERSIONS[version];
  if (!v) throw new Error(`unknown policy version: ${version}`);
  const { rows } = await client.query(`SELECT id FROM users WHERE ${AUDIENCE} ORDER BY id`);
  let queued = 0;
  for (const u of rows) {
    const r = await enqueue(client, {
      userId: u.id, kind: KIND, urgency: 'urgent',
      payload: { version, url: v.url },
      idempotencyKey: `${KIND}:${version}:${u.id}`,
    });
    if (r.data.enqueued) queued += 1;
  }
  return { candidates: rows.length, queued };
}

// Counts only; nothing here names anybody.
async function stats(client, version) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS rows,
            count(*) FILTER (WHERE sent_at IS NOT NULL AND hold_reason IS NULL)::int AS delivered,
            count(*) FILTER (WHERE sent_at IS NULL)::int AS waiting,
            count(*) FILTER (WHERE sent_at IS NOT NULL AND hold_reason IS NOT NULL)::int AS dropped
       FROM outbox WHERE kind = $1 AND payload->>'version' = $2`, [KIND, version]);
  return rows[0];
}

module.exports = { KIND, VERSIONS, AUDIENCE, audience, enqueueAll, stats };
