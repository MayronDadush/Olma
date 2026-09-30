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
// into their personal workspace by provisionUser. The conversation the
// person is already in just continues, more capable — and since 2026-09-25
// (owner) their own agent says so in one message, `welcome_followup`: it
// acts on what they wrote to the greeter and hands over their page. It is not
// a second hello; the greeter's introduction stands and this never repeats it.
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
const onboardingDomain = require('../domain/onboarding');
const { reopenMessage } = require('../intake/messages');
const templates = require('../domain/message-templates');
const intakeRoom = require('../domain/intake-room');
const referral = require('../domain/referral');
const preferences = require('../domain/preferences');
const language = require('../domain/language');
const { minutesInTz, parseHHMM } = require('../outbox/gate');
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

// The same words read for one thing only: a friend's invite code
// (domain/referral.js). Deliberately WITHOUT the guard above — every friend a
// person invites sends the identical prefilled sentence, so the guard would
// drop exactly the messages this is for. That is safe because nothing read
// here reaches anybody's context: the code becomes a number in a growth table,
// and a wrong one costs a wrong line in it.
async function readIntakeReferralText(phone) {
  try { return await sessions.readPeerUserText(INTAKE_AGENT_ID, phone); } catch { return null; }
}

// Which door they came in by, for `users.joined_via` (migration 101). A code
// outranks a room: the code is something they chose to send. A room outranks
// an invite, because a room makes the connections itself (2026-09-09), so
// every room joiner also looks invited.
async function joinedVia(client, { phone, invited, referralText }) {
  const referredByUserId = referralText ? await referral.referrerFor(client, referralText, phone) : null;
  if (referredByUserId) return { joinedVia: 'friend_link', referredByUserId };
  const { rows } = await client.query(
    // By the roster's own number too: a member who never wrote has no user_id
    // on their roster row until something links it.
    `SELECT 1 FROM chat_group_members m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.phone = $1 OR u.phone = $1 LIMIT 1`, [phone]);
  if (rows[0]) return { joinedVia: 'room', referredByUserId: null };
  return { joinedVia: invited ? 'invite' : 'direct', referredByUserId: null };
}

// The LANGUAGE of what they typed to the greeter, as a code and nothing else.
//
// The guard above drops a carryover that another peer's text matches, and the
// commonest first message there is — "היי" — matches everybody's. With the
// text gone, provisioning had nothing to read a language from and fell back to
// the dialling code, which for an Israeli number is the right answer by luck
// and for anyone else is not: u-40 (+1) wrote "היי", the greeter answered in
// Hebrew, and every word from his own agent after that was English, with the
// audit saying `localeSource: phone_prefix` (2026-09-24).
//
// A language carries none of what the guard protects. And in the one case
// the guard fires on — two peers with the SAME text — both texts are in the
// same language, so whose file was read cannot change the answer.
async function readIntakeLanguage(phone) {
  try {
    const text = await sessions.readPeerUserText(INTAKE_AGENT_ID, phone);
    return text ? language.detectLanguage(text, phone) : null;
  } catch { return null; }
}

// ---- has the greeter actually spoken, and what did it say? -------------------

// The sweep ticks every FIVE SECONDS, and the greeter takes twenty to forty to
// answer. So for the whole life of this code the sweep has been reaching a new
// person long before the greeter said a word to them, and then claiming, in
// `greetedByIntake`, that the greeter had answered with the owner's opening
// copy. Measured on the two people it hurt on 2026-09-07: the stamp preceded
// the greeter's reply by 32 seconds (u-29) and 19 seconds (u-28).
//
// It is false a second way even after the greeter has spoken. Its prompt does
// say to open with the copy verbatim, and it does not always obey: a person
// whose first message carries a real request gets a real answer instead. That
// is not a rare shape — it is the NORMAL one for the population this product
// now grows by. בר was in a WhatsApp group Olma sits in, was asked when he was
// free, and DM'd "אני יכול מחר" as his first ever word to her. A first message
// from a group participant is an ANSWER, not a hello.
//
// So neither half may be assumed. Read what the greeter actually said, and let
// the text decide (`incidents.md`, "Two people, no introduction").
const GREETER_GRACE_MS = 5 * 60_000;

// A welcome follow-up that has not gone out in an hour is not a follow-up to
// anything any more; their first turn carries the page instead (turn.advise).
const WELCOME_FOLLOWUP_TTL_MS = 60 * 60_000;

// The morning after, for the welcome follow-up of somebody the greeter met
// with a room's short opening (domain/intake-room.js): the next time their
// window opens on a day that is not today — or today's opening, if they wrote
// before it. The gate still decides at that moment (quiet day, pause), so
// this is when to LOOK, not a promise to send.
function nextMorning(window, tz, now) {
  const mins = minutesInTz(tz, now);
  const start = parseHHMM(window.start);
  const delta = mins < start ? start - mins : 1440 - mins + start;
  return new Date(now.getTime() + delta * 60_000);
}
// Long enough to outlast a quiet day after that morning; past it, their
// first turn carries the page instead (turn.advise).
const ROOM_FOLLOWUP_TTL_MS = 3 * 24 * 3600_000;

async function defaultReadGreeterReply(phone) {
  try {
    const msgs = await sessions.readRecentMessages(INTAKE_AGENT_ID, 10, undefined, phone);
    // Newest assistant turn wins. `readRecentMessages` already drops the
    // marker a crashed turn leaves behind, so "it answered" cannot be a model
    // call that died.
    const last = [...msgs].reverse().find((m) => m.role === 'assistant');
    return last ? last.text : null;
  } catch { return null; }
}

// Did that reply carry the owner's opening copy?
//
// Compared on the copy's SUBSTANCE line rather than the whole block: the
// greeting line is short enough to collide by accident, the last line ends in
// an emoji that survives a round trip less reliably, and a stray trailing
// space must not read as "never introduced" and buy them a second
// introduction. Both locales are checked because the sweep runs before the
// user row that would settle which one they are.
// Checked against the DEFAULTS and the owner's current rewording both: the
// greeter's file is re-rendered by a job, so for a few minutes after an edit
// the copy it actually said may be either one — and, for the same minute
// after a deploy, the copy the code shipped before (PREVIOUS_OPENINGS).
// Every language with an opening template is checked, not a fixed two.
function saidTheOpening(text, overrides) {
  if (!text) return false;
  const t = String(text);
  const copies = [
    ...Object.values(onboardingDomain.OPENING),
    ...onboardingDomain.PREVIOUS_OPENINGS,
    ...Object.keys(onboardingDomain.OPENING).map((lang) => onboardingDomain.openingMessage(lang, overrides)),
  ];
  return copies.some((copy) => {
    const substance = copy.split('\n').filter(Boolean)[1];
    return Boolean(substance) && t.includes(substance);
  });
}

function intakeConfigured(configPath) {
  try {
    const cfg = occ.loadConfig(configPath);
    return occ.hasAgent(cfg, INTAKE_AGENT_ID);
  } catch { return false; }
}

// Somebody who arrived with a game night's code (stage 4ב) was answered by
// code in brokerd, not by the greeter — introduced, privacy line and all, and
// stamped `opening_sent_at` for it — so the greeter has nothing to wait for
// and nothing to carry over. Only `provisionUser` wrote that column on a
// pending row before this, which makes it plus the claim's own audit row the
// whole mark: nothing else has to remember them. Three days, because a claim
// the sweep somehow could not provision (a config write that failed) must not
// be retried for ever. Selected by the claim and never by the gateway's
// session list, whether or not a claimed message leaves a session there.
const GAME_CLAIM_WINDOW = '3 days';
async function gameClaimed(client) {
  const { rows } = await client.query(
    `SELECT u.phone, (extract(epoch FROM now() - max(a.created_at)) * 1000)::bigint AS age_ms
       FROM audit_log a JOIN users u ON u.id = a.actor_id
      WHERE a.event = 'games.intake_claim' AND a.created_at > now() - interval '${GAME_CLAIM_WINDOW}'
        AND u.status = 'pending' AND u.agent_id IS NULL AND u.opening_sent_at IS NOT NULL
        AND u.is_eval = false
      GROUP BY u.phone`);
  return rows.map((r) => ({ phone: r.phone, ageMs: Number(r.age_ms) }));
}

// One discovery pass. deps: { listSessions, configPath, readFirstMessage, readLanguage }
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

  // After the breaker, never before it: a game claim costs no model turn and
  // has its own cap in brokerd, and ten new players at one table must not
  // close registration for everybody else.
  const claimed = await gameClaimed(client);
  const claimedPhones = new Set(claimed.map((c) => c.phone));
  const listed = new Set(sessions.map((s) => s.phone));
  const todo = [...sessions, ...claimed.filter((c) => !listed.has(c.phone))];

  for (const { phone, ageMs } of todo) {
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

    // Wait for the greeter to say SOMETHING before taking this person over.
    //
    // Provisioning at 0.36s after their message (measured, u-29) is what lost
    // בר's first words: `readFirstMessage` reads the same session store the
    // gateway had not finished writing, so the carryover came back empty and
    // his "אני יכול מחר" reached nobody — while the greeter, thirty seconds
    // later, told him it had been noted and that his own assistant would pick
    // it up. Neither was true. Waiting a tick or two costs nothing (the
    // greeter is holding the conversation either way) and is what makes both
    // the carryover and `greetedByIntake` readable at all.
    //
    // Bounded, because a greeter that never answers must not strand somebody
    // outside the system for ever: past the grace we provision anyway, and
    // `greetedByIntake` is then false — so their own agent opens with the
    // copy, which is exactly the behaviour that predates this whole path.
    const gameClaim = claimedPhones.has(phone) && existing && existing.status === 'pending';
    const greeterReply = gameClaim ? null : deps.readGreeterReply
      ? await deps.readGreeterReply(phone)
      : await defaultReadGreeterReply(phone);
    if (!gameClaim && greeterReply === null && (ageMs ?? Infinity) < GREETER_GRACE_MS) {
      out.waitingOnGreeter = (out.waitingOnGreeter || 0) + 1;
      continue;
    }

    // Extracted before provisioning so seedWorkspace can write it straight
    // into USER.md — facts only (readPeerUserText caps + condenses), never
    // the raw transcript.
    const firstMessage = !gameClaim && deps.readFirstMessage
      ? await deps.readFirstMessage(phone, sessions.map((s) => s.phone))
      : null;
    // Only consulted when the carryover above came back empty (provisionUser).
    const languageHint = !gameClaim && deps.readLanguage ? await deps.readLanguage(phone) : null;
    const inviter = invited
      ? (await client.query(`SELECT first_name, last_name, phone FROM users WHERE id = $1`, [invited.requester_id])).rows[0]
      : null;
    const invitedInfo = invited ? {
      connectionId: Number(invited.id),
      inviterName: [inviter.first_name, inviter.last_name].filter(Boolean).join(' ') || inviter.phone,
      reason: invited.invite_reason || null,
    } : null;

    // The room's short opening is an introduction too — it says she is an AI
    // and carries the privacy link — so it stamps `opening_sent_at` like the
    // owner's, and nothing waits behind an introduction still owed. What it
    // leaves out is what she helps with, and that is the follow-up's job.
    const via = await joinedVia(client, {
      phone, invited,
      referralText: deps.readReferralText ? await deps.readReferralText(phone) : null,
    });

    const saidOwners = !gameClaim && saidTheOpening(greeterReply, await templates.load(client));
    const roomOpened = !gameClaim && !saidOwners && intakeRoom.saidRoomOpening(greeterReply);
    const greetedByIntake = gameClaim || saidOwners || roomOpened;
    const prov = await provisionUser(client, {
      phone, invitedByConnectionId: invited ? invited.id : null, configPath: deps.configPath,
      // The language the claim was answered in, which is on the row — there
      // is no carryover to read one from.
      ...(gameClaim ? { locale: existing.locale } : {}),
      firstMessage, languageHint, invitedInfo, registerUndo: deps.registerUndo,
      joinedVia: via.joinedVia, referredByUserId: via.referredByUserId,
      // What the greeter ACTUALLY said, never what it was told to say. This
      // was `true` unconditionally for one evening, on the reasoning that
      // being in the greeter's session list proved the greeter had answered
      // with the opening copy. It proved neither (see saidTheOpening above),
      // and two people were stamped as introduced without ever being
      // introduced: `turn_start` then told their own agents the introduction
      // was done, so nobody ever said who Olma was.
      greetedByIntake,
      // Read apart from `greetedByIntake`: a greeter that reworded the copy
      // and kept the link is not an introduction, and has still said the link
      // — their own agent then opens with the copy minus that line (turn.advise).
      privacyLinkSaid: onboardingDomain.carriesPrivacyLink(greeterReply),
    });
    if (!prov.ok) { out.skipped++; continue; }
    const user = prov.data.user;

    // Their own agent speaks next, unasked, seconds after the greeter
    // (owner, 2026-09-25): it answers what they wrote there — the greeter has
    // no tools, so a request made to it has not been done — and hands over
    // their page, which could not exist while the greeter was speaking.
    // Only after a greeter that really introduced her: otherwise their own
    // agent's first turn still owes the opening copy, and it carries the page
    // too (turn.advise). The gate drops this row if they write to their own
    // agent first, because that turn answers the same words.
    //
    // After the room's short opening it waits (owner, 2026-09-29): the
    // coordination goes first (group-meetings.admitLateMembers, within the
    // minute), and what Olma is comes after it. If they answer, their first
    // turn says it and the gate drops this row as `answered_in_turn`; if they
    // do not, this says it the next morning. A coordination that closed while
    // the greeter was speaking has nothing to go first, so then it goes now.
    //
    // After a game claim it waits for the morning too, always (owner,
    // 2026-10-01): they came for the night, and what else she does is for
    // the day after it — never in the middle of the game. Their turns during
    // the night do not drop it (outbox/gate.js), because "עוד כניסה" is not
    // them hearing what she is.
    if (greetedByIntake) {
      const waiting = roomOpened ? await intakeRoom.roomFor(client, phone) : null;
      const now = new Date();
      let releaseAfter = null;
      let expiresAt = new Date(now.getTime() + WELCOME_FOLLOWUP_TTL_MS);
      if (gameClaim || (waiting && waiting.meetingId)) {
        const pref = await preferences.availabilityWindow(client, user.id);
        const window = pref.ok ? pref.data.window : preferences.DEFAULT_WINDOW;
        releaseAfter = nextMorning(window, user.timezone, now);
        expiresAt = new Date(releaseAfter.getTime() + ROOM_FOLLOWUP_TTL_MS);
      }
      await enqueue(client, {
        userId: user.id, kind: 'welcome_followup',
        payload: {
          hasNote: Boolean(user.intake_note_at),
          greeterReply: typeof greeterReply === 'string' ? greeterReply.slice(0, 600) : null,
          ...(roomOpened ? { roomOpening: true } : {}),
          ...(gameClaim ? { gameOpening: true } : {}),
        },
        idempotencyKey: `welcome_followup:${user.id}`,
        expiresAt, releaseAfter,
      });
      out.welcomed = (out.welcomed || 0) + 1;
    }

    if (invited) {
      await connectionsDomain.attachProvisionedTarget(client, invited.id, user.id);
    }
    if (gameClaim) out.fromGame = (out.fromGame || 0) + 1;
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
  const wording = await templates.load(client);
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
      payload: { text: reopenMessage(phone, wording) },
      idempotencyKey: `reopen:${phone}`,
    });
    await client.query(`UPDATE waitlist SET notified_at = now() WHERE phone = $1`, [phone]);
    notified++;
  }
  return { notified };
}

module.exports = {
  sweepIntakeSessions, runIntakeSweep, sweepReopen, intakeConfigured, INTAKE_AGENT_ID,
  defaultListIntakeSessions, readIntakeFirstMessage, readIntakeLanguage, readIntakeReferralText, joinedVia,
  defaultReadGreeterReply, saidTheOpening, nextMorning, GREETER_GRACE_MS, gameClaimed,
};
