'use strict';
// The availability picker — the first "ephemeral UI": a personal, short-lived
// link where a meeting participant taps dates and dayparts instead of typing
// them. Three rules carried over from the rest of the system, on purpose:
//
//   * The server is the judge. The page submits raw form data; everything
//     stored (dates, daypart vocabulary, labels, timezone) is normalized and
//     validated HERE. A submitted option is a CONSTRAINT/offer, never an
//     agreement — meetings still confirm only through tryConfirmMeeting.
//   * Overlap is computed in code, in UTC instants, at zero tokens. Options
//     are picked in each owner's local timezone and converted here — the
//     "משמרת 15:00 stored as UTC" incident is exactly what skipping the
//     conversion would reproduce, one layer up.
//   * Notifications ride the outbox like every other cross-user event:
//     idempotency-keyed, urgency 'urgent' (same as meeting proposals), and
//     therefore still subject to the recipient's quiet hours, pause and block.
const crypto = require('node:crypto');
const audit = require('./audit');
const flags = require('./flags');
const { ok, err } = require('./results');
const { enqueue } = require('../outbox/enqueue');

const LINK_TTL_DAYS = 7;
const MAX_OPTIONS = 10;
const MAX_RANGE_DAYS = 14;   // one option may span a range; beyond this it is
                             // not availability, it is "whenever" — say that in chat
const HORIZON_DAYS = 60;     // farthest pickable date
const MIN_OVERLAP_MINUTES = 30;
const MAX_OVERLAP_WINDOWS = 10;

// Daypart vocabulary, minutes from local midnight. Closed set — the same
// refuse-don't-guess posture as reminders.normalizeRepeatRule: a part outside
// this list is refused, never coerced.
const PARTS = {
  morning: { he: 'בוקר', from: 8 * 60, to: 12 * 60 },
  noon:    { he: 'צהריים', from: 12 * 60, to: 16 * 60 },
  evening: { he: 'ערב', from: 17 * 60, to: 21 * 60 },
  all_day: { he: 'כל היום', from: 8 * 60, to: 21 * 60 },
  hour:    { he: 'שעה מסוימת' }, // window filled in from the picked hour
};
const HOUR_WINDOW_MINUTES = 60;

const HEB_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const FALLBACK_TZ = 'Asia/Jerusalem';

// ---- date arithmetic (calendar dates as strings, no clock involved) --------

function dateMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function validDate(dateStr) {
  if (!DATE_RE.test(dateStr || '')) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
function addDays(dateStr, n) {
  return new Date(dateMs(dateStr) + n * 86_400_000).toISOString().slice(0, 10);
}
function daysBetween(a, b) { return Math.round((dateMs(b) - dateMs(a)) / 86_400_000); }

function todayInTz(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || FALLBACK_TZ }).format(new Date());
  } catch { return new Intl.DateTimeFormat('en-CA', { timeZone: FALLBACK_TZ }).format(new Date()); }
}

function dayLabel(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `יום ${HEB_DAYS[new Date(dateMs(dateStr)).getUTCDay()]} ${d}.${m}`;
}
function shortDate(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${d}.${m}`;
}
const mm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

// ---- local wall clock → UTC instant, without dependencies ------------------
// Same iterative Intl trick the gate uses for minutesInTz, in the other
// direction. Never falls back silently to UTC: an unusable timezone falls to
// FALLBACK_TZ, which is at least the population this system serves — and
// users.timezone is set at provisioning precisely so this stays theoretical.
function tzOffsetMs(tz, utcMs) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    parts.hour === '24' ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - utcMs;
}
function utcMsOf(dateStr, minutes, tz) {
  let zone = tz || FALLBACK_TZ;
  try { tzOffsetMs(zone, 0); } catch { zone = FALLBACK_TZ; }
  const guess = dateMs(dateStr) + minutes * 60_000;
  // Two passes converge for every real timezone (DST shifts are < 1 day).
  const once = guess - tzOffsetMs(zone, guess);
  return guess - tzOffsetMs(zone, once);
}

// ---- option normalization --------------------------------------------------

function windowOf(part, hour) {
  if (part === 'hour') {
    const [, h, m] = HOUR_RE.exec(hour);
    const from = Number(h) * 60 + Number(m);
    return { from, to: Math.min(from + HOUR_WINDOW_MINUTES, 24 * 60) };
  }
  return { from: PARTS[part].from, to: PARTS[part].to };
}

function optionLabel(o) {
  const when = o.part === 'hour' ? `בשעה ${o.hour}` : `${PARTS[o.part].he} (${mm(windowOf(o.part, o.hour).from)}–${mm(windowOf(o.part, o.hour).to)})`;
  const days = o.start_date === o.end_date
    ? dayLabel(o.start_date)
    : `${shortDate(o.start_date)}–${shortDate(o.end_date)}`;
  return `${days} — ${when}`;
}

// One raw option from the page → the stored shape, or an err with a Hebrew
// message the page shows as-is.
function normalizeOption(raw, tz, today) {
  if (!raw || typeof raw !== 'object') return err('invalid', 'אופציה לא תקינה');
  const start = String(raw.start_date || '');
  const end = String(raw.end_date || raw.start_date || '');
  if (!validDate(start) || !validDate(end)) return err('invalid', 'תאריך לא תקין');
  if (daysBetween(start, end) < 0) return err('invalid', 'טווח תאריכים הפוך');
  if (daysBetween(start, end) > MAX_RANGE_DAYS) {
    return err('invalid', `טווח ארוך מדי — עד ${MAX_RANGE_DAYS} ימים לאופציה`);
  }
  if (start < today) return err('invalid', `התאריך ${shortDate(start)} כבר עבר`);
  if (daysBetween(today, start) > HORIZON_DAYS) return err('invalid', 'תאריך רחוק מדי קדימה');
  const part = String(raw.part || '');
  if (!PARTS[part]) return err('invalid', 'חלק יום לא מוכר');
  let hour = null;
  if (part === 'hour') {
    hour = String(raw.hour || '');
    if (!HOUR_RE.test(hour)) return err('invalid', 'שעה לא תקינה');
  }
  const o = { start_date: start, end_date: end, part, hour, tz: tz || FALLBACK_TZ };
  o.label = optionLabel(o);
  return ok(o);
}

function normalizeOptions(rawList, tz, today = todayInTz(tz)) {
  if (!Array.isArray(rawList) || rawList.length === 0) return err('invalid', 'לא נבחרו אופציות');
  if (rawList.length > MAX_OPTIONS) return err('invalid', `אפשר עד ${MAX_OPTIONS} אופציות`);
  const out = [];
  for (const raw of rawList) {
    const one = normalizeOption(raw, tz, today);
    if (!one.ok) return one;
    out.push(one.data);
  }
  return ok(out);
}

// ---- overlap, in UTC instants ----------------------------------------------

function utcWindowsOf(options) {
  const windows = [];
  for (const o of options) {
    const w = windowOf(o.part, o.hour);
    for (let d = o.start_date; d <= o.end_date; d = addDays(d, 1)) {
      windows.push([utcMsOf(d, w.from, o.tz), utcMsOf(d, w.to, o.tz)]);
    }
  }
  return mergeIntervals(windows);
}

function mergeIntervals(list) {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [f, t] of sorted) {
    if (out.length && f <= out[out.length - 1][1]) {
      out[out.length - 1][1] = Math.max(out[out.length - 1][1], t);
    } else out.push([f, t]);
  }
  return out;
}

function intersectIntervals(a, b) {
  const out = [];
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    const f = Math.max(a[i][0], b[j][0]);
    const t = Math.min(a[i][1], b[j][1]);
    if (f < t) out.push([f, t]);
    if (a[i][1] < b[j][1]) i += 1; else j += 1;
  }
  return out;
}

// Windows that work for EVERYONE, as UTC ms pairs. Pure code, zero tokens.
function overlapWindows(optionLists) {
  if (!optionLists.length) return [];
  let acc = utcWindowsOf(optionLists[0]);
  for (const opts of optionLists.slice(1)) {
    acc = intersectIntervals(acc, utcWindowsOf(opts));
    if (!acc.length) return [];
  }
  return acc
    .filter(([f, t]) => t - f >= MIN_OVERLAP_MINUTES * 60_000)
    .slice(0, MAX_OVERLAP_WINDOWS);
}

// A UTC window rendered for one reader, in THEIR timezone.
function windowLabel([fromMs, toMs], tz) {
  let zone = tz || FALLBACK_TZ;
  try { tzOffsetMs(zone, fromMs); } catch { zone = FALLBACK_TZ; }
  const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: zone });
  const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false });
  const d = fmtDate.format(new Date(fromMs));
  return `${dayLabel(d)} ${fmtTime.format(new Date(fromMs))}–${fmtTime.format(new Date(toMs))}`;
}

// ---- links -----------------------------------------------------------------

async function baseUrl(client) {
  const v = await flags.getFlag(client, 'public_base_url');
  return String(v || '').replace(/\/$/, '');
}

// Mint (or reuse) this user's link for this meeting. Idempotent on purpose:
// the agent may offer the picker twice in one negotiation, and two live links
// to the same form would just be confusing.
async function createLink(client, userId, meetingId) {
  const { rows } = await client.query(
    `SELECT m.status FROM meetings m
     JOIN meeting_participants p ON p.meeting_id = m.id
     WHERE m.id = $1 AND p.user_id = $2 AND p.state != 'opted_out'`,
    [meetingId, userId]
  );
  if (!rows[0]) return err('not_found', 'not a participant of this meeting');
  if (rows[0].status !== 'negotiating') {
    return err('invalid', `this meeting is ${rows[0].status} — availability is only collected while negotiating`);
  }
  const existing = await client.query(
    `SELECT token FROM picker_links
     WHERE meeting_id = $1 AND user_id = $2 AND expires_at > now()
     ORDER BY id DESC LIMIT 1`,
    [meetingId, userId]
  );
  let token = existing.rows[0] && existing.rows[0].token;
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    await client.query(
      `INSERT INTO picker_links (token, meeting_id, user_id, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
      [token, meetingId, userId, LINK_TTL_DAYS]
    );
    await audit.record(client, userId, 'picker.link_created', { meetingId });
  }
  const url = `${await baseUrl(client)}/pick/${token}`;
  return ok({
    url,
    validForDays: LINK_TTL_DAYS,
    tellTheUser: `הקישור אישי (בתוקף ${LINK_TTL_DAYS} ימים) — מסמנים בו עד ${MAX_OPTIONS} אופציות של תאריך/טווח וחלק יום, ואפשר לפתוח שוב ולעדכן.`,
  });
}

// The page's whole world, by token. Distinguishes the three dead-link cases
// because each deserves its own honest page, not a shared 404.
async function loadPage(client, token) {
  const { rows } = await client.query(
    `SELECT l.meeting_id, l.user_id, l.expires_at,
            m.status, m.title, m.initiator_id,
            u.first_name, u.timezone
     FROM picker_links l
     JOIN meetings m ON m.id = l.meeting_id
     JOIN users u ON u.id = l.user_id
     WHERE l.token = $1`,
    [token]
  );
  const row = rows[0];
  if (!row) return err('not_found', 'no such link');
  if (new Date(row.expires_at).getTime() < Date.now()) return err('invalid', 'expired', { reason: 'expired' });
  if (row.status !== 'negotiating') return err('invalid', 'closed', { reason: 'closed', title: row.title, status: row.status });

  const subs = await client.query(
    `SELECT a.user_id, a.options, u.first_name
     FROM meeting_availability a
     JOIN users u ON u.id = a.user_id
     JOIN meeting_participants p ON p.meeting_id = a.meeting_id AND p.user_id = a.user_id
     WHERE a.meeting_id = $1 AND p.state != 'opted_out'`,
    [row.meeting_id]
  );
  const mine = subs.rows.find((s) => Number(s.user_id) === Number(row.user_id));
  const others = subs.rows
    .filter((s) => Number(s.user_id) !== Number(row.user_id))
    .map((s) => ({ name: (s.first_name || '').trim() || 'משתתף', options: s.options || [] }));

  return ok({
    meetingId: Number(row.meeting_id),
    userId: Number(row.user_id),
    title: row.title,
    viewerName: (row.first_name || '').trim(),
    tz: row.timezone || FALLBACK_TZ,
    today: todayInTz(row.timezone),
    mine: (mine && mine.options) || [],
    others,
  });
}

// ---- submit ----------------------------------------------------------------

const optionsHash = (options) =>
  crypto.createHash('sha256').update(JSON.stringify(options)).digest('hex').slice(0, 16);

// Store this person's options and notify whoever the state now points at:
// while people are still missing, the ones who have not answered hear that
// options are waiting for them; the moment the last one submits, the
// INITIATOR alone gets the computed overlap — they are the one who proposes.
// Nobody is messaged twice about the same content (idempotency on a hash of
// the options), and an identical double-tap of the submit button is one row.
async function submit(client, token, rawList) {
  const page = await loadPage(client, token);
  if (!page.ok) return page;
  const { meetingId, userId, title, tz } = page.data;

  const norm = normalizeOptions(rawList, tz);
  if (!norm.ok) return norm;
  const options = norm.data;

  await client.query(
    `INSERT INTO meeting_availability (meeting_id, user_id, options, submitted_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (meeting_id, user_id)
     DO UPDATE SET options = EXCLUDED.options, submitted_at = now()`,
    [meetingId, userId, JSON.stringify(options)]
  );
  await audit.record(client, userId, 'picker.availability_submitted', {
    meetingId, count: options.length,
  });

  const parts = await client.query(
    `SELECT p.user_id, u.first_name, u.timezone,
            (SELECT a.options FROM meeting_availability a
              WHERE a.meeting_id = p.meeting_id AND a.user_id = p.user_id) AS options
     FROM meeting_participants p JOIN users u ON u.id = p.user_id
     WHERE p.meeting_id = $1 AND p.state != 'opted_out'`,
    [meetingId]
  );
  const me = parts.rows.find((r) => Number(r.user_id) === userId);
  const fromName = (me && me.first_name || '').trim() || 'משתתף';
  const pending = parts.rows.filter((r) => !r.options);
  const hash = optionsHash(options);
  const initiator = await client.query(`SELECT initiator_id FROM meetings WHERE id = $1`, [meetingId]);
  const initiatorId = Number(initiator.rows[0].initiator_id);

  if (pending.length === 0) {
    // Everyone active is in — compute the intersection once, label it in the
    // initiator's own timezone, and hand THEM the next move.
    const windows = overlapWindows(parts.rows.map((r) => r.options));
    const initiatorTz = (parts.rows.find((r) => Number(r.user_id) === initiatorId) || {}).timezone;
    const allHash = optionsHash(parts.rows.map((r) => ({ u: Number(r.user_id), o: r.options })));
    await enqueue(client, {
      userId: initiatorId, kind: 'availability_complete', urgency: 'urgent',
      idempotencyKey: `availdone:${meetingId}:${allHash}`,
      payload: {
        meetingId, title,
        overlap: windows.map((w) => windowLabel(w, initiatorTz)),
        people: parts.rows.map((r) => (r.first_name || '').trim() || 'משתתף'),
      },
    });
  } else {
    // Someone still has to answer — tell exactly those people, in their own
    // agents' voices, never the ones who already gave theirs (they will hear
    // the actual proposal next, not everyone's raw options again).
    for (const p of pending) {
      if (Number(p.user_id) === userId) continue;
      await enqueue(client, {
        userId: Number(p.user_id), kind: 'availability_shared', urgency: 'urgent',
        idempotencyKey: `availshare:${meetingId}:${p.user_id}:${hash}`,
        payload: { meetingId, title, fromName, options: options.map((o) => o.label) },
      });
    }
  }
  return ok({ saved: options.length, allSubmitted: pending.length === 0 });
}

// For meetings.getStatus: labels per user, so one status tool keeps telling
// the whole story. Options are offers by construction — sharing them IS their
// purpose — so there is no private variant here.
async function labelsByUser(client, meetingId) {
  const { rows } = await client.query(
    `SELECT user_id, options FROM meeting_availability WHERE meeting_id = $1`, [meetingId]
  );
  return new Map(rows.map((r) => [Number(r.user_id), (r.options || []).map((o) => o.label)]));
}

module.exports = {
  LINK_TTL_DAYS, MAX_OPTIONS, MAX_RANGE_DAYS, HORIZON_DAYS, PARTS,
  normalizeOptions, overlapWindows, windowLabel, todayInTz, utcMsOf, dayLabel,
  createLink, loadPage, submit, labelsByUser,
};
