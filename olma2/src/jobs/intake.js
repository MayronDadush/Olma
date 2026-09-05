'use strict';
// The intake pipeline sweeps, run inside brokerd.
//
// Discovery: unknown phones that landed on the intake agent (they already got
// a real, in-voice reply from it — a tool-less agent that answers for real,
// see intake/intake-workspace.js). For each: registration open, or
// invited-by-a-friend → provision. Closed and uninvited → waitlist (the
// intake agent's standing instructions already told them; we only remember the
// promise to ping back).
//
// No gateway restart is involved any more — provisioning writes the agent and
// the binding in ONE config save, and that combination hot-applies. See
// intake/openclaw-config.js for why, and what the earlier probe got wrong.
//
// No separate welcome message either (2026-08-17 redesign): whatever the
// person already said to the intake agent is extracted and handed straight
// into their personal workspace by provisionUser — there is nothing left for
// this sweep to enqueue once provisioning succeeds. The conversation the
// person is already in just continues, silently more capable.
//
// Reopen: registration_open flipped back on → keep the promise, through the
// outbox (respectfully timed), exactly once per waitlisted phone.
const { withTx } = require('../db/pool');
const usersDomain = require('../domain/users');
const connectionsDomain = require('../domain/connections');
const flags = require('../domain/flags');
const audit = require('../domain/audit');
const { enqueue } = require('../outbox/enqueue');
const { provisionUser } = require('../intake/provision');
const { reopenMessage } = require('../intake/messages');
const occ = require('../intake/openclaw-config');
// The worker-thread facade: this sweep ticks every 5 seconds inside brokerd,
// and its reads are the most frequent synchronous work the daemon did
// (see channels/sessions-async.js). Both readers below were already awaited
// by sweepIntakeSessions, so the switch changes nothing for callers.
const sessions = require('../channels/sessions-async');

const INTAKE_AGENT_ID = 'intake';

// ---- session discovery ------------------------------------------------------

// Reads the gateway's own on-disk session index for the intake agent — one
// small file, no process spawn (the CLI equivalent cost 2.9s of CPU per call;
// see channels/sessions.js). Throws if the file is malformed, so the sweep's
// heartbeat goes red rather than reporting a convincing "no new users" while
// discovery is actually broken.
async function defaultListIntakeSessions() {
  return (await sessions.listSessionsForAgent(INTAKE_AGENT_ID))
    .filter((s) => s.channel === 'whatsapp' && s.chatType === 'direct')
    .map((s) => ({ phone: s.peer, key: s.key, ageMs: s.ageMs }));
}

// What this person typed to the greeter while we set them up — folded into
// their personal workspace by provisionUser (see intake/provision.js).
//
// This is the ONE place in the system where one person's private words are
// written into another person's permanent context, so it is the one place
// that must prove whose words they are. It failed exactly that way: user 13's
// card carried user 8's intake message ("תזכירי לי לשאול את חיים...") for a
// week, and on 2026-08-27 his agent read it back to him as if it were his own
// reminder. The lookup is peer-scoped and reads correctly today, so the
// mechanism was upstream — a session index that, at that moment, resolved his
// key to another peer's file. Trusting that mapping is the bug regardless of
// how it broke.
//
// `otherPhones` is every OTHER peer the greeter has spoken to (the sweep
// already has the list). If any of them produces the identical text, the
// mapping cannot be trusted for either of them — drop it. A dropped carryover
// costs one person a warmer first turn; a wrong one hands their private
// message to a stranger.
async function readIntakeFirstMessage(phone, otherPhones = []) {
  try {
    const text = await sessions.readPeerUserText(INTAKE_AGENT_ID, phone);
    if (!text) return null;
    for (const other of otherPhones) {
      if (other === phone) continue;
      if (await sessions.readPeerUserText(INTAKE_AGENT_ID, other) === text) return null;
    }
    return text;
  } catch { return null; }
}

function intakeConfigured(configPath) {
  try {
    const cfg = occ.loadConfig(configPath);
    return occ.hasAgent(cfg, INTAKE_AGENT_ID);
  } catch { return false; }
}

// One discovery pass. deps: { listSessions, configPath, readFirstMessage }
async function sweepIntakeSessions(client, deps) {
  if (!intakeConfigured(deps.configPath)) return { skipped: 'no_intake_agent' };
  const sessions = await (deps.listSessions || defaultListIntakeSessions)();
  const out = { provisioned: [], waitlisted: [], skipped: 0 };

  // Circuit breaker: the catch-all means every stranger message costs a model
  // turn with NO quota guarding it (quota starts at provisioning). If intake
  // activity in the last hour exceeds the cap, close registration — the
  // intake greeter flips to its "paused" text and an issue hits the
  // dashboard. Turns a spam flood from an open tab into a capped bill.
  const cap = Number(await flags.getFlag(client, 'intake_hourly_cap') ?? 30);
  const recentCount = sessions.filter((s) => (s.ageMs ?? 0) < 3600_000).length;
  if (recentCount > cap && (await flags.getFlag(client, 'registration_open')) === true) {
    await flags.setFlag(client, 'registration_open', false);
    const guard = require('./config-guard');
    await guard.fileViolations(client, [
      `intake circuit breaker tripped — ${recentCount} intake sessions in the last hour (cap ${cap}); registration auto-closed`,
    ]);
    await audit.record(client, null, 'intake.breaker_tripped', { recentCount, cap });
    out.breakerTripped = true;
  }

  for (const { phone } of sessions) {
    if (!/^\+\d{7,15}$/.test(phone)) { out.skipped++; continue; }
    const existing = await usersDomain.getByPhone(client, phone);
    if (existing && existing.status === 'active' && existing.agent_id) { out.skipped++; continue; }
    if (existing && existing.status === 'blocked') { out.skipped++; continue; }

    const invited = (await client.query(
      `SELECT * FROM connections WHERE target_phone = $1 AND status = 'invited' ORDER BY invited_at LIMIT 1`,
      [phone]
    )).rows[0];
    const regOpen = (await flags.getFlag(client, 'registration_open')) === true;

    if (!regOpen && !invited) {
      // remember the promise; the intake agent's closed-mode text already answered them
      await client.query(
        `INSERT INTO waitlist (phone, reason) VALUES ($1, 'organic') ON CONFLICT (phone) DO NOTHING`, [phone]
      );
      await audit.record(client, null, 'intake.waitlisted', { phone });
      out.waitlisted.push(phone);
      continue;
    }

    // Extracted before provisioning so seedWorkspace can write it straight
    // into USER.md — facts only (readPeerUserText caps + condenses), never
    // the raw transcript.
    const firstMessage = deps.readFirstMessage
      ? await deps.readFirstMessage(phone, sessions.map((s) => s.phone))
      : null;
    const inviter = invited
      ? (await client.query(`SELECT first_name, last_name, phone FROM users WHERE id = $1`, [invited.requester_id])).rows[0]
      : null;
    const invitedInfo = invited ? {
      connectionId: Number(invited.id),
      inviterName: [inviter.first_name, inviter.last_name].filter(Boolean).join(' ') || inviter.phone,
      reason: invited.invite_reason || null,
    } : null;

    const prov = await provisionUser(client, {
      phone, invitedByConnectionId: invited ? invited.id : null, configPath: deps.configPath,
      firstMessage, invitedInfo, registerUndo: deps.registerUndo,
    });
    if (!prov.ok) { out.skipped++; continue; }
    const user = prov.data.user;

    if (invited) {
      await connectionsDomain.attachProvisionedTarget(client, invited.id, user.id);
    }
    out.provisioned.push(phone);
  }
  return out;
}

// Owns the transaction, because provisioning's side effects live outside it.
// The sweep provisions several people in ONE transaction; the DB rolls all of
// them back together if any later step throws, but a workspace already
// written to disk and an agent already in openclaw.json do not roll back with
// it. That is how six orphan agents appeared on the live box on 2026-08-26,
// each holding a real user's private carryover text, with no audit row to say
// they existed. Anything the sweep created is undone here on the way out —
// and this wrapper sits OUTSIDE withTx on purpose, so a failure in COMMIT
// itself is compensated too, not just a failure inside the callback.
async function runIntakeSweep(pool, deps) {
  const undos = [];
  try {
    return await withTx(pool, (client) => sweepIntakeSessions(client, {
      ...deps, registerUndo: (fn) => undos.push(fn),
    }));
  } catch (e) {
    // Reverse order: last thing created is the first thing removed.
    for (const undo of undos.reverse()) {
      try { undo(); } catch (inner) { console.error(`[intake] undo failed: ${inner.message}`); }
    }
    throw e;
  }
}

// ---- registration reopen ----------------------------------------------------

async function sweepReopen(client) {
  const regOpen = (await flags.getFlag(client, 'registration_open')) === true;
  if (!regOpen) return { notified: 0 };
  const { rows } = await client.query(
    `SELECT phone FROM waitlist WHERE notified_at IS NULL LIMIT 50`
  );
  let notified = 0;
  for (const { phone } of rows) {
    let user = await usersDomain.getByPhone(client, phone);
    if (!user) {
      // A failed create returns a result with no `data` at all — reaching
      // straight through it threw a TypeError that killed the sweep for every
      // remaining waitlisted person.
      const created = await usersDomain.createUser(client, { phone, status: 'pending' });
      if (!created.ok) continue;
      user = created.data.user;
    }
    await enqueue(client, {
      userId: user.id, kind: 'registration_reopened',
      payload: { text: reopenMessage(phone) },
      idempotencyKey: `reopen:${phone}`,
    });
    await client.query(`UPDATE waitlist SET notified_at = now() WHERE phone = $1`, [phone]);
    notified++;
  }
  return { notified };
}

module.exports = {
  sweepIntakeSessions, runIntakeSweep, sweepReopen, intakeConfigured, INTAKE_AGENT_ID,
  defaultListIntakeSessions, readIntakeFirstMessage,
};
