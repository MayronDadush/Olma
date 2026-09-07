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

// Her own number, as the gateway writes it into the roster of every group she
// is in. Measured on the first real group (2026-09-06): `group_members` was
// `+972559347282, +972549495254, M&M (+972526269826)` — the first is her.
// Left in, she is a member who has never written to herself, so the group can
// never open and the nudge tags her own number at the people it is asking for
// help. Same source as the intro's `{{me}}` tag (proactive-text.SELF_NUMBER),
// so one env var moves both.
const SELF_PHONE = normalizePhone(process.env.OLMA_WA_NUMBER || '972559347282');

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
    // She is in every group she is in; she is not a member of it.
    if (phone === SELF_PHONE) continue;
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
// Every tag is answered. There was a 30-minute cooldown here for a day
// (2026-09-05) and the owner removed it: a person who tags her and hears
// nothing has been told she is broken, not that she is being polite. What
// keeps her from spamming a room is the sweep itself, which reads one
// transcript per tick and answers the NEWEST tag it finds — forty tags inside
// one tick are one answer, and the answer gets shorter after the first.
function decideNotice(group) {
  if (group.state === 'open') return { kind: 'none', reason: 'group is open' };
  if (group.state === 'retired') return { kind: 'none', reason: 'not in this group' };
  if (group.state === 'too_large') {
    // Said once, ever. Nobody can fix it by writing a message, so repeating it
    // is nagging a room about a decision it cannot act on.
    return group.notices_sent > 0
      ? { kind: 'none', reason: 'already told them it is too large' }
      : { kind: 'too_large' };
  }
  return { kind: group.notices_sent === 0 ? 'explain' : 'nudge' };
}

// `toldOfMissing` separates the two things a notice can be about. Only a
// notice naming people who have not written to her stamps `gate_notice_at`,
// and only that stamp earns the opening line when they finally do — a room
// told it is too large was never waiting on anybody, and a room that was
// never waiting has nothing to celebrate (migration 047).
async function noteNoticeSent(client, groupId, { toldOfMissing = true } = {}) {
  await client.query(
    `UPDATE chat_groups
        SET last_notice_at = now(),
            notices_sent = notices_sent + 1,
            gate_notice_at = CASE WHEN $2 THEN now() ELSE gate_notice_at END
      WHERE id = $1`,
    [groupId, toldOfMissing === true]
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

// ---- the group's own identity ----------------------------------------------
//
// A SECOND door, deliberately not a branch inside `users.resolveByToken`.
// That function's whole contract is "possession of this token IS this person",
// and the one thing a group must never be is a person: a group agent that
// resolved to a user would hold that user's tasks, their facts, their
// calendar and their private chat, in a room with other people in it. So the
// group token lives in its own column, resolves through its own function, and
// the two never meet — the migration that created the column said so before
// any of this existed (042).
//
// Token shape mirrors a user's exactly (prefix + 32 hex) so nothing downstream
// has to special-case its length.
const GROUP_TOKEN_RE = /^olma_grp_[0-9a-f]{32}$/;

// Which DOOR a token is for, by prefix alone — never whether it is valid.
// A truncated group token has to reach the group resolver and be refused
// there: routed to the user door instead it would come back "unknown identity
// token", and the model would go looking for a person's file it does not
// have.
function looksLikeGroupToken(token) {
  return typeof token === 'string' && token.startsWith('olma_grp_');
}

async function resolveByToken(client, identityToken) {
  const recovery = ' — read the file .olma-identity in your workspace and retry with its exact contents as olma_identity, never from memory';
  if (!GROUP_TOKEN_RE.test(String(identityToken || ''))) {
    return err('forbidden', 'malformed group identity' + recovery);
  }
  const { rows } = await client.query(
    `SELECT * FROM chat_groups WHERE identity_token = $1`, [identityToken]);
  const group = rows[0];
  if (!group) return err('forbidden', 'unknown group identity' + recovery);
  // Only an OPEN group acts. A locked one is muted at the gateway and has no
  // agent, so this should be unreachable — which is exactly why it is checked:
  // the day the mute fails, the tools must not be the thing that lets a room
  // where somebody never signed up start reaching those people privately.
  if (group.state !== 'open') {
    return err('forbidden', `this group is ${group.state}, not open`);
  }
  return ok({ group });
}

// WHO, in the room, this turn is acting for. Read off the last inbound the
// gateway filed for the group (domain/group-context), never from anything the
// model sends: a group agent that could name its own actor could act as any
// member of the room, and the whole point of the group having its own identity
// is that the person is chosen by the server.
//
// Null is a real answer — nothing filed yet, or the person who tagged her is
// not a user. A caller that needs a person must refuse on null rather than
// pick one.
async function actingMember(client, group) {
  if (!group || !group.agent_id) return null;
  const sessionKey = `agent:${group.agent_id}:whatsapp:group:${group.external_id}`;
  const { rows: ctx } = await client.query(
    `SELECT sender_e164 FROM group_inbound_context WHERE session_key = $1 AND agent_id = $2`,
    [sessionKey, group.agent_id]);
  const phone = ctx[0] && normalizePhone(ctx[0].sender_e164);
  if (!phone) return null;
  const { rows } = await client.query(
    `SELECT u.* FROM users u
       JOIN chat_group_members m ON m.user_id = u.id AND m.group_id = $2 AND m.left_at IS NULL
      WHERE u.phone = $1`,
    [phone, group.id]);
  return rows[0] || null;
}

// What she is allowed to say out loud about the room, and nothing else: who is
// in it (the room can see that itself) and who has not written to her (she
// already tags exactly those people in the gate notice). No name, no fact and
// no availability from anybody's private chat crosses this line.
async function roomStatus(client, group) {
  const members = await listMembers(client, group.id);
  return {
    subject: group.subject, state: group.state,
    members: members.map((m) => ({
      phone: m.phone,
      displayName: m.display_name || null,
      wroteToHer: Boolean(m.user_id && m.last_inbound_at),
    })),
  };
}

// ---- what kind of room this is ---------------------------------------------
//
// Two kinds, and a third state that is neither (migration 051). The owner's
// framing (2026-09-07): a room of friends invites everybody and has no
// minimum; a room that plays padel needs four. Both invite everyone — the
// difference is what "enough" means, and whether there is a moment where the
// thing is FULL.
//
// NULL is never treated as 'social'. A room nobody has answered for is
// coordinated exactly as it was before this existed, and no sentence about a
// quorum is available to say about it. That is the whole rule: a guess never
// acts.
const GROUP_KINDS = ['social', 'game'];

function validKind(kind) {
  return GROUP_KINDS.includes(String(kind || ''));
}

// Set or correct it. The admin page and the group tool both come through here,
// so a number typed on the dashboard is validated exactly like one the room
// said out loud.
async function setKind(client, groupId, { kind, min = null, max = null, closeAtTarget = null }, actorId = null) {
  const group = await getById(client, groupId);
  if (!group) return err('not_found', 'no such group');
  if (!validKind(kind)) return err('invalid', `kind must be one of: ${GROUP_KINDS.join(', ')}`);
  const asInt = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const lo = asInt(min);
  const hi = asInt(max);
  for (const [label, v] of [['minimum', lo], ['maximum', hi]]) {
    if (v === null) continue;
    if (!Number.isInteger(v) || v < 2 || v > 100) {
      return err('invalid', `${label} must be a whole number between 2 and 100`);
    }
  }
  if (lo !== null && hi !== null && hi < lo) return err('invalid', 'the maximum cannot be below the minimum');
  // A social room has no quorum by definition — accepting numbers for one
  // would create a room that is 'social' and behaves like a game.
  if (kind === 'social' && (lo !== null || hi !== null)) {
    return err('invalid', 'a social group has no minimum or maximum — that is what makes it social');
  }
  const { rows } = await client.query(
    `UPDATE chat_groups
        SET kind = $2, quorum_min = $3, quorum_max = $4,
            close_at_target = COALESCE($5, close_at_target),
            kind_asked_at = COALESCE(kind_asked_at, now())
      WHERE id = $1 RETURNING *`,
    [groupId, kind, lo, hi, closeAtTarget === null ? null : Boolean(closeAtTarget)]);
  await audit.record(client, actorId, 'group.kind', {
    groupId, kind, min: lo, max: hi, closeAtTarget: closeAtTarget === null ? undefined : Boolean(closeAtTarget),
  });
  return ok({ group: rows[0] });
}

// Asked once, ever — stamped whether or not anybody answers. A room that let
// the question go by is not asked it again on the next coordination; the
// dashboard is where it gets filled in after that.
async function noteKindAsked(client, groupId) {
  await client.query(
    `UPDATE chat_groups SET kind_asked_at = COALESCE(kind_asked_at, now()) WHERE id = $1`, [groupId]);
  return ok({ groupId });
}

// Pure: what a given number of yes-answers means for this room. `known` false
// is the NULL kind — every other field is null with it, so a caller that
// forgets to check cannot accidentally read "0 short of 0" as a full house.
function quorumFor(group, yesCount) {
  if (!group || !validKind(group.kind)) {
    return { known: false, kind: null, min: null, max: null, met: null, short: null, full: false, mayClose: false };
  }
  const min = group.quorum_min === null || group.quorum_min === undefined ? null : Number(group.quorum_min);
  const max = group.quorum_max === null || group.quorum_max === undefined ? null : Number(group.quorum_max);
  const yes = Number(yesCount) || 0;
  return {
    known: true, kind: group.kind, min, max,
    // A room with no minimum is never short of anybody: everyone is invited
    // and whoever can, comes.
    met: min === null ? true : yes >= min,
    short: min === null ? 0 : Math.max(0, min - yes),
    full: max !== null && yes >= max,
    // The only automatic-looking thing here, and it still only ever tells the
    // model it MAY: closing is an act, and an act in a room is said out loud
    // by somebody.
    mayClose: Boolean(group.close_at_target) && max !== null && yes >= max,
  };
}

module.exports = {
  DEFAULT_TIMEZONE,
  parseRoster, normalizePhone, majorityTimezone, SELF_PHONE,
  registerGroup, getById, getByExternalId, listMembers, syncRoster,
  decideState, evaluate, applyState,
  decideNotice, noteNoticeSent, noteMention,
  GROUP_KINDS, validKind, setKind, noteKindAsked, quorumFor,
  GROUP_TOKEN_RE, looksLikeGroupToken, resolveByToken, actingMember, roomStatus,
};
