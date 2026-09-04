'use strict';
// The whole value of scripts/user-testbed.js is the promise that a reset is
// undoable. A test that only checks it "runs" tests nothing — so these drive a
// real snapshot -> real deprovision -> real restore against a real database
// with cross-user data in it, and assert the state is byte-identical afterwards.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./helpers');
const testbed = require('../scripts/user-testbed');
const { deprovisionUser } = require('../src/intake/deprovision');

let db, tmp;
before(async () => {
  db = await h.freshDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'testbed-'));
});
after(async () => {
  if (db) await db.teardown();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// Two users who are connected to each other, so the cascade reaches rows that
// are not "owned" by the user being deleted. Getting that wrong is the whole
// risk: delete Miron, and Gali's side of the friendship goes with him.
async function seed(pool) {
  const a = await h.makeUser(pool, '+972500000001', { firstName: 'Alef' });
  const b = await h.makeUser(pool, '+972500000002', { firstName: 'Bet' });
  const c = await pool.connect();
  try {
    await c.query(`UPDATE users SET agent_id='u-a', workspace_path=$2 WHERE id=$1`,
      [a.id, path.join(tmp, 'ws-a')]);
    await c.query(`UPDATE users SET agent_id='u-b' WHERE id=$1`, [b.id]);
    await c.query(`INSERT INTO tasks (owner_id, title, status) VALUES ($1,'קנה חלב','open'),($1,'שלם שכר דירה','open')`, [a.id]);
    await c.query(`INSERT INTO user_preferences (user_id, key, value) VALUES ($1,'tone','short')`, [a.id]);
    await c.query(`INSERT INTO user_facts (user_id, category, fact) VALUES ($1,'routine','רץ בבקרים')`, [a.id]);
    await c.query(
      `INSERT INTO connections (requester_id, target_id, target_phone, status)
       VALUES ($1,$2,'+972500000001','active')`, [b.id, a.id]);
    // A jsonb ARRAY, deliberately. node-pg turns a JS array back into a
    // Postgres array literal rather than JSON, so a restore that does not say
    // "this column is json" fails here and only here — it was found against
    // real data, and this row is what stops it coming back.
    await c.query(
      `INSERT INTO user_plans (user_id, headline, bullets)
       VALUES ($1, 'השבוע', $2::jsonb)`,
      [a.id, JSON.stringify(['לסיים את הדוח', 'להתקשר לרופא'])]);
    // And a jsonb OBJECT, which survives by luck rather than by design.
    await c.query(
      `INSERT INTO outbox (user_id, kind, payload, idempotency_key)
       VALUES ($1, 'reminder', $2::jsonb, 'testbed-1')`,
      [a.id, JSON.stringify({ taskId: 7, rung: 1 })]);
  } finally { c.release(); }
  return { a, b };
}

test('the snapshot records what Postgres actually cascades, including the other side of a connection', async () => {
  const { a, b } = await seed(db.pool);
  const obs = await testbed.observeDeletion(db.pool, a.id);

  assert.equal(obs.removed.users.length, 1, 'exactly one users row');
  assert.equal(obs.removed.users[0].id, a.id);
  assert.equal(obs.removed.tasks.length, 2);
  assert.equal(obs.removed.user_preferences.length, 1);
  assert.equal(obs.removed.user_facts.length, 1);
  // B's connection row is B's, and it dies with A. If this ever stops being
  // captured, restoring A leaves B quietly friendless.
  assert.equal(obs.removed.connections.length, 1);
  assert.equal(obs.removed.connections[0].requester_id, b.id);
  assert.ok(!obs.removed.users.some((u) => u.id === b.id), 'B survives');

  // And the transaction really was thrown away.
  const still = await db.pool.query('SELECT count(*)::int c FROM users WHERE id=$1', [a.id]);
  assert.equal(still.rows[0].c, 1, 'observeDeletion must never commit');
});

test('a real delete followed by a restore puts every row back exactly as it was', async () => {
  const c0 = await db.pool.connect();
  try { await c0.query('TRUNCATE users CASCADE'); } finally { c0.release(); }
  const { a, b } = await seed(db.pool);

  const before = await snapshotState(db.pool);
  const obs = await testbed.observeDeletion(db.pool, a.id);

  // The real thing, on a real row, not a simulation.
  const cfgPath = path.join(tmp, 'openclaw.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ agents: { entries: [] }, bindings: [] }));
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const res = await deprovisionUser(c, '+972500000001', { configPath: cfgPath, removeWorkspace: false });
    assert.ok(res.ok, 'deprovision succeeded');
    await c.query('COMMIT');
  } finally { c.release(); }

  const gone = await db.pool.query('SELECT count(*)::int c FROM users WHERE id=$1', [a.id]);
  assert.equal(gone.rows[0].c, 0, 'user is really deleted');
  const bLonely = await db.pool.query('SELECT count(*)::int c FROM connections');
  assert.equal(bLonely.rows[0].c, 0, 'the connection cascaded away, as expected');

  await restoreFrom(db.pool, obs);

  const after = await snapshotState(db.pool);
  assert.deepEqual(after, before, 'state after restore is identical to state before the delete');
});

test('the identity sequence is pushed past a hand-restored id, so the next signup does not collide', async () => {
  const c0 = await db.pool.connect();
  try { await c0.query('TRUNCATE users CASCADE'); } finally { c0.release(); }
  const { a } = await seed(db.pool);
  const obs = await testbed.observeDeletion(db.pool, a.id);

  const cfgPath = path.join(tmp, 'openclaw2.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ agents: { entries: [] }, bindings: [] }));
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await deprovisionUser(c, '+972500000001', { configPath: cfgPath, removeWorkspace: false });
    await c.query('COMMIT');
  } finally { c.release(); }

  await restoreFrom(db.pool, obs);

  // Without resyncSequences this insert reuses A's id and throws on the PK.
  const fresh = await h.makeUser(db.pool, '+972500000009', { firstName: 'Gimel' });
  assert.ok(fresh.id > a.id, `new id ${fresh.id} must be past the restored ${a.id}`);
});

test('insertPlan orders parents before children and defers the users<->connections cycle', async () => {
  // No such user — this call is only here for the schema metadata it returns.
  const { edges, pk } = await testbed.observeDeletion(db.pool, -1);

  const tables = ['users', 'connections', 'tasks', 'user_preferences'];
  const plan = testbed.insertPlan(tables, edges, pk);
  assert.ok(plan.order.indexOf('users') < plan.order.indexOf('tasks'), 'users before tasks');
  assert.ok(plan.order.indexOf('users') < plan.order.indexOf('connections'), 'users before connections');
  // users.invited_by_connection_id points the other way; it has to be deferred.
  assert.ok(plan.deferred.some((d) => d.child === 'users' && d.col === 'invited_by_connection_id'),
    'the cycle is broken by deferring the nullable column, not by guessing an order');
});

test('cascadeClosure follows CASCADE only, and setNullEdges finds the pointers that merely go null', async () => {
  const c = await db.pool.connect();
  let edges;
  try { edges = await testbedEdges(c); } finally { c.release(); }
  const closure = testbed.cascadeClosure(edges);
  assert.ok(closure.has('tasks') && closure.has('outbox') && closure.has('connections'));
  assert.ok(!closure.has('schema_migrations'));
  assert.ok(!closure.has('audit_log'), 'audit_log survives a user deletion by design');
  const nulls = testbed.setNullEdges(edges, closure);
  assert.ok(nulls.some((e) => e.child === 'issues' && e.child_col === 'reporter_id'),
    'a reported issue outlives its reporter, with the pointer nulled');
});


test('diffState is not a rubber stamp — it reports a row that came back changed', () => {
  const before = { tasks: ['{"id":1,"title":"a"}', '{"id":2,"title":"b"}'], users: ['{"id":1}'] };
  assert.deepEqual(testbed.diffState(before, before), [], 'identical state is clean');
  const short = { tasks: ['{"id":1,"title":"a"}'], users: ['{"id":1}'] };
  assert.deepEqual(testbed.diffState(before, short), ['tasks: 2 rows before, 1 after']);
  const altered = { tasks: ['{"id":1,"title":"a"}', '{"id":2,"title":"CHANGED"}'], users: ['{"id":1}'] };
  assert.deepEqual(testbed.diffState(before, altered), ['tasks: 1 row(s) came back different']);
});

test('restoreRowsInto is the same code the rehearsal and the real restore both run', async () => {
  const c0 = await db.pool.connect();
  try { await c0.query('TRUNCATE users CASCADE'); } finally { c0.release(); }
  const { a } = await seed(db.pool);
  const obs = await testbed.observeDeletion(db.pool, a.id);

  // Delete and restore INSIDE one transaction, then throw it away — the exact
  // shape `rehearse` uses. The assertions are that the state matched mid-
  // transaction, and that nothing survived the rollback.
  const c = await db.pool.connect();
  let problems;
  try {
    await c.query('BEGIN');
    const before = await closureState(c);
    await deprovisionUser(c, '+972500000001', { configPath: cfgFile(), removeWorkspace: false });
    const gone = await c.query('SELECT count(*)::int c FROM users WHERE id=$1', [a.id]);
    assert.equal(gone.rows[0].c, 0, 'the delete really happened inside the transaction');
    await testbed.restoreRowsInto(c, obs);
    problems = testbed.diffState(before, await closureState(c));
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  assert.deepEqual(problems, [], 'restore reproduced the state exactly');

  // And the rollback really rolled back: the row is still the ORIGINAL one,
  // not a re-inserted copy left behind by a leaked commit.
  const after = await db.pool.query('SELECT count(*)::int c FROM users WHERE id=$1', [a.id]);
  assert.equal(after.rows[0].c, 1);
});

// --- helpers -------------------------------------------------------------

async function testbedEdges(client) {
  // observeDeletion does this internally; re-query here so the assertion is
  // about the schema, not about a code path that could itself be wrong.
  const { rows } = await client.query(`
    SELECT src.relname AS child, a.attname AS child_col, tgt.relname AS parent,
           con.confdeltype AS ondel, a.attnotnull AS child_notnull
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class tgt ON tgt.oid = con.confrelid
    JOIN unnest(con.conkey) WITH ORDINALITY AS ck(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ck.attnum
    WHERE con.contype='f' AND src.relnamespace='public'::regnamespace`);
  return rows;
}

// Everything in the cascade closure, ordered, as one comparable blob.
async function snapshotState(pool) {
  const c = await pool.connect();
  try {
    const edges = await testbedEdges(c);
    const closure = [...testbed.cascadeClosure(edges)].sort();
    const out = {};
    for (const tbl of closure) {
      const { rows } = await c.query(`SELECT * FROM ${tbl}`);
      out[tbl] = rows.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort();
    }
    return out;
  } finally { c.release(); }
}

// The DB half of restore, run and committed — the real function, not a copy.
async function restoreFrom(pool, obs) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await testbed.restoreRowsInto(c, obs);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

function cfgFile() {
  const p = path.join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ agents: { entries: [] }, bindings: [] }));
  return p;
}

// The same shape testbed's stateOfClosure produces, for comparing across a
// delete/restore pair.
async function closureState(client) {
  const edges = await testbedEdges(client);
  const out = {};
  for (const tbl of [...testbed.cascadeClosure(edges)].sort()) {
    const { rows } = await client.query(`SELECT * FROM ${tbl}`);
    out[tbl] = rows.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort();
  }
  return out;
}
