'use strict';
// The identity-hardening watchdog. Two sweeps, both read-only:
//
// 1. OpenClaw config invariants — the settings the entire user-isolation
//    model rests on. If an OpenClaw update quietly regresses one of these,
//    nothing crashes: identity just stops being enforceable. This guard turns
//    "silent break, discovered weeks later" into "red row on the dashboard +
//    an issue within minutes".
// 2. Identity-file consistency — every active user's workspace must hold a
//    .olma-identity that matches users.identity_token exactly.
const fs = require('node:fs');
const path = require('node:path');
const occ = require('../intake/openclaw-config');
const infraAgent = require('../domain/infra-agent');
const sessions = require('../channels/sessions');
const { INTAKE_AGENT_ID } = require('./intake');

// The invariants, each with why it matters.
function checkOpenclawConfig(cfg) {
  const violations = [];
  const tools = cfg.tools || {};
  if (!tools.fs || tools.fs.workspaceOnly !== true) {
    violations.push('tools.fs.workspaceOnly is not true — identity tokens become readable across workspaces');
  }
  const also = Array.isArray(tools.alsoAllow) ? tools.alsoAllow : [];
  if (!also.includes('read')) {
    violations.push('tools.alsoAllow lacks "read" — agents cannot read their .olma-identity, all tool auth fails');
  }
  if (!cfg.mcp || !cfg.mcp.servers || Object.keys(cfg.mcp.servers).length === 0) {
    violations.push('mcp.servers is empty — the Olma tool server is not registered');
  }
  // The owner of ambient work. With a multi-agent roster and no systemAgent,
  // the gateway refuses every agent-less operation — which is the whole raw
  // pipe: reminders, the credit-out alarm, the runway warning, the nightly
  // eval alert. It fails per-send with a config error, so nothing crashes and
  // the outbox's own backoff hides it; on 2026-09-01 that cost a rent
  // reminder that expired undelivered and left the credit alarm mute for
  // twelve hours. The 2026.8.1 upgrade introduced the requirement and filled
  // this field in only for rosters that held a single agent.
  const roster = occ.listAgentIds(cfg);
  const systemAgent = ((cfg.agents || {}).defaults || {}).systemAgent || {};
  if (roster.length > 1 && !systemAgent.agentId) {
    violations.push('agents.defaults.systemAgent.agentId is unset — every raw `message send` refuses, so reminders and the credit alarm cannot go out (fix: scripts/set-system-agent.js --apply)');
  } else if (systemAgent.agentId && !occ.hasAgent(cfg, systemAgent.agentId)) {
    violations.push(`agents.defaults.systemAgent.agentId points at "${systemAgent.agentId}", which is not in the roster — ambient sends resolve to nothing`);
  }
  return violations;
}

async function checkIdentityFiles(client) {
  const { rows } = await client.query(
    `SELECT id, phone, workspace_path, identity_token FROM users
     WHERE status = 'active' AND workspace_path IS NOT NULL`
  );
  const violations = [];
  for (const u of rows) {
    const p = path.join(u.workspace_path, '.olma-identity');
    let problem = null;
    try {
      const onDisk = fs.readFileSync(p, 'utf8').trim();
      if (onDisk !== u.identity_token) problem = 'identity file does not match DB token';
    } catch {
      problem = `identity file missing/unreadable at ${p}`;
    }
    if (!problem) continue;
    // Since 2026-08-27 the token is rendered inline into AGENTS.md and the
    // file is only the FALLBACK. So a stale file is two different
    // situations wearing one sentence, and they deserve different urgency:
    // if the doctrine carries the right token the person is working fine and
    // only their recovery path is broken (file it, wake nobody); if it does
    // not, every tool call they make fails and that is worth an alarm.
    // Eight users hit the first case on 2026-09-01 — a test suite that ran on
    // the box overwrote their files — and the alarm said "כל קריאת כלי שלהם
    // נכשלת" about eight people whose agents were answering normally. An
    // alert that overstates is spent the first time it is checked.
    let doctrineOk = false;
    try {
      doctrineOk = fs.readFileSync(path.join(u.workspace_path, 'AGENTS.md'), 'utf8')
        .includes(u.identity_token);
    } catch { doctrineOk = false; }
    violations.push(doctrineOk
      ? `user ${u.id} (${u.phone}): ${problem} — fallback only, AGENTS.md carries the right token`
      : `user ${u.id} (${u.phone}): ${problem}`);
  }
  return violations;
}

// AGENTS.md carries the identity token inline (2026-08-27), so it is now a
// per-user secret rendered by a template — and a rendering bug could hand one
// person's agent another person's token, which is total impersonation rather
// than a leak. Same detector shape as the carryover check below, and the same
// reasoning: the failure is silent, so a machine has to be the one looking.
// A workspace still on the pre-token doctrine is NOT a violation — it falls
// back to reading .olma-identity, which still works.
async function checkAgentsTokens(client) {
  const { rows } = await client.query(
    `SELECT id, phone, workspace_path, identity_token FROM users
     WHERE status = 'active' AND workspace_path IS NOT NULL`
  );
  const byToken = new Map(rows.map((u) => [u.identity_token, Number(u.id)]));
  const violations = [];
  for (const u of rows) {
    let doctrine;
    try { doctrine = fs.readFileSync(path.join(u.workspace_path, 'AGENTS.md'), 'utf8'); } catch { continue; }
    if (doctrine.includes('{{IDENTITY_TOKEN}}')) {
      violations.push(`user ${u.id} (${u.phone}): AGENTS.md has an unrendered {{IDENTITY_TOKEN}} — every tool call will fail auth`);
      continue;
    }
    if (doctrine.includes(u.identity_token)) continue; // correct, and the common case
    for (const [token, ownerId] of byToken) {
      if (ownerId !== Number(u.id) && doctrine.includes(token)) {
        violations.push(`user ${u.id} (${u.phone}): AGENTS.md carries user ${ownerId}'s identity token — that agent can act as them`);
        break;
      }
    }
  }
  return violations;
}

// A carryover section holds one person's own words, quoted into their own
// card by provisioning. If two cards quote the SAME words, one of them is
// reading a stranger's message — which is what happened on 2026-08-20 and was
// only noticed on 2026-08-27, by a human, after the agent read it aloud to the
// wrong person. Prevention lives in jobs/intake.readIntakeFirstMessage; this
// is the detector, because a leak that only a person can spot is a leak that
// runs for a week.
// The seal that became the poison (2026-08-31 → 2026-09-02).
//
// Provisioning used to write `openclaw-workspace-state.json` into every new
// workspace to tell the gateway "setup is already done" — that is what kept
// OpenClaw's stock onboarding kit from hijacking a person's first
// conversation. Gateway 2026.8.1 moved that state into its own sqlite and
// reads the file as UNMIGRATED legacy state: assertNoUnmigratedWorkspaceState
// throws on its mere existence, without reading it, before the turn runs.
// Fail-closed, by design, and correct — but it turned our seal into a fatal
// marker in every workspace that had one.
//
// It cost 126 real inbound WhatsApp messages over 48 hours (98 to u-8, 28 to
// u-14, plus intake, so no stranger could be registered either) and NOTHING
// said so: /health was green, no heartbeat errored, the audit log had no row
// because turn_start never ran — the absence of the evidence WAS the symptom.
// It was found by reading the gateway journal by hand.
//
// The write is gone (intake/provision.js), so this is the backstop for a file
// arriving some other way: a doctor run interrupted, a restored backup, a
// future gateway writing one again.
const LEGACY_WORKSPACE_STATE = 'openclaw-workspace-state.json';

async function checkLegacyWorkspaceState(client, deps = {}) {
  const base = deps.openclawHome || process.env.OLMA_OPENCLAW_HOME || '/root/.openclaw';
  const { rows } = await client.query(
    `SELECT id, workspace_path FROM users
     WHERE status = 'active' AND workspace_path IS NOT NULL`
  );
  const violations = [];
  for (const u of rows) {
    if (fs.existsSync(path.join(u.workspace_path, LEGACY_WORKSPACE_STATE))) {
      violations.push(
        `user ${u.id}'s workspace holds ${LEGACY_WORKSPACE_STATE} — the gateway refuses every turn for that agent until it is moved aside`);
    }
  }
  // The greeter has no user row, and it is the one workspace whose failure is
  // invisible from the user table: strangers simply stop becoming users.
  if (fs.existsSync(path.join(base, 'workspaces', 'intake', LEGACY_WORKSPACE_STATE))) {
    violations.push(
      `the intake workspace holds ${LEGACY_WORKSPACE_STATE} — the greeter refuses every turn, so nobody new can register`);
  }
  return violations;
}

const CARRYOVER_HEADING = '## מה שכבר שיתפו';
const QUOTED_RE = /<<<([\s\S]*?)>>>/;
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

// Two cards holding identical text is SUSPICION, not proof, and on 2026-09-02
// this fired on a pair who had each independently typed "היי" to the greeter.
// A detector that files a leak against two people saying hello is the
// detection-layer-nobody-trusts failure — and it files it onto the same
// dashboard as the rows that do matter.
//
// The question that settles it is what the person actually sent: does THEIR
// OWN intake session contain the words their card is quoting? Containment
// rather than equality, because the greeter's session keeps growing after
// provisioning — the card holds a prefix of what is there now, never the whole
// of it. It also names which of the two cards is wrong, instead of reporting a
// pair and leaving an operator to work out which half to act on.
//
// null (no session left to read) is not innocence: an unverifiable pair falls
// back to reporting the collision, exactly as before.
function quotesOwnWords(read, phone, quoted, cache) {
  if (!cache.has(phone)) {
    let own = null;
    try { own = read(phone); } catch { own = null; }
    cache.set(phone, own ? norm(own) : null);
  }
  const own = cache.get(phone);
  return own === null ? null : own.includes(quoted);
}

async function checkCarryovers(client, deps = {}) {
  const read = deps.readPeerText || ((phone) => sessions.readPeerUserText(INTAKE_AGENT_ID, phone));
  const { rows } = await client.query(
    `SELECT id, phone, workspace_path FROM users
     WHERE status = 'active' AND workspace_path IS NOT NULL
     ORDER BY id`
  );
  const seen = new Map(); // carryover text → the first user who quoted it
  const cache = new Map(); // phone → their own intake text, read at most once
  const reported = new Set(); // user ids already named, so a pair cannot re-report one
  const violations = [];
  for (const u of rows) {
    let card;
    try { card = fs.readFileSync(path.join(u.workspace_path, 'USER.md'), 'utf8'); } catch { continue; }
    const at = card.indexOf(CARRYOVER_HEADING);
    if (at < 0) continue;
    const section = card.slice(at);
    const body = norm(section);
    // Legacy cards carry no <<< >>> fence; with nothing quotable to look up,
    // the old collision rule is all there is.
    const m = section.match(QUOTED_RE);
    const quoted = m ? norm(m[1]) : null;
    const mine = quoted ? quotesOwnWords(read, u.phone, quoted, cache) : null;
    const prior = seen.get(body);

    // A leak does not need an accomplice, and requiring one is what kept the
    // only two real leaks on the box invisible. Checking a card only once a
    // SECOND card shows up holding the same words assumes the victim's own
    // card still quotes the original — and it does not: a leak overwrites,
    // so the text ends up on exactly one card and the pair never forms.
    // Audited live 2026-09-03 against every active user's real intake session:
    // u-11 quoted a reminder about Pesach they never sent (they said "היי"),
    // u-17 quoted u-14's "מה העניינים ירון מה זה?" while she had actually
    // asked to book a nail appointment. Neither collided with anything, so
    // neither was ever reported; the ONLY pair on the box was two people who
    // had both said hello. The detector was looking exclusively at the case
    // that was innocent and past the two that were not.
    if (mine === false) {
      violations.push(prior
        ? `user ${u.id}'s card quotes an intake message they never sent — the same text is on user ${prior.id}'s card`
        : `user ${u.id}'s card quotes an intake message they never sent — it is not in their own intake session`);
      reported.add(u.id);
      if (prior === undefined) seen.set(body, u);
      continue;
    }
    if (prior === undefined) { seen.set(body, u); continue; }

    const theirs = quoted ? quotesOwnWords(read, prior.phone, quoted, cache) : null;
    if (mine === true && theirs === true) continue; // both of them really said it

    // `mine === false` is handled above, so the only card left to accuse is
    // the earlier one — and only if its own pass has not already named it.
    const suspect = (theirs === false && !reported.has(prior.id)) ? prior : null;
    if (suspect) {
      // Not sorted, deliberately: which card is WRONG is a fact about the
      // problem, so this title is stable on its own and naming them in that
      // order is the whole value of it.
      violations.push(
        `user ${suspect.id}'s card quotes an intake message they never sent — the same text is on user ${u.id}'s card`);
      reported.add(suspect.id);
    } else if (theirs === false) {
      continue; // already named on its own pass
    } else {
      // The unverifiable pair, and here the order IS arbitrary — which of the
      // two the loop reaches first is not a fact about anything.
      // fileViolations dedupes on the title, so unsorted this is two titles for
      // one condition: live on 2026-09-02 that filed the same carryover SEVEN
      // times, each tick filing one spelling and closing the other.
      const [a, b] = [Number(prior.id), Number(u.id)].sort((x, y) => x - y);
      violations.push(
        `users ${a} and ${b} carry the SAME intake carryover text — one card is quoting another person's message`);
    }
  }
  return violations;
}

// The marker that says "this row is the guard's, and the guard owns its
// lifecycle" — matched on the way back OUT, so only rows filed here are ever
// auto-closed. A human-filed or agent-reported issue is never touched.
const GUARD_DETAIL = 'raised by config-guard';

// Idempotent issue filing: one open issue per distinct violation text.
async function fileViolations(client, violations) {
  let filed = 0;
  for (const v of violations) {
    const title = v.slice(0, 200);
    const { rows } = await client.query(
      `SELECT 1 FROM issues WHERE title = $1 AND status IN ('new','triaged')`, [title]
    );
    if (rows[0]) continue;
    await client.query(
      `INSERT INTO issues (category, source, title, detail, status)
       VALUES ('bug', 'agent_detected', $1, $2, 'new')`,
      [title, GUARD_DETAIL]
    );
    filed++;
  }
  return filed;
}

// A watchdog that only ever OPENS rows stops being a watchdog. Every sweep
// re-derives the full truth from scratch — which is also what makes closing
// safe to get wrong: a condition closed prematurely is re-filed on the very
// next tick, so the worst case is a row that flickers, not one that vanishes.
// A title the guard filed and no longer reports is a condition that has cleared — and leaving it open is worse than never
// filing it, because it buries the live rows among the dead ones. Found on
// 2026-08-27: 13 open issues, every single one already resolved (four identity
// mismatches fixed the day before, nine outbox alarms from a credit outage
// long since over). That list is the same shape as the /health page nobody
// read for 13 hours — a signal that cries wolf teaches you to ignore it.
//
// Deliberately narrow: only rows this guard filed (detail = GUARD_DETAIL) and
// only while still open. 'fixed' rather than a delete — the fact that the
// condition happened at all is history worth keeping, and the dashboard can
// still show it. ('fixed' is the schema's word; the CHECK on issues.status
// allows new|triaged|fixed|wontfix and nothing else.)
async function closeResolved(client, violations) {
  const titles = violations.map((v) => v.slice(0, 200));
  const { rowCount } = await client.query(
    `UPDATE issues SET status = 'fixed', updated_at = now()
      WHERE detail = $1 AND status IN ('new','triaged')
        AND NOT (title = ANY($2::text[]))`,
    [GUARD_DETAIL, titles]
  );
  return rowCount;
}

// Messages that keep failing delivery are invisible otherwise: the worker
// retries with backoff forever and nobody hears about it.
// Every agent in openclaw.json must belong to somebody. The DB→disk direction
// was checked from the start; this is the reverse, and nothing looked that way
// until six orphan agents (u-15..u-20) were found by hand on 2026-08-27, two
// days after a rolled-back sweep left them behind — each with a workspace
// holding another user's carryover text and an identity token belonging to no
// one. Only `u-<n>` ids are judged: `main`, `intake` and any future
// infrastructure agent have no user row by design.
async function checkOrphanAgents(client, cfg) {
  const ids = occ.listAgentIds(cfg).filter((id) => /^u-\d+$/.test(id));
  if (!ids.length) return [];
  const { rows } = await client.query(
    `SELECT agent_id FROM users WHERE agent_id = ANY($1) AND status = 'active'`, [ids]);
  const known = new Set(rows.map((r) => r.agent_id));
  return ids.filter((id) => !known.has(id)).map((id) =>
    `agent ${id} is in openclaw.json with no active user — orphan of a failed provisioning; its workspace may hold another person's text`);
}

// The count deliberately does NOT go in the title. fileViolations dedupes on
// the title, so a count that moves files a brand-new issue every time it
// changes: nine near-identical "N outbox message(s) stuck" rows piled up over
// four days of the credit outage, which is how a dashboard stops being read.
async function checkStuckOutbox(client) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM outbox
     WHERE sent_at IS NULL AND attempts >= 5 AND created_at < now() - interval '1 hour'`);
  return rows[0].n > 0
    ? ['outbox messages stuck after 5+ delivery attempts — proactive messaging is failing']
    : [];
}

// `main` has no user, so nothing it ever says is addressed to anybody — and
// on 2026-09-01 it said it into a real person's WhatsApp. It still held six
// delivery-capable sessions from the v1 `--to <phone>` era, harmless for as
// long as nothing ran main; then the gateway upgrade auto-created 36 cron
// jobs targeting it and it began waking every half hour, emitting the literal
// string NO_REPLY and its own auth failures to whoever was on the other end.
//
// The session is the half worth watching, because it bounds every future
// thing that wakes main — including whatever the next upgrade invents. See
// domain/infra-agent.js.
async function checkInfraAgentSessions(client, deps) {
  const found = await infraAgent.deliverableInfraSessions(client, deps || {});
  // One row per (agent, channel), never per session: the count belongs in the
  // body, not the title, or a person joining files a brand-new issue —
  // checkStuckOutbox's lesson.
  const byAgent = new Map();
  for (const f of found) {
    const k = `${f.agentId}:${f.channel}`;
    byAgent.set(k, (byAgent.get(k) || 0) + 1);
  }
  return [...byAgent.keys()].map((k) => {
    const [agentId, channel] = k.split(':');
    return `agent ${agentId} holds ${channel} sessions that active users have talked INTO — it has no user of its own, so anything that wakes it answers a real person in a real conversation`;
  });
}

// Most violations describe damage nobody feels today: an orphan agent, a
// duplicated carryover, a config setting that WOULD matter if something else
// also broke. A dashboard row is the right home for those.
//
// Three are different in kind — while they hold, the affected agents cannot
// make a single successful tool call, and the person on the other end simply
// gets nothing:
//
//   - an identity file or an AGENTS.md whose token is not the DB's: every
//     tool call from that workspace fails auth;
//   - tools.alsoAllow lacking "read": the same, for everyone at once;
//   - mcp.servers empty: no Olma tools exist at all.
//
// On 2026-08-31 the guard filed five identity mismatches at 19:08:40, less
// than a minute after they appeared. They sat unread for eighty minutes,
// while five users' agents failed every call they made. The detection was
// never the problem — this file has been right and unread twice now
// (see the closeResolved note above, 2026-08-27). So this class alerts on
// the same raw pipe as the credit alarm: no model, no agent turn, works
// precisely when the system cannot answer for itself.
// "fallback only" is the negative lookahead's whole job: that variant means
// the person's agent is working and only their recovery path is stale, which
// belongs on the dashboard, not on a phone. See checkIdentityFiles.
const BREAKS_USERS = [
  /identity file (does not match DB token|missing)(?!.*fallback only)/,
  // Named exactly, not `AGENTS\.md .*token`: that pattern also matched the
  // reassuring half of the sentence above ("AGENTS.md carries the right
  // token") and turned a deliberate non-alert back into an alarm.
  /AGENTS\.md has an unrendered/,
  /AGENTS\.md carries user \d+'s identity token/,
  /alsoAllow lacks "read"/,
  /mcp\.servers is empty/,
  // Same class, arrived 2026-09-02: the agent does not fail a tool call, it
  // never starts a turn at all. Silent for 48 hours the first time.
  /holds openclaw-workspace-state\.json/,
];

function breaksUsers(violation) {
  return BREAKS_USERS.some((re) => re.test(violation));
}

// One flag holds the set we have already alerted about, so a condition that
// persists across ticks is announced ONCE and a NEW one still gets through —
// the tiering rule the balance warning already follows. Recovery clears the
// entry, so the same break happening again next week alerts again.
const ALERTED_FLAG = 'config_guard_alerted';

async function alertCritical(client, violations, deps) {
  if (!deps || !deps.send) return null;
  const flags = require('../domain/flags');
  const critical = violations.filter(breaksUsers);
  let known = [];
  try { known = JSON.parse((await flags.getFlag(client, ALERTED_FLAG)) || '[]'); } catch { known = []; }
  if (!Array.isArray(known)) known = [];

  // Two halves of the stored set, and they are written under different rules.
  // Dropping the CLEARED ones is unconditional — a condition that resolved
  // must leave, or its recurrence next month is silently swallowed. Adding a
  // fresh one records that somebody was TOLD, so it may only be written once
  // the pipe confirms it: the same promise the credit alarm and the balance
  // warning make, and the reason a failed send retries on the next tick
  // instead of vanishing into a flag that claims it was announced.
  const stillKnown = known.filter((v) => critical.includes(v));
  const fresh = critical.filter((v) => !known.includes(v));

  const save = async (set) => {
    const next = set.slice(0, 50);
    if (JSON.stringify(next) !== JSON.stringify(known)) {
      await flags.setFlag(client, ALERTED_FLAG, JSON.stringify(next));
    }
  };

  if (!fresh.length) {
    await save(stillKnown);
    return null;
  }

  const phone = (await flags.getFlag(client, 'admin_alert_phone'))
    || require('./credit-watch').DEFAULT_ALERT_PHONE;
  const lines = ['🔴 אולמה: משתמשים חסומים ברמת הזהות — כל קריאת כלי שלהם נכשלת.'];
  for (const v of fresh.slice(0, 6)) lines.push(`• ${v}`);
  if (fresh.length > 6) lines.push(`ועוד ${fresh.length - 6}.`);
  lines.push('הפירוט בדשבורד, בקטע התקלות.');

  // A pipe that throws must not take the issue rows down with it — the
  // dashboard record is the durable half and is already written by now.
  let sent = null;
  let error = null;
  try { sent = await deps.send(phone, lines.join('\n')); } catch (e) { error = e.message; }
  const ok = Boolean(sent && sent.ok);
  await save(ok ? stillKnown.concat(fresh) : stillKnown);
  if (ok) return { alerted: fresh.length, phone };
  return { alertFailed: true, ...(error ? { alertError: error } : {}) };
}

async function run(client, { configPath, ...deps } = {}) {
  let violations = [];
  try {
    const cfg = occ.loadConfig(configPath);
    violations = violations.concat(checkOpenclawConfig(cfg));
    violations = violations.concat(await checkOrphanAgents(client, cfg));
  } catch (e) {
    violations.push('openclaw.json unreadable: ' + e.message);
  }
  violations = violations.concat(await checkIdentityFiles(client));
  violations = violations.concat(await checkAgentsTokens(client));
  violations = violations.concat(await checkLegacyWorkspaceState(client, deps));
  violations = violations.concat(await checkCarryovers(client));
  violations = violations.concat(await checkStuckOutbox(client));
  violations = violations.concat(await checkInfraAgentSessions(client, deps));
  const filed = await fileViolations(client, violations);
  const closed = await closeResolved(client, violations);
  // Filing first, alerting second: the dashboard row is the durable record
  // and must exist even if the pipe is down.
  const alert = await alertCritical(client, violations, deps);
  return {
    violations: violations.length, newIssues: filed, closedIssues: closed,
    ...(alert || {}),
  };
}

module.exports = {
  run, checkOpenclawConfig, checkIdentityFiles, checkAgentsTokens,
  checkCarryovers, checkOrphanAgents, checkStuckOutbox, checkInfraAgentSessions,
  checkLegacyWorkspaceState, LEGACY_WORKSPACE_STATE,
  fileViolations, closeResolved,
  alertCritical, breaksUsers, ALERTED_FLAG,
};
