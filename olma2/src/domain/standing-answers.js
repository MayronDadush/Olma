'use strict';
// An answer somebody gave before the time it answers existed (owner,
// 2026-09-28, off Padel Gang's coordination 57).
//
// גיא said "לא יכול השבוע — טס לחול" at 09:15; the first time went on the
// table at 09:23, so the constraint declined nothing and he stayed "has not
// answered" on every time that followed, and was asked about each of them.
// מירון said "אני יכול כל יום השבוע מ18" before there was a table at all, and
// none of the four times after 18:00 carried his yes. The words were kept; the
// ANSWER in them had nowhere to go.
//
// So a constraint may carry WINDOWS beside its words — "no, from here to
// there", "yes, from 18:00, these days" — and a time put on the table later is
// answered for them wherever a window covers it. Both directions are the
// owner's choice ("גם כן וגם לא"), and so is the other half: whoever is
// answered this way is TOLD, privately, what was marked and why, so a yes
// they did not mean is one sentence from being undone.
//
// A window never answers a time they have already answered — their own word
// on a time always beats a rule about it — and never a whole day, whose hour
// is a stand-in (`meeting-option-moment.standInFor`) that no window can judge.
const { ok } = require('./results');
const audit = require('./audit');
const { hasOffset, weekdayInZone } = require('./datetime');

// Longer than any "this week"/"next week" anybody says, short enough that a
// window is never a standing rule about their life — that is a preference
// (`remember_preference key availability`), not an answer about one meeting.
const MAX_SPAN_MS = 21 * 24 * 3600_000;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
// How long a notice waits for the rest of a burst: three times put up in a
// minute are one message saying three things.
const GATHER_MS = 2 * 60_000;

const minutesOf = (hhmm) => { const m = HHMM.exec(hhmm); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

// The window as it is kept, or null with the reason it was not. A bad window
// drops the WINDOW and keeps the words — the constraint is what they said,
// the window is what the model made of it (the same split as `usableDue`).
function validWindow(w) {
  if (!w || typeof w !== 'object') return { window: null, reason: 'not an object' };
  if (w.answer !== 'y' && w.answer !== 'n') return { window: null, reason: 'answer must be y or n' };
  if (!hasOffset(w.from) || !hasOffset(w.to)) return { window: null, reason: 'from and to need a UTC offset' };
  const from = new Date(w.from).getTime();
  const to = new Date(w.to).getTime();
  if (!(to > from)) return { window: null, reason: 'to must be after from' };
  if (to - from > MAX_SPAN_MS) return { window: null, reason: 'longer than 21 days is a preference, not an answer' };
  const out = { answer: w.answer, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  for (const k of ['after', 'before']) {
    if (w[k] === undefined || w[k] === null || w[k] === '') continue;
    if (minutesOf(w[k]) === null) return { window: null, reason: `${k} must be HH:MM` };
    out[k] = w[k];
  }
  if (Array.isArray(w.days) && w.days.length) {
    const days = [...new Set(w.days.map(Number))];
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return { window: null, reason: 'days are 0 (Sunday) to 6' };
    out.days = days.sort();
  }
  return { window: out, reason: null };
}

function localMinutes(ms, tz) {
  try {
    const [h, m] = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ms)).split(':').map(Number);
    return (h % 24) * 60 + m;
  } catch { return null; }
}

// Does this window speak about this time, on THEIR clock? A time with no
// instant, or a whole day, is never covered.
function covers(w, option, tz) {
  if (!w || !option || option.allDay || !option.startsAt) return false;
  const t = new Date(option.startsAt).getTime();
  if (Number.isNaN(t)) return false;
  if (t < new Date(w.from).getTime() || t >= new Date(w.to).getTime()) return false;
  if (w.after || w.before) {
    const mins = localMinutes(t, tz);
    if (mins === null) return false;
    if (w.after && mins < minutesOf(w.after)) return false;
    if (w.before && mins >= minutesOf(w.before)) return false;
  }
  if (w.days) {
    const day = weekdayInZone(new Date(t).toISOString(), tz);
    if (day === null || !w.days.includes(day)) return false;
  }
  return true;
}

// The answer their windows give this time: the most recently SAID one that
// covers it wins, because a later sentence is a correction of an earlier one.
// Each verdict carries the words it came from, which is what they are told.
function verdictFor(constraints, option, tz) {
  let hit = null;
  for (const c of constraints || []) {
    for (const w of c.windows || []) if (covers(w, option, tz)) hit = { answer: w.answer, because: c.text };
  }
  return hit;
}

async function peopleWithWindows(client, meetingId) {
  const { rows } = await client.query(
    `SELECT p.user_id, p.constraints, u.timezone FROM meeting_participants p JOIN users u ON u.id = p.user_id
      WHERE p.meeting_id = $1 AND p.state <> 'opted_out'
        AND jsonb_path_exists(p.constraints, '$[*].windows[*]')`, [meetingId]);
  return rows;
}

async function answeredBy(client, optionId) {
  const { rows } = await client.query('SELECT user_id FROM meeting_option_answers WHERE option_id = $1', [optionId]);
  return new Set(rows.map((r) => Number(r.user_id)));
}

async function optionRow(client, optionId) {
  const { rows } = await client.query(
    `SELECT id, slot_text, starts_at, all_day FROM meeting_options WHERE id = $1 AND status = 'active'`, [optionId]);
  return rows[0] ? { id: Number(rows[0].id), slotText: rows[0].slot_text, startsAt: rows[0].starts_at, allDay: rows[0].all_day } : null;
}

async function answerFor(client, userId, meetingId, option, verdict) {
  const options = require('./meeting-options');
  const res = await options.answer(client, userId, meetingId, option.id, verdict.answer);
  if (!res.ok) return null;
  await audit.record(client, userId, 'meeting.auto_answered', {
    meetingId: Number(meetingId), optionId: option.id, answer: verdict.answer,
  });
  return { userId: Number(userId), optionId: option.id, slot: option.slotText, answer: verdict.answer, because: verdict.because };
}

// A time just went on the table: answer it for everybody whose windows cover
// it, except whoever put it there (their own yes is already on it).
async function applyToOption(client, meetingId, optionId, { exceptUserId = null } = {}) {
  const option = await optionRow(client, optionId);
  if (!option || option.allDay) return [];
  const people = await peopleWithWindows(client, meetingId);
  if (!people.length) return [];
  const done = await answeredBy(client, optionId);
  const out = [];
  for (const p of people) {
    const uid = Number(p.user_id);
    if (uid === Number(exceptUserId) || done.has(uid)) continue;
    const verdict = verdictFor(p.constraints, option, p.timezone);
    if (!verdict) continue;
    const a = await answerFor(client, uid, meetingId, option, verdict);
    if (a) out.push(a);
  }
  return out;
}

// They just said it, with times already on the table: answer every one they
// have not answered yet. They are in the conversation, so this is returned to
// the tool and said in the reply — not queued as a second message.
async function applyToTable(client, meetingId, userId) {
  const { rows: [p] } = await client.query(
    `SELECT p.constraints, u.timezone FROM meeting_participants p JOIN users u ON u.id = p.user_id
      WHERE p.meeting_id = $1 AND p.user_id = $2 AND p.state <> 'opted_out'`, [meetingId, userId]);
  if (!p) return [];
  const { rows: table } = await client.query(
    `SELECT o.id FROM meeting_options o
      WHERE o.meeting_id = $1 AND o.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM meeting_option_answers a WHERE a.option_id = o.id AND a.user_id = $2)
      ORDER BY o.starts_at NULLS LAST, o.id`, [meetingId, userId]);
  const out = [];
  for (const r of table) {
    const option = await optionRow(client, r.id);
    if (!option || option.allDay) continue;
    const verdict = verdictFor(p.constraints, option, p.timezone);
    if (!verdict) continue;
    const a = await answerFor(client, userId, meetingId, option, verdict);
    if (a) out.push(a);
  }
  return out;
}

// Somebody else put a time up and it was answered for them: they hear it,
// privately, so a yes they did not mean is one sentence from being undone. A
// burst gathers into ONE unsent notice rather than a message per time — the
// row the worker has not locked is extended; one in flight is left alone.
async function tell(client, userId, meetingId, answers, { title = null } = {}) {
  if (!answers.length) return ok({ told: false });
  const lines = answers.map((a) => ({ optionId: a.optionId, slot: a.slot, answer: a.answer, because: a.because }));
  const { rows: pending } = await client.query(
    `SELECT id, payload FROM outbox
      WHERE user_id = $1 AND kind = 'meeting_auto_answered' AND sent_at IS NULL
        AND (payload->>'meetingId')::bigint = $2
      ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`, [userId, meetingId]);
  if (pending[0]) {
    const have = pending[0].payload.answers || [];
    const merged = [...have, ...lines.filter((l) => !have.some((h) => h.optionId === l.optionId))];
    await client.query(
      `UPDATE outbox SET payload = jsonb_set(payload, '{answers}', $2::jsonb) WHERE id = $1 AND sent_at IS NULL`,
      [pending[0].id, JSON.stringify(merged)]);
    return ok({ told: true, folded: true });
  }
  const { enqueue } = require('../outbox/enqueue');
  await enqueue(client, {
    userId, kind: 'meeting_auto_answered',
    payload: { meetingId: Number(meetingId), title: title || 'meeting', answers: lines },
    releaseAfter: new Date(Date.now() + GATHER_MS),
    idempotencyKey: `mauto:${meetingId}:${userId}:${lines.map((l) => l.optionId).join('-')}`,
  });
  return ok({ told: true, folded: false });
}

module.exports = {
  validWindow, covers, verdictFor, applyToOption, applyToTable, tell,
  MAX_SPAN_MS, GATHER_MS,
};
