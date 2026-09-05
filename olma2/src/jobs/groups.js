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
// The direction every uncertain case falls: **silent**. An unparseable roster
// entry, a transcript that cannot be read, a group whose members we cannot
// resolve — all of them leave the group locked. A group that stays quiet when
// it should have spoken is a bug. A group that speaks when somebody has not
// signed up is the feature failing.
const groups = require('../domain/groups');
const flags = require('../domain/flags');
const audit = require('../domain/audit');
const text = require('../domain/proactive-text');
const gate = require('../outbox/gate');
const sessions = require('../channels/sessions');
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

// May a proactive line go out to this group right now? Anything that is a
// REPLY to a live tag always may — that is the grace window, not an exception
// to it.
function mayAnnounce(group, now = new Date()) {
  const lastMention = group.last_mention_at ? new Date(group.last_mention_at).getTime() : 0;
  if (lastMention && now.getTime() - lastMention < gate.CONVERSATION_GRACE_MS) return true;
  return gate.withinWindow(GROUP_WINDOW, group.timezone || groups.DEFAULT_TIMEZONE, now);
}

// One pass. deps: { configPath, listGroupSessions, readGroupContext, send, now }
// `send(jid, text)` is the raw pipe — no model, so nothing here depends on a
// billing account being in credit.
async function sweepGroups(client, deps) {
  const configPath = deps.configPath;
  if (!greeterInstalled(configPath)) return { skipped: 'no_greeter' };

  const readContext = deps.readGroupContext || sessions.readGroupContext;
  const now = deps.now || new Date();

  // Scoped to the agents that can actually own a group, never a full scan.
  // `listSessions()` opens every agent's sqlite store, and on a one-core box a
  // sweep that does that every ten seconds is the polling cost this project
  // already removed once (`openclaw sessions list`, 2.9s of CPU a call). The
  // greeter holds every unregistered and locked group; the rest is the handful
  // of groups that are actually open.
  const { rows: openAgents } = await client.query(
    `SELECT agent_id FROM chat_groups WHERE agent_id IS NOT NULL AND state <> 'retired'`);
  const agentIds = [pg.GREETER_AGENT_ID, ...openAgents.map((r) => r.agent_id)];
  const list = deps.listGroupSessions || ((ids) => ids.flatMap(
    (id) => sessions.listSessionsForAgent(id).filter((s) => s.chatType === 'group')));
  const out = {
    registered: [], intros: 0, notices: 0, opened: [], relocked: [], announced: 0,
    unreadable: 0, strangers: 0, skipped: 0,
  };

  for (const session of list(agentIds)) {
    const jid = session.peer;
    if (!jid || !jid.endsWith('@g.us')) { out.skipped++; continue; }

    const ctx = readContext(session.agentId, session.key);
    // Null is "no evidence", not "an empty group" — a store we could not read
    // must never look like a group with nobody in it.
    if (!ctx || !ctx.members) { out.unreadable++; continue; }
    const { members, unparsed } = groups.parseRoster(ctx.members);
    if (!members.length) { out.unreadable++; continue; }

    let group = await groups.getByExternalId(client, 'whatsapp', jid);
    let justRegistered = false;

    // ---- first sight -------------------------------------------------------
    if (!group) {
      const reg = await groups.registerGroup(client, {
        externalId: jid, subject: ctx.subject, members,
      });
      // 'forbidden' means nobody here is an Olma user. She says nothing at
      // all in a group of strangers — no row, no agent, no introduction.
      if (!reg.ok) { out.strangers++; continue; }
      group = reg.data.group;
      justRegistered = true;
      out.registered.push(jid);

      // Tag-only from here, and the deny belt goes on in the same write.
      pg.admitRegisteredGroup({ configPath, jid });

      // Her first words in the room. She is answering a live message, so the
      // quiet-hours window does not apply — somebody is plainly there.
      if (await deps.send(jid, text.renderGroupIntro())) {
        out.intros++;
        await audit.record(client, group.registered_by_user_id, 'group.introduced', {
          groupId: group.id, externalId: jid,
        });
      }
    } else {
      await groups.syncRoster(client, group.id, members);
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
    const isNew = !justRegistered && activity > lastSeen;
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
      // until morning.
      if (!group.opened_announced_at && mayAnnounce(group, now)) {
        if (await deps.send(jid, text.renderGroupOpened())) {
          await client.query(`UPDATE chat_groups SET opened_announced_at = now() WHERE id = $1`,
            [group.id]);
          out.announced++;
          await audit.record(client, group.registered_by_user_id, 'group.opened', {
            groupId: group.id, externalId: jid, from: before,
          });
        }
      }
    } else if (isNew) {
      // Tagged while locked. Every tag gets an answer — the owner's rule —
      // but the answer shortens after the first, and a cooldown keeps a
      // repeat-tagger from turning her into a spammer in somebody's group.
      const notice = groups.decideNotice(group, { now });
      if (notice.kind !== 'none') {
        const body = notice.kind === 'too_large'
          ? text.renderGroupTooLarge(Number(await flags.getFlag(client, 'group_max_members')) || 25)
          : text.renderGroupGateNotice({ kind: notice.kind, missing: missing.map((m) => m.phone) });
        if (await deps.send(jid, body)) {
          await groups.noteNoticeSent(client, group.id);
          out.notices++;
        }
      }
    }

    await client.query(`UPDATE chat_groups SET last_seen_at = $2 WHERE id = $1`,
      [group.id, new Date(activity || now)]);
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

module.exports = { sweepGroups, runGroupSweep, greeterInstalled, mayAnnounce, GROUP_WINDOW };
