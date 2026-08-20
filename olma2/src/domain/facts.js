'use strict';
// What Olma knows about a person, as structured rows — the replacement for the
// markdown memory layer that never actually got written (see migration 008).
//
// A preference is how to work with someone ("short answers", "no calls before
// 09:00") and lives in domain/preferences.js. A fact is who they are and what
// is going on in their life ("daughter Noa starts first grade in September").
// The split matters because they are consumed differently: preferences steer
// behaviour and some are read by the delivery gate, facts are context the agent
// reads to sound like it has been paying attention.
const { ok, err } = require('./results');
const audit = require('./audit');

// Validated here rather than by a DB CHECK — the same call connection features
// made, so adding a category stays a one-line change with no migration.
const KNOWN_FACT_CATEGORIES = ['work', 'family', 'people', 'health', 'plans', 'habits', 'context'];
// conversation = a job read it out of a transcript; user_stated = they said it
// to Olma's face; admin = an operator typed it into the dashboard. The third is
// worth its own value rather than borrowing 'user_stated': "the person told us"
// and "we decided this about the person" are not the same claim, and only one
// of them is evidence.
const KNOWN_SOURCES = ['conversation', 'user_stated', 'admin'];

// A fact is rendered as ONE line of USER.md, and USER.md has a structural
// contract: everything from the first "\n## " onward is treated as the
// preserved intake tail. A fact carrying a newline and a "## " would therefore
// forge that boundary and permanently swallow the rest of the card. So facts
// are flattened to a single line at the only door that writes them. The length
// cap is the second half of the same guard: this text goes into the agent's
// context on every single turn, so an essay here is paid for forever.
const MAX_FACT_CHARS = 200;

function cleanFact(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS);
}

function parseExpiry(value) {
  if (value == null || value === '') return { ok: true, value: null };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { ok: false };
  return { ok: true, value: d.toISOString() };
}

async function rememberFact(client, userId, { category, fact, importance, expiresAt, source } = {}) {
  if (!KNOWN_FACT_CATEGORIES.includes(category)) {
    return err('invalid', `category must be one of: ${KNOWN_FACT_CATEGORIES.join(', ')}`);
  }
  const text = cleanFact(fact);
  if (!text) return err('invalid', 'fact required');

  const imp = Number(importance || 1);
  if (![1, 2, 3].includes(imp)) return err('invalid', 'importance must be 1, 2 or 3');

  const src = source || 'conversation';
  if (!KNOWN_SOURCES.includes(src)) return err('invalid', `source must be one of: ${KNOWN_SOURCES.join(', ')}`);

  const expiry = parseExpiry(expiresAt);
  if (!expiry.ok) return err('invalid', 'expires_at must be a valid ISO datetime');

  const { rows } = await client.query(
    `INSERT INTO user_facts (user_id, category, fact, importance, source, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [userId, category, text, imp, src, expiry.value]
  );
  await audit.record(client, userId, 'fact.remembered', { factId: Number(rows[0].id), category, importance: imp });
  return ok({ fact: rows[0] });
}

// Soft delete: the row stays, it just stops being retrieved. Someone correcting
// Olma is itself worth keeping, and a hard DELETE throws that away.
async function forgetFact(client, userId, factId) {
  const { rows } = await client.query(
    `UPDATE user_facts SET active = false, updated_at = now()
     WHERE id = $1 AND user_id = $2 AND active = true RETURNING id, category`,
    [factId, userId]
  );
  if (!rows[0]) return err('not_found', 'no active fact with that id');
  await audit.record(client, userId, 'fact.forgotten', { factId: Number(rows[0].id) });
  return ok({ factId: Number(rows[0].id) });
}

// Active, unexpired facts. `query` is a plain ILIKE — no embeddings by design,
// so this stays free to run and adds no always-on dependency.
async function listFacts(client, userId, { category, query } = {}) {
  const params = [userId];
  let sql = `SELECT id, category, fact, importance, source, expires_at, learned_at
               FROM user_facts
              WHERE user_id = $1 AND active = true
                AND (expires_at IS NULL OR expires_at > now())`;
  if (category) {
    if (!KNOWN_FACT_CATEGORIES.includes(category)) {
      return err('invalid', `category must be one of: ${KNOWN_FACT_CATEGORIES.join(', ')}`);
    }
    params.push(category);
    sql += ` AND category = $${params.length}`;
  }
  if (query && String(query).trim()) {
    params.push(`%${String(query).trim()}%`);
    sql += ` AND fact ILIKE $${params.length}`;
  }
  sql += ' ORDER BY importance DESC, learned_at DESC';
  const { rows } = await client.query(sql, params);
  return ok({ facts: rows });
}

// What goes into USER.md. Importance first, then recency — so a core fact from
// a month ago outranks an ordinary one from this morning, which is the whole
// reason importance exists.
async function topFacts(client, userId, k = 10) {
  const limit = Math.max(1, Math.min(Number(k) || 10, 50));
  const { rows } = await client.query(
    `SELECT id, category, fact, importance, learned_at FROM user_facts
      WHERE user_id = $1 AND active = true
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY importance DESC, learned_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

module.exports = {
  rememberFact, forgetFact, listFacts, topFacts,
  KNOWN_FACT_CATEGORIES, KNOWN_SOURCES, MAX_FACT_CHARS, cleanFact,
};
