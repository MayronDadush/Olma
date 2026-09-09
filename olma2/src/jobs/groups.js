'use strict';
// The group sweep — the one pass that turns everything else on.
//
// It reads the gateway's own transcripts for group sessions, and from them
// learns three things nothing else in this system can tell it: that a group
// exists at all, who is in it, and that somebody just tagged her. Then it
// registers, provisions, locks, unlocks, and says the four fixed sentences.
//
// Why the transcript and not a tool the model calls: the roster arrives in the
// inbound envelope, which reaches the MODEL's prompt. A gate fed by what the
// model reports back is a gate the model opens by under-reporting. Here the
// model is in neither the roster path nor the speaking path — every word this
// sweep sends is written in proactive-text.js and goes out on the raw pipe.
//
// Nothing here talks to the gateway any more: every sentence becomes a row in
// `group_outbox` inside the same transaction as the stamp that records it as
// said, and one sender drains that queue (domain/group-outbox.js). Deciding
// and sending were one step until 2026-09-07, and the sixteen seconds between
// them were long enough for a deploy to restart brokerd and have a room told
// the same thing twice.
//
// The direction every uncertain case falls: **silent**. An unparseable roster
// entry, a transcript that cannot be read, a group whose members we cannot
// resolve — all of them leave the group locked. A group that stays quiet when
// it should have spoken is a bug. A group that speaks when somebody has not
// signed up is the feature failing.
const groups = require('../domain/groups');
const flags = require('../domain/flags');
const audit = require('../domain/audit');
const groupContext = require('../domain/group-context');
const groupMeetings = require('../domain/group-meetings');
const groupVoice = require('../domain/group-voice');
const groupOutbox = require('../domain/group-outbox');
const groupConnections = require('../domain/group-connections');
const gate = require('../outbox/gate');
// Through the worker facade, never channels/sessions.js: every read there is
// synchronous, and this runs inside brokerd on the loop that answers live
// users. Ten seconds is exactly the cadence that would deafen the daemon.
const sessions = require('../channels/sessions-async');
const occ = require('../intake/openclaw-config');
const pg = require('../intake/provision-group');
const { withTx } = require('../db/pool');

// Groups get the same 09:00-21:00 the delivery gate gives a person, in
// whichever timezone most of the members are in — and the same 15-minute
// conversation grace, so an answer to somebody standing right there is never
// held until morning.
const GROUP_WINDOW = { start: '09:00', end: '21:00' };

function greeterInstalled(configPath) {
  try {
    const cfg = occ.loadConfig(configPath);
    return occ.hasAgent(cfg, pg.GREETER_AGENT_ID) && occ.isAgentMuted(cfg, pg.GREETER_AGENT_ID);
  } catch { return false; }
}

// May a proactive line go out to this group right now? A room where somebody
// is demonstrably present always may — that is the grace window, the same one
// a DM gets, and not an exception to the hours.
//
// The grace reads `last_member_write_at`: the newest
// `chat_group_members.last_wrote_at` in the room, which means a MEMBER wrote
// (migration 056). It used to read `chat_groups.last_mention_at`, and that is
// how a room was told about a coordination at 01:12 (2026-09-08, group
// "5 Percent (Maprinter)", `group_outbox` #4). Two separate faults, either one
// enough on its own:
//
//   `last_mention_at` is stamped by the sweep whenever a group session's
//   `lastInteractionAt` is newer than `chat_groups.last_seen_at` — but a room
//   has SEVERAL gateway sessions (`main`, `ggreet`, `g-N`) and the sweep runs
//   its loop once per session while `last_seen_at` is one column, overwritten
//   by whichever session came last. So some other session is always newer, the
//   stamp is rewritten on EVERY pass, and the fifteen-minute window never
//   closes. Measured live: all three rooms carried the same `last_mention_at`
//   to the millisecond, advancing every tick, with nobody writing.
//
//   And `lastInteractionAt` moves when OLMA sends into the room — the raw pipe
//   sends as `agents.defaults.systemAgent.agentId`, which is `main`, whose
//   session for that room was stamped at the exact second the 01:12 line went
//   out. She talked, therefore she might talk: a window that renews itself.
//
// A member writing cannot do either. It is per room, it is written only from
// a real inbound message, and Olma's own voice never touches it.
//
// A row that does not carry the column at all gets NO grace and falls to the
// hours. Fail closed: the cost is a line held until morning, and the cost the
// other way is this entry.
function mayAnnounce(group, now = new Date()) {
  const wrote = group.last_member_write_at ? new Date(group.last_member_write_at).getTime() : 0;
  // `elapsed >= 0` is not pedantry. A write stamped AFTER the moment we are
  // deciding for is not a conversation in progress, it is a clock that
  // disagrees with itself — and read as somebody present it would open quiet
  // hours in the small hours, which is the one thing this window exists to
  // stop.
  const elapsed = now.getTime() - wrote;
  if (wrote && elapsed >= 0 && elapsed < gate.CONVERSATION_GRACE_MS) return true;
  return gate.withinWindow(GROUP_WINDOW, group.timezone || groups.DEFAULT_TIMEZONE, now);
}

// Who may reach her in a group AT ALL. The room admission above decides which
// groups she is in; this decides which people in them the gateway will even
// wake her for, and left alone it admits everyone — see the measurement in
// openclaw-config.js (`groupAllowFrom` unset falls back to `allowFrom`, which
// is `["*"]`).
//
// It is declarative and it lives here rather than in user provisioning, for
// two reasons. One rule then covers a user joining, pausing, being blocked and
// being deleted, instead of four mirrored call sites that drift. And
// provisioning keeps its cheap write: `channels.whatsapp.accounts.*` restarts
// the WhatsApp channel, and paying that in the middle of somebody's onboarding
// is exactly the cost `addAllowFrom` already refuses to pay.
//
// A user who is paused is deliberately NOT here. Her answer in a group reaches
// the whole room including them, so admitting a paused member's tag would walk
// straight around the pause the delivery gate exists to enforce.
async function syncSenderGate(client, configPath) {
  const { rows } = await client.query(
    `SELECT phone FROM users
      WHERE status = 'active' AND paused_at IS NULL AND NOT is_eval
      ORDER BY phone`);
  const cfg = occ.loadConfig(configPath);
  const synced = occ.syncGroupAllowFrom(cfg, rows.map((r) => r.phone));
  // Written inside the sweep's transaction and not undone on rollback, which
  // is safe in the one direction that matters: the list is derived from rows
  // this pass only READ, and the next pass re-derives it either way.
  if (synced.changed) occ.saveConfig(cfg, configPath);
  return { ...synced, open: occ.isGroupSenderGateOpen(cfg) };
}

// One pass. deps: { configPath, listGroupSessions, readGroupContext, send, now }
// `send(jid, text)` is the raw pipe — no model, so nothing here depends on a
// billing account being in credit.
async function sweepGroups(client, deps) {
  const configPath = deps.configPath;
  if (!greeterInstalled(configPath)) return { skipped: 'no_greeter' };

  // The newest message per group, as the gateway described it to the model.
  // Since 2026-09-06 that is a DB row brokerd writes from the gateway plugin
  // (domain/group-context.js), not the transcript: on OpenClaw 2026.8.1 the
  // store keeps the bare text and the block was never there to read.
  const readContext = deps.readGroupContext || ((agentId, key) => groupContext.read(client, agentId, key));
  const now = deps.now || new Date();

  // Before anything else, and every pass: a stale sender gate is the one
  // failure here that is invisible from the outside — she keeps working, she
  // is just answerable by people who never signed up.
  const senderGate = await syncSenderGate(client, configPath);
  // Scoped to the agents that can actually own a group, never a full scan.
  // `listSessions()` opens every agent's sqlite store, and on a one-core box a
  // sweep that does that every ten seconds is the polling cost this project
  // already removed once (`openclaw sessions list`, 2.9s of CPU a call). The
  // greeter holds every unregistered and locked group; the rest is the handful
  // of groups that are actually open.
  const { rows: openAgents } = await client.query(
    `SELECT agent_id FROM chat_groups WHERE agent_id IS NOT NULL AND state <> 'retired'`);
  const agentIds = [pg.GREETER_AGENT_ID, ...openAgents.map((r) => r.agent_id)];
  const list = deps.listGroupSessions || (async (ids) => {
    const all = [];
    for (const id of ids) {
      all.push(...(await sessions.listSessionsForAgent(id)).filter((s) => s.chatType === 'group'));
    }
    return all;
  });
  const out = {
    // Every one of these counts a sentence QUEUED, not delivered: this pass
    // decides and writes the row, and `group_outbox` reports what actually
    // went out. Splitting the two is the point — the deciding is transactional
    // and the sending is not, and pretending otherwise is what said a line
    // twice (migration 055).
    registered: [], intros: 0, notices: 0, opened: [], relocked: [], announced: 0,
    unreadable: 0, strangers: 0, skipped: 0,
    // Connections made because two people share a room. Counts the pairs
    // this pass changed, so a steady state reads 0 and a new member reads
    // however many people were already in there with her.
    connected: 0,
    // `senderGateOpen` is the loud one: true means the gateway is admitting
    // every sender in every group, and nothing else in this pass can tell.
    senderAllowFrom: senderGate.entries.length, senderGateOpen: senderGate.open,
  };

  for (const session of await list(agentIds)) {
    const jid = session.peer;
    if (!jid || !jid.endsWith('@g.us')) { out.skipped++; continue; }

    const ctx = await readContext(session.agentId, session.key);
    // Null is "no evidence", not "an empty group" — a store we could not read
    // must never look like a group with nobody in it.
    if (!ctx || !ctx.members) { out.unreadable++; continue; }
    const { members, unparsed } = groups.parseRoster(ctx.members);
    if (!members.length) { out.unreadable++; continue; }

    let group = await groups.getByExternalId(client, 'whatsapp', jid);
    // Set when she says her opening in THIS pass — registered or not. The gate
    // below reads it: she does not say "nice to meet you" and "some of you have
    // not signed up" in one breath.
    let justGreeted = false;

    // ---- first sight -------------------------------------------------------
    if (!group) {
      const reg = await groups.registerGroup(client, {
        externalId: jid, subject: ctx.subject, members,
      });
      // 'forbidden' means nobody here is an Olma user. She says nothing at
      // all in a group of strangers — no row, no agent, no introduction.
      if (!reg.ok) { out.strangers++; continue; }
      group = reg.data.group;
      out.registered.push(jid);

      // Tag-only from here, and the deny belt goes on in the same write.
      pg.admitRegisteredGroup({ configPath, jid });
    } else {
      await groups.syncRoster(client, group.id, members);
    }

    // Standing in the same room IS the introduction (owner's rule, 2026-09-09):
    // everybody here who is already a user is connected to everybody else,
    // every feature on. On EVERY pass, not only the one that registered the
    // group — the room fills up over days, and a member who signs up next week
    // has to be connected by the pass that notices, not by somebody
    // remembering. It costs two queries once everyone is connected
    // (`group-connections.js`), and it never invites a stranger or undoes a
    // revoke.
    const linked = await groupConnections.connectRoom(client, group.id);
    out.connected += linked.data.created + linked.data.activated;

    // ---- her first words in the room ---------------------------------------
    // Due while `introduced_at` is NULL, not only on the pass that registered
    // the group. A send that fails leaves the column NULL and the next pass
    // says it again — the first real group was registered and left silent for
    // ever because this sat inside the registration branch and the box was too
    // busy to run the CLI inside its timeout (2026-09-06). She is answering a
    // live message either way, so the quiet-hours window does not apply.
    // A send we are UNSURE of stamps: the same busy box that loses the answer
    // has usually delivered the message, and a room greeted twice reads worse
    // than one greeted late.
    if (!group.introduced_at) {
      await groupOutbox.enqueue(client, {
        groupId: group.id, kind: 'intro', idempotencyKey: `g${group.id}:intro`,
      });
      out.intros++;
      justGreeted = true;
      const { rows: stamped } = await client.query(
        `UPDATE chat_groups SET introduced_at = now() WHERE id = $1 RETURNING *`, [group.id]);
      group = stamped[0] || group;
      await audit.record(client, group.registered_by_user_id, 'group.introduced', {
        groupId: group.id, externalId: jid,
      });
    }

    // A roster line we could not read a phone out of is a member we cannot
    // check. Leave the group exactly as it is rather than opening it on a
    // roster we know is incomplete.
    if (unparsed.length) {
      await client.query(`UPDATE chat_groups SET last_seen_at = $2 WHERE id = $1`,
        [group.id, new Date(session.lastInteractionAt || now)]);
      out.skipped++;
      continue;
    }

    // ---- was that a tag? ---------------------------------------------------
    // A registered group is mention-gated, so any turn newer than our
    // watermark IS a tag. Before registration the greeter wakes on anything,
    // which is exactly how the introduction above got sent.
    // Not on the pass that registered the group: the message that woke her
    // there was very likely not a tag at all (before registration the greeter
    // wakes on anything), and her word for that event is the introduction. She
    // is not going to say "nice to meet you" and "some of you have not signed
    // up" in the same breath — the nudge belongs to the next time somebody
    // actually asks her for something.
    const lastSeen = group.last_seen_at ? new Date(group.last_seen_at).getTime() : 0;
    const activity = Number(session.lastInteractionAt || 0);
    // `justGreeted` covers the pass that decided the introduction; the pending
    // row covers every pass after it until the greeting has actually gone out.
    // Deciding and sending are separate transactions now, so a pass that finds
    // `introduced_at` stamped is NOT evidence the room has heard anything yet.
    const greetingOwed = justGreeted || await groupOutbox.pending(client, group.id, 'intro');
    const isNew = !greetingOwed && activity > lastSeen;
    // Somebody is demonstrably present either way, which is what the
    // announcement's grace window is about.
    if (activity > lastSeen) await groups.noteMention(client, group.id);

    // ---- the gate ----------------------------------------------------------
    const evaluated = await groups.evaluate(client, group.id);
    if (!evaluated.ok) { out.skipped++; continue; }
    const { state, missing } = evaluated.data;
    const before = group.state;
    const applied = await groups.applyState(client, group.id, state);
    group = applied.ok ? applied.data.group : group;

    if (state === 'open' && !group.agent_id) {
      const prov = await pg.provisionGroup(client, {
        groupId: group.id, configPath, registerUndo: deps.registerUndo,
      });
      if (prov.ok && prov.data.created) {
        group = prov.data.group;
        out.opened.push(jid);
      }
    } else if (state !== 'open' && group.agent_id) {
      // Somebody joined who has not written to her. The agent and the route
      // come away, and the group falls back to the muted greeter.
      const relocked = await pg.lockGroup(client, { groupId: group.id, configPath });
      if (relocked.ok && relocked.data.changed) {
        group = relocked.data.group;
        out.relocked.push(jid);
      }
    }

    // Keep the card honest about who is in the room and what state it is in.
    if (group.workspace_path) {
      pg.refreshGroupCard(group.workspace_path, {
        subject: group.subject,
        members: await groups.listMembers(client, group.id),
        state: group.state,
      });
    }

    // ---- what she says -----------------------------------------------------
    if (state === 'open') {
      // The opening announcement is proactive: she is starting this, not
      // answering it, so it waits for the group's own hours. Two columns
      // rather than one because opening and announcing are different moments
      // — a group that opens at 02:00 is still open, it is just not announced
      // until morning. And it goes out only if there was a wait to end. "יש! כולם כאן" ANSWERS her own
      // "עוד לא שלחו לי: …"; in a room where nobody was ever missing it
      // announces the end of something that never started, which is what the
      // first real group got (owner, 2026-09-06 — "כולם היו מההתחלה שם"). The
      // introduction has already welcomed them, and it is the whole greeting
      // that room needs. `gate_notice_at` is stamped only by a notice about
      // somebody MISSING, never by `too_large` (migration 047).
      // The row in hand came from provisioning, from a state change or from
      // the sweep's own list, and none of those carry the roster — so the one
      // column `mayAnnounce` judges on is fetched here rather than assumed.
      const presentGroup = { ...group, last_member_write_at: await groups.lastMemberWriteAt(client, group.id) };
      if (!group.opened_announced_at && group.gate_notice_at && mayAnnounce(presentGroup, now)) {
        await groupOutbox.enqueue(client, {
          groupId: group.id, kind: 'opened', idempotencyKey: `g${group.id}:opened`,
        });
        out.announced++;
        await client.query(`UPDATE chat_groups SET opened_announced_at = now() WHERE id = $1`,
          [group.id]);
        await audit.record(client, group.registered_by_user_id, 'group.opened', {
          groupId: group.id, externalId: jid, from: before,
        });
      }
    } else if (isNew) {
      // Tagged while locked. Every tag gets an answer — the owner's rule, and
      // he took out the cooldown that once held the second one — but the
      // answer shortens after the first. It goes out as a REPLY to the message
      // that tagged her when the transcript gave us its id: in a room where
      // three people are talking, a bare "עוד מחכה ל…" floats; quoted under
      // the tag, it is plainly an answer to that person.
      const notice = groups.decideNotice(group);
      if (notice.kind !== 'none') {
        // The key counts the notice, so a second tag earns a second (shorter)
        // one while the first can never be written twice.
        const nth = Number(group.notices_sent || 0) + 1;
        const payload = notice.kind === 'too_large'
          ? { maxMembers: Number(await flags.getFlag(client, 'group_max_members')) || 25 }
          : { kind: notice.kind, missing: missing.map((m) => m.phone) };
        await groupOutbox.enqueue(client, {
          groupId: group.id,
          kind: notice.kind === 'too_large' ? 'too_large' : 'gate_notice',
          payload,
          replyTo: ctx.messageId || null,
          idempotencyKey: `g${group.id}:notice:${nth}`,
        });
        out.notices++;
        // `toldOfMissing` is what earns the opening line later: a room told
        // it is too large was never waiting on a person.
        await groups.noteNoticeSent(client, group.id, {
          toldOfMissing: notice.kind !== 'too_large',
        });
      }
    }

    await client.query(`UPDATE chat_groups SET last_seen_at = $2 WHERE id = $1`,
      [group.id, new Date(activity || now)]);
  }

  return out;
}

// ---- what the room hears about its own coordination -------------------------
//
// A second, slower pass, and deliberately not part of the one above. That one
// is the GATE — it runs every ten seconds because a tag deserves an answer now
// — and this one is three sentences a room hears at most once each per
// coordination. Sharing a tick would mean doing this work six times a minute
// for a result that changes over hours.
//
// Everything it sends is fixed text on the raw pipe (domain/message-templates,
// reworded by the owner from the admin page), for the same reason as the gate
// notices: no model, so a room whose members are slow costs nothing at all.
// And every line waits for the group's own daytime (mayAnnounce) — nobody
// asked for these, which is exactly what makes the hour matter.
async function sweepGroupVoice(client, deps) {
  const now = deps.now || new Date();
  const out = { said: [], held: 0 };

  // Coordinations that could still owe the room a sentence. A confirmed one
  // is here only until its line goes out; a negotiating one stays until it
  // closes, and the decision below is what says "nothing new".
  const { rows } = await client.query(
    // Aliased, both of them: `g.*` also has an `id` and a `created_at`, and a
    // duplicate column name in one row silently keeps the LAST one — which
    // would date every coordination from the day the ROOM was registered.
    `SELECT m.id AS meeting_id, m.status, m.created_at AS meeting_created_at,
            m.group_base_at, m.group_chase_at, m.group_done_at,
            m.group_dayof_at, m.group_hour_at, g.*,
            (SELECT max(last_wrote_at) FROM chat_group_members
              WHERE group_id = g.id) AS last_member_write_at
       FROM meetings m JOIN chat_groups g ON g.id = m.group_id
      WHERE g.state = 'open'
        AND (m.status = 'negotiating'
             OR (m.status = 'confirmed'
                 AND (m.group_done_at IS NULL
                      -- still ahead of us, and one of the two reminders unsaid
                      OR (m.confirmed_start_at IS NOT NULL AND m.confirmed_start_at > now()
                          AND (m.group_dayof_at IS NULL OR m.group_hour_at IS NULL)))))
      ORDER BY (m.status = 'confirmed') DESC, m.id DESC`);

  // At most one line per room per pass. Two sentences in a row about the same
  // plan is a paragraph nobody asked for, and the second one keeps.
  const spoken = new Set();
  for (const row of rows) {
    if (spoken.has(String(row.id))) continue;
    const { rows: full } = await client.query(
      `SELECT id, title, status, confirmed_slot, confirmed_start_at, initiator_id
         FROM meetings WHERE id = $1`, [row.meeting_id]);
    const st = await groupMeetings.statusOf(client, row, full[0] || null);
    const line = groupVoice.decideGroupLine(st.coordination, {
      saidBase: Boolean(row.group_base_at),
      saidChase: Boolean(row.group_chase_at),
      saidDone: Boolean(row.group_done_at),
      saidDayOf: Boolean(row.group_dayof_at),
      saidHour: Boolean(row.group_hour_at),
      startedAtMs: new Date(row.meeting_created_at).getTime(),
      nowMs: now.getTime(),
      timezone: row.timezone,
    });
    if (line.kind === 'none') continue;
    // Due, but not now: the room is asleep. Nothing is stamped, so it goes out
    // in the morning — which is the whole reason these three are separate
    // columns and not one counter.
    if (!mayAnnounce(row, now)) { out.held++; continue; }

    await groupOutbox.enqueue(client, {
      groupId: row.id,
      kind: 'coordination',
      payload: { line },
      idempotencyKey: `g${row.id}:m${row.meeting_id}:${line.kind}`,
    });
    const column = {
      base: 'group_base_at', chase: 'group_chase_at', done: 'group_done_at',
      dayof: 'group_dayof_at', soon: 'group_hour_at',
    }[line.kind];
    await client.query(`UPDATE meetings SET ${column} = now() WHERE id = $1`, [row.meeting_id]);
    await audit.record(client, row.registered_by_user_id, 'group.coordination_said', {
      groupId: row.id, meetingId: Number(row.meeting_id), kind: line.kind,
    });
    spoken.add(String(row.id));
    out.said.push({ groupId: row.id, meetingId: Number(row.meeting_id), kind: line.kind });
  }
  return out;
}

// Owns the transaction, for the same reason the intake sweep does: provisioning
// writes files and a gateway config that no ROLLBACK can reach. Anything the
// pass created is undone on the way out, and this wrapper sits OUTSIDE withTx
// so a failure in COMMIT itself is compensated too.
async function runGroupSweep(pool, deps) {
  const undos = [];
  try {
    return await withTx(pool, (client) => sweepGroups(client, {
      ...deps, registerUndo: (fn) => undos.push(fn),
    }));
  } catch (e) {
    for (const undo of undos.reverse()) {
      try { undo(); } catch (inner) { console.error(`[groups] undo failed: ${inner.message}`); }
    }
    throw e;
  }
}

module.exports = {
  sweepGroups, runGroupSweep, sweepGroupVoice, greeterInstalled, mayAnnounce, syncSenderGate, GROUP_WINDOW,
};
