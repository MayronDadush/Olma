'use strict';
// The ad library (owner, 2026-10-01): short branded clips the owner uploads
// and watches on the ADMIN page, marks "in rotation", and chooses for each
// whether WhatsApp shows it as a GIF or as a video. Olma then sends them to
// people from time to time — at most one per person per `everyDays`, never the
// same clip twice — on rules the owner sets on the same page, not in code.
//
// Built the way the intro video is (domain/intro-video.js), on purpose:
//   - one outbox row per person per clip, so the GATE decides when: their
//     window, their quiet day, behind an introduction still owed, and a pause
//     drops it with no exception. Unlike the intro, somebody who has stopped
//     answering is NOT reached (`gate.decide` drops it as `quiet`) — an ad is
//     the plainest case of something she decided to say;
//   - the clip's language is chosen at DELIVERY off `users.locale`, and so is
//     its format, so an edit on the page reaches rows already queued;
//   - no words ride with it, and the next turn is told what was sent
//     (`domain/turn.js`, `brandAd`), because a raw send never enters the
//     session and "מה זה?" must reach a model that knows.
//
// Nothing is rendered on the box. A render peaked at ~1.5GB of Chrome on the
// Mac (2026-10-01) against 725MB free here, so clips arrive finished, one MP4
// per language, uploaded through the admin page into `storeDir()` — outside
// /opt/olma2, where a deploy's rsync would delete them.
//
// OFF until the owner says otherwise, twice over: the `brand_ads` flag's
// `enabled` is false and no clip is in rotation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { enqueue } = require('../outbox/enqueue');
const flagsDomain = require('./flags');
const introVideo = require('./intro-video');

const KIND = 'brand_ad';
const FLAG = 'brand_ads';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LANGS = ['he', 'en'];
const FORMATS = ['gif', 'mp4'];
const TIMINGS = ['morning', 'window'];
// WhatsApp's own ceiling for a video. A clip over it is refused at the upload,
// where the owner can see why, rather than at a send nobody watches.
const MAX_BYTES = 16 * 1024 * 1024;
// Same windows as the intro's statistics, so the two read alike.
const REPLY_WINDOW_HOURS = 24;

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  // At most one ad per person in this many days, counted from the last one
  // that was queued for them — sent, held or dropped alike, so a person the
  // gate keeps dropping is not re-tried every hour.
  everyDays: 21,
  // Only people who wrote to her (or used their page) inside this many days.
  activeWithinDays: 30,
  // 'morning': released at their first digest hour, or 09:00 when they have
  // none. 'window': queued at once, and the gate sends it when their window is
  // open.
  timing: 'morning',
  // No ad in the days right after the intro video reached them.
  introGapDays: 7,
});

function storeDir() {
  return process.env.OLMA_BRAND_ADS_DIR || '/var/lib/olma2/ads';
}

// Every field checked and bounded; anything unreadable falls back to the
// default for THAT field, never to "enabled".
function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const int = (v, d, min, max) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : d;
  };
  return {
    enabled: s.enabled === true,
    everyDays: int(s.everyDays, DEFAULT_SETTINGS.everyDays, 1, 365),
    activeWithinDays: int(s.activeWithinDays, DEFAULT_SETTINGS.activeWithinDays, 1, 365),
    timing: TIMINGS.includes(s.timing) ? s.timing : DEFAULT_SETTINGS.timing,
    introGapDays: int(s.introGapDays, DEFAULT_SETTINGS.introGapDays, 0, 365),
  };
}

async function getSettings(client) {
  return normalizeSettings(await flagsDomain.getFlag(client, FLAG));
}

async function saveSettings(client, input) {
  const next = normalizeSettings(input);
  await flagsDomain.setFlag(client, FLAG, next);
  return next;
}

// ── the library ──────────────────────────────────────────────────────────────

async function createAd(client, { id, title, about }) {
  const slug = String(id || '').trim().toLowerCase();
  const name = String(title || '').trim().slice(0, 120);
  if (!ID_RE.test(slug)) return { ok: false, error: 'bad_id' };
  if (!name) return { ok: false, error: 'no_title' };
  const { rows } = await client.query(
    `INSERT INTO brand_ads (id, title, about) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [slug, name, String(about || '').trim().slice(0, 500)]);
  return rows[0] ? { ok: true, id: slug } : { ok: false, error: 'exists' };
}

async function updateAd(client, id, { title, about, inRotation, format, skipIfIntro }) {
  const name = String(title || '').trim().slice(0, 120);
  if (!name) return { ok: false, error: 'no_title' };
  if (!FORMATS.includes(format)) return { ok: false, error: 'bad_format' };
  const { rowCount } = await client.query(
    `UPDATE brand_ads SET title = $2, about = $3, in_rotation = $4, format = $5,
            skip_if_intro = $6, updated_at = now()
      WHERE id = $1`,
    [id, name, String(about || '').trim().slice(0, 500), inRotation === true, format, skipIfIntro === true]);
  return rowCount ? { ok: true } : { ok: false, error: 'not_found' };
}

// An MP4 begins with an `ftyp` box: four bytes of size, then the type. Asked
// of the bytes rather than the file name, because a .gif renamed .mp4 would
// otherwise reach WhatsApp and arrive as nothing.
function looksLikeMp4(buf) {
  return Buffer.isBuffer(buf) && buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp';
}

// Writes the file, then the row. Returns the file it replaced so the caller can
// remove it AFTER the transaction commits — removed inside, a rollback would
// leave the row pointing at nothing. A file written for a transaction that
// then rolls back is an orphan on disk, which costs a megabyte and nobody's
// message.
async function saveFile(client, { adId, lang, data, dir = storeDir() }) {
  if (!LANGS.includes(lang)) return { ok: false, error: 'bad_lang' };
  if (!data || !data.length) return { ok: false, error: 'empty' };
  if (data.length > MAX_BYTES) return { ok: false, error: 'too_big' };
  if (!looksLikeMp4(data)) return { ok: false, error: 'not_mp4' };
  const { rows: ad } = await client.query(`SELECT id FROM brand_ads WHERE id = $1`, [adId]);
  if (!ad[0]) return { ok: false, error: 'not_found' };
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  const file = `${adId}-${lang}-${sha.slice(0, 10)}.mp4`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), data);
  const { rows: prev } = await client.query(
    `SELECT file FROM brand_ad_files WHERE ad_id = $1 AND lang = $2`, [adId, lang]);
  await client.query(
    `INSERT INTO brand_ad_files (ad_id, lang, file, bytes, sha256) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (ad_id, lang) DO UPDATE
       SET file = EXCLUDED.file, bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256, uploaded_at = now()`,
    [adId, lang, file, data.length, sha]);
  const replaced = prev[0] && prev[0].file !== file ? prev[0].file : null;
  return { ok: true, file, bytes: data.length, replaced };
}

function removeStoredFile(file, dir = storeDir()) {
  if (!file || file.includes('/') || file.includes('..')) return;
  try { fs.unlinkSync(path.join(dir, file)); } catch { /* already gone */ }
}

// The path of the clip as stored, for the admin page's player. Null when there
// is none — never a guess at another language.
async function storedFile(client, adId, lang, dir = storeDir()) {
  const { rows } = await client.query(
    `SELECT file, bytes FROM brand_ad_files WHERE ad_id = $1 AND lang = $2`, [adId, lang]);
  if (!rows[0]) return null;
  return { path: path.join(dir, rows[0].file), bytes: rows[0].bytes };
}

// What delivery needs, read when the row goes out: the clip in THEIR language
// and the format the page says now. Their language only — a Hebrew writer is
// never sent the English cut because the Hebrew one was taken down.
async function forDelivery(client, adId, locale) {
  const lang = introVideo.langFor(locale);
  const { rows } = await client.query(
    `SELECT a.format, f.file FROM brand_ads a
       JOIN brand_ad_files f ON f.ad_id = a.id AND f.lang = $2
      WHERE a.id = $1`, [adId, lang]);
  return rows[0] ? { file: rows[0].file, format: rows[0].format, lang } : null;
}

function stageMedia(file, opts = {}) {
  return introVideo.stageMedia(file, { assetDir: storeDir(), subdir: 'ads', ...opts });
}

async function listAds(client) {
  const { rows: ads } = await client.query(
    `SELECT id, title, about, in_rotation, format, skip_if_intro, created_at
       FROM brand_ads ORDER BY created_at, id`);
  const { rows: files } = await client.query(
    `SELECT ad_id, lang, file, bytes, uploaded_at FROM brand_ad_files`);
  return ads.map((a) => ({
    ...a,
    files: Object.fromEntries(files.filter((f) => f.ad_id === a.id).map((f) => [f.lang, f])),
  }));
}

// ── who gets one next ────────────────────────────────────────────────────────

// The same people the intro reaches, minus the paused: active, onboarded, not
// the eval user. The gate asks the pause and the silence again at delivery.
const AUDIENCE = `u.status = 'active' AND u.onboarded_at IS NOT NULL AND u.paused_at IS NULL AND NOT u.is_eval`;

// One row per person who is due an ad now, with the clip they would get: the
// oldest clip in rotation that has a cut in their language and has not reached
// them (a row the gate DROPPED did not reach them, so that clip stays
// available — but the spacing below still counts it).
// The intro clip reached them either on its own or as a game or room
// joiner's welcome (jobs/intake.js, `clip`): the same clip both ways.
const INTRO_SEEN = `(o.kind = 'intro_video' OR (o.kind = 'welcome_followup' AND o.payload ? 'clip'))`;

async function due(client, settings, now = new Date()) {
  const { rows } = await client.query(
    `SELECT u.id AS user_id, u.timezone, u.digest_times, u.locale, pick.id AS ad_id
       FROM users u
       CROSS JOIN LATERAL (
         SELECT a.id FROM brand_ads a
           JOIN brand_ad_files f ON f.ad_id = a.id
            AND f.lang = CASE WHEN lower(coalesce(u.locale, '')) LIKE 'he%' THEN 'he' ELSE 'en' END
          WHERE a.in_rotation
            AND NOT EXISTS (SELECT 1 FROM outbox o
                             WHERE o.user_id = u.id AND o.kind = $2 AND o.payload->>'ad' = a.id
                               AND (o.sent_at IS NULL OR o.hold_reason IS NULL))
            AND NOT (a.skip_if_intro AND EXISTS (
                  SELECT 1 FROM outbox o WHERE o.user_id = u.id AND ${INTRO_SEEN}
                     AND o.sent_at IS NOT NULL AND o.hold_reason IS NULL))
          ORDER BY a.created_at, a.id LIMIT 1) pick
      WHERE ${AUDIENCE}
        AND greatest(u.last_inbound_at, u.last_dashboard_at) > $1::timestamptz - make_interval(days => $3)
        AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.user_id = u.id AND o.kind = $2
                          AND (o.sent_at IS NULL OR o.created_at > $1::timestamptz - make_interval(days => $4)))
        AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.user_id = u.id AND ${INTRO_SEEN}
                          AND o.sent_at IS NOT NULL AND o.hold_reason IS NULL
                          AND o.sent_at > $1::timestamptz - make_interval(days => $5))
      ORDER BY u.id`,
    [now, KIND, settings.activeWithinDays, settings.everyDays, settings.introGapDays]);
  return rows;
}

// Their first digest hour, else 09:00 — the next time that clock reads it in
// THEIR zone, worked out by Postgres so a DST night cannot move it.
function morningOf(digestTimes) {
  const first = String(digestTimes || '').split(',').map((s) => s.trim()).find((s) => /^\d{2}:\d{2}$/.test(s));
  return first || '09:00';
}

async function nextMorning(client, tz, hhmm, now) {
  const { rows } = await client.query(
    `SELECT CASE WHEN x > $1::timestamptz THEN x
                 ELSE ((($1::timestamptz AT TIME ZONE $2)::date + 1 + $3::time) AT TIME ZONE $2) END AS at
       FROM (SELECT ((($1::timestamptz AT TIME ZONE $2)::date + $3::time) AT TIME ZONE $2) AS x) s`,
    [now, tz || 'UTC', hhmm]);
  return rows[0].at;
}

// One tick of the `brand_ads` job. Off means nothing is read past the flag.
// The key carries the day, because the "never twice" promise is the query's
// (a clip that reached them is never picked again) and a dropped row must not
// lock that clip away from them for ever; two ticks in one day still collapse.
async function sweep(client, { now = new Date() } = {}) {
  const settings = await getSettings(client);
  if (!settings.enabled) return { enabled: false, queued: 0 };
  const day = now.toISOString().slice(0, 10);
  let queued = 0;
  for (const r of await due(client, settings, now)) {
    const releaseAfter = settings.timing === 'morning'
      ? await nextMorning(client, r.timezone, morningOf(r.digest_times), now) : null;
    const res = await enqueue(client, {
      userId: r.user_id, kind: KIND, urgency: 'urgent',
      payload: { ad: r.ad_id }, releaseAfter,
      idempotencyKey: `${KIND}:${r.ad_id}:${r.user_id}:${day}`,
    });
    if (res.data.enqueued) queued += 1;
  }
  return { enabled: true, queued };
}

// What the page shows above the switch: who the NEXT tick would queue, by
// clip, whether or not the sender is on — so turning it on is never a guess.
async function preview(client, now = new Date()) {
  const settings = await getSettings(client);
  const rows = await due(client, settings, now);
  const byAd = {};
  for (const r of rows) byAd[r.ad_id] = (byAd[r.ad_id] || 0) + 1;
  return { people: rows.length, byAd };
}

// Read straight off the rows that did the work, like the intro's: the outbox
// stamp says it reached them, `message.received` says they wrote after.
async function stats(client, now = new Date()) {
  const { rows } = await client.query(
    `SELECT o.payload->>'ad' AS ad, o.sent_at, o.hold_reason, o.attempts, o.last_error,
            (SELECT min(a.created_at) FROM audit_log a
              WHERE a.actor_id = o.user_id AND a.event = 'message.received'
                AND a.created_at > o.sent_at) AS first_reply_at
       FROM outbox o WHERE o.kind = $1`, [KIND]);
  const out = {};
  const nowMs = now.getTime();
  for (const r of rows) {
    const s = out[r.ad] || (out[r.ad] = { delivered: 0, waiting: 0, dropped: 0, failing: 0, replied: 0, tooEarly: 0 });
    if (r.sent_at && r.hold_reason === null) {
      s.delivered += 1;
      const sent = new Date(r.sent_at).getTime();
      const reply = r.first_reply_at ? new Date(r.first_reply_at).getTime() - sent : null;
      if (reply !== null && reply <= REPLY_WINDOW_HOURS * 3_600_000) s.replied += 1;
      else if (nowMs - sent < REPLY_WINDOW_HOURS * 3_600_000) s.tooEarly += 1;
    } else if (r.sent_at) s.dropped += 1;
    else if (r.attempts > 0 && r.last_error) s.failing += 1;
    else s.waiting += 1;
  }
  return out;
}

// The line the next turn carries (domain/turn.js): the raw send never enters
// their session. The `about` is the owner's own sentence about the clip.
async function recentForTurn(client, userId) {
  const { rows } = await client.query(
    `SELECT o.sent_at, a.title, a.about FROM outbox o
       LEFT JOIN brand_ads a ON a.id = o.payload->>'ad'
      WHERE o.user_id = $1 AND o.kind = $2 AND o.hold_reason IS NULL
        AND o.sent_at > now() - interval '24 hours'
      ORDER BY o.sent_at DESC LIMIT 1`, [userId, KIND]);
  const r = rows[0];
  if (!r) return null;
  const what = r.about || r.title || 'a short clip about what she does';
  return {
    sentAt: r.sent_at,
    what: `Olma sent them a short video (no text) about herself: ${what}. A reply now may be about it.`,
  };
}

module.exports = {
  KIND, FLAG, ID_RE, LANGS, FORMATS, TIMINGS, MAX_BYTES, DEFAULT_SETTINGS,
  storeDir, normalizeSettings, getSettings, saveSettings,
  createAd, updateAd, looksLikeMp4, saveFile, removeStoredFile, storedFile, forDelivery, stageMedia, listAds,
  due, morningOf, nextMorning, sweep, preview, stats, recentForTurn,
};
