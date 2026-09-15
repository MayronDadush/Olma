'use strict';
// groups — one section of the admin page (see ./index.js).
//
// The STATE here is read-only, on purpose: it is decided by the sweep from the
// gateway's own transcripts (jobs/groups.js), and an operator button that
// forced a group open would be a second writer to a gate whose whole promise
// is that it opens only when the last person has written to her. What the
// operator needs is to SEE it: which groups exist, who is still missing, and
// whether the sender gate is closed — the one thing the config file spells as
// an absent key.
//
// The one editable thing is the KIND and its numbers (migration 051), because
// that is a setting and not something the sweep derived: what sort of room it
// is, and how many people the thing it arranges needs. Olma asks the room once
// and this is where it gets fixed when the room never answered or answered
// wrongly. It goes through `groups.setKind` — validated and audited exactly
// like the room's own answer.
const { esc } = require('../../html');
const occ = require('../../../../intake/openclaw-config');
const { GREETER_AGENT_ID } = require('../../../../intake/provision-group');
const groupsDomain = require('../../../../domain/groups');

const STATE_LABEL = {
  locked: 'נעולה', open: 'פתוחה', too_large: 'גדולה מדי', retired: 'עזבה',
};

function gateLine(configPath) {
  let cfg;
  try { cfg = occ.loadConfig(configPath); } catch { return '<p class="dim">הגדרות השער לא נקראו.</p>'; }
  const acc = (cfg.channels && cfg.channels.whatsapp && cfg.channels.whatsapp.accounts
    && cfg.channels.whatsapp.accounts.default) || {};
  const policy = acc.groupPolicy || '(לא מוגדר)';
  const greeter = occ.hasAgent(cfg, GREETER_AGENT_ID) && occ.isAgentMuted(cfg, GREETER_AGENT_ID);
  const senders = occ.groupAllowFrom(cfg).length;
  const open = occ.isGroupSenderGateOpen(cfg);
  // The open gate is the loud one — the only failure in this feature that is
  // invisible from inside a group, because she keeps working.
  const gate = open
    ? '<b style="color:#b00">שער השולחים פתוח — כל אחד בכל קבוצה יכול להעיר אותה</b>'
    : `שער השולחים סגור (${senders} מספרים)`;
  return `<p class="dim">קבוצות בשער: <b>${esc(policy)}</b> · מקבל פנים ${greeter ? 'מותקן' : 'לא מותקן'} · ${gate}</p>`;
}


// The kind, and the numbers that only a game has. An empty select is the third
// state and stays available: it means nobody has told her, which is not the
// same as "social" and must be visible as its own thing.
function kindForm(g, csrf) {
  const sel = (v, label) => `<option value="${v}"${g.kind === v ? ' selected' : ''}>${label}</option>`;
  const num = (name, v) => `<input name="${name}" size="2" value="${v === null || v === undefined ? '' : esc(String(v))}" title="${name}">`;
  return `<form method="post" action="/group-kind" style="display:inline">
    <input type="hidden" name="csrf" value="${esc(csrf || '')}">
    <input type="hidden" name="id" value="${g.id}">
    <select name="kind">${g.kind ? '' : '<option value="" selected>—</option>'}${sel('game', 'משחק')}${sel('social', 'חברתית')}</select>
    ${num('minimum', g.quorum_min)}${num('maximum', g.quorum_max)}
    <label class="dim"><input type="checkbox" name="close_at_target"${g.close_at_target ? ' checked' : ''}>סוגר ביעד</label>
    <button>שמור</button>
  </form>`;
}

async function renderGroups(client, csrf, _probe, ctx = {}) {
  const { rows: groups } = await client.query(
    `SELECT g.*, u.first_name AS registered_by
       FROM chat_groups g LEFT JOIN users u ON u.id = g.registered_by_user_id
      ORDER BY g.state = 'open', g.created_at DESC LIMIT 50`);
  const head = gateLine(ctx.configPath || occ.DEFAULT_PATH);
  if (!groups.length) return head + '<p class="dim">אין קבוצות עדיין.</p>';

  const { rows: members } = await client.query(
    `SELECT m.group_id, m.phone, m.display_name, m.user_id,
            u.last_inbound_at, u.opening_sent_at, u.first_name
       FROM chat_group_members m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.left_at IS NULL AND m.group_id = ANY($1)
      ORDER BY m.first_seen_at`, [groups.map((g) => g.id)]);
  const byGroup = new Map();
  for (const m of members) {
    if (!byGroup.has(m.group_id)) byGroup.set(m.group_id, []);
    byGroup.get(m.group_id).push(m);
  }

  // The intro's own `group_outbox` row — at most one ever, the idempotency key
  // is `g<id>:intro`. Surfaced here because nothing else on this page shows a
  // retry: `attempts > 1` is the one thing on the box that tells an operator
  // "this room may have heard it twice" without SSH and a hand-typed query.
  const { rows: intros } = await client.query(
    `SELECT group_id, attempts, claimed_at, sent_at, hold_reason, last_error
       FROM group_outbox WHERE kind = 'intro' AND group_id = ANY($1)`, [groups.map((g) => g.id)]);
  const introByGroup = new Map(intros.map((r) => [r.group_id, r]));

  const rows = groups.map((g) => {
    const list = byGroup.get(g.id) || [];
    // Names for the missing, never numbers — this page is read over a
    // shoulder more often than the config is.
    // The gate's own predicate, called rather than re-written here: a
    // hand-copied WHERE clause cannot fail when the original drifts, and this
    // page naming somebody the gate does not consider missing is the operator
    // being told the room is stuck on a person who is already through.
    const missing = list.filter((m) => !groupsDomain.isConnected(m))
      .map((m) => m.first_name || m.display_name || '(ללא שם)');
    return `<tr>
      <td>${esc(g.subject || g.external_id)}</td>
      <td>${esc(STATE_LABEL[g.state] || g.state)}</td>
      <td>${list.length}</td>
      <td>${missing.length ? esc(missing.join(', ')) : '—'}</td>
      <td class="dim">${esc(g.registered_by || '—')}</td>
      <td class="dim">${g.opened_announced_at ? '✓' : (g.opened_at ? 'ממתינה לשעות' : '—')}</td>
      <td class="dim">${introLine(g, introByGroup.get(g.id))}</td>
      <td>${kindForm(g, csrf)}</td>
    </tr>`;
  }).join('');
  // No "תיוג אחרון" column. It rendered `chat_groups.last_mention_at`, which
  // the sweep rewrote on every pass whatever anybody did, so it read "seconds
  // ago" for every room for ever — and once `mayAnnounce` moved off that column
  // (migration 056) this page was its only reader left, so the write goes with
  // it (migration 059; the DB column stays, migrations here are additive).
  // Nothing here replaces it: the honest
  // version would have been "when a session she can see last moved", and the
  // sweep cannot see `main`, which is the session the raw pipe sends as.
  return `${head}<table><tr><th>קבוצה</th><th>מצב</th><th>אנשים</th><th>עוד לא כתבו לה</th>
    <th>נרשמה דרך</th><th>הוכרזה</th><th>היכרות</th><th>סוג וכמה צריך</th></tr>${rows}</table>
    <p class="dim">סוג: <b>משחק</b> — יש מינימום, ואולי מקסימום שאפשר לסגור עליו.
    <b>חברתית</b> — כולם מוזמנים, בלי מינימום. ריק = אף אחד עוד לא אמר לה, והיא לא מנחשת.</p>`;
}

// What the room's own intro row (group_outbox, kind='intro') says happened.
// `attempts > 1` is the tell an operator cannot see anywhere else: it means
// the first send was booked as a definite refusal and retried, which is
// exactly the failure shape a room hearing "נעים מאוד" twice would leave
// behind if the refusal itself was wrong about nothing having gone out.
function introLine(g, row) {
  if (!g.introduced_at) return '—';
  if (!row) return 'סומן, אין שורה'; // stamped but the row is gone — should not happen, worth a look
  let label;
  if (row.sent_at && !row.hold_reason) label = 'נשלחה';
  else if (row.sent_at && row.hold_reason === 'unconfirmed') label = 'לא ידוע אם נשלחה';
  else if (row.sent_at && row.hold_reason === 'abandoned') label = 'ננטשה';
  else if (row.claimed_at) label = 'בתהליך שליחה';
  else label = 'ממתינה בתור';
  if (row.attempts > 1) {
    label += ` (ניסיון ${row.attempts}${row.last_error ? `, קודם: ${esc(String(row.last_error).slice(0, 80))}` : ''})`;
  }
  return label;
}

module.exports = { renderGroups, STATE_LABEL };
