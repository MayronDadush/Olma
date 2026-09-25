'use strict';
// owner-messages — the log of what the owner asked Olma to say by hand, from
// the admin page's "לכתוב הודעה יזומה" (migration 089).
//
// It exists to be READ BACK by people (owner, 2026-09-24): every entry is a
// moment Olma could have noticed on her own, and a moment that keeps coming
// back is a feature to build in code. Nothing in this file reaches the model.
//
// Three things are learned after the fact, and only from something actually
// read — NULL is "not known yet", never "nothing happened" (CLAUDE.md,
// "Absence of evidence scored as evidence"):
//   sent_at    — from the outbox row, while it lasts (retention deletes it);
//   sent_text  — the first thing Olma wrote in the transcript after it went
//                out. The model words it at send time, so the transcript is
//                the only place the real sentence ever exists;
//   replied_at — the person's next message.received after it went out.
// Each is written once found, so the log outlives both the transcript and the
// routine audit rows it was read from.
const sessions = require('../channels/sessions');

// The model composes the message after the send is stamped, usually within
// seconds. A text later than this is more likely an answer to something else.
const SENT_TEXT_WINDOW_MS = 10 * 60 * 1000;
// Past this, a text that has not turned up is not going to.
const LOOK_BACK_DAYS = 3;

async function record(client, { userId, outboxId, instruction, urgency }) {
  await client.query(
    `INSERT INTO owner_messages (user_id, outbox_id, instruction, urgency)
     VALUES ($1, $2, $3, $4)`,
    [userId, outboxId || null, instruction, urgency === 'urgent' ? 'urgent' : 'normal']);
}

// The first assistant text in the window after `sentAt`, or null when the
// transcript could not be read or holds nothing that counts. A decision to
// stay quiet is not the sentence that went out.
function sentTextFrom(texts, sentAtMs) {
  if (!Array.isArray(texts)) return null;
  const hit = texts.find((t) => t.at >= sentAtMs && t.at <= sentAtMs + SENT_TEXT_WINDOW_MS
    && t.text.trim() && t.text.trim() !== 'NO_REPLY');
  return hit ? hit.text.trim() : null;
}

async function fillOutcomes(client, { scan = sessions.scanAssistantTextSince, now = new Date() } = {}) {
  // sent_at: copied while the outbox row still exists. A row the admin
  // cancelled is marked sent too, and never went anywhere — it stays NULL.
  await client.query(
    `UPDATE owner_messages m SET sent_at = o.sent_at
       FROM outbox o
      WHERE m.outbox_id = o.id AND m.sent_at IS NULL AND o.sent_at IS NOT NULL
        AND o.hold_reason IS DISTINCT FROM 'cancelled_by_admin'`);

  await client.query(
    `UPDATE owner_messages m SET replied_at = (
        SELECT min(a.created_at) FROM audit_log a
         WHERE a.actor_id = m.user_id AND a.event = 'message.received'
           AND a.created_at > m.sent_at)
      WHERE m.sent_at IS NOT NULL AND m.replied_at IS NULL`);

  const { rows } = await client.query(
    `SELECT m.id, m.sent_at, u.agent_id
       FROM owner_messages m JOIN users u ON u.id = m.user_id
      WHERE m.sent_at IS NOT NULL AND m.sent_text IS NULL AND u.agent_id IS NOT NULL
        AND m.sent_at > $1::timestamptz - make_interval(days => $2)
        AND m.sent_at < $1::timestamptz - make_interval(secs => $3)`,
    [now, LOOK_BACK_DAYS, SENT_TEXT_WINDOW_MS / 1000]);
  for (const r of rows) {
    const sentAtMs = new Date(r.sent_at).getTime();
    let texts;
    try { texts = await scan(r.agent_id, sentAtMs - 1); } catch { texts = null; }
    const text = sentTextFrom(texts, sentAtMs);
    if (text) {
      await client.query(`UPDATE owner_messages SET sent_text = $2 WHERE id = $1`, [r.id, text]);
    }
  }
}

async function list(client, limit = 100) {
  const { rows } = await client.query(
    `SELECT m.*, u.first_name, u.last_name, u.phone, u.timezone,
            o.hold_reason AS outbox_hold, (o.id IS NOT NULL) AS outbox_exists,
            (o.sent_at IS NOT NULL) AS outbox_sent,
            (SELECT count(*) FROM owner_messages)::int AS total
       FROM owner_messages m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN outbox o ON o.id = m.outbox_id
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $1`, [limit]);
  return rows;
}

// ---- what it taught, and what it might become --------------------------------
// Both written by the owner, by hand, from the section. Nothing reads them but
// people: an idea is a place to collect evidence until he decides to go
// through it, never a queue anything acts on.
const IDEA_STATUSES = ['open', 'building', 'built', 'dropped'];
const clip = (v, n) => String(v || '').trim().slice(0, n) || null;

async function setNote(client, id, { insight, ideaId }) {
  const idea = Number(ideaId) || null;
  await client.query(
    `UPDATE owner_messages SET insight = $2,
            idea_id = (SELECT id FROM feature_ideas WHERE id = $3)
      WHERE id = $1`,
    [Number(id) || 0, clip(insight, 1000), idea]);
}

// A new idea when no id is given. A status outside the list, or an empty
// title, changes nothing — an unreadable form must never blank a row.
async function saveIdea(client, { id, title, detail, status }) {
  const t = clip(title, 200);
  if (!t) return null;
  const s = IDEA_STATUSES.includes(status) ? status : null;
  if (id) {
    await client.query(
      `UPDATE feature_ideas SET title = $2, detail = $3, status = COALESCE($4, status), updated_at = now()
        WHERE id = $1`,
      [Number(id) || 0, t, clip(detail, 2000), s]);
    return Number(id);
  }
  const { rows } = await client.query(
    `INSERT INTO feature_ideas (title, detail, status) VALUES ($1, $2, COALESCE($3, 'open')) RETURNING id`,
    [t, clip(detail, 2000), s]);
  return rows[0].id;
}

// Open ones first, then by how much evidence they have: the idea with the
// most messages behind it is the one worth talking about next.
async function listIdeas(client) {
  const { rows } = await client.query(
    `SELECT f.*, count(m.id)::int AS evidence
       FROM feature_ideas f LEFT JOIN owner_messages m ON m.idea_id = f.id
      GROUP BY f.id
      ORDER BY array_position(ARRAY['building','open','built','dropped'], f.status),
               count(m.id) DESC, f.created_at DESC`);
  return rows;
}

module.exports = {
  record, fillOutcomes, list, sentTextFrom, setNote, saveIdea, listIdeas,
  IDEA_STATUSES, SENT_TEXT_WINDOW_MS, LOOK_BACK_DAYS,
};
