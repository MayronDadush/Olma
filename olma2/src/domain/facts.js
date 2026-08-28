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
const { namesAMoment } = require('./datetime');

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

// Two doctrine rules made structural (2026-08-27), refused at the one door
// every writer shares — the live tool, the extraction job, the dashboard:
//
// - A phone number never belongs in a fact or a preference; contacts and
//   connections are how people are tracked (structured + tool-backed, not
//   prose the model might mis-recall). Nine-plus digits allowing the usual
//   phone separators — a date ("2026-08-26", 8 digits) or an hour range
//   ("10:00-20:00", broken by the colons) never reaches nine.
const PHONE_LIKE_RE = /(?:\d[\s\-().]*){9,}/;
function phoneLike(text) { return PHONE_LIKE_RE.test(String(text || '')); }

// - A fact that IS a bare name statement ("שמו חיים.") is the exact row that
//   left users nameless on every screen while their own card asserted the
//   name two lines down — a name belongs in set_my_name, where invitations
//   and digests can actually use it. Deliberately narrow, same reasoning as
//   weekdayClash: a false positive here refuses a real fact, so only the
//   nothing-but-a-name shape is caught. "שמו של הכלב רקסי" (a pet), and any
//   sentence that carries more than the name, pass untouched.
//   The copula and the article are both optional in Hebrew, and every variant
//   is the same sentence: "שם שלו הוא מירון" slipped past the first version of
//   this guard and landed on a live card that already printed
//   `First name: מירון` one line above it.
const NAME_STATEMENT_RES = [
  /^(?:שמו|שמה)\s+(?!של\s)(?:הוא\s+|היא\s+)?\S+(?:\s+\S+)?$/,
  /^ה?שם\s+של(?:ו|ה|י)\s+(?:הוא\s+|היא\s+)?\S+(?:\s+\S+)?$/,
  /^קוראים\s+ל(?:ו|ה|י)\s+\S+(?:\s+\S+)?$/,
  /^(?:his|her|my|their)\s+name\s+is\s+\S+(?:\s+\S+)?$/i,
];
function bareNameStatement(text) {
  const t = String(text || '').replace(/[.!]+$/, '').trim();
  return NAME_STATEMENT_RES.some((re) => re.test(t));
}

// - A fact that describes OLMA'S OWN STATE is not biography. "היומן שלו מחובר
//   כעת ל-Google Calendar עם גישת read_write" sat on a live card while
//   renderCard printed `Calendar: connected (read_write)` two lines above it:
//   a duplicate that costs a Top-K slot today, and a CONTRADICTION the day he
//   disconnects, because nothing invalidates a fact when the state it copied
//   changes. The card, integrations, connections and preferences are the live
//   copies; a fact is a frozen one. Narrow by construction — a system noun AND
//   a connection/configuration verb together, or the access-level literals,
//   which mean nothing else. "יש לו פגישה ביומן" and "הוא מנותק רגשית" each
//   carry only one half and pass.
const SYSTEM_NOUN_RE = /יומן|calendar|דייג['\u05F3\u2019]?סט|digest|סיכום יומי|אולמה|olma/i;
const SYSTEM_STATE_RE = /מחובר|מחוברת|מחוברים|מנותק|נותק|חיבר|חיברה|מוגדר|הוגדר|connected|disconnected/i;
const ACCESS_LEVEL_RE = /read_write|read_only/i;
function systemState(text) {
  const t = String(text || '');
  return ACCESS_LEVEL_RE.test(t) || (SYSTEM_NOUN_RE.test(t) && SYSTEM_STATE_RE.test(t));
}

function parseExpiry(value) {
  if (value == null || value === '') return { ok: true, value: null };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { ok: false };
  return { ok: true, value: d.toISOString() };
}

async function rememberFact(client, userId, { category, fact, importance, expiresAt, source } = {}) {
  if (!KNOWN_FACT_CATEGORIES.includes(category)) {
    return err('invalid', `category must be one of: ${KNOWN_FACT_CATEGORIES.join(', ')}`, { reason: 'category' });
  }
  const text = cleanFact(fact);
  if (!text) return err('invalid', 'fact required');
  if (phoneLike(text)) {
    return err('invalid', 'a phone number never goes into a fact — save the person with save_contact, and keep the fact about them without the digits', { reason: 'phone' });
  }
  if (bareNameStatement(text)) {
    return err('invalid', 'a name is profile, not a fact — call set_my_name instead (an unconfirmed guess is fine); stored as a fact it leaves every screen showing a phone number', { reason: 'name' });
  }
  if (systemState(text)) {
    return err('invalid', "that is Olma's own state, not something about the person — it is already on their card and in the integrations/connections tables, and a copy here goes stale the moment it changes", { reason: 'system_state' });
  }

  const imp = Number(importance || 1);
  if (![1, 2, 3].includes(imp)) return err('invalid', 'importance must be 1, 2 or 3');

  const src = source || 'conversation';
  if (!KNOWN_SOURCES.includes(src)) return err('invalid', `source must be one of: ${KNOWN_SOURCES.join(', ')}`);

  const expiry = parseExpiry(expiresAt);
  if (!expiry.ok) return err('invalid', 'expires_at must be a valid ISO datetime');
  // A fact anchored to a moment must say when it stops being one. See
  // datetime.namesAMoment for what counts and, more importantly, what does not
  // — a recurring weekday ("ביום חמישי עובד מהבית") is durable and passes.
  if (!expiry.value && namesAMoment(text)) {
    return err('invalid', 'this names a specific date or day ("היום", "29.8") — set expires_at to when it stops being true, or, if it is something they need to DO, save it with add_task instead', { reason: 'needs_expiry' });
  }

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
  phoneLike, bareNameStatement, systemState,
};
