'use strict';
// The intake pipeline sweeps, run inside brokerd.
//
// Discovery: unknown phones that landed on the intake agent (they already got
// an instant contextual reply from it — a tool-less agent that can only talk).
// For each: registration open, or invited-by-a-friend → provision and queue
// the personalized welcome immediately. Closed and uninvited → waitlist (the
// intake agent's standing instructions already told them; we only remember the
// promise to ping back).
//
// No gateway restart is involved any more — provisioning writes the agent and
// the binding in ONE config save, and that combination hot-applies. See
// intake/openclaw-config.js for why, and what the earlier probe got wrong.
//
// Reopen: registration_open flipped back on → keep the promise, through the
// outbox (respectfully timed), exactly once per waitlisted phone.
const usersDomain = require('../domain/users');
const connectionsDomain = require('../domain/connections');
const flags = require('../domain/flags');
const audit = require('../domain/audit');
const { enqueue } = require('../outbox/enqueue');
const { provisionUser } = require('../intake/provision');
const { welcomeText, reopenMessage } = require('../intake/messages');
const occ = require('../intake/openclaw-config');
const sessions = require('../channels/sessions');

const INTAKE_AGENT_ID = 'intake';

// ---- session discovery ------------------------------------------------------

// Reads the gateway's own on-disk session index for the intake agent — one
// small file, no process spawn (the CLI equivalent cost 2.9s of CPU per call;
// see channels/sessions.js). Throws if the file is malformed, so the sweep's
// heartbeat goes red rather than reporting a convincing "no new users" while
// discovery is actually broken.
function defaultListIntakeSessions() {
  return sessions.listSessionsForAgent(INTAKE_AGENT_ID)
    .filter((s) => s.channel === 'whatsapp' && s.chatType === 'direct')
    .map((s) => ({ phone: s.peer, key: s.key, ageMs: s.ageMs }));
}

function intakeConfigured(configPath) {
  try {
    const cfg = occ.loadConfig(configPath);
    return (cfg.agents && cfg.agents.list || []).some((a) => a.id === INTAKE_AGENT_ID);
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

    const prov = await provisionUser(client, {
      phone, invitedByConnectionId: invited ? invited.id : null, configPath: deps.configPath,
    });
    if (!prov.ok) { out.skipped++; continue; }
    const user = prov.data.user;

    if (invited) {
      await connectionsDomain.attachProvisionedTarget(client, invited.id, user.id);
    }
    const firstMessage = deps.readFirstMessage ? await deps.readFirstMessage(phone) : null;
    const inviter = invited
      ? (await client.query(`SELECT first_name, last_name, phone FROM users WHERE id = $1`, [invited.requester_id])).rows[0]
      : null;
    await enqueue(client, {
      // No releaseAfter: the binding written a line above is already live, so
      // the very next drain can deliver — and the caller kicks one immediately.
      userId: user.id, kind: 'welcome', urgency: 'urgent',
      payload: {
        text: welcomeText({ firstName: user.first_name, phone }),
        firstMessage,
        invited: invited ? {
          connectionId: Number(invited.id),
          inviterName: [inviter.first_name, inviter.last_name].filter(Boolean).join(' ') || inviter.phone,
          reason: invited.invite_reason || null,
        } : null,
      },
      idempotencyKey: `welcome:${user.id}`,
    });
    out.provisioned.push(phone);
  }
  return out;
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
    const user = await usersDomain.getByPhone(client, phone)
      || (await usersDomain.createUser(client, { phone, status: 'pending' })).data.user;
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

module.exports = { sweepIntakeSessions, sweepReopen, intakeConfigured, INTAKE_AGENT_ID, defaultListIntakeSessions };
