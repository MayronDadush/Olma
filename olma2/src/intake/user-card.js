'use strict';
// USER.md rendered from the DB — the identity card the gateway injects into
// the agent's context every turn.
//
// Design rule this file exists to enforce (decided 2026-08-19): anything the
// system knows about a person is written into their card BY THE SYSTEM, as a
// side effect of the tool call that learned it — never left for the agent to
// remember to write. Before this file, USER.md was written once at
// provisioning and then never again; verified live: every active user's card
// still said "First name: unknown" while the users row knew their name, so
// every turn opened by telling the agent it didn't know the person.
//
// Contract with provisioning: everything BEFORE the first "## " heading is
// the renderer's; everything FROM the first "## " on is preserved verbatim.
// That protects the pending-intake sections seedWorkspace appends (which the
// agent processes on its first real turn and then removes) from being wiped
// by a re-render that lands in between.
const fs = require('node:fs');
const path = require('node:path');

// Tool names whose success makes the card stale. Kept here, next to the
// renderer, so adding a card field and adding its trigger are one edit.
const CARD_TOOLS = new Set([
  'set_my_name', 'set_my_timezone', 'set_my_language',
  'set_digest_preferences', 'remember_preference', 'forget_preference',
  // A fact stated outright mid-conversation shows up in the card immediately,
  // the same turn — it should not have to wait for the extraction job to run.
  'remember_fact', 'forget_fact',
  // Calendar and connection state live on the card too (see renderCard), so
  // the calls that change them refresh it. Connecting a calendar happens in
  // the OAuth callback (an HTTP route, not a tool) — the dashboard calls
  // refreshUserCard there itself.
  'disconnect_calendar',
  'respond_to_connection_request', 'revoke_connection', 'set_contact_label',
  // The address book is on the card as a count, because the whole point of
  // saving a contact is that nobody is ever asked for that number again — and
  // the agent only knows the book is worth checking if the card says so.
  // The two bulk-import tools move that same count, often by a lot — the
  // Google OAuth callback that actually connects the sync has nothing to
  // refresh (see the dashboard route: connecting alone changes no card
  // field), only the import running here does.
  'save_contact', 'forget_contact', 'import_google_contacts', 'import_contacts_file',
]);

// How many facts the card carries. This text is injected on every single turn,
// so the cut is a running cost, not a display choice; importance ordering in
// topFacts is what makes a fixed, small K survivable.
const CARD_FACT_LIMIT = 10;

function renderCard(user, prefs, facts = [], extras = {}) {
  const lines = ['# User', ''];
  lines.push(`First name: ${user.first_name || 'unknown'}`);
  if (user.last_name) lines.push(`Last name: ${user.last_name}`);
  lines.push(`Language: ${user.locale || 'he'}`);
  lines.push(`Timezone: ${user.timezone || 'unknown'}${user.timezone_confirmed ? '' : ' (unconfirmed — confirm when natural)'}`);
  lines.push(user.digest_times
    ? `Daily digest: ${user.digest_times} (${user.digest_scope || 'summary'})`
    : 'Daily digest: not set up — offer it once their list has real content');
  // State the agent otherwise burns a tool call to discover — or worse,
  // forgets exists. Both failure modes were observed live: calendar_status
  // called on every confirmation, and an agent asking a user for the phone
  // number of a friend it had approved one minute earlier.
  if (extras.calendar !== undefined) {
    lines.push(extras.calendar
      ? `Calendar: connected (${extras.calendar})`
      : 'Calendar: not connected');
  }
  if (extras.connections !== undefined) {
    lines.push(extras.connections > 0
      ? `Connections: ${extras.connections} active — resolve people by name via list_my_connections before ever asking for a phone number`
      : 'Connections: none yet');
  }
  if (extras.contacts) {
    lines.push(`Address book: ${extras.contacts} saved — look a person up with list_my_contacts instead of asking for their number`);
  }
  if (prefs.length) {
    lines.push('', 'Learned preferences:');
    for (const p of prefs) lines.push(`- ${p.key}: ${p.value}`);
  }
  if (facts.length) {
    lines.push('', 'What you know about them:');
    for (const f of facts) lines.push(`- [${f.category}] ${f.fact}`);
  }
  return lines.join('\n') + '\n';
}

// Re-render one user's card. Best-effort by design: this runs AFTER the tool
// call's transaction committed, so it must never throw back into the tool
// path — a card that lags one call behind is annoying, a failed tool call
// because of a file write is a real bug.
async function refreshUserCard(pool, userId) {
  try {
    const { rows: users } = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
    const user = users[0];
    if (!user || !user.workspace_path) return false;
    const file = path.join(user.workspace_path, 'USER.md');
    if (!fs.existsSync(user.workspace_path)) return false; // test users, foreign box
    const { rows: prefs } = await pool.query(
      `SELECT key, value FROM user_preferences WHERE user_id = $1 ORDER BY key`, [userId]
    );
    const facts = await require('../domain/facts').topFacts(pool, userId, CARD_FACT_LIMIT);
    const { rows: cal } = await pool.query(
      `SELECT access_level FROM integrations
       WHERE user_id = $1 AND provider = 'google_calendar' AND status = 'connected'`, [userId]
    );
    const { rows: conn } = await pool.query(
      `SELECT count(*)::int AS n FROM connections
       WHERE status = 'active' AND (requester_id = $1 OR target_id = $1)`, [userId]
    );
    const { rows: book } = await pool.query(
      `SELECT count(*)::int AS n FROM user_contacts WHERE user_id = $1`, [userId]
    );
    const extras = {
      calendar: cal[0] ? cal[0].access_level : false,
      connections: conn[0].n,
      contacts: book[0].n,
    };
    let tail = '';
    try {
      const current = fs.readFileSync(file, 'utf8');
      const cut = current.indexOf('\n## ');
      if (cut >= 0) tail = current.slice(cut + 1);
    } catch { /* no card yet — render fresh */ }
    fs.writeFileSync(file, renderCard(user, prefs, facts, extras) + (tail ? '\n' + tail : ''));
    return true;
  } catch (e) {
    console.error(`[user-card] refresh failed for user ${userId}: ${e.message}`);
    return false;
  }
}

module.exports = { refreshUserCard, renderCard, CARD_TOOLS };
