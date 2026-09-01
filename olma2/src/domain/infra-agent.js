'use strict';
// `main` is the agent with no user. It exists to own ambient gateway work —
// since #96 it is `agents.defaults.systemAgent.agentId`, which is what makes
// the raw `openclaw message send` pipe resolve at all.
//
// On 2026-09-01 it also turned out to hold six live, delivery-capable WhatsApp
// sessions pointed at real people, left over from the v1 era when `--to
// <phone>` alone ran a turn on the DEFAULT agent. That was harmless while
// nothing ever ran main. Then the 2026.8.1 upgrade auto-created 36 cron jobs
// (a `heartbeat` and a `skillCollectionReview` per agent in the roster, all
// with sessionTarget `main`), main started waking every ~30 minutes, and its
// output — including the literal text `NO_REPLY` and its own auth failures,
// because main has no identity token and improvises one — landed in a real
// user's WhatsApp:
//
//   11:25  Past quiet hours now (08:24 UTC), but no user messages waiting…
//          NO_REPLY
//   11:25  הטוקן מהקובץ שוב נדחה. אעצור הפעם.  NO_REPLY
//
// Two independent conditions had to hold, and this file names them both so a
// detector can watch each: main is WOKEN, and main can DELIVER to a person.
// Removing either stops the leak; the delivery half is the real chokepoint,
// because it bounds every future thing that wakes main, including whatever
// the next gateway upgrade invents.
const sessions = require('../channels/sessions');

// Agents with no user row. `intake` belongs here too but is deliberately NOT
// judged on sessions: talking to peers who are not yet users is its entire
// job, so a direct session to a phone is correct for it and a violation for
// main.
const INFRA_AGENTS = ['main', 'intake'];
const DELIVERABLE_AGENTS = ['main'];

// Channels where a session carries a real delivery route to a person. A cron
// or ACP session key is not one of these and must never be reported.
const PERSON_CHANNELS = new Set([
  'whatsapp', 'telegram', 'signal', 'imessage', 'sms', 'discord', 'slack', 'matrix',
]);

// Sessions under a userless agent that point at an active user's own phone.
// Matched on the peer, against users.phone, so a session to some stranger who
// never became a user is not swept up in it.
async function deliverableInfraSessions(client, { list, agents = DELIVERABLE_AGENTS } = {}) {
  const readOne = list || sessions.listSessionsForAgent;
  const { rows } = await client.query(
    `SELECT phone, agent_id, id FROM users WHERE status = 'active' AND phone IS NOT NULL`);
  const byPhone = new Map(rows.map((u) => [u.phone, u]));

  const found = [];
  for (const agentId of agents) {
    let entries = [];
    // An unreadable store is "no evidence", never "no sessions" — the same
    // rule readAgentIndex follows one layer down. It throws rather than
    // reporting a clean bill of health for a store nobody could open.
    try { entries = readOne(agentId) || []; } catch { continue; }
    for (const e of entries) {
      if (!e || e.chatType !== 'direct') continue;
      // An archived session is the remediation, not the fault. Reporting one
      // is how a detector becomes furniture: the six sessions this file was
      // written for were archived within the hour, and without this the guard
      // would have filed the same violation every tick for ever, against a
      // fix that had already landed. Caught by running the shipped script
      // against the live box and reading `already_archived` six times.
      if (e.archivedAt) continue;
      if (!PERSON_CHANNELS.has(e.channel)) continue;
      const owner = byPhone.get(e.peer);
      if (!owner) continue;
      // Their own agent being this one would mean the roster says so, which
      // is a different (and legitimate) arrangement than a leftover session.
      if (owner.agent_id === agentId) continue;
      found.push({ agentId, channel: e.channel, peer: e.peer, userId: Number(owner.id), key: e.key });
    }
  }
  return found;
}

module.exports = { deliverableInfraSessions, INFRA_AGENTS, DELIVERABLE_AGENTS, PERSON_CHANNELS };
