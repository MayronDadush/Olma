'use strict';
// Group mode — the state of one group chat Olma sits in.
// Design and the decisions behind it: olma2/docs/group-mode.md.
//
// The product rule: she is addressable only by a real @-mention, and she
// answers NOBODY in a group until every member has written to her privately
// at least once. This file owns that state; it never sends anything and never
// touches the gateway config. Enforcement is two layers apart on purpose:
//
//   this file          decides locked/open, and who is missing
//   the gateway config makes "locked" true — a sendPolicy deny rule on the
//                      group's session-key prefix, so the model CANNOT speak
//                      there even if a message talks it into wanting to
//   brokerd            composes the locked-state notice server-side and sends
//                      it on the raw pipe
//
// A prompt that asks the model not to answer is not a gate; this project has
// that failure written down five times over. The model is never in the
// enforcement path here, and it is not in the ROSTER path either: the roster
// arrives in the inbound envelope (`group_members`), which reaches the model's
// prompt, so a gate computed from what the model reports back through a tool
// would be a gate the model can open by under-reporting. brokerd reads the
// same string off the gateway's own transcript store instead
// (channels/sessions.js) and hands it to `syncRoster` below.
const { ok, err } = require('./results');
const flags = require('./flags');
const audit = require('./audit');

const DEFAULT_TIMEZONE = 'Asia/Jerusalem';

// ---- roster parsing ---------------------------------------------------------

// The gateway formats the roster as `Name (+972…), +972…, Name (+972…)` —
// `formatGroupMembers` in the WhatsApp plugin, which drops the name half when
// it has no display name for that participant. Parsing is deliberately strict
// about the phone and forgiving about everything else: a member we cannot
// resolve to a phone number is a member we cannot check the gate for, and
// silently dropping them would OPEN a group that should stay locked. They come
// back as `unparsed` so the caller can refuse rather than guess.
function parseRoster(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const members = [];
  const unparsed = [];
  for (const chunk of text.split(',')) {
    const entry = chunk.trim();
    if (!entry) continue;
    const withName = /^(.*?)\s*\((\+?\d[\d\s-]{5,})\)$/.exec(entry);
    const bare = /^(\+?\d[\d\s-]{5,})$/.exec(entry);
    const rawPhone = withName ? withName[2] : (bare ? bare[1] : null);
    if (!rawPhone) { unparsed.push(entry); continue; }
    const phone = normalizePhone(rawPhone);
    if (!phone) { unparsed.push(entry); continue; }
    const displayName = withName ? cleanName(withName[1]) : null;
    members.push({ phone, displayName });
  }
  return { members: dedupe(members), unparsed };
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return `+${digits}`;
}

// A WhatsApp display name is free text: emoji, decoration, or the number
// itself when the peer set none. A name that is mostly digits tells us
// nothing and is worse than no name, because it looks like one.
function cleanName(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.replace(/\D/g, '').length >= 7) return null;
  const words = text.split(' ').filter((w) => /\p{L}/u.test(w));
  return words.length ? words.join(' ') : null;
}

function dedupe(members) {
  const byPhone = new Map();
  for (const m of members) {
    const existing = byPhone.get(m.phone);
    // Later entries win only when they add a name we did not have.
    if (!existing || (!existing.displayName && m.displayName)) byPhone.set(m.phone, m);
  }
  return [...byPhone.values()];
}

// ---- timezone ---------------------------------------------------------------

// A group's quiet hours run in whichever timezone most of its members are in.
// Ties break lexicographically rather than by iteration order, so the same
// roster always produces the same answer — a group whose quiet hours moved
// because two rows came back in a different order would be impossible to
// diagnose from a log.
function majorityTimezone(timezones, fallback = DEFAULT_TIMEZONE) {
  const counts = new Map();
  for (const tz of timezones) {
    if (!tz) continue;
    counts.set(tz, (counts.get(tz) || 0) + 1);
  }
  if (!counts.size) return fallback;
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0][0];
}

// ---- registration -----------------------------------------------------------

// Being added to a group creates NOTHING unless Olma already knows somebody in
// it. Without this, anyone in the world mints an agent, a workspace and a row
// on the box by adding her number to a group of strangers.
async function registerGroup(client, { channel = 'whatsapp', externalId, subject, members }) {
  if (!externalId) return err('invalid', 'group needs an external id');
  const roster = Array.isArray(members) ? dedupe(members.filter((m) => m && m.phone)) : [];
  if (!roster.length) return err('invalid', 'group needs at least one parsed member');

  const known = await knownUsers(client, roster.map((m) => m.phone));
  if (!known.size) return err('forbidden', 'no member of this group is an Olma user');

  const existing = await getByExternalId(client, channel, externalId);
  if (existing) return ok({ group: existing, created: false });

  const registeredBy = [...known.values()].sort((a, b) => a.id - b.id)[0];
  const { rows } = await client.query(
    `INSERT INTO chat_groups (channel, external_id, subject, registered_by_user_id, timezone)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [channel, externalId, subject || null, registeredBy.id,
      majorityTimezone([...known.values()].map((u) => u.timezone))]
  );
  const group = rows[0];
  await syncRoster(client, group.id, roster);
  await audit.record(client, registeredBy.id, 'group.registered', {
    groupId: group.id, channel, externalId, subject: subject || null, members: roster.length,
  });
  return ok({ group: await getById(client, group.id), created: true });
}

async function knownUsers(client, phones) {
  if (!phones.length) return new Map();
  const { rows } = await client.query(
    `SELECT id, phone, timezone, last_inbound_at, paused_at FROM users WHERE phone = ANY($1)`,
    [phones]
  );
  return new Map(rows.map((r) => [r.phone, r]));
}

async function getById(client, id) {
  const { rows } = await client.query(`SELECT * FROM chat_groups WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getByExternalId(client, channel, externalId) {
  const { rows } = await client.query(
    `SELECT * FROM chat_groups WHERE channel = $1 AND external_id = $2`, [channel, externalId]
  );
  return rows[0] || null;
}

async function listMembers(client, groupId, { includeLeft = false } = {}) {
  const { rows } = await client.query(
    `SELECT m.*, u.last_inbound_at, u.timezone, u.paused_at, u.first_name
       FROM chat_group_members m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.group_id = $1 ${includeLeft ? '' : 'AND m.left_at IS NULL'}
      ORDER BY m.first_seen_at, m.phone`,
    [groupId]
  );
  return rows;
}

// ---- roster reconciliation --------------------------------------------------

// Idempotent: the same roster twice is a no-op. Three things move —
//   joined:   a phone we have never seen here
//   rejoined: a phone that had left_at and is back
//   left:     a phone we have a live row for that is no longer in the roster
// and every member's user_id is re-resolved, because the whole point of the
// gate is that people become users while the group waits for them.
async function syncRoster(client, groupId, members) {
  const roster = dedupe((members || []).filter((m) => m && m.phone));
  const known = await knownUsers(client, roster.map((m) => m.phone));
  const existing = await listMembers(client, groupId, { includeLeft: true });
  const byPhone = new Map(existing.map((r) => [r.phone, r]));

  const joined = [];
  const rejoined = [];
  for (const m of roster) {
    const user = known.get(m.phone) || null;
    const prev = byPhone.get(m.phone);
    if (!prev) {
      await client.query(
        `INSERT INTO chat_group_members (group_id, phone, display_name, user_id)
         VALUES ($1, $2, $3, $4)`,
        [groupId, m.phone, m.displayName || null, user ? user.id : null]
      );
      joined.push(m.phone);
      continue;
    }
    await client.query(
      `UPDATE chat_group_members
          SET display_name = COALESCE($3, display_name), user_id = $4, left_at = NULL
        WHERE group_id = $1 AND phone = $2`,
      [groupId, m.phone, m.displayName || null, user ? user.id : null]
    );
    if (prev.left_at) rejoined.push(m.phone);
  }

  const inRoster = new Set(roster.map((m) => m.phone));
  const left = [];
  for (const row of existing) {
    if (row.left_at || inRoster.has(row.phone)) continue;
    await client.query(
      `UPDATE chat_group_members SET left_at = now() WHERE group_id = $1 AND phone = $2`,
      [groupId, row.phone]
    );
    left.push(row.phone);
  }

  const tz = majorityTimezone(
    roster.map((m) => (known.get(m.phone) || {}).timezone)
  );
  await client.query(`UPDATE chat_groups SET timezone = $2 WHERE id = $1`, [groupId, tz]);
  return { joined, rejoined, left, timezone: tz };
}

// ---- the gate ---------------------------------------------------------------

// "Has written to her privately" is `users.last_inbound_at IS NOT NULL` — a
// real inbound message, not `onboarded_at` (stamped at provisioning, before
// they have necessarily said a word) and not `first_turn_at` (the moment WE
// handed something to the model). The rule the owner stated is about what the
// PERSON did.
function isConnected(member) {
  return Boolean(member.user_id && member.last_inbound_at);
}

// Pure, so the whole policy is testable without a database.
// Returns { state, missing, memberCount } — never writes.
function decideState(members, { maxMembers }) {
  const live = members.filter((m) => !m.left_at);
  if (live.length > maxMembers) {
    return { state: 'too_large', missing: [], memberCount: live.length };
  }
  const missing = live.filter((m) => !isConnected(m));
  return {
    state: missing.length ? 'locked' : 'open',
    missing: missing.map((m) => ({ phone: m.phone, displayName: m.display_name || null })),
    memberCount: live.length,
  };
}

async function evaluate(client, groupId) {
  const group = await getById(client, groupId);
  if (!group) return err('not_found', 'no such group');
  const maxMembers = Number(await flags.getFlag(client, 'group_max_members')) || 25;
  const members = await listMembers(client, groupId);
  return ok({ group, ...decideState(members, { maxMembers }) });
}

// Applies whatever `evaluate` decided. Returns the transition so the caller
// can act on it — the caller is what enqueues the "everyone is here" message
// and creates the connections; this file deliberately does neither, so a state
// recomputation can never send anything by itself.
//
// `retired` is sticky: she was removed from the group, and a stale roster read
// must not put her back.
async function applyState(client, groupId, next) {
  const group = await getById(client, groupId);
  if (!group) return err('not_found', 'no such group');
  if (group.state === 'retired') return ok({ group, from: 'retired', to: 'retired', changed: false });
  if (group.state === next) return ok({ group, from: group.state, to: next, changed: false });

  const opening = next === 'open' && !group.opened_at;
  const { rows } = await client.query(
    `UPDATE chat_groups
        SET state = $2,
            opened_at = CASE WHEN $3 THEN now() ELSE opened_at END,
            notices_sent = CASE WHEN $2 = 'locked' AND $4 <> 'locked' THEN 0 ELSE notices_sent END
      WHERE id = $1 RETURNING *`,
    [groupId, next, opening, group.state]
  );
  await audit.record(client, group.registered_by_user_id, 'group.state', {
    groupId, from: group.state, to: next,
  });
  return ok({ group: rows[0], from: group.state, to: next, changed: true, firstOpen: opening });
}

// ---- the locked-state notice ------------------------------------------------

// What she says when tagged in a locked group. First tag explains; every tag
// after that nudges the people who are missing, by mention. Both are composed
// by brokerd from this decision — the model is muted and cannot produce
// either, which is the entire point.
//
// Pure, and rate-limited by wall-clock rather than by count, so a group that
// tags her forty times in a minute hears from her once.
const NOTICE_COOLDOWN_MS = 30 * 60_000;

function decideNotice(group, { now = new Date(), cooldownMs = NOTICE_COOLDOWN_MS } = {}) {
  if (group.state === 'open') return { kind: 'none', reason: 'group is open' };
  if (group.state === 'retired') return { kind: 'none', reason: 'not in this group' };
  if (group.state === 'too_large') {
    // Said once, ever. Nobody can fix it by writing a message, so repeating it
    // is nagging a room about a decision it cannot act on.
    return group.notices_sent > 0
      ? { kind: 'none', reason: 'already told them it is too large' }
      : { kind: 'too_large' };
  }
  const last = group.last_notice_at ? new Date(group.last_notice_at).getTime() : 0;
  if (last && now.getTime() - last < cooldownMs) {
    return { kind: 'none', reason: 'cooldown' };
  }
  return { kind: group.notices_sent === 0 ? 'explain' : 'nudge' };
}

async function noteNoticeSent(client, groupId) {
  await client.query(
    `UPDATE chat_groups SET last_notice_at = now(), notices_sent = notices_sent + 1 WHERE id = $1`,
    [groupId]
  );
  return ok({ groupId });
}

// The gate's `lastInboundAt` for a group: stamped on every real mention, so
// outbox/gate.js gives the group the same 15-minute conversation grace a DM
// gets and never holds an answer to someone standing right there.
async function noteMention(client, groupId) {
  await client.query(`UPDATE chat_groups SET last_mention_at = now() WHERE id = $1`, [groupId]);
  return ok({ groupId });
}

module.exports = {
  DEFAULT_TIMEZONE, NOTICE_COOLDOWN_MS,
  parseRoster, normalizePhone, majorityTimezone,
  registerGroup, getById, getByExternalId, listMembers, syncRoster,
  decideState, evaluate, applyState,
  decideNotice, noteNoticeSent, noteMention,
};
