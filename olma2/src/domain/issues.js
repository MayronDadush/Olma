'use strict';
// One table for bugs / edge cases / feature requests / friction — absorbs
// v1's separate feature_requests. Agents self-log alongside user reports;
// friction ("user hit the same wall three times") is a first-class category.
const { ok, err } = require('./results');
const audit = require('./audit');

const CATEGORIES = ['bug', 'edge_case', 'feature_request', 'friction'];
const SOURCES = ['user_reported', 'agent_detected'];
const STATUSES = ['new', 'triaged', 'fixed', 'wontfix'];

// The eval user's runs must not reach the operator's issue list. The nightly
// suite replays real past incidents, and several of them END in a correct
// refusal — the school essay, the finance explainer — whose doctrine says to
// log a feature_request. So every night the same scenarios filed the same
// rows again, and by 2026-09-03 SEVEN of the eight open issues were the test
// account talking to itself: five "write a 300-word essay on Herzl", two
// "explain prime vs variable interest". The one real issue (a leaked identity
// token) was one row in eight.
//
// That is the detection-layer-nobody-trusts failure this repo has recorded
// repeatedly, arriving from the direction nobody watched: the eval user is
// documented as sealed off — every sweep skips it, the outbox gate drops its
// rows — and report_issue was simply never given that seal.
//
// It returns ok, exactly as the outbox gate DROPS rather than errors: the
// scenario under test asserts the agent made this call, and turning a correct
// refusal into a tool error would fail the eval for the opposite of the
// reason it exists. Nothing is written, and `dropped` says so out loud rather
// than pretending a row exists.
async function isEvalReporter(client, reporterId) {
  if (!reporterId) return false;
  const { rows } = await client.query(`SELECT is_eval FROM users WHERE id = $1`, [reporterId]);
  return rows[0] ? rows[0].is_eval === true : false;
}

async function reportIssue(client, reporterId, { category, source, title, detail, relatedEntityType, relatedEntityId }) {
  if (!CATEGORIES.includes(category)) return err('invalid', `category must be one of ${CATEGORIES.join('|')}`);
  if (!SOURCES.includes(source)) return err('invalid', `source must be one of ${SOURCES.join('|')}`);
  if (!title || !title.trim()) return err('invalid', 'title required');
  // Validation runs FIRST: a malformed call from the eval user is still a bug
  // in the doctrine under test, and swallowing it would hide a real failure.
  if (await isEvalReporter(client, reporterId)) return ok({ issue: null, dropped: 'eval_user' });
  const { rows } = await client.query(
    `INSERT INTO issues (category, source, reporter_id, title, detail, related_entity_type, related_entity_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [category, source, reporterId || null, title.trim(), detail || null,
     relatedEntityType || null, relatedEntityId || null]
  );
  await audit.record(client, reporterId, 'issue.reported', {
    issueId: rows[0].id, category, source,
  });
  return ok({ issue: rows[0] });
}

async function setStatus(client, issueId, status) {
  if (!STATUSES.includes(status)) return err('invalid', `status must be one of ${STATUSES.join('|')}`);
  const { rows } = await client.query(
    `UPDATE issues SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [issueId, status]
  );
  if (!rows[0]) return err('not_found', 'issue not found');
  return ok({ issue: rows[0] });
}

async function listIssues(client, { status, category, limit } = {}) {
  const { rows } = await client.query(
    `SELECT i.*, u.first_name AS reporter_first_name, u.phone AS reporter_phone
     FROM issues i LEFT JOIN users u ON u.id = i.reporter_id
     WHERE ($1::text IS NULL OR i.status = $1)
       AND ($2::text IS NULL OR i.category = $2)
     ORDER BY i.created_at DESC LIMIT $3`,
    [status || null, category || null, limit || 100]
  );
  return ok({ issues: rows });
}

module.exports = { CATEGORIES, SOURCES, STATUSES, reportIssue, setStatus, listIssues, isEvalReporter };
