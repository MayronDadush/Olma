'use strict';
// One table for bugs / edge cases / feature requests / friction — absorbs
// v1's separate feature_requests. Agents self-log alongside user reports;
// friction ("user hit the same wall three times") is a first-class category.
const { ok, err } = require('./results');
const audit = require('./audit');

const CATEGORIES = ['bug', 'edge_case', 'feature_request', 'friction'];
const SOURCES = ['user_reported', 'agent_detected'];
const STATUSES = ['new', 'triaged', 'fixed', 'wontfix'];

async function reportIssue(client, reporterId, { category, source, title, detail, relatedEntityType, relatedEntityId }) {
  if (!CATEGORIES.includes(category)) return err('invalid', `category must be one of ${CATEGORIES.join('|')}`);
  if (!SOURCES.includes(source)) return err('invalid', `source must be one of ${SOURCES.join('|')}`);
  if (!title || !title.trim()) return err('invalid', 'title required');
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

module.exports = { CATEGORIES, SOURCES, STATUSES, reportIssue, setStatus, listIssues };
