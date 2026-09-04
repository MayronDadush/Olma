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
  'set_my_name', 'set_my_timezone', 'set_my_language', 'set_assistant_persona',
  // Paused state belongs on the card: a paused person who writes must not be
  // met with an offer to set up a daily digest.
  'pause_olma', 'resume_olma',
  'set_digest_preferences', 'remember_preference', 'forget_preference',
  // A fact stated outright mid-conversation shows up in the card immediately,
  // the same turn — it should not have to wait for the extraction job to run.
  'remember_fact', 'forget_fact',
  // Calendar and connection state live on the card too (see renderCard), so
  // the calls that change them refresh it. Connecting a calendar happens in
  // the OAuth callback (an HTTP route, not a tool) — the dashboard calls
  // refreshUserCard there itself.
  'disconnect_calendar', 'disconnect_email',
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
  // The unconfirmed marker matches the timezone line below it, and for the
  // same reason: a guessed name reads as settled unless the card says
  // otherwise, and then nobody ever asks. "unknown" is the louder case —
  // spell out that it is the first thing to fix rather than a field to live
  // with, which is how it survived on four live cards at once.
  lines.push(user.first_name
    ? `First name: ${user.first_name}${user.name_confirmed ? '' : ' (unconfirmed — check it in passing, then set_my_name with confirmed: true)'}`
    : 'First name: unknown — ask what to call them and save it with set_my_name');
  if (user.last_name) lines.push(`Last name: ${user.last_name}`);
  lines.push(`Language: ${user.locale || 'he'}`);
  // Who the assistant is for THIS user — rendered only off the default.
  // The default (עולמה, feminine register) is already the doctrine every
  // agent carries, and repeating it on every turn for every user is cost.
  if (user.assistant_gender === 'male' || user.assistant_name) {
    const personaName = user.assistant_name || 'עולמה';
    lines.push(`Assistant persona: your name with them is "${personaName}"`
      + (user.assistant_name ? ' — use it, never עולמה' : '')
      + (user.assistant_gender === 'male'
        ? '; MASCULINE register — every self-referencing verb and adjective (אני בודק, שמח), no mixing'
        : ''));
  }
  // Top of the card, right under their name, because it changes what every
  // other line means: none of the settings below are running.
  if (user.paused_at) {
    lines.push('PAUSED — they asked Olma to stop reaching out. Answer them normally when '
      + 'they write, but never offer, pitch or schedule anything. Only if they ask to come '
      + 'back, call resume_olma.');
  }
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
  // Stated as what it is ALLOWED to do, not merely that it exists: an agent
  // that knows a mailbox is connected but not that it is read-only is one
  // offer away from promising to send a reply it cannot send.
  if (extras.mail !== undefined) {
    lines.push(extras.mail
      ? `Email: connected (${extras.mail}, read-only — search it with search_my_email when they ask; you cannot send, reply or delete, and you never browse it unasked)`
      : 'Email: not connected');
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
    // The list is the top CARD_FACT_LIMIT, and until this line nothing said
    // so — ten facts and a full stop read as everything on file, so the model
    // answered from the card and never reached for the rest. A truncation
    // nobody announces is the same mistake as a check that goes quiet: the
    // reader cannot tell "that is all there is" from "that is what fitted".
    const hidden = Math.max(0, (extras.factsTotal || facts.length) - facts.length);
    if (hidden) {
      lines.push(`- (+${hidden} more not shown here — list_my_facts for the rest,`
        + ' and always before telling them you do not know something)');
    }
  }
  // The overnight plan (jobs/planning.js). Briefing notes FOR the agent, never
  // a message to forward — weave it in when the conversation touches it, lead
  // the morning digest with it, never recite it unprompted. Rendered only
  // while fresh: yesterday's plan presented as today's is worse than none.
  // Paused users get no plan section — leaning forward is what they declined.
  if (extras.plan && !user.paused_at) {
    lines.push('', `Today's plan (built overnight — notes for YOU, not a message to send):`);
    lines.push(`${extras.plan.headline}`);
    for (const b of extras.plan.bullets) lines.push(`- ${b}`);
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
    // Counted rather than inferred from a limit+1 read: the card states the
    // number, and a number that is only ever "at least one" is not worth
    // printing. Same filter as topFacts, or the two disagree and the card
    // promises facts list_my_facts will not return.
    const { rows: factCount } = await pool.query(
      `SELECT count(*)::int AS n FROM user_facts
        WHERE user_id = $1 AND active = true
          AND (expires_at IS NULL OR expires_at > now())`, [userId]
    );
    const { rows: cal } = await pool.query(
      `SELECT access_level FROM integrations
       WHERE user_id = $1 AND provider = 'google_calendar' AND status = 'connected'`, [userId]
    );
    const { rows: mailRows } = await pool.query(
      `SELECT account_label FROM integrations
       WHERE user_id = $1 AND provider = ANY($2) AND status = 'connected'
       ORDER BY connected_at DESC NULLS LAST, id DESC LIMIT 1`,
      [userId, require('../domain/mail').PROVIDER_KEYS]
    );
    const { rows: conn } = await pool.query(
      `SELECT count(*)::int AS n FROM connections
       WHERE status = 'active' AND (requester_id = $1 OR target_id = $1)`, [userId]
    );
    const { rows: book } = await pool.query(
      `SELECT count(*)::int AS n FROM user_contacts WHERE user_id = $1`, [userId]
    );
    const { rows: planRows } = await pool.query(
      `SELECT headline, bullets, built_at FROM user_plans
        WHERE user_id = $1 AND built_at > now() - ($2 || ' hours')::interval`,
      [userId, String(require('../jobs/planning').PLAN_FRESH_HOURS)]
    );
    const extras = {
      calendar: cal[0] ? cal[0].access_level : false,
      mail: mailRows[0] ? (mailRows[0].account_label || 'connected') : false,
      connections: conn[0].n,
      contacts: book[0].n,
      factsTotal: factCount[0].n,
      plan: planRows[0]
        ? { headline: planRows[0].headline, bullets: planRows[0].bullets || [] }
        : null,
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
