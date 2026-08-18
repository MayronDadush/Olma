'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { detectLanguage, resolveLocale } = require('../src/domain/language');
const users = require('../src/domain/users');

test('language detection: script decides, and a loanword does not flip it', () => {
  // The whole point of detecting by script rather than vocabulary
  assert.equal(detectLanguage('היי מה נשמע', '+972526269826'), 'he');
  assert.equal(detectLanguage('יש לי meeting מחר', '+972526269826'), 'he',
    'an English word inside a Hebrew sentence is still Hebrew');
  assert.equal(detectLanguage('привет как дела', '+79161234567'), 'ru');
  assert.equal(detectLanguage('مرحبا كيف حالك', '+9705551234'), 'ar');
});

test('language detection: Latin script is disambiguated by dialling code', () => {
  // Latin alone cannot name a language — a dozen share it.
  assert.equal(detectLanguage('bonjour ca va', '+33612345678'), 'fr');
  assert.equal(detectLanguage('hallo wie gehts', '+4915112345678'), 'de');
  // An Israeli who writes in Latin characters actively chose not to write
  // Hebrew — honouring that IS the rule, and they can ask for Hebrew back.
  assert.equal(detectLanguage('hi there', '+972526269826'), 'en');
  // A Latin-script message from a country whose language we cannot name
  // falls back to the lingua franca rather than inventing one.
  assert.equal(detectLanguage('hello', '+8613800138000'), 'en');
});

test('language detection: no signal at all returns null, never a coin flip', () => {
  assert.equal(detectLanguage('👍', '+972526269826'), null);
  assert.equal(detectLanguage('5', '+33612345678'), null);
  assert.equal(detectLanguage('', '+972526269826'), null);
  assert.equal(detectLanguage(null, '+972526269826'), null);
  assert.equal(detectLanguage('?!', '+972526269826'), null, 'punctuation is not language');
});

test('resolveLocale: real text beats the phone guess, and reports which it used', () => {
  // source matters: an observation needs no confirmation, a guess might
  assert.deepEqual(resolveLocale({ text: 'היי', phone: '+14155551234' }),
    { locale: 'he', source: 'message' });
  assert.deepEqual(resolveLocale({ text: '👍', phone: '+972526269826' }),
    { locale: 'he', source: 'phone_prefix' });
  assert.deepEqual(resolveLocale({ text: '👍', phone: '+99977712345' }),
    { locale: 'en', source: 'default' });
  assert.deepEqual(resolveLocale({}), { locale: 'en', source: 'default' });
});

// ---- explicit override, against a real DB ----------------------------------

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

test('setLocale: only their explicit request changes it, and junk is refused', async () => {
  const u = await makeUser(db.pool, '+972640000001', { firstName: 'Yara' });
  const okRes = await withTx(db.pool, (c) => users.setLocale(c, u.id, 'EN'));
  assert.equal(okRes.ok, true);
  assert.equal(okRes.data.locale, 'en', 'normalised to lower case');

  const { rows } = await db.pool.query(`SELECT locale FROM users WHERE id = $1`, [u.id]);
  assert.equal(rows[0].locale, 'en');

  const audited = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'user.locale_set'`, [u.id]);
  assert.equal(audited.rows[0].detail.locale, 'en', 'a language change is an auditable event');

  for (const bad of ['', 'english', '123', 'h', null, '<script>']) {
    const res = await withTx(db.pool, (c) => users.setLocale(c, u.id, bad));
    assert.equal(res.ok, false, `refused: ${JSON.stringify(bad)}`);
  }
  const after = await db.pool.query(`SELECT locale FROM users WHERE id = $1`, [u.id]);
  assert.equal(after.rows[0].locale, 'en', 'a refused change leaves the old value intact');
});
