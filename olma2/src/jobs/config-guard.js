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

// ── The doctrine budget ──────────────────────────────────────────────────────
// AGENTS.md is injected into every turn, and the gateway will not tell you when
// it no longer fits. `trimAgentsBootstrapContent` (dist/bootstrap-*.js) keeps a
// head and a tail and DELETES WHAT IS BETWEEN THEM — so the failure is not a
// refused turn or a truncated ending, it is a hole in the middle of the
// instructions, in whichever section happens to sit at the cut. Nothing logs,
// nothing errors, and the model simply behaves as though a rule it was never
// shown does not exist.
//
// Found 2026-09-04 by measuring rather than by anything failing: every user's
// rendered AGENTS.md was 41,227 chars against a 40,000 budget, and the 1,227
// being dropped were the middle of "Other people — consent first, always",
// including the rule that stops an agent inventing the day of a meeting that
// reaches somebody else. It had been happening 47 times a day, for all 11
// users, and the reason no test caught it is structural: the test file's 65
// pins are what a truncation has to avoid, so it can only ever eat an unpinned
// section — which is exactly what it ate.
//
// This is a dashboard row and deliberately NOT in BREAKS_USERS. Tool calls all
// succeed; what degrades is judgement, silently. That list means one thing and
// widening it is the mistake #97 fixed.
const GATEWAY_DEFAULT_BOOTSTRAP_MAX_CHARS = 2e4;
// One doctrine bullet runs 300–500 chars and a paragraph 600–900, so this
// margin says "the next paragraph you add will not fit" while there is still
// time to shorten something instead of discovering the loss afterwards.
const BOOTSTRAP_WARN_MARGIN = 750;

// The limit is a CONFIG VALUE, not a constant — ours is 40000, the gateway's
// own default is 20000 — so it is read rather than assumed. An absent key means
// the gateway default applies; reading it as "no limit" would make this check
// pass on precisely the config where the budget is tightest.
function bootstrapBudget(cfg) {
  const v = (((cfg || {}).agents || {}).defaults || {}).bootstrapMaxChars;
  return Number.isFinite(v) && v > 0 ? v : GATEWAY_DEFAULT_BOOTSTRAP_MAX_CHARS;
}

async function checkBootstrapBudget(client, cfg) {
  const limit = bootstrapBudget(cfg);
  const { rows } = await client.query(
    `SELECT id, workspace_path FROM users
     WHERE status = 'active' AND workspace_path IS NOT NULL ORDER BY id`
  );
  let largest = 0; let over = 0; let near = 0; let read = 0;
  for (const u of rows) {
    let size;
    // A file that could not be read is never a file in trouble — the
    // credit-watch rule. It is counted as unread and reported as such below,
    // because a check that goes quiet is indistinguishable from one that
    // passes, which is the failure this file has now recorded four times.
    try { size = fs.readFileSync(path.join(u.workspace_path, 'AGENTS.md'), 'utf8').length; }
    catch { continue; }
    read++;
    if (size > largest) largest = size;
    if (size > limit) over++;
    else if (size > limit - BOOTSTRAP_WARN_MARGIN) near++;
  }
  const violations = [];
  // No number goes in the text. fileViolations dedupes on the title and
  // closeResolved closes titles no longer reported, so a size in there would
  // file a fresh issue and close the old one on the next deploy that moved the
  // file by a byte — the guard fighting itself, exactly as the non-deterministic
  // carryover title did. Magnitude belongs in the heartbeat, where it does not
  // key anything.
  if (over) {
    violations.push(
      "an active user's AGENTS.md is over the gateway's bootstrap budget — the middle of the doctrine is cut out before the model ever sees it, silently (shorten src/intake/agents-template.md, then resync-agent-templates.js)");
  } else if (near) {
    violations.push(
      "an active user's AGENTS.md is nearly at the gateway's bootstrap budget — the next doctrine paragraph will be silently cut (shorten src/intake/agents-template.md)");
  }
  return {
    violations,
    // Reported every tick, unlike `configValidation`: this one is a measurement
    // an operator wants to watch drift, not an exception.
    stats: { limit, largest, over, near, read, users: rows.length },
    ...(read === 0 && rows.length ? { skipped: 'no AGENTS.md could be read' } : {}),
  };
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

// Permission to use a model is spread across THREE independent lists, and a
// model missing from any one of them is refused — so they only work when they
// agree. Found 2026-09-01, the expensive way: a pilot registered two models
// through the two lists the code knew about and the override was still refused,
// because gateway 2026.8.1 had introduced a third, `agents.defaults.modelPolicy
// .allow`, and seeded it from the then-current allowlist. Nothing was broken
// and nothing said so; the config simply disagreed with itself.
//
//   agents.defaults.models              — the allowlist (what we intend to permit)
//   models.providers.openrouter.models  — the catalog (what the gateway can resolve)
//   agents.defaults.modelPolicy.allow   — a second permit list, 2026.8.1+
//
// This is the `agents.list` → `agents.entries` shape a third time: the vendor's
// own migration moves a key, our writer keeps the old schema in its head, and
// the failure is silent until something tries to use the result. The general
// version — diffing every key in openclaw.json against what we expect — was
// deliberately NOT built. It cannot tell a key that matters from the dozens
// that do not, and a guard that files an issue per harmless vendor addition is
// the 13-dead-rows failure documented above, manufactured on purpose.
//
// Severity is split because the consequences are not comparable: a DEFAULT
// model missing from a restricting list means every live turn fails, while a
// registered-but-unpermitted candidate only means the next pilot is refused.
function modelIdsOf(defaultModel) {
  if (typeof defaultModel === 'string') return [defaultModel];
  if (defaultModel && typeof defaultModel === 'object') {
    const fb = Array.isArray(defaultModel.fallbacks) ? defaultModel.fallbacks : [];
    return [defaultModel.primary, ...fb].filter((m) => typeof m === 'string' && m);
  }
  return [];
}

function checkModelPermissions(cfg) {
  const defaults = (cfg.agents && cfg.agents.defaults) || {};
  const allowlist = Object.keys(defaults.models || {});
  const policy = defaults.modelPolicy;
  // An absent or EMPTY allow list means "no restriction" — the gateway's own
  // error text says so ("remove/empty the list to allow any model"). Only a
  // list that actually restricts can be disagreed with.
  const policyAllow = policy && Array.isArray(policy.allow) && policy.allow.length
    ? new Set(policy.allow) : null;
  const catalog = new Set(
    (((cfg.models || {}).providers || {}).openrouter || {}).models
      ?.map((m) => m && m.id).filter(Boolean) || []);
  const inCatalog = (id) => !id.startsWith('openrouter/') || catalog.has(id.replace(/^openrouter\//, ''));

  const violations = [];

  // The live path first. A default or fallback the gateway will refuse is not a
  // latent problem — it is every user's next message failing, or silently
  // burning a fallback nobody chose.
  for (const id of modelIdsOf(defaults.model)) {
    if (policyAllow && !policyAllow.has(id)) {
      violations.push(`default/fallback model ${id} is missing from agents.defaults.modelPolicy.allow — the gateway will refuse it and live turns fall through to the next fallback`);
    }
    if (!inCatalog(id)) {
      violations.push(`default/fallback model ${id} has no entry in models.providers.openrouter.models — the gateway cannot resolve it`);
    }
  }

  // Then the pilot path: registered candidates that cannot actually be selected.
  for (const id of allowlist) {
    if (modelIdsOf(defaults.model).includes(id)) continue; // already reported above, with the louder wording
    if (policyAllow && !policyAllow.has(id)) {
      violations.push(`model ${id} is in the allowlist but not in agents.defaults.modelPolicy.allow — a --model pilot on it will be refused`);
    }
    if (!inCatalog(id)) {
      violations.push(`model ${id} is in the allowlist but not in models.providers.openrouter.models — a --model pilot on it will be refused`);
    }
  }
  return violations;
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

// Every check above reads the config FILE. This one asks a different question:
// will the gateway actually load it? Found 2026-09-03 by writing a key the
// per-agent schema does not accept (`agents.entries.<id>.tools.toolSearch`):
//
//   [reload] config reload skipped (invalid config):
//   agents.entries.u-15.tools: Unrecognized keys: "sessions", "media", "toolSearch"
//
// The gateway logged that once and kept serving the LAST VALID config. Nothing
// errored, nothing retried, every agent answered normally — and meanwhile the
// file on disk had stopped being the thing in force. That is the dangerous
// half: `provision.js` writes a joiner's agent + binding into this same file
// and depends on the hot reload to make them live (the bundled agents.list +
// bindings write, which is why there is no restart). While the config is
// invalid, that write is inert: the new user's agent never exists to the
// gateway, their binding routes nowhere, and no reader of the file can tell —
// `occ.loadConfig` parses it perfectly. Same silent shape as `intakeConfigured`
// reading only `.list`.
//
// Deliberately NOT in BREAKS_USERS. That list means exactly "their tool calls
// fail", and this breaks nobody who already exists — the gateway is still
// serving a config that works. It is a dashboard row. If it earns a phone
// later it should get its OWN list with its own meaning, the way a leaked
// credential does, never a widening of that one.
// Returns { violations, skipped } rather than a bare array, and that is the
// point. Every path below that declines to judge — no validator wired, no
// binary, a path this cannot map, a timeout — files NO violation, which is
// right: a thing that could not be READ is never a thing in trouble (the
// credit-watch rule). But a check that goes quiet and looks identical to a
// check that passed is this project's most-repeated failure, recorded four
// times over: thirteen resolved issues nobody read, /health red for thirteen
// hours, the archived-session detector reporting its own fix. So the reason
// rides the job heartbeat, where an operator can tell "nothing wrong" from
// "not looking". Raised by a peer session reviewing this design, and correct.
async function checkConfigApplied({ configPath, validateConfig } = {}) {
  // Unwired → silent, but SAID. The default is off so no test spawns a
  // subprocess by accident; bin/olma-brokerd.js supplies the real validator.
  if (typeof validateConfig !== 'function') return { violations: [], skipped: 'no validator wired' };
  let res;
  try {
    res = await validateConfig(configPath);
  } catch (e) {
    return { violations: [], skipped: 'validator failed: ' + String((e && e.message) || e).slice(0, 120) };
  }
  // valid === null is the validator declining: no CLI on this box, or a config
  // path it refuses to map to a home directory. Not a pass, not a failure.
  if (!res || res.valid === null || res.valid === undefined) {
    return { violations: [], skipped: (res && res.reason) || 'validator returned nothing' };
  }
  if (res.valid !== false) return { violations: [], skipped: null };
  // The issue paths, not a count: they are stable for a given breakage (so
  // fileViolations' title dedupe still collapses repeat sweeps) and they are
  // the only actionable part. checkStuckOutbox's lesson was a COUNT that moved
  // every tick for one unchanged problem; a changed path IS a changed problem.
  const issues = Array.isArray(res.issues) ? res.issues : [];
  const detail = issues.slice(0, 3)
    .map((i) => `${i && i.path ? i.path : '?'}: ${i && i.message ? i.message : '?'}`)
    .join('; ')
    .slice(0, 300);
  const more = issues.length > 3 ? ` (+${issues.length - 3} more)` : '';
  return {
    violations: [`openclaw.json does not validate — the gateway is serving the last valid config, so every config write since is inert and a new user's agent cannot go live${detail ? ` — ${detail}` : ''}${more}`],
    skipped: null,
  };
}

// The real validator. Deliberately built here rather than inlined in brokerd so
// the path rule is testable, and deliberately NOT the default inside run().
//
// `openclaw config validate` resolves its own target from $OPENCLAW_HOME —
// there is no --config flag — so this can only speak for the file the guard
// just read if it can prove the two are the same. It insists on the exact
// <home>/.openclaw/openclaw.json shape and declines otherwise: validating a
// DIFFERENT file and reporting the answer as if it were this one is worse than
// not looking, because it would be confidently wrong.
function makeConfigValidator({ run, timeoutMs = 20000 } = {}) {
  const exec = run || ((home, ms) => new Promise((resolve) => {
    const { execFile } = require('node:child_process');
    execFile('openclaw', ['config', 'validate', '--json'], {
      env: { ...process.env, OPENCLAW_HOME: home },
      timeout: ms, maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  }));
  return async function validateConfig(configPath) {
    if (typeof configPath !== 'string' || path.basename(configPath) !== 'openclaw.json'
      || path.basename(path.dirname(configPath)) !== '.openclaw') {
      return { valid: null, reason: `config path not validatable (${configPath || 'unset'})` };
    }
    const home = path.dirname(path.dirname(configPath));
    const { err, stdout, stderr } = await exec(home, timeoutMs);
    // A non-zero exit is how "invalid" is reported, so the error alone proves
    // nothing — the JSON body decides. Only an unparseable body is a decline.
    let body = null;
    try { body = JSON.parse(String(stdout || '').trim() || 'null'); } catch { body = null; }
    if (!body || typeof body !== 'object' || typeof body.valid !== 'boolean') {
      const why = err && err.code === 'ENOENT' ? 'openclaw CLI not on PATH'
        : err && err.killed ? 'validator timed out'
          : 'validator output unparseable';
      return { valid: null, reason: `${why}${stderr ? ': ' + String(stderr).slice(0, 120) : ''}` };
    }
    return { valid: body.valid, issues: Array.isArray(body.issues) ? body.issues : [] };
  };
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

// The set of leaks already seen, kept in a flag rather than a table: it is a
// handful of rows of operational state, it is written by exactly one caller,
// and `config_guard_alerted` above already establishes the pattern — a
// migration would buy nothing here.
const LEAK_FLAG = 'token_leak_seen';

// A live identity token that was sent to somebody as message text.
//
// Remembered rather than re-derived, because the scan window bounds cost and
// must not bound truth: an unrotated credential that scrolls past the window
// would otherwise vanish from the violations list and closeResolved would
// close the issue on its own — a detector announcing a fix nobody performed.
// An entry leaves only when the user's token no longer matches the fingerprint
// that leaked, which is exactly the moment the exposure ends.
async function checkLeakedTokens(client, deps) {
  const flags = require('../domain/flags');
  const tokenLeak = require('../domain/token-leak');

  let stored = [];
  try { stored = JSON.parse((await flags.getFlag(client, LEAK_FLAG)) || '[]'); } catch { stored = []; }
  if (!Array.isArray(stored)) stored = [];

  const { fpByUser } = await tokenLeak.liveTokens(client);
  const found = await tokenLeak.scanForLeaks(client, deps || {});
  const next = tokenLeak.reconcile(stored, found, fpByUser);

  if (JSON.stringify(next) !== JSON.stringify(stored)) {
    await flags.setFlag(client, LEAK_FLAG, JSON.stringify(next.slice(0, 50)));
  }
  return next.map(tokenLeak.violationFor);
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
// A SECOND thing worth a phone, and deliberately its own list rather than a
// widening of the one above. BREAKS_USERS means exactly "their tool calls
// fail"; a leaked credential breaks nothing and is still urgent. Merging them
// would put the alert list back to meaning two things at once — the mistake
// #97 fixed and this file has warned about twice. Two lists, one meaning each,
// each with its own headline.
const LEAKS_CREDENTIAL = [
  /a live identity token was sent as message text/,
];

function leaksCredential(violation) {
  return LEAKS_CREDENTIAL.some((re) => re.test(violation));
}

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

// Each class gets its own headline, because a wrong one is worse than none:
// announcing a leaked credential under "users are blocked" would send the
// operator looking for an outage that is not happening.
const ALERT_CLASSES = [
  { match: breaksUsers, headline: '🔴 אולמה: משתמשים חסומים ברמת הזהות — כל קריאת כלי שלהם נכשלת.', tail: 'הפירוט בדשבורד, בקטע התקלות.' },
  {
    match: leaksCredential,
    headline: '🔴 אולמה: טוקן זהות חי נשלח כטקסט לצ׳אט אמיתי.',
    tail: 'הטוקן עדיין תקף — החלפתו היא מה שמסיים את החשיפה. הפירוט בדשבורד, בקטע התקלות.',
    // Waits for a civil hour. Rotating a token is a deliberate act nobody
    // performs asleep, and the exposure is days old by the time it is noticed
    // — so this is not the "everything is down" class above, which still goes
    // out whenever it happens. Deferring leaves it UNSTAMPED, so the next
    // 10-minute tick simply retries until the window opens: the same promise
    // the credit alarm makes, minus the queue it needs because its evidence
    // ages out. A leaked token's evidence does not — it is remembered.
    daytimeOnly: true,
  },
];

async function alertCritical(client, violations, deps) {
  if (!deps || !deps.send) return null;
  const flags = require('../domain/flags');
  const critical = violations.filter((v) => ALERT_CLASSES.some((c) => c.match(v)));
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

  const creditWatch = require('./credit-watch');
  const phone = (await flags.getFlag(client, 'admin_alert_phone'))
    || creditWatch.DEFAULT_ALERT_PHONE;

  // One message per class that has something new, so each arrives under a
  // headline that is true of it. A class with nothing fresh sends nothing.
  const announced = [];
  let error = null;
  let deferred = 0;
  for (const cls of ALERT_CLASSES) {
    const mine = fresh.filter(cls.match);
    if (!mine.length) continue;
    if (cls.daytimeOnly && !(await creditWatch.alertHourOpen(client, phone))) {
      deferred += mine.length;
      continue; // unstamped on purpose — the next tick retries it
    }
    const lines = [cls.headline];
    for (const v of mine.slice(0, 6)) lines.push(`• ${v}`);
    if (mine.length > 6) lines.push(`ועוד ${mine.length - 6}.`);
    lines.push(cls.tail);
    // A pipe that throws must not take the issue rows down with it — the
    // dashboard record is the durable half and is already written by now.
    let sent = null;
    try { sent = await deps.send(phone, lines.join('\n')); } catch (e) { error = e.message; }
    // Only what the pipe CONFIRMED is recorded as announced; anything else is
    // left unstamped so the next tick retries it. Stamping first would let one
    // gateway outage swallow the alert permanently.
    if (sent && sent.ok) announced.push(...mine);
  }

  await save(stillKnown.concat(announced));
  const out = {};
  if (announced.length) { out.alerted = announced.length; out.phone = phone; }
  // A deferral is not a failure and must not read as one on the heartbeat —
  // `alertFailed` is what somebody looks at when the pipe is broken.
  if (deferred) out.deferredToMorning = deferred;
  if (!announced.length && !deferred) {
    out.alertFailed = true;
    if (error) out.alertError = error;
  }
  return Object.keys(out).length ? out : null;
}

async function run(client, { configPath, ...deps } = {}) {
  let violations = [];
  let budget = null;
  try {
    const cfg = occ.loadConfig(configPath);
    violations = violations.concat(checkOpenclawConfig(cfg));
    violations = violations.concat(checkModelPermissions(cfg));
    violations = violations.concat(await checkOrphanAgents(client, cfg));
    budget = await checkBootstrapBudget(client, cfg);
    violations = violations.concat(budget.violations);
  } catch (e) {
    violations.push('openclaw.json unreadable: ' + e.message);
  }
  // Outside the try on purpose: the checks above read the file, this one asks
  // whether the gateway can LOAD it, and the incident that motivated it had a
  // file that parsed perfectly (valid JSON, invalid schema). The two overlap
  // only when the file is corrupt outright, where both statements are true.
  const applied = await checkConfigApplied({ configPath, ...deps });
  violations = violations.concat(applied.violations);
  violations = violations.concat(await checkIdentityFiles(client));
  violations = violations.concat(await checkAgentsTokens(client));
  violations = violations.concat(await checkLegacyWorkspaceState(client, deps));
  violations = violations.concat(await checkCarryovers(client));
  violations = violations.concat(await checkStuckOutbox(client));
  violations = violations.concat(await checkInfraAgentSessions(client, deps));
  violations = violations.concat(await checkLeakedTokens(client, deps));
  const filed = await fileViolations(client, violations);
  const closed = await closeResolved(client, violations);
  // Filing first, alerting second: the dashboard row is the durable record
  // and must exist even if the pipe is down.
  const alert = await alertCritical(client, violations, deps);
  return {
    violations: violations.length, newIssues: filed, closedIssues: closed,
    // Only when it declined. A key that is always present reads as noise and
    // stops being looked at; one that appears only when a check went quiet is
    // the whole reason it is here.
    ...(applied.skipped ? { configValidation: applied.skipped } : {}),
    // Always present when it ran, so the doctrine's headroom is a number an
    // operator watches shrink rather than a thing they hear about once it is
    // already gone.
    ...(budget ? { bootstrap: budget.stats } : {}),
    ...(budget && budget.skipped ? { bootstrapCheck: budget.skipped } : {}),
    ...(alert || {}),
  };
}

module.exports = {
  run, checkOpenclawConfig, checkModelPermissions, checkConfigApplied, makeConfigValidator,
  checkIdentityFiles, checkAgentsTokens,
  checkCarryovers, checkOrphanAgents, checkStuckOutbox, checkInfraAgentSessions,
  checkLegacyWorkspaceState, LEGACY_WORKSPACE_STATE,
  checkBootstrapBudget, bootstrapBudget,
  GATEWAY_DEFAULT_BOOTSTRAP_MAX_CHARS, BOOTSTRAP_WARN_MARGIN,
  checkLeakedTokens, fileViolations, closeResolved,
  alertCritical, breaksUsers, leaksCredential, ALERTED_FLAG, LEAK_FLAG,
};
