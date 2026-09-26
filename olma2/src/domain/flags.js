'use strict';
// Feature flags + admin-tunable numbers, changeable from the dashboard without
// a deploy. Quota limits live here (with defaults) precisely because the exact
// numbers were deliberately left open — flipping them must not need code.
const { ok } = require('./results');

const DEFAULTS = {
  registration_open: true,
  quota_daily_free: 50,      // generous placeholders; admin-tunable, not final
  quota_hourly_paid: 50,
  intake_hourly_cap: 30,     // intake circuit breaker: max new-stranger sessions/hour
  // Media generation (domain/media.js): who may, and on which models.
  media_gen_phones: '+972505404255',
  // Who may ring Olma from the personal page (domain/voice.js,
  // pageCallAllowed). Comma-separated E.164, or 'all'. Open for everybody as
  // of 2026-09-15 — the two-lifetime-attempts cap (CALL_ATTEMPTS_LIMIT) and
  // the 120s duration cap are the agreed guardrails for that rollout. The
  // chat tool (call_me_on_the_phone) is not gated by this — the voice bridge
  // is still the judge of who it will dial for either door.
  dashboard_call_phones: 'all',
  media_image_model: 'meta/muse-image',
  media_video_model: 'bytedance/seedance-2.0-mini',
  // Reminder escalation (domain/reminders.js): how many times one reminder may
  // come back, and how long after a DELIVERED rung the next one is due.
  reminder_escalation_max: 3,
  reminder_escalation_gap_hours: 3,
  live_subscriptions_per_user: 5,   // cap on active live-update subscriptions
  // outbox/worker.js: how many times a day Olma may interrupt somebody with
  // something she DECIDED to say. Urgent rows and the three kinds a person
  // chose for themselves (reminder, digest, introduction) are exempt in
  // gate.decide and uncounted by the worker. It lived only as an inline
  // fallback until 2026-09-11, which meant the admin flag editor showed it
  // with no default beside it — a number nobody can see the default of is one
  // nobody can safely change.
  proactive_daily_budget: 4,
  // domain/reactions.openingDelayMs: how long a message may go unanswered
  // before the 👀 (or 👂) goes on it. A reply inside it needs no "I'm on it",
  // and a 👀 landing under the answer is noise. The owner's number
  // (2026-09-25), read off 123 real messages: a quarter answered inside 10s,
  // 42% inside 15s. 0 puts the mark on at once.
  eyes_delay_seconds: 15,
  // Group mode (domain/groups.js): the largest group she will work in. Above
  // it she says so once and stops — a 50-person group never realistically gets
  // every member to write to her privately, and each tag costs a model turn.
  // A flag rather than a constant because it is a taste call about a product
  // that has not met a real group yet.
  group_max_members: 25,
  // domain/groups.decideState: may a room start coordinating before EVERY member
  // has written to her privately? Open by the owner's choice (2026-09-22), after
  // Padel Gang (group 9) registered at 09:45 with seven members, four of them
  // resolved to users who had written and three of them numbers the gateway only
  // ever named by LID. By 09:57 the room had been told twice who it was waiting
  // for, tagging numbers nobody dials — and one of those three turned out to be
  // Gal (u-37), who had written to her at 10:03 and whose row the gate cannot
  // see because `syncRoster` resolves by phone. Two of the three have no phone
  // behind them anywhere on the box, so that room can never open. With this open a room opens once at least
  // `MIN_CONNECTED_TO_OPEN` members are connected, and the ones who have not
  // written are still listed as missing: the room is usable, and the fact that
  // some people are not in it yet stays true rather than being papered over.
  // Closed restores the original rule, everybody or nobody.
  group_open_without_everyone: true,
  // domain/group-context.js: which rooms may have an UNTAGGED message of theirs
  // claimed — ended before any model turn starts, so the stamp that opens the
  // fifteen-minute window is taken and she says nothing. Room jids,
  // comma-separated, or 'all'. Empty on purpose: it is flipped together with
  // that room's `requireMention: false`, and only after the plugin trace has
  // shown `addressedToHer` agreeing with the gateway's own `was_mentioned` on
  // that room's real traffic. A false "not addressed" is her going silent on
  // somebody who did ask her something, so this one is earned per room.
  group_untagged_rooms: '',
  // Which rooms may carry a sentence a MEMBER asked her to say there
  // (group-meetings.relayToRoom, owner 2026-09-22). Room jids, comma-separated,
  // or 'all'. Empty on purpose and flipped per room: the standing rule is that
  // only the test rooms are experimented on, and a relay is the first thing a
  // room hears that is somebody's own words rather than the owner's copy.
  group_relay_rooms: '',
  // channels/openclaw.js digest branch: how many items make the morning
  // picture a wall of text worth drawing instead of listing. The number is a
  // flag because it is a taste call about a message people read every day,
  // and taste should not need a deploy. 0 disables the card entirely.
  digest_card_min_items: 3,
  // Boost mode (domain/boost.js + jobs/boost.js): the demo switch. The STATE
  // is written by the dashboard and reconciled onto the gateway config by the
  // job; `{on:false}` is off. The MODEL is separate on purpose — re-pointing
  // boost at a new candidate must not require re-engaging it, and a model id
  // living in a flag is what keeps a model swap an edit rather than a deploy.
  boost_mode: { on: false },
  boost_model: 'openrouter/openai/gpt-5.6-luna',
  // Mailbox connection (domain/mail.js): '' = nobody but the admin, 'all' =
  // everyone, or a comma-separated E.164 list. Default OFF on purpose — the
  // code half of the feature can merge and auto-deploy while the half that
  // lives in Google's console (the Gmail scope and its verification tier) is
  // still open, and a consent link that lands on a Google error screen is a
  // worse first impression than a feature nobody was offered yet.
  email_access_phones: '',
  // Months the personal Claude subscription was billed at something other than
  // the standing $20 — a Max upgrade, a paused month. {"YYYY-MM": usd}. No API
  // exposes subscription billing, so this is the only way the page can be right
  // about it, and it has to be an edit rather than a deploy.
  claude_subscription_overrides: {},
  // Base for user-facing links (availability picker). The dashboard's own
  // host — Caddy already routes it here.
  public_base_url: 'https://olmachat.duckdns.org',
  // jobs/credit-watch.js: mute just the credit-outage + balance-runway
  // WhatsApp lines to the admin phone. Explicit default (not just "falsy
  // null") so the dashboard's bool dropdown renders "סגור" rather than
  // showing neither option selected before anyone has touched this flag.
  credit_alerts_muted: false,
  // jobs/sweeps.sweepFinishedTasks: how long after an appointment ENDS before
  // it leaves the open list. A flag rather than a constant because the right
  // number is a judgement about how people use the list, and finding it out
  // should not need a deploy. Three hours: long enough that a doctor's
  // appointment at 09:00 is not swept while somebody is still in the waiting
  // room, short enough that it is gone before they next look.
  task_auto_archive_grace_hours: 3,
  // domain/google-connect-gate.js: who may mint a NEW Google consent link
  // (calendar, contacts, or the combined one). '' = nobody but an admin,
  // 'all' = everybody, or a comma-separated E.164 list. Default CLOSED, for
  // the reason email_access_phones is closed: the console half of the feature
  // — scopes and the verification tier — is still open, and a link that lands
  // on Google's "app is not secure" screen is a worse first impression than a
  // feature nobody was offered yet. Blocks new links only; anyone already
  // connected keeps working.
  google_connect_phones: '',
  // domain/groups.ensureRosterUsers: may a number seen on a group's roster become
  // a `users` row (`status = 'pending'`, no agent, no workspace, nothing sent)?
  // CLOSED by default and opened by hand, because it is the first write in this
  // system that creates a person's record from something nobody said. Measured on
  // the box the day it shipped, opening it mints exactly one row across every
  // registered group — a member of "פנתרה" with a real Israeli number and no user
  // — and refuses the two members of Padel Gang the gateway only ever names by
  // LID (`phone-timezone.isRealPhone`). What the row is FOR is the coordination
  // that could not reach them; what it must not do is be mistaken for somebody
  // who has met her, which is why `status = 'pending'` is now the question asked
  // by the delivery gate, `connections.requestConnection`,
  // `group-connections.connectRoom`, `syncRoster`'s timezone vote, the
  // unanswered-strangers check and the growth count.
  group_roster_users: false,
  // A room member who has never written to her hears about a coordination
  // opening there ONCE, privately, in the owner's fixed words
  // (`group-meetings.coldInvite`, 2026-09-26). Reaches only the rows
  // `group_roster_users` mints, so it does nothing while that is off.
  group_cold_invite: false,
  // jobs/twin-shadow.js: Jev (Typesafe) answers "is this new task already on
  // their list?" beside the code, on real tasks, and nothing acts on it. OFF
  // by default and read every tick: turning it on sends new task titles and
  // the open list beside them to OpenRouter, which the owner allowed for this
  // on 2026-09-24, and turning it off stops that on the next tick.
  jev_shadow_twins: false,
};

async function getFlag(client, key) {
  const { rows } = await client.query(`SELECT value FROM feature_flags WHERE key = $1`, [key]);
  if (rows[0]) return rows[0].value;
  return key in DEFAULTS ? DEFAULTS[key] : null;
}

async function setFlag(client, key, value) {
  await client.query(
    `INSERT INTO feature_flags (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
  return ok({ key, value });
}

module.exports = { getFlag, setFlag, DEFAULTS };
