'use strict';
// groups — one section of the admin page (see ./index.js).
//
// Read-only, on purpose. Every state here is decided by the sweep from the
// gateway's own transcripts (jobs/groups.js), and an operator button that
// forced a group open would be a second writer to a gate whose whole promise
// is that it opens only when the last person has written to her. What the
// operator needs is to SEE it: which groups exist, who is still missing, and
// whether the sender gate is closed — the one thing the config file spells as
// an absent key.
const { esc } = require('../../html');
const { ago } = require('../html');
const occ = require('../../../../intake/openclaw-config');
const { GREETER_AGENT_ID } = require('../../../../intake/provision-group');

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

async function renderGroups(client, _csrf, _probe, ctx = {}) {
  const { rows: groups } = await client.query(
    `SELECT g.*, u.first_name AS registered_by
       FROM chat_groups g LEFT JOIN users u ON u.id = g.registered_by_user_id
      ORDER BY g.state = 'open', g.created_at DESC LIMIT 50`);
  const head = gateLine(ctx.configPath || occ.DEFAULT_PATH);
  if (!groups.length) return head + '<p class="dim">אין קבוצות עדיין.</p>';

  const { rows: members } = await client.query(
    `SELECT m.group_id, m.phone, m.display_name, m.user_id, u.last_inbound_at, u.first_name
       FROM chat_group_members m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.left_at IS NULL AND m.group_id = ANY($1)
      ORDER BY m.first_seen_at`, [groups.map((g) => g.id)]);
  const byGroup = new Map();
  for (const m of members) {
    if (!byGroup.has(m.group_id)) byGroup.set(m.group_id, []);
    byGroup.get(m.group_id).push(m);
  }

  const rows = groups.map((g) => {
    const list = byGroup.get(g.id) || [];
    // Names for the missing, never numbers — this page is read over a
    // shoulder more often than the config is.
    const missing = list.filter((m) => !(m.user_id && m.last_inbound_at))
      .map((m) => m.first_name || m.display_name || '(ללא שם)');
    return `<tr>
      <td>${esc(g.subject || g.external_id)}</td>
      <td>${esc(STATE_LABEL[g.state] || g.state)}</td>
      <td>${list.length}</td>
      <td>${missing.length ? esc(missing.join(', ')) : '—'}</td>
      <td class="dim">${esc(g.registered_by || '—')}</td>
      <td class="dim">${g.last_mention_at ? esc(ago(g.last_mention_at)) : '—'}</td>
      <td class="dim">${g.opened_announced_at ? '✓' : (g.opened_at ? 'ממתינה לשעות' : '—')}</td>
    </tr>`;
  }).join('');
  return `${head}<table><tr><th>קבוצה</th><th>מצב</th><th>אנשים</th><th>עוד לא כתבו לה</th>
    <th>נרשמה דרך</th><th>תיוג אחרון</th><th>הוכרזה</th></tr>${rows}</table>`;
}

module.exports = { renderGroups, STATE_LABEL };
