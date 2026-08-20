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
