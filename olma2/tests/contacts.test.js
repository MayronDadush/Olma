'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const contacts = require('../src/domain/contacts');
const connections = require('../src/domain/connections');

let db, user, other;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972526269826', { firstName: 'מירון' });
  other = await makeUser(db.pool, '+972544686188', { firstName: 'יובל' });
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

// ---------------------------------------------------------------- normalising

test('a number is read in whatever shape it arrives, against the owner country', () => {
  const owner = '+972526269826';
  // exactly the shape a shared WhatsApp contact card carries
  assert.equal(contacts.normalisePhone('+972 54-261-3404', owner), '+972542613404');
  assert.equal(contacts.normalisePhone('054-261-3404', owner), '+972542613404');
  assert.equal(contacts.normalisePhone('0542613404', owner), '+972542613404');
  assert.equal(contacts.normalisePhone('00972542613404', owner), '+972542613404');
  assert.equal(contacts.normalisePhone('+1 (415) 555-0132', owner), '+14155550132');
  // RTL/bidi marks ride along with any number copied out of a Hebrew keyboard
  assert.equal(contacts.normalisePhone('‏+972-54-261-3404‎', owner), '+972542613404');
});

test('an ambiguous fragment is refused rather than guessed into a stranger', () => {
  const owner = '+972526269826';
  // "542613404" is an Israeli mobile missing its zero — and also a perfectly
  // valid Argentinian number (+54). Guessing here dials a real person.
  assert.equal(contacts.normalisePhone('542613404', owner), null);
  assert.equal(contacts.normalisePhone('14155550132', owner), null);
  assert.equal(contacts.normalisePhone('1234', owner), null);
  assert.equal(contacts.normalisePhone('שלום', owner), null);
  assert.equal(contacts.normalisePhone('', owner), null);
  // a national number means nothing without a country to read it against
  assert.equal(contacts.normalisePhone('054-261-3404', null), null);
  // spelled out in full, the owner's own country code is trustworthy
  assert.equal(contacts.normalisePhone('972542613404', owner), '+972542613404');
});

// ---------------------------------------------------------------- address book

test('saving a card, then re-sharing it, corrects the name instead of duplicating', async () => {
  await withClient(async (c) => {
    const first = await contacts.saveContact(c, user.id, {
      name: 'עמית מור', phone: '+972 54-261-3404', source: 'contact_card',
    });
    assert.equal(first.ok, true);
    assert.equal(first.data.created, true);
    assert.equal(first.data.contact.phone, '+972542613404');

    // the same person, typed by hand this time, with a fuller name
    const again = await contacts.saveContact(c, user.id, {
      name: 'עמית מור (עבודה)', phone: '054-261-3404', source: 'user_stated',
    });
    assert.equal(again.data.created, false, 'same person, same row');
    assert.equal(again.data.contact.id, first.data.contact.id);
    assert.equal(again.data.contact.name, 'עמית מור (עבודה)');

    const all = await contacts.listContacts(c, user.id);
    assert.equal(all.data.contacts.length, 1);
  });
});

test('a contact needs a readable name and a readable number', async () => {
  await withClient(async (c) => {
    assert.equal((await contacts.saveContact(c, user.id, { name: '  ', phone: '0501112222' })).ok, false);
    const bad = await contacts.saveContact(c, user.id, { name: 'מישהו', phone: 'תשאל אותו' });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.reason, 'bad_phone');
  });
});

test('the book is private to its owner', async () => {
  await withClient(async (c) => {
    await contacts.saveContact(c, other.id, { name: 'סוד', phone: '+972501234567' });
    const mine = await contacts.listContacts(c, user.id, { query: 'סוד' });
    assert.equal(mine.data.contacts.length, 0);
  });
});

test('lookup finds by name fragment and by digits', async () => {
  await withClient(async (c) => {
    const found = await contacts.listContacts(c, user.id, { query: 'עמית' });
    assert.equal(found.data.contacts.length, 1);
    const byDigits = await contacts.listContacts(c, user.id, { query: '3404' });
    assert.equal(byDigits.data.contacts.length, 1);
  });
});

test('an ambiguous name resolves to nobody, and names the candidates', async () => {
  await withClient(async (c) => {
    await contacts.saveContact(c, user.id, { name: 'דנה', phone: '+972501110001' });
    await contacts.saveContact(c, user.id, { name: 'דנה כהן', phone: '+972501110002' });

    const one = await contacts.resolveContact(c, user.id, 'עמית');
    assert.equal(one.ok, true);

    // an exact name beats its own substring matches — that is an answer
    const exact = await contacts.resolveContact(c, user.id, 'דנה');
    assert.equal(exact.ok, true);
    assert.equal(exact.data.contact.phone, '+972501110001');

    const both = await contacts.resolveContact(c, user.id, 'דנה כ');
    assert.equal(both.ok, true);

    const none = await contacts.resolveContact(c, user.id, 'מי שלא קיים');
    assert.equal(none.ok, false);
    assert.equal(none.error.reason, 'no_match');
  });
});

test('a genuinely ambiguous query refuses to pick a winner', async () => {
  await withClient(async (c) => {
    await contacts.saveContact(c, user.id, { name: 'רון א', phone: '+972502220001' });
    await contacts.saveContact(c, user.id, { name: 'רון ב', phone: '+972502220002' });
    const res = await contacts.resolveContact(c, user.id, 'רון');
    assert.equal(res.ok, false);
    assert.equal(res.error.reason, 'ambiguous');
    assert.equal(res.error.candidates.length, 2);
  });
});

test('forgetting removes the row, and only the owner may', async () => {
  await withClient(async (c) => {
    const saved = await contacts.saveContact(c, user.id, { name: 'זמני', phone: '+972509998877' });
    const notYours = await contacts.forgetContact(c, other.id, saved.data.contact.id);
    assert.equal(notYours.ok, false);
    assert.equal((await contacts.forgetContact(c, user.id, saved.data.contact.id)).ok, true);
    assert.equal((await contacts.listContacts(c, user.id, { query: 'זמני' })).data.contacts.length, 0);
  });
});

test('the audit trail records the save without recording the number', async () => {
  await withClient(async (c) => {
    await contacts.saveContact(c, user.id, { name: 'רשומה', phone: '+972507776655' });
    const { rows } = await c.query(
      `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'contact.saved' AND detail->>'name' = 'רשומה'`,
      [user.id]
    );
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows[0].detail).includes('7776655'),
      "a third party's number does not belong in a trail an operator browses");
  });
});

// ------------------------------------------------------- what it is all for

test('a saved contact becomes a connection request with no number typed', async () => {
  await withClient(async (c) => {
    // יובל is already a real user; the card is how מירון names him
    await contacts.saveContact(c, user.id, {
      name: 'יובל גליצרין', phone: '+972 54-468-6188', source: 'contact_card',
    });
    const hit = await contacts.resolveContact(c, user.id, 'יובל');
    assert.equal(hit.data.contact.phone, other.phone,
      'the card resolves to the exact E.164 the user row holds');

    const res = await connections.requestConnection(c, user.id, hit.data.contact.phone, {
      reason: 'לתאם קפה',
    });
    assert.equal(res.ok, true);
    assert.equal(res.data.targetKnown, true);
  });
});
