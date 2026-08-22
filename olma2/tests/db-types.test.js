'use strict';
// Locks the int8 typing contract from src/db/types.js. Without this, the
// regression is invisible: node-pg's default hands back bigint ids as
// strings, every `===` against a JSON-number tool argument is silently false,
// and nothing throws — the symptom is a guard that never fires, surfacing
// weeks later as "add_subtask_to_shared refuses every call". A test that only
// exercised DB-row ids against other DB-row ids would pass under both
// behaviours, so these assertions check the TYPE, not just the value.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const tasks = require('../src/domain/tasks');

let db, user;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972595000001', { firstName: 'מירון' });
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

test('ids come back as numbers, not strings', async () => {
  assert.equal(typeof user.id, 'number', 'users.id');
  await withClient(async (c) => {
    const added = await tasks.addTask(c, user.id, { title: 'לבדוק את הטיפוסים' });
    assert.equal(added.ok, true);
    assert.equal(typeof added.data.task.id, 'number', 'tasks.id');
    assert.equal(typeof added.data.task.owner_id, 'number', 'tasks.owner_id (FK)');
  });
});

test('a DB id strict-equals the same id arriving as a JSON number', async () => {
  // This is the whole point: an MCP tool argument is parsed from JSON, so it
  // is a number. Before the parser this assertion failed while every query
  // built from the same value still worked, which is why the bug hid so long.
  await withClient(async (c) => {
    const added = await tasks.addTask(c, user.id, { title: 'מטלה' });
    // The model emits a bare numeric literal, so this must parse the id as
    // JSON *text* — round-tripping the JS value through stringify would just
    // hand back whatever type it already had and assert nothing.
    const idFromJson = JSON.parse(`{"task_id": ${added.data.task.id}}`).task_id;
    assert.equal(typeof idFromJson, 'number');
    assert.equal(added.data.task.id === idFromJson, true);
  });
});

test('count(*) is a number, and past 2^53 the raw string is kept', async () => {
  await withClient(async (c) => {
    const counted = await c.query('SELECT count(*) FROM users');
    assert.equal(typeof counted.rows[0].count, 'number');

    // Number() would round this to ...992 and report a wrong id forever.
    // Unreachable here (identity columns start at 1) but the guard must hold.
    const huge = await c.query('SELECT 9007199254740993::bigint AS n');
    assert.equal(huge.rows[0].n, '9007199254740993');
  });
});

// ---- migration numbering ----------------------------------------------------
// Two branches picking the same next number is the ordinary way this repo
// works, and it used to fail in the worst possible way: version is the PRIMARY
// KEY of schema_migrations, so the runner applied one file, inserted the
// version, then violated the key on the other — taking out every test file's
// freshDb() in its before hook and leaving CI with no readable result at all.
// Only the pull_request merge commit ever saw both files, so the branch's own
// push build stayed green throughout.
test('no two migrations share a version number', () => {
  const { listMigrations } = require('../src/db/migrate');
  const seen = new Map();
  for (const m of listMigrations()) {
    assert.equal(seen.has(m.version), false,
      `${m.file} collides with ${seen.get(m.version)} on version ${m.version}`);
    seen.set(m.version, m.file);
  }
});

test('a duplicate version is refused by name, before anything is applied', (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'migrations');
  const decoy = path.join(dir, '001-decoy-collision.sql');
  fs.writeFileSync(decoy, '-- deliberate collision, removed by this test\n');
  t.after(() => fs.rmSync(decoy, { force: true }));

  // require() is cached from the test above, so this is the same module the
  // runner uses — the guard has to live in listMigrations, not in a caller.
  delete require.cache[require.resolve('../src/db/migrate')];
  const { listMigrations } = require('../src/db/migrate');
  assert.throws(() => listMigrations(), /two migrations share version 1/);
  assert.throws(() => listMigrations(), /001-init\.sql/);
  assert.throws(() => listMigrations(), /001-decoy-collision\.sql/);
});

test('a version already applied from a different file is refused, not skipped', async () => {
  // The dangerous half. Production had version 12 applied from
  // 012-usage-from-transcripts.sql, deployed by hand off an unmerged branch —
  // so a new 012 in this tree would have been filtered out as "already done",
  // the deploy would have reported success, and the column the code needs
  // would simply never have been created.
  const { migrate } = require('../src/db/migrate');
  const fresh = await freshDb();
  try {
    // pretend some other branch burned this tree's highest version number
    const mine = require('../src/db/migrate').listMigrations().at(-1);
    await fresh.pool.query(
      `UPDATE schema_migrations SET file = 'somebody-elses-branch.sql' WHERE version = $1`,
      [mine.version]);
    const client = await fresh.pool.connect();
    try {
      await assert.rejects(() => migrate(client),
        /was already applied here from somebody-elses-branch\.sql/);
    } finally { client.release(); }
  } finally { await fresh.teardown(); }
});

test('re-running migrations on an up-to-date database is a no-op', async () => {
  const { migrate } = require('../src/db/migrate');
  const fresh = await freshDb();
  try {
    const client = await fresh.pool.connect();
    try {
      assert.deepEqual(await migrate(client), [], 'freshDb already migrated; nothing left to do');
    } finally { client.release(); }
  } finally { await fresh.teardown(); }
});
