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

// The owner's rule (2026-09-23): the profile column (`users.gender`, which the
// room and the page read) and this preference (which the private chat reads)
// agree, whichever side the change came from.
async function genderState(id) {
  const { rows: [u] } = await db.pool.query(`SELECT gender FROM users WHERE id = $1`, [id]);
  const { rows: p } = await db.pool.query(
    `SELECT value FROM user_preferences WHERE user_id = $1 AND key = 'gender_forms'`, [id]);
  return { gender: u.gender, pref: p[0] ? p[0].value : null };
}

test('said in the private chat, the profile and the room follow — and "נשי" reads as feminine', async () => {
  const groupTurn = require('../src/domain/group-turn');
  const u = await makeUser(db.pool, '+972611010004');
  const c = await db.pool.connect();
  try { await preferences.remember(c, u.id, 'gender_forms', 'נשי'); } finally { c.release(); }
  assert.deepEqual(await genderState(u.id), { gender: 'female', pref: 'נשי' }, 'their own words stay as they said them');
  assert.equal((await turnStart(u)).genderForms, 'feminine', 'the private regex used to miss "נשי"');
  assert.equal(groupTurn.addressOf(await genderState(u.id)), 'feminine');

  // Changed their mind, in the same chat: both move.
  const c2 = await db.pool.connect();
  try { await preferences.remember(c2, u.id, 'gender_forms', 'לשון זכר'); } finally { c2.release(); }
  assert.deepEqual(await genderState(u.id), { gender: 'male', pref: 'לשון זכר' });

  // Words that name neither leave the column alone.
  const c3 = await db.pool.connect();
  try { await preferences.remember(c3, u.id, 'gender_forms', 'לא משנה לי'); } finally { c3.release(); }
  assert.equal((await genderState(u.id)).gender, 'male');

  // Withdrawn: withdrawn everywhere.
  const c4 = await db.pool.connect();
  try { assert.equal((await preferences.forget(c4, u.id, 'gender_forms')).ok, true); } finally { c4.release(); }
  assert.deepEqual(await genderState(u.id), { gender: null, pref: null });
});

test('set on the page or in a room, the private chat follows — and agreeing words are left as they were', async () => {
  const users = require('../src/domain/users');
  const u = await makeUser(db.pool, '+972611010005');
  const c = await db.pool.connect();
  try {
    assert.equal((await users.setPersonal(c, u.id, { gender: 'female' })).ok, true);
    assert.deepEqual(await genderState(u.id), { gender: 'female', pref: 'לשון נקבה' });
    assert.equal((await turnStart(u)).genderForms, 'feminine');

    assert.equal((await users.setPersonal(c, u.id, { gender: 'male' })).ok, true);
    assert.deepEqual(await genderState(u.id), { gender: 'male', pref: 'לשון זכר' }, 'a contradicting word is replaced');
    assert.equal((await turnStart(u)).genderForms, undefined);

    await preferences.remember(c, u.id, 'gender_forms', 'זכר, תמיד');
    assert.equal((await users.setPersonal(c, u.id, { gender: 'male' })).ok, true);
    assert.equal((await genderState(u.id)).pref, 'זכר, תמיד', 'words that already agree are theirs and stay');

    // A birthday alone never touches it.
    assert.equal((await users.setPersonal(c, u.id, { birthDate: '1990-01-01' })).ok, true);
    assert.equal((await genderState(u.id)).pref, 'זכר, תמיד');

    assert.equal((await users.setPersonal(c, u.id, { gender: null })).ok, true);
    assert.deepEqual(await genderState(u.id), { gender: null, pref: null });
  } finally { c.release(); }
});
