'use strict';
// The intro video: a short looping clip of Olma introducing herself, sent to
// everybody she already serves (owner, 2026-09-27: "לכולם חוץ ממי שמושהה").
//
// It is an outbox row like everything else she decides to say, so the gate
// decides WHEN — their window, their quiet day, behind an introduction still
// owed — and a pause drops it. The one gate difference is written in
// `outbox/gate.js`: somebody who has stopped answering still gets this one,
// because the owner named the pause as the only exception.
//
// No words ride with it: the clip carries its own. Which clip is decided at
// DELIVERY off `users.locale`, exactly as a reminder's language is
// (proactive-text.localizedKey) — a person who switches to English between the
// enqueue and their morning gets the English one.
//
// The statistics are read straight off the rows that did the work — the
// outbox stamp says when it reached them, `message.received` in the audit log
// says when they next wrote — so there is no second ledger to drift from the
// first. What cannot be read is said as unknown, never as zero: whether they
// WATCHED it is not something the pipe reports to us.
const fs = require('node:fs');
const path = require('node:path');
const { enqueue } = require('../outbox/enqueue');

const KIND = 'intro_video';
const ASSET_DIR = path.join(__dirname, '..', '..', 'assets', 'intro');
// One entry per clip. The file names are the shipped assets; the id is what the
// rows and the idempotency key carry, so a second clip later is a second id and
// never a re-send of this one.
const VIDEOS = {
  v2: { he: 'v2-he.mp4', en: 'v2-en.mp4' },
};
// The windows the owner asked about: "כמה כתבו הודעה בחצי שעה הקרובה".
// The day is there so "ignored" is not declared half an hour after a message
// somebody reads at lunch.
const REPLY_WINDOW_MIN = 30;
const IGNORE_WINDOW_HOURS = 24;
// Hold reasons that mean the row will never reach them. `expired` is not
// expected (no expiry is set) and is counted here if it ever appears.
const DROPPED = ['paused', 'quiet', 'pending_user', 'eval_user', 'duplicate', 'expired'];

function langFor(locale) {
  return String(locale || '').trim().toLowerCase().startsWith('he') ? 'he' : 'en';
}

// The welcome of somebody who came in through a game night or a room
// (jobs/intake.js, `clip` on the payload): the same clip, and ONE fixed line
// under it. No page link since 2026-10-08 (owner: many people use Olma in
// WhatsApp only, so the page is not handed over at the start). Fixed rather
// than composed — a model asked for "one
// short line" wrote 210-245 characters about what Olma does, which is exactly
// what the clip already says (owner, 2026-10-04). The flag names the clip;
// anything that is not one of ours is "no clip", and the text goes as before.
function welcomeClipFor(flagValue) {
  const id = typeof flagValue === 'string' ? flagValue.trim() : '';
  return id && VIDEOS[id] ? id : null;
}

const WELCOME_CAPTION = {
  he: 'זו עולמה, ב־15 שניות 🙂',
  en: 'This is Olma, in 15 seconds 🙂',
};

function welcomeCaption(locale) {
  return WELCOME_CAPTION[langFor(locale)];
}

function fileFor(videoId, locale) {
  const v = VIDEOS[videoId];
  if (!v) return null;
  return v[langFor(locale)] || v.en;
}

// The gateway reads outbound media only from inside the system agent's
// workspace (a path under /tmp is refused with LocalMediaAccessError, measured
// 2026-09-26). So the shipped asset is copied there before the send, and again
// whenever the copy there differs — a redeployed clip must not be shadowed by
// yesterday's. The ad library (domain/brand-ads.js) stages the same way, from
// its own store into its own `subdir`.
function stageMedia(file, { home = process.env.OLMA_OPENCLAW_HOME || '/root/.openclaw', assetDir = ASSET_DIR, subdir = 'intro' } = {}) {
  const src = path.join(assetDir, file);
  const destDir = path.join(home, 'workspace', 'outbox-media', subdir);
  const dest = path.join(destDir, file);
  const want = fs.statSync(src).size;
  let have = -1;
  try { have = fs.statSync(dest).size; } catch { /* not there yet */ }
  if (have !== want) {
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest);
  }
  return dest;
}

// Everybody Olma serves today and could legally be told anything: active,
// onboarded, not paused, not the eval user. The gate asks the pause again at
// delivery, so somebody who pauses tonight is still dropped tomorrow morning.
const AUDIENCE = `status = 'active' AND onboarded_at IS NOT NULL AND paused_at IS NULL AND NOT is_eval`;

async function audience(client) {
  const { rows } = await client.query(
    `SELECT count(*) FILTER (WHERE ${AUDIENCE})::int AS eligible,
            count(*) FILTER (WHERE ${AUDIENCE} AND lower(coalesce(locale, '')) LIKE 'he%')::int AS he,
            count(*) FILTER (WHERE status = 'active' AND onboarded_at IS NOT NULL AND paused_at IS NOT NULL AND NOT is_eval)::int AS paused,
            count(*) FILTER (WHERE ${AUDIENCE} AND checkin_misses >= 1)::int AS silent
       FROM users`);
  const r = rows[0];
  return { eligible: r.eligible, he: r.he, en: r.eligible - r.he, paused: r.paused, silent: r.silent };
}

// Idempotent per person per clip: running it twice queues nothing the second
// time. Urgent so the daily proactive budget does not fold it into a digest
// (which would say "a video" in words and send no video); the night, a quiet
// day and a pending introduction all still apply.
async function enqueueAll(client, videoId) {
  if (!VIDEOS[videoId]) throw new Error(`unknown intro video: ${videoId}`);
  const { rows } = await client.query(`SELECT id FROM users WHERE ${AUDIENCE} ORDER BY id`);
  let queued = 0;
  for (const u of rows) {
    const r = await enqueue(client, {
      userId: u.id, kind: KIND, urgency: 'urgent',
      payload: { video: videoId },
      idempotencyKey: `${KIND}:${videoId}:${u.id}`,
    });
    if (r.data.enqueued) queued += 1;
  }
  return { candidates: rows.length, queued };
}

async function stats(client, videoId, now = new Date()) {
  const { rows } = await client.query(
    `SELECT o.user_id, o.sent_at, o.hold_reason, o.last_error, o.attempts,
            (lower(coalesce(u.locale, '')) LIKE 'he%') AS he,
            (SELECT min(a.created_at) FROM audit_log a
              WHERE a.actor_id = o.user_id AND a.event = 'message.received'
                AND a.created_at > o.sent_at) AS first_reply_at
       FROM outbox o JOIN users u ON u.id = o.user_id
      WHERE o.kind = $1 AND o.payload->>'video' = $2`, [KIND, videoId]);
  const out = {
    video: videoId, rows: rows.length,
    delivered: 0, deliveredHe: 0, deliveredEn: 0, unconfirmed: 0,
    waiting: 0, waitingReasons: {}, failing: 0, dropped: 0, droppedReasons: {},
    repliedWithin30m: 0, repliedWithin24h: 0, ignored24h: 0, tooEarlyToTell: 0,
    watched: null,
  };
  const nowMs = now.getTime();
  for (const r of rows) {
    if (r.sent_at && r.hold_reason === null) {
      out.delivered += 1;
      if (r.he) out.deliveredHe += 1; else out.deliveredEn += 1;
      // A timeout is booked as sent (rules/delivering.md) and very likely
      // went out; counted as delivered and shown apart.
      if (r.last_error) out.unconfirmed += 1;
      const sent = new Date(r.sent_at).getTime();
      const reply = r.first_reply_at ? new Date(r.first_reply_at).getTime() - sent : null;
      if (reply !== null && reply <= REPLY_WINDOW_MIN * 60_000) out.repliedWithin30m += 1;
      if (reply !== null && reply <= IGNORE_WINDOW_HOURS * 3_600_000) out.repliedWithin24h += 1;
      else if (nowMs - sent >= IGNORE_WINDOW_HOURS * 3_600_000) out.ignored24h += 1;
      else out.tooEarlyToTell += 1;
    } else if (r.sent_at) {
      out.dropped += 1;
      out.droppedReasons[r.hold_reason] = (out.droppedReasons[r.hold_reason] || 0) + 1;
    } else if (r.attempts > 0 && r.last_error) {
      out.failing += 1;
    } else {
      out.waiting += 1;
      const why = r.hold_reason || 'due';
      out.waitingReasons[why] = (out.waitingReasons[why] || 0) + 1;
    }
  }
  return out;
}

module.exports = {
  KIND, VIDEOS, DROPPED, REPLY_WINDOW_MIN, IGNORE_WINDOW_HOURS,
  WELCOME_CAPTION,
  langFor, fileFor, stageMedia, welcomeClipFor, welcomeCaption, audience, enqueueAll, stats,
};
