'use strict';
// Who gets a morning or an evening summary, at what hour, and how many of
// them actually arrived (owner, 2026-10-06). Read-only, for the admin page.
//
// Two different questions, kept apart because they disagree:
//  - what is SET: `users.digest_times`, or 20:00 for somebody on
//    `daily_once_phones` (jobs/sweeps.js, DAILY_ONCE_AT), whose own times are
//    then ignored;
//  - what ARRIVED: scheduled `digest` rows in the outbox, delivered
//    (`sent_at` set and no `hold_reason`). A cancelled or expired row carries
//    `sent_at` too, which is why the hold is what tells them apart — the same
//    reading sweepDigests uses for `last_digest_at`.
// A scheduled row's key is `digest:<user>:<UTC day>:<HH:MM>`, so the slot it
// was written for is on the row; a digest sent by hand from somewhere else
// has another key and is counted as such, never as a slot.
const flags = require('./flags');
const { coveredBy } = require('./turn');

const DAILY_ONCE_AT = '20:00';

// Morning before noon, evening from five; anything between is its own word,
// because a 14:00 summary is neither and calling it one would be a guess.
function partOf(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):\d{2}$/);
  if (!m) return null;
  const h = Number(m[1]);
  if (h < 12) return 'morning';
  if (h < 17) return 'noon';
  return 'evening';
}

function slotsOf(u, dailyOnceFlag) {
  if (coveredBy(dailyOnceFlag, u.phone)) return { times: [DAILY_ONCE_AT], dailyOnce: true };
  const times = String(u.digest_times || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { times, dailyOnce: false };
}

async function summary(client, { days = 30 } = {}) {
  const dailyOnceFlag = await flags.getFlag(client, 'daily_once_phones');
  const { rows: users } = await client.query(
    `SELECT u.id, u.first_name, u.phone, u.timezone, u.digest_times, u.digest_scope,
            u.status, u.onboarded_at, u.paused_at
       FROM users u
      WHERE u.status = 'active' AND NOT u.is_eval AND NOT u.is_test`);
  const { rows: sent } = await client.query(
    `SELECT o.user_id,
            CASE WHEN o.idempotency_key LIKE 'digest:%'
                 THEN split_part(o.idempotency_key, ':', 4) || ':' || split_part(o.idempotency_key, ':', 5) END AS slot,
            o.sent_at,
            to_char(o.sent_at AT TIME ZONE COALESCE(u.timezone, 'Asia/Jerusalem'), 'HH24:MI') AS local_time,
            to_char(o.sent_at AT TIME ZONE COALESCE(u.timezone, 'Asia/Jerusalem'), 'YYYY-MM-DD') AS local_day,
            o.hold_reason
       FROM outbox o JOIN users u ON u.id = o.user_id
      WHERE o.kind = 'digest' AND o.sent_at IS NOT NULL
        AND o.created_at > now() - ($1 || ' days')::interval
        AND NOT u.is_eval AND NOT u.is_test
      ORDER BY o.sent_at`,
    [String(days)]);

  const week = Date.now() - 7 * 86400_000;
  const byUser = new Map();
  for (const r of sent) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }

  const people = [];
  for (const u of users) {
    const { times, dailyOnce } = slotsOf(u, dailyOnceFlag);
    const rows = byUser.get(u.id) || [];
    if (!times.length && !rows.length) continue;
    const arrived = rows.filter((r) => !r.hold_reason);
    const missed = rows.filter((r) => r.hold_reason);
    const reasons = {};
    for (const r of missed) reasons[r.hold_reason] = (reasons[r.hold_reason] || 0) + 1;
    // Per slot: how many arrived and at what local times, so a 09:00 that
    // keeps reaching them at 11:40 (held by quiet hours, a busy gateway) shows.
    const slots = {};
    for (const t of times) slots[t] = { slot: t, part: partOf(t), arrived: 0, arrived7: 0, times: [] };
    let manual = 0;
    for (const r of arrived) {
      if (!r.slot) { manual++; continue; }
      if (!slots[r.slot]) slots[r.slot] = { slot: r.slot, part: partOf(r.slot), arrived: 0, arrived7: 0, times: [], retired: true };
      slots[r.slot].arrived++;
      if (new Date(r.sent_at).getTime() > week) slots[r.slot].arrived7++;
      slots[r.slot].times.push(r.local_time);
    }
    const state = u.paused_at ? 'paused' : !u.onboarded_at ? 'not_onboarded' : times.length ? 'on' : 'off';
    people.push({
      id: Number(u.id), name: u.first_name, timezone: u.timezone, dailyOnce, state,
      times, scope: u.digest_scope,
      slots: Object.values(slots).sort((a, b) => a.slot.localeCompare(b.slot)),
      arrived: arrived.length,
      arrived7: arrived.filter((r) => new Date(r.sent_at).getTime() > week).length,
      manual, missed: missed.length, reasons,
      lastAt: arrived.length ? arrived[arrived.length - 1].sent_at : null,
      lastLocal: arrived.length ? `${arrived[arrived.length - 1].local_day} ${arrived[arrived.length - 1].local_time}` : null,
    });
  }

  // Headcounts over the people who will get one on their next slot — set,
  // onboarded, not paused — by part of day. One person with a morning and an
  // evening is counted in both.
  const live = people.filter((p) => p.state === 'on');
  const parts = { morning: 0, noon: 0, evening: 0 };
  for (const p of live) {
    for (const part of new Set(p.times.map(partOf).filter(Boolean))) parts[part]++;
  }
  const delivered = { morning: 0, noon: 0, evening: 0, manual: 0 };
  for (const p of people) {
    for (const s of p.slots) if (s.part) delivered[s.part] += s.arrived;
    delivered.manual += p.manual;
  }
  return {
    days,
    people: people.sort((a, b) => (a.state === 'on' ? 0 : 1) - (b.state === 'on' ? 0 : 1) || b.arrived - a.arrived),
    live: live.length, parts, delivered,
    missed: people.reduce((n, p) => n + p.missed, 0),
  };
}

module.exports = { summary, partOf, DAILY_ONCE_AT };
