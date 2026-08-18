'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const prefs = require('../src/domain/preferences');

let db, user;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972509000001');
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

test('remember/forget/list round-trip with upsert', async () => {
  await withClient(async (c) => {
    await prefs.remember(c, user.id, 'tone', 'short and direct');
    await prefs.remember(c, user.id, 'tone', 'even shorter'); // upsert
    const l = await prefs.list(c, user.id);
    assert.equal(l.data.preferences.length, 1);
    assert.equal(l.data.preferences[0].value, 'even shorter');

    const gone = await prefs.forget(c, user.id, 'tone');
    assert.equal(gone.ok, true);
    const missing = await prefs.forget(c, user.id, 'tone');
    assert.equal(missing.error.code, 'not_found');
  });
});

test('keys are validated — no markdown smuggling into structure', async () => {
  await withClient(async (c) => {
    const bad = await prefs.remember(c, user.id, '<!-- comment -->', 'x');
    assert.equal(bad.ok, false);
    const bad2 = await prefs.remember(c, user.id, 'UPPER CASE', 'x');
    assert.equal(bad2.ok, false);
  });
});

test('availabilityWindow: stated beats default, garbage falls back safely', async () => {
  await withClient(async (c) => {
    const def = await prefs.availabilityWindow(c, user.id);
    assert.equal(def.data.source, 'default');
    // Assert against the exported constant, not a copy of its value — the
    // default is a product decision that has already moved once (09:00-20:00
    // → 08:00-21:00) and duplicating it here just means a second place to
    // forget. What matters is that an unstated window IS the default one.
    assert.deepEqual(def.data.window, prefs.DEFAULT_WINDOW);

    await prefs.remember(c, user.id, 'availability', '10:30-23:00');
    const stated = await prefs.availabilityWindow(c, user.id);
    assert.equal(stated.data.source, 'stated');
    assert.deepEqual(stated.data.window, { start: '10:30', end: '23:00' });

    await prefs.remember(c, user.id, 'availability', 'whenever I feel like it');
    const garbage = await prefs.availabilityWindow(c, user.id);
    assert.equal(garbage.data.source, 'default'); // gate never crashes on bad data
  });
});
