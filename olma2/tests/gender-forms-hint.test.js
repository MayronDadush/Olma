'use strict';
// The nightly evals kept flagging one masculine verb in an otherwise feminine
// reply to a user who had asked for feminine address. The doctrine already
// says "hold the stored preference" — from 40k chars away. This puts the same
// sentence in the turn_start RESULT, for exactly the people it applies to,
// where a cheap model actually reads it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { createBrokerServer } = require('../src/brokerd/server');
const preferences = require('../src/domain/preferences');

let db, broker;
before(async () => { db = await freshDb(); broker = createBrokerServer({ pool: db.pool }); });
after(async () => { await db.teardown(); });

async function turnStart(user) {
  const res = await broker.dispatch(
    { id: 1, method: 'tool_call', params: { name: 'turn_start', args: { olma_identity: user.identity_token } } },
    { opened: false, counted: false });
  assert.equal(res.ok, true, res.text);
  return JSON.parse(res.text.replace(/^OK /, ''));
}

test('no stored preference: nothing about gender rides the result', async () => {
  const u = await makeUser(db.pool, '+972611010001');
  const data = await turnStart(u);
  assert.equal(data.genderForms, undefined);
  assert.equal(data.hints && data.hints.genderForms, undefined, 'the hint costs tokens only where it applies');
});

test('a stored feminine preference turns into the reminder, every turn', async () => {
  const u = await makeUser(db.pool, '+972611010002');
  const c = await db.pool.connect();
  try { await preferences.remember(c, u.id, 'gender_forms', 'נקבה — לפנות אליה בלשון נקבה'); } finally { c.release(); }
  const data = await turnStart(u);
  assert.equal(data.genderForms, 'feminine');
  assert.match(data.hints.genderForms, /FEMININE/);
  assert.match(data.hints.genderForms, /תרצי/);
  assert.match(data.hints.genderForms, /Reread/);
  // Every turn, not once: the slip happens on the tenth message as easily as
  // the first.
  assert.equal((await turnStart(u)).genderForms, 'feminine');
});

test('a stored masculine preference is the default register and gets no hint', async () => {
  const u = await makeUser(db.pool, '+972611010003');
  const c = await db.pool.connect();
  try { await preferences.remember(c, u.id, 'gender_forms', 'זכר'); } finally { c.release(); }
  const data = await turnStart(u);
  assert.equal(data.genderForms, undefined);
  assert.equal(data.hints && data.hints.genderForms, undefined);
});
