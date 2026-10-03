'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const repair = require('../src/domain/repair');
const sessions = require('../src/channels/sessions');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

test('a number is matched however the operator happens to have it written', async () => {
  const u = await makeUser(db.pool, '+972505404255', { firstName: 'חיים' });
  await withTx(db.pool, async (c) => {
    for (const form of ['0505404255', '050-540-4255', '+972505404255', '972505404255']) {
      const found = await repair.findUserByPhoneFragment(c, form);
      assert.equal(found.ok, true, form);
      assert.equal(Number(found.data.user.id), Number(u.id), form);
    }
    assert.equal((await repair.findUserByPhoneFragment(c, '0509999999')).error.code, 'not_found');
    assert.equal((await repair.findUserByPhoneFragment(c, '4255')).error.code, 'invalid',
      'too short to aim at one person');
  });
});

test('an ambiguous fragment refuses rather than picking someone', async () => {
  await makeUser(db.pool, '+972521114455', { firstName: 'A' });
  await makeUser(db.pool, '+441114455', { firstName: 'B' });
  await withTx(db.pool, async (c) => {
    const res = await repair.findUserByPhoneFragment(c, '1114455');
    assert.equal(res.ok, false);
    assert.equal(res.error.candidates.length, 2, 'the operator is shown both, not guessed at');
  });
});

// ---- the display name the gateway hands us ----------------------------------

test('the display name is read out of the gateway\'s own conversation info', () => {
  const info = (sender, senderId) =>
    'Conversation info (untrusted metadata):\n```json\n'
    + JSON.stringify({ chat_id: senderId, sender_id: senderId, sender }, null, 2)
    + '\n```\n\nwhat they actually wrote';

  assert.equal(sessions.displayNameFromPrompt(info('חיים דדוש', '+972505404255')), 'חיים דדוש');
  assert.equal(sessions.displayNameFromPrompt(info('חיים דדוש', '+972505404255'), '+972505404255'),
    'חיים דדוש');
  assert.equal(sessions.displayNameFromPrompt(info('חיים דדוש', '+972500000000'), '+972505404255'),
    null, 'the intake agent holds every stranger — a name must match whose turn it was');
  assert.equal(sessions.displayNameFromPrompt(info('+972505404255', '+972505404255')), null,
    'with no display name set the gateway echoes the number — that is not a name');
  assert.equal(sessions.displayNameFromPrompt(info('', '+972505404255')), null);
  assert.equal(sessions.displayNameFromPrompt('a turn with no conversation info at all'), null);
});
