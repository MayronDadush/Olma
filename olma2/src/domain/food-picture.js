'use strict';
// The evening picture of what somebody ate (food/src/picture.js draws it):
// every evening with two meals or more, a funny picture of the day, and on
// Saturday evening one of the whole week instead. The owner's calls,
// 2026-10-09:
//   - only a day with 2+ meals (foodd answers `too_few` otherwise);
//   - its own allowance, not the two pictures a day Olma may start
//     (card-budget.js), and not the daily message budget either (gate.js);
//   - paid from foodd's own key under a monthly cap (foodd decides, and
//     sends the card drawn by code past it);
//   - at 20:30, or half an hour before their window closes if that is
//     earlier, never before 19:00;
//   - the week on Saturday evening for everybody, which for somebody whose
//     Saturday is quiet means after havdalah: the sweep simply waits while
//     the quiet day lasts.
//
// The sweep DECIDES and asks foodd for the picture; the outbox SENDS it, on
// the raw pipe, as the image and the caption under it, the same shape as the
// welcome clip (channels/openclaw.js). Nothing here is a model's words.
//
// Behind the flag `food_picture_phones`: '' is nobody, 'all' is everyone who
// holds the food pack, otherwise a comma-separated list of phones.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const flags = require('./flags');
const preferences = require('./preferences');
const quietFacts = require('./quiet-facts');
const { coveredBy } = require('./turn');
const { minutesInTz } = require('../outbox/gate');
const { enqueue } = require('../outbox/enqueue');

const KIND = 'food_picture';
const FLAG = 'food_picture_phones';
const SLOT = 20 * 60 + 30;           // 20:30
const EARLIEST = 19 * 60;            // never before 19:00
const BEFORE_CLOSE = 30;             // or half an hour before the window closes
// How long after the slot a sweep still asks. A box that was down for an hour
// still sends tonight's picture; one that was down all evening does not send
// it at midnight.
const CATCH_UP_MIN = 3 * 60;
// A day's picture is about this evening, and is not worth a morning; the
// week's still is on Sunday.
const DAY_TTL_MS = 3 * 3600_000;
const WEEK_TTL_MS = 18 * 3600_000;
const FILE_MAX_AGE_MS = 2 * 86400_000;
const SUBDIR = 'food';

const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

// Minutes after local midnight at which this person's picture is due.
function slotFor(window) {
  if (!window || !window.end) return SLOT;
  const start = toMin(window.start), end = toMin(window.end);
  // A window that runs past midnight closes after 20:30 by definition.
  if (!(end > start)) return SLOT;
  return Math.max(EARLIEST, Math.min(SLOT, end - BEFORE_CLOSE));
}

// The raw pipe sends from the default agent's workspace (intro-video.js,
// stageMedia), so that is where the picture is written: a random name, under
// a directory that holds nothing else.
function mediaDir(home = process.env.OLMA_OPENCLAW_HOME || '/root/.openclaw') {
  return path.join(home, 'workspace', 'outbox-media', SUBDIR);
}
function save(png, { home } = {}) {
  const dir = mediaDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomUUID()}.png`);
  fs.writeFileSync(file, png);
  return file;
}
// The delivery reads a path off the row, so it must be one this module wrote:
// inside the directory, a plain name, a PNG. Anything else is refused.
function fileOk(file, { home } = {}) {
  if (typeof file !== 'string') return false;
  const dir = mediaDir(home);
  return path.dirname(file) === dir && /^[0-9a-f-]{36}\.png$/.test(path.basename(file)) && fs.existsSync(file);
}
function purge({ home, now = Date.now() } = {}) {
  const dir = mediaDir(home);
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    const f = path.join(dir, name);
    try { if (now - fs.statSync(f).mtimeMs > FILE_MAX_AGE_MS) { fs.unlinkSync(f); n += 1; } } catch { /* gone already */ }
  }
  return n;
}

// The SVG foodd answered, as a PNG, with Olma's own fonts (the same render as
// brokerd's pack_card). It carries a photo, so it is larger than a card: up
// to 2 MB of SVG, about 60 ms of render measured on a 1080 px picture.
const MAX_SVG = 2 * 1024 * 1024;
function render(svg) {
  if (typeof svg !== 'string' || !svg.startsWith('<svg') || svg.length > MAX_SVG) throw new Error('bad svg');
  const { FONT_FILES, FONT_FAMILY } = require('./schedule-card');
  const { Resvg } = require('@resvg/resvg-js');
  return new Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: FONT_FAMILY } }).render().asPng();
}

// The words under the picture: foodd drew both languages, the person's
// language picks one, and their invite link goes under it so a forward
// carries the way in (food/src/card.js, caption, the same lines).
function captionFor(payload, locale, inviteLink) {
  const en = /^en/i.test(String(locale || ''));
  const texts = (payload && payload.texts) || {};
  const line = String((en ? texts.en : texts.he) || texts.he || texts.en || '').trim();
  if (!inviteLink) return line;
  return `${line}\n\n${en ? 'Want one too? Message Allma:' : 'רוצה גם? כתבו לעולמה:'}\n${inviteLink}`;
}

// Who is due right now, and with what. Read-only.
async function due(client, now = new Date()) {
  const flag = await flags.getFlag(client, FLAG);
  if (!String(flag == null ? '' : flag).trim()) return [];
  const dailyOnce = await flags.getFlag(client, 'daily_once_phones');
  const { rows } = await client.query(
    `SELECT u.id, u.phone, u.first_name, u.timezone, u.locale
       FROM users u JOIN user_packs p ON p.user_id = u.id AND p.pack = 'food'
      WHERE u.status = 'active' AND u.onboarded_at IS NOT NULL AND u.paused_at IS NULL
        AND NOT u.is_eval AND COALESCE(u.checkin_misses, 0) = 0`);
  const out = [];
  for (const u of rows) {
    if (!coveredBy(flag, u.phone)) continue;
    // Somebody who hears from Olma once a day hears the evening message, and
    // a picture held for it would be folded into its words and lost.
    if (coveredBy(dailyOnce, u.phone)) continue;
    const tz = u.timezone || 'Asia/Jerusalem';
    const win = await preferences.availabilityWindow(client, u.id);
    const window = win.ok ? win.data.window : null;
    const slot = slotFor(window);
    const local = minutesInTz(tz, now);
    if (local < slot || local >= slot + CATCH_UP_MIN) continue;
    // A quiet day is waited out, never paid for: the gate would only hold the
    // picture until it expired. On an Israeli Saturday this is what moves the
    // week's picture to after havdalah.
    const facts = await quietFacts.quietFactsFor(client, { id: u.id, timezone: tz, locale: u.locale }, now);
    if (quietFacts.quietDayReason(facts, tz, now)) continue;
    const day = quietFacts.localDateInTz(tz, now);
    const kind = quietFacts.weekdayInTz(tz, now) === 6 ? 'week' : 'day';
    // A day's picture after their window has closed would be held for the
    // night and expire unseen, paid for. Not asked. The week's is still worth
    // the morning, which is why it is the one kept past havdalah in a summer
    // when their window closes before it.
    if (kind === 'day' && window && toMin(window.end) > toMin(window.start) && local >= toMin(window.end)) continue;
    const key = `${KIND}:${u.id}:${kind}:${day}`;
    const { rows: had } = await client.query('SELECT 1 FROM outbox WHERE idempotency_key = $1', [key]);
    if (had.length) continue;
    out.push({ user: u, kind, day, key });
  }
  return out;
}

// One tick. The decisions are read in one short transaction; foodd is asked
// OUTSIDE any (a picture takes seconds to draw), one person at a time.
async function sweep(pool, { now = new Date(), foodd = require('../channels/foodd'), home } = {}) {
  let list;
  const c = await pool.connect();
  try { list = await due(c, now); } finally { c.release(); }
  purge({ home, now: now.getTime() });
  const out = { due: list.length, queued: 0, skipped: {}, failed: 0 };
  for (const d of list) {
    let r;
    try {
      r = await foodd.picture({
        // foodd knows two languages and reads anything but 'en' as Hebrew.
        user: { id: Number(d.user.id), name: d.user.first_name, timezone: d.user.timezone, locale: /^en/i.test(String(d.user.locale || '')) ? 'en' : 'he' },
        kind: d.kind, day: d.day,
      });
    } catch (e) {
      console.error('[food_pictures] foodd:', e.message);
      out.failed += 1;
      continue;
    }
    // `too_few` (fewer than two meals) and `already` are answers, not faults.
    if (!r || !r.ok) { const why = (r && r.reason) || 'no answer'; out.skipped[why] = (out.skipped[why] || 0) + 1; continue; }
    let file;
    try { file = save(render(r.svg), { home }); } catch (e) {
      console.error('[food_pictures] render:', e.message);
      out.failed += 1;
      continue;
    }
    const res = await enqueue(pool, {
      userId: d.user.id, kind: KIND, urgency: 'normal',
      payload: { file, picture: d.kind, day: d.day, texts: r.texts || {}, model: r.model || null, drawn: Boolean(r.drawn) },
      expiresAt: new Date(now.getTime() + (d.kind === 'week' ? WEEK_TTL_MS : DAY_TTL_MS)),
      idempotencyKey: d.key,
    });
    if (res.data.enqueued) out.queued += 1;
  }
  return out;
}

// The raw pipe never enters their session, so a "חחח" or a "מה זה?" right
// after the picture would reach a model that never saw it — the same channel
// as the intro video and the ad (domain/turn.js).
async function recentForTurn(client, userId) {
  const { rows } = await client.query(
    `SELECT sent_at, payload->>'picture' AS picture FROM outbox
      WHERE user_id = $1 AND kind = $2 AND hold_reason IS NULL
        AND sent_at > now() - interval '12 hours'
      ORDER BY sent_at DESC LIMIT 1`, [userId, KIND]);
  const r = rows[0];
  if (!r) return null;
  return {
    sentAt: r.sent_at,
    what: `Olma sent them a funny illustrated picture of everything they ate ${r.picture === 'week' ? 'this week' : 'today'}, drawn from their food log, with one line under it. `
      + 'A reply now may be about it; it is for fun and for sharing, and it judges nothing they ate.',
  };
}

module.exports = {
  recentForTurn,
  KIND, FLAG, slotFor, due, sweep, render, save, fileOk, purge, mediaDir, captionFor,
  SLOT, EARLIEST, CATCH_UP_MIN,
};
