'use strict';
// Each test file gets its own throwaway database, built by running the real
// migrations — the same runner production uses. No hand-applied ALTERs in
// tests, ever (the v1 wound this design exists to close).
require('../src/db/types'); // tests must see production's int8 typing
// Never chattr +i inside test fixtures — an immutable file under /tmp
// survives the teardown's rm -rf and litters the box (see intake/provision).
process.env.OLMA_IMMUTABLE_IDENTITY = 'off';
const { Client, Pool } = require('pg');
const crypto = require('node:crypto');
const { migrate } = require('../src/db/migrate');

const ADMIN_URL = process.env.OLMA_TEST_ADMIN_URL
  || 'postgres://olma:olma2local@127.0.0.1:5432/olma2_test';

function testDbName() {
  return 'olma2_t_' + crypto.randomBytes(6).toString('hex');
}

// Creates a fresh DB + pool; returns { pool, teardown }.
async function freshDb() {
  const name = testDbName();
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = ADMIN_URL.replace(/\/[^/]*$/, '/' + name);
  const setup = new Client({ connectionString: url });
  await setup.connect();
  await migrate(setup);
  await setup.end();

  // Production's Postgres session runs in Etc/UTC (verified on the box), and
  // several jobs quietly depend on it: jobs/metrics.js picks its day with
  // `now.toISOString().slice(0, 10)` in JS, then counts rows with
  // `created_at::date`, which Postgres resolves in the SESSION's zone. Those
  // agree only under UTC. On a developer machine whose Postgres inherits a
  // local zone they disagree for the hours between the two midnights, and the
  // rollup silently files a day's metrics under the wrong date — which is how
  // this surfaced: as a test failing after midnight local, on a box in IDT.
  // Tests inherit the timezone rather than choose one, so pin it to what
  // production actually runs; a suite green only where the clocks agree is
  // testing a configuration nobody deploys.
  const pool = new Pool({ connectionString: url, max: 6, options: '-c timezone=Etc/UTC' });
  const teardown = async () => {
    await pool.end();
    const admin2 = new Client({ connectionString: ADMIN_URL });
    await admin2.connect();
    try {
      await admin2.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } catch (e) {
      // WITH (FORCE) has to terminate any backend still attached, which needs
      // pg_signal_backend. Failing to clean up a throwaway database must never
      // turn a passing suite red — a leftover olma2_t_* database is inert, and
      // the next run's CREATE uses a fresh random name anyway.
      console.warn(`[test] could not drop ${name}: ${e.message}`);
    }
    await admin2.end();
  };
  return { pool, teardown, url };
}

// Shorthand: create an active user and return the row.
async function makeUser(pool, phone, extra = {}) {
  const users = require('../src/domain/users');
  const client = await pool.connect();
  try {
    const res = await users.createUser(client, { phone, firstName: extra.firstName || 'Test', ...extra });
    if (!res.ok) throw new Error('makeUser failed: ' + res.error.message);
    return res.data.user;
  } finally {
    client.release();
  }
}

// A future timestamp that AGREES with the slot text about the day. Meeting
// slots are cross-checked (domain/datetime.weekdayClash), so a test that hard-
// codes "Tuesday 17:00" alongside now+48h passes or fails depending on which
// day the suite happens to run. Given the text, this lands on the next
// occurrence of the weekday it names, or simply now+hours when it names none.
function slotStart(text, { hours = 48, hourUtc = 17 } = {}) {
  const { weekdaysInText } = require('../src/domain/datetime');
  const iso = (d) => d.toISOString().replace(/\.\d+Z$/, '+00:00');
  const base = new Date(Date.now() + hours * 3600_000);
  const want = weekdaysInText(text);
  if (want.length === 0) return iso(base);
  const d = new Date(Date.UTC(
    base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hourUtc, 0, 0));
  while (d.getUTCDay() !== want[0]) d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
}

// Today, at an hour nobody's quiet hours cover — for tests that drive the
// outbox worker but are not about the night gate.
//
// The sibling of slotStart, one dimension over: that one exists because a test
// hard-coding a weekday passes or fails depending on the DAY the suite runs,
// and this one because a test that lets drainOnce default its own `now` passes
// or fails depending on the HOUR. Test users are created with a NULL timezone,
// which the gate reads as UTC, and the fallback availability window is
// 08:00-21:00 — so the suite was green for thirteen hours a day and red for
// eleven, and CI's own deploy-on-merge run cleared it by fifteen minutes on
// 2026-08-30. Noon sits mid-window both as UTC and as Israel time, the only
// two zones test users have.
//
// Pass this as drainOnce's third argument. Reach for it only when the night
// rule is beside the point; a test ABOUT quiet hours should still pick its own
// hour deliberately.
function daytime(date = new Date()) {
  const d = new Date(date);
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

module.exports = { freshDb, makeUser, slotStart, daytime };
