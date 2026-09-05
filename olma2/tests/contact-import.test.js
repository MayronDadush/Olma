'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const contacts = require('../src/domain/contacts');

let db;
before(async () => {
  db = await freshDb();
  await makeUser(db.pool, '+972526269826', { firstName: 'מירון' });
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

async function rowsFor(userId) {
  const { rows } = await db.pool.query(
    `SELECT display_name, phone, source FROM user_contacts WHERE user_id = $1 ORDER BY display_name`, [userId]);
  return rows;
}

test('importContacts: counts, primary+extra rows, and skip reasons', async () => {
  const u = await makeUser(db.pool, '+972631100001', { firstName: 'Batch1' });
  const res = await withClient((c) => contacts.importContacts(c, u.id, [
    { name: 'דנה כהן', phones: [{ value: '054-261-3404', type: 'mobile' }, { value: '03-2222222', type: 'work' }] },
    { name: 'No Number Guy', phones: [{ value: 'not-a-number', type: 'other' }] },
    { name: '', phones: [{ value: '054-1111111', type: 'mobile' }] }, // no name
    { name: 'Self', phones: [{ value: u.phone, type: 'mobile' }] }, // owner's own number
  ], 'google'));
  assert.ok(res.ok);
  assert.equal(res.data.imported, 2); // primary + work row for Dana
  assert.equal(res.data.skippedBadNumber, 1);
  assert.equal(res.data.skippedNoName, 1);
  assert.equal(res.data.skippedSelf, 1);
  assert.equal(res.data.totalSeen, 4);

  const rows = await rowsFor(u.id);
  assert.deepEqual(rows.map((r) => r.display_name).sort(), ['דנה כהן', 'דנה כהן — עבודה']);
  for (const r of rows) assert.equal(r.source, 'google');
});

test('resolveContact still resolves the primary uniquely after a multi-number import', async () => {
  const u = await makeUser(db.pool, '+972631100002', { firstName: 'Batch2' });
  await withClient((c) => contacts.importContacts(c, u.id, [
    { name: 'גלי לוי', phones: [
      { value: '054-3333333', type: 'mobile' },
      { value: '03-4444444', type: 'home' },
      { value: '03-5555555', type: 'other' },
    ] },
  ], 'google'));
  const res = await withClient((c) => contacts.resolveContact(c, u.id, 'גלי לוי'));
  assert.ok(res.ok);
  assert.equal(res.data.contact.phone, '+972543333333');
  const rows = await rowsFor(u.id);
  assert.deepEqual(rows.map((r) => r.display_name).sort(), ['גלי לוי', 'גלי לוי — בית', 'גלי לוי — נוסף']);
});

test('a hand-saved contact is never renamed by a bulk import; import-over-import updates freely', async () => {
  const u = await makeUser(db.pool, '+972631100003', { firstName: 'Batch3' });
  await withClient((c) => contacts.saveContact(c, u.id, {
    name: 'שם שהמשתמש בחר', phone: '054-6666666', source: 'user_stated',
  }));

  const first = await withClient((c) => contacts.importContacts(c, u.id, [
    { name: 'שם מגוגל', phones: [{ value: '054-6666666', type: 'mobile' }] },
  ], 'google'));
  assert.equal(first.data.kept, 1);
  assert.equal(first.data.imported, 0);
  assert.equal(first.data.updated, 0);
  let rows = await rowsFor(u.id);
  assert.equal(rows[0].display_name, 'שם שהמשתמש בחר');
  assert.equal(rows[0].source, 'user_stated');

  // A second import-sourced row, then a rename on THAT one, does update.
  await withClient((c) => contacts.importContacts(c, u.id, [
    { name: 'עודד', phones: [{ value: '054-7777777', type: 'mobile' }] },
  ], 'google'));
  const renamed = await withClient((c) => contacts.importContacts(c, u.id, [
    { name: 'עודד שי', phones: [{ value: '054-7777777', type: 'mobile' }] },
  ], 'google'));
  assert.equal(renamed.data.updated, 1);
  rows = await rowsFor(u.id);
  assert.ok(rows.some((r) => r.display_name === 'עודד שי'));
});

test('double-running the same import is idempotent — second run is all "updated", none "imported"', async () => {
  const u = await makeUser(db.pool, '+972631100004', { firstName: 'Batch4' });
  const entries = [
    { name: 'איתי', phones: [{ value: '054-8888888', type: 'mobile' }] },
    { name: 'נועה', phones: [{ value: '054-9999999', type: 'mobile' }] },
  ];
  const first = await withClient((c) => contacts.importContacts(c, u.id, entries, 'google'));
  assert.equal(first.data.imported, 2);
  const second = await withClient((c) => contacts.importContacts(c, u.id, entries, 'google'));
  assert.equal(second.data.imported, 0);
  assert.equal(second.data.updated, 2);
});

test('in-batch duplicate phone numbers are deduped before the SQL runs', async () => {
  const u = await makeUser(db.pool, '+972631100005', { firstName: 'Batch5' });
  const res = await withClient((c) => contacts.importContacts(c, u.id, [
    { name: 'ראשון', phones: [{ value: '054-1212121', type: 'mobile' }] },
    { name: 'כפילות', phones: [{ value: '054-1212121', type: 'mobile' }] }, // same number, different name
  ], 'google'));
  assert.ok(res.ok);
  assert.equal(res.data.imported, 1);
  assert.equal(res.data.duplicates, 1);
});

test('a large batch is chunked and still lands every row (>500)', async () => {
  const u = await makeUser(db.pool, '+972631100006', { firstName: 'Batch6' });
  const entries = [];
  for (let i = 0; i < 620; i++) {
    entries.push({ name: `Person ${i}`, phones: [{ value: `+9725500${String(i).padStart(5, '0')}`, type: 'mobile' }] });
  }
  const res = await withClient((c) => contacts.importContacts(c, u.id, entries, 'google'));
  assert.equal(res.data.imported, 620);
  const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM user_contacts WHERE user_id = $1`, [u.id]);
  assert.equal(rows[0].n, 620);
});

test('an unknown import source is rejected', async () => {
  const u = await makeUser(db.pool, '+972631100007', { firstName: 'Batch7' });
  const res = await withClient((c) => contacts.importContacts(c, u.id, [], 'not_a_real_source'));
  assert.equal(res.ok, false);
});

// ---------------------------------------------------------------- namesForPhone

test('namesForPhone: reverse lookup crosses users, is empty when nobody saved the number', async () => {
  const a = await makeUser(db.pool, '+972631100010', { firstName: 'A' });
  const b = await makeUser(db.pool, '+972631100011', { firstName: 'B' });
  await withClient((c) => contacts.saveContact(c, a.id, { name: 'אמא', phone: '054-5000000', source: 'user_stated' }));
  await withClient((c) => contacts.saveContact(c, b.id, { name: 'רותי', phone: '054-5000000', source: 'user_stated' }));

  const hits = await withClient((c) => contacts.namesForPhone(c, '+972545000000'));
  assert.equal(hits.length, 2);
  // node-postgres returns BIGINT id columns as strings; namesForPhone
  // Number()s its own userId, so compare numerically on both sides.
  assert.deepEqual(hits.map((h) => h.userId).sort((x, y) => x - y),
    [Number(a.id), Number(b.id)].sort((x, y) => x - y));

  const none = await withClient((c) => contacts.namesForPhone(c, '+972630000000'));
  assert.deepEqual(none, []);
});
