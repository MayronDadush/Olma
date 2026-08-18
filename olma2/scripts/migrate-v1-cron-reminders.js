#!/usr/bin/env node
// One-off: carry the last live v1 gateway-cron jobs into v2, so switching v1
// off does not silently take a reminder away from anyone.
//
// v1 kept per-user reminders as `openclaw cron` jobs delivering an announce
// message. v2 has two better-shaped homes for them:
//   a real per-task reminder  -> tasks + task_reminders (the medication one)
//   a daily "check your list" -> users.digest_times     (the tasks one)
//
// Also backfills users.timezone. Nothing set it, so every user row was NULL,
// and NULL means the delivery gate and the digest sweep both fall back to UTC
// — in Israel that shifts the whole quiet-hours window three hours (a
// 09:00-20:00 window actually runs 12:00-23:00 local). Inferred from the phone
// prefix and left timezone_confirmed = false, because the user has not
// confirmed it; their agent still should.
//
// Idempotent: re-running changes nothing. Dry run unless --apply.
'use strict';
const { createPool, withTx } = require('../src/db/pool');
const { timezoneForPhone } = require('../src/domain/phone-timezone');

const APPLY = process.argv.includes('--apply');

// v1 job -> v2 shape. Times are the LOCAL times the v1 cron used.
const PLAN = [
  {
    phone: '+972502205854',
    kind: 'reminder',
    title: 'לקחת תרופה',
    localTime: '18:30',          // v1: "תזכורת יומית - לקחת תרופה", 30 18 * * * Asia/Jerusalem
    repeat: 'daily',
  },
  {
    phone: '+972557049763',
    kind: 'digest',
    localTime: '17:00',          // v1: "Daily tasks reminder", 0 17 * * * Asia/Jerusalem
  },
];

// Next occurrence of a local HH:MM in the given IANA zone, as a UTC instant.
// Converges by comparing what the zone actually shows and correcting — no
// offset table, and DST-correct because Intl does the work.
function nextLocalTime(tz, hhmm, now = new Date()) {
  const [h, m] = hhmm.split(':').map(Number);
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const probe = new Date(now.getTime() + dayOffset * 86400_000);
    const localDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(probe);
    let guess = new Date(`${localDate}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
    for (let i = 0; i < 3; i++) {
      const shown = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(guess);
      const [sh, sm] = shown.split(':').map(Number);
      const deltaMin = (h * 60 + m) - (sh * 60 + sm);
      if (deltaMin === 0) break;
      guess = new Date(guess.getTime() + deltaMin * 60_000);
    }
    if (guess > now) return guess;
  }
  return null;
}

async function main() {
  const pool = createPool();
  const changes = [];

  await withTx(pool, async (c) => {
    const { rows: users } = await c.query(
      `SELECT id, phone FROM users WHERE timezone IS NULL`);
    for (const u of users) {
      const tz = timezoneForPhone(u.phone);
      if (!tz) continue;
      changes.push(`user ${u.id} (${u.phone}): timezone NULL -> ${tz}`);
      if (APPLY) {
        await c.query(`UPDATE users SET timezone = $2 WHERE id = $1 AND timezone IS NULL`, [u.id, tz]);
      }
    }

    for (const item of PLAN) {
      const { rows } = await c.query(
        `SELECT id, phone, timezone, digest_times FROM users WHERE phone = $1`, [item.phone]);
      const user = rows[0];
      if (!user) { changes.push(`SKIP ${item.phone}: no v2 user`); continue; }
      const tz = user.timezone || timezoneForPhone(item.phone) || 'UTC';

      if (item.kind === 'digest') {
        if (user.digest_times) { changes.push(`skip ${item.phone}: digest_times already set`); continue; }
        changes.push(`user ${user.id} (${item.phone}): digest_times -> ${item.localTime} (${tz})`);
        if (APPLY) {
          await c.query(`UPDATE users SET digest_times = $2 WHERE id = $1`, [user.id, item.localTime]);
        }
        continue;
      }

      // reminders are always task children in v2
      const existing = await c.query(
        `SELECT r.id FROM task_reminders r JOIN tasks t ON t.id = r.task_id
         WHERE t.owner_id = $1 AND t.title = $2 AND r.cancelled_at IS NULL`,
        [user.id, item.title]);
      if (existing.rows[0]) { changes.push(`skip ${item.phone}: "${item.title}" already exists`); continue; }

      const at = nextLocalTime(tz, item.localTime);
      changes.push(`user ${user.id} (${item.phone}): task "${item.title}" + ${item.repeat} reminder ` +
                   `at ${item.localTime} ${tz} (next: ${at.toISOString()})`);
      if (APPLY) {
        const t = await c.query(
          `INSERT INTO tasks (owner_id, title, source) VALUES ($1, $2, 'migrated_from_v1') RETURNING id`,
          [user.id, item.title]);
        await c.query(
          `INSERT INTO task_reminders (task_id, remind_at, repeat_rule) VALUES ($1, $2, $3)`,
          [t.rows[0].id, at, item.repeat]);
        await c.query(
          `INSERT INTO audit_log (actor_id, event, detail, retention_class)
           VALUES ($1, 'reminder.migrated_from_v1', $2, 'routine')`,
          [user.id, JSON.stringify({ title: item.title, localTime: item.localTime, tz })]);
      }
    }
  });

  console.log(changes.length ? changes.join('\n') : '(nothing to do)');
  console.log(APPLY ? '\napplied.' : '\ndry run — pass --apply to write');
  await pool.end();
}

main().catch((e) => { console.error('failed:', e.message); process.exit(1); });
