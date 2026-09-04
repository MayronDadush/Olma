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

// How long teardown waits for pool.end() before declaring a leaked client, and
// how long after the tests finish we allow the process to still be alive.
// Both are enormous next to a healthy file (the whole suite is ~25s) and exist
// only to convert a silent hang into a loud failure.
// The env overrides exist so tests/helpers-guards.test.js can drive both of
// these in a second instead of a minute — a guard that cannot be shown to
// fire is not a guard.
const POOL_END_TIMEOUT_MS = Number(process.env.OLMA_TEST_POOL_END_MS || 15_000);
const EXIT_WATCHDOG_MS = Number(process.env.OLMA_TEST_EXIT_WATCHDOG_MS || 60_000);

// A test child that finishes its tests and then cannot exit is invisible:
// `node --test` waits on `once(child, 'exit')` for ever, and the child's
// output is buffered into a report that is never flushed. `--test-timeout`
// does NOT cover it — measured: a file whose tests all pass but which leaves
// one socket open hangs for ever regardless of that flag. So the child has to
// notice for itself. The timer is UNREF'd, so it cannot be the thing keeping
// the process alive, and a parked event loop still runs timers.
// See incidents.md, "A test file poisoned every other one".
// Armed at module load, not inside freshDb(): every test file requires this
// helper on its first line, before it registers any hooks of its own, so this
// `after` is registered first and therefore RUNS first — the clock starts
// before the file's own teardown, which is what we want.
function armExitWatchdog() {
  const { after } = require('node:test');
  after(() => {
    const t = setTimeout(() => {
      console.error(`[exit-watchdog] ${process.argv[1]}: tests finished but this process is `
        + `still alive ${EXIT_WATCHDOG_MS}ms later, so the suite would hang here for ever.`);
      console.error('[exit-watchdog] still holding the event loop open: '
        + JSON.stringify(process.getActiveResourcesInfo()));
      console.error('[exit-watchdog] usually an unclosed pg Client/Pool, server or socket.');
      process.exit(7);
    }, EXIT_WATCHDOG_MS);
    t.unref();
  });
}

// Creates a fresh DB + pool; returns { pool, teardown }.
// Every client this opens is closed in a `finally`, and that is not tidiness
// — it is the difference between a red suite and a dead one. A connected pg
// Client is an open TCP handle, so it keeps the event loop alive; if anything
// here throws while one is open, the `before` hook fails AND the test child
// can never exit. `node --test` then waits on `once(child, 'exit')` for ever,
// with no output at all (the runner buffers a file's report until the file
// completes). That is precisely the wedge that cost several evenings and four
// dead CI runs: the thrown error was correct and had nowhere to go.
// See incidents.md, "A test file poisoned every other one".
armExitWatchdog();

async function freshDb() {
  const name = testDbName();
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const url = ADMIN_URL.replace(/\/[^/]*$/, '/' + name);
  const setup = new Client({ connectionString: url });
  await setup.connect();
  try {
    await migrate(setup);
  } finally {
    await setup.end();
  }

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

  // pool.end() only settles once every client has been returned, so a single
  // pool.connect() without a `finally { client.release() }` makes teardown
  // wait for ever — the same invisible hang, one door along. Record where each
  // checkout came from so the failure can NAME the culprit instead of just
  // stopping. The callback form is pg's own internal path (pool.query uses
  // it) and is passed straight through untouched.
  const outstanding = new Map();
  const poolConnect = pool.connect.bind(pool);
  pool.connect = function connect(cb) {
    if (typeof cb === 'function') return poolConnect(cb);
    const where = new Error('client checked out here').stack;
    return poolConnect().then((client) => {
      outstanding.set(client, where);
      const release = client.release;
      client.release = function patched(...args) {
        outstanding.delete(client);
        return release.apply(this, args);
      };
      return client;
    });
  };

  const endPool = async () => {
    let outcome = null;
    const ended = pool.end().then(
      () => { outcome = { ok: true }; },
      (err) => { outcome = { ok: false, err }; });
    await Promise.race([ended, new Promise((r) => {
      // unref'd: a watchdog must never be the reason a process stays alive
      setTimeout(r, POOL_END_TIMEOUT_MS).unref();
    })]);
    if (outcome && outcome.ok) return;
    if (outcome) throw outcome.err;
    // Force the sockets shut. Without this the throw below is academic: the
    // handles would still hold the child open and the hang would be silent
    // again. pool._clients is private, and there is no public equivalent.
    for (const client of pool._clients.slice()) {
      try { client.end(); } catch { /* already gone */ }
    }
    const where = [...outstanding.values()];
    throw new Error(
      `pool.end() did not settle in ${POOL_END_TIMEOUT_MS}ms: ${outstanding.size} client(s) were `
      + 'checked out and never released. Every pool.connect() needs a matching '
      + 'finally { client.release() }.'
      + (where.length ? `\n${where[0]}` : ''));
  };

  const teardown = async () => {
    await endPool();
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
