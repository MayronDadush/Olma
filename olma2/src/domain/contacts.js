'use strict';
// The address book — see migration 009 for why it exists.
//
// The short version: a WhatsApp contact card reaches the model on the turn it
// arrives and NOWHERE else. Session history keeps only `<contact>`, payload
// stripped. So the name and number have to become a row during that one turn,
// or they are gone. Every function here exists to make that cheap and to make
// the number never have to be asked for twice.
const { ok, err } = require('./results');
const audit = require('./audit');
const { PREFIXES } = require('./phone-timezone');

const MAX_NAME_CHARS = 80;
const MAX_NOTE_CHARS = 200;
const KNOWN_SOURCES = ['contact_card', 'user_stated'];
// Longest dialling code first, so 972 wins over 97 and 351 over 35 — the same
// ordering rule phone-timezone depends on, for the same reason.
const SORTED_CODES = [...PREFIXES].map((p) => p.code).sort((a, b) => b.length - a.length);

function countryCodeOf(e164) {
  const digits = String(e164 || '').replace(/\D/g, '');
  return SORTED_CODES.find((c) => digits.startsWith(c)) || null;
}

// Turn whatever a person or a contact card handed us into E.164, resolving
// national numbers against the OWNER's country.
//
// This is the piece that was missing: requestConnection demands a strict
// /^\+\d{7,15}$/, and a shared card arrives as "+972 54-261-3404" — spaces and
// dashes included — while people type "054-261-3404". Both are the same human.
// Without normalisation here, the agent is left to reformat phone numbers by
// hand in its head, which is exactly the kind of silent arithmetic a model
// should never be trusted with when the cost of a slip is messaging a stranger.
function normalisePhone(raw, ownerPhone) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  // Hebrew and Arabic keyboards inject bidi marks around numbers; they survive
  // copy-paste into a message and would otherwise poison every digit test.
  s = s.replace(/[‎‏‪-‮⁦-⁩]/g, '');
  const plus = s.startsWith('+') || s.startsWith('00');
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;

  if (plus) {
    const d = s.startsWith('00') ? digits.replace(/^00/, '') : digits;
    return /^\d{7,15}$/.test(d) ? `+${d}` : null;
  }
  const owner = countryCodeOf(ownerPhone);
  // A national number ("054...", "0044...") only means something relative to a
  // country. We have exactly one honest source for that: the owner's own
  // number. No owner country, no guess.
  if (digits.startsWith('0')) {
    if (!owner) return null;
    const local = digits.replace(/^0+/, '');
    if (!local) return null;
    return /^\d{7,15}$/.test(owner + local) ? `+${owner}${local}` : null;
  }
  // Bare digits with no leading zero and no plus. Tempting to match them
  // against the dialling-code table — but almost every digit string starts with
  // SOME country code, and an Israeli mobile typed without its zero
  // ("542613404") reads as a perfectly valid Argentinian number. The only safe
  // reading is the owner's own country, spelled out in full.
  if (owner && digits.startsWith(owner) && /^\d{7,15}$/.test(digits)) return `+${digits}`;
  return null;
}

function cleanName(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS);
}

async function saveContact(client, userId, { name, phone, source, note } = {}) {
  const displayName = cleanName(name);
  if (!displayName) return err('invalid', 'a contact needs a name');
  const usersDomain = require('./users');
  const owner = await usersDomain.getById(client, userId);
  const e164 = normalisePhone(phone, owner && owner.phone);
  if (!e164) {
    return err('invalid', 'could not read that as a phone number', { reason: 'bad_phone' });
  }
  const src = KNOWN_SOURCES.includes(source) ? source : 'contact_card';
  const cleanNote = note ? String(note).replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS) : null;

  const { rows } = await client.query(
    `INSERT INTO user_contacts (user_id, display_name, phone, source, note)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, phone) DO UPDATE SET
       display_name = excluded.display_name,
       source = excluded.source,
       note = COALESCE(excluded.note, user_contacts.note),
       updated_at = now()
     RETURNING *, (xmax = 0) AS inserted`,
    [userId, displayName, e164, src, cleanNote]
  );
  const row = rows[0];
  // The phone itself is deliberately NOT in the audit detail. The trail records
  // that a contact was saved, not a third party's number in a table an operator
  // reads casually — the number lives in exactly one place, behind the owner.
  await audit.record(client, userId, row.inserted ? 'contact.saved' : 'contact.updated', {
    contactId: Number(row.id), name: displayName, source: src,
  });
  return ok({ contact: shape(row), created: row.inserted, isSelf: owner && owner.phone === e164 });
}

function shape(row) {
  return {
    id: Number(row.id),
    name: row.display_name,
    phone: row.phone,
    source: row.source,
    note: row.note || null,
  };
}

// Free-text lookup over the owner's own address book. Substring, case
// insensitive, on the name — and on the phone too, so "3404" finds someone the
// user half-remembers. Deliberately dumb: an address book of a few dozen rows
// does not need ranking, and a wrong "smart" match here messages the wrong
// person.
async function listContacts(client, userId, { query } = {}) {
  const q = query ? `%${String(query).trim()}%` : null;
  const { rows } = await client.query(
    `SELECT * FROM user_contacts
     WHERE user_id = $1
       AND ($2::text IS NULL OR display_name ILIKE $2 OR phone ILIKE $2)
     ORDER BY display_name`,
    [userId, q]
  );
  return ok({ contacts: rows.map(shape) });
}

// Resolve a name to ONE contact, or say why not. The callers that matter
// (connection requests, meeting invitations) are about to message a real human,
// so an ambiguous answer must never silently pick a winner.
async function resolveContact(client, userId, name) {
  const res = await listContacts(client, userId, { query: name });
  const hits = res.data.contacts;
  if (hits.length === 1) return ok({ contact: hits[0] });
  if (hits.length === 0) return err('not_found', 'no saved contact by that name', { reason: 'no_match' });
  // An exact name match beats its own substring matches ("דנה" among "דנה" and
  // "דנה כהן") — that is a real answer, not a coin flip.
  const needle = String(name).trim().toLowerCase();
  const exact = hits.filter((c) => c.name.trim().toLowerCase() === needle);
  if (exact.length === 1) return ok({ contact: exact[0] });
  return err('conflict', 'more than one contact matches that name', {
    reason: 'ambiguous', candidates: hits.map((c) => ({ id: c.id, name: c.name })),
  });
}

async function forgetContact(client, userId, contactId) {
  const { rows } = await client.query(
    `DELETE FROM user_contacts WHERE id = $1 AND user_id = $2 RETURNING display_name`,
    [contactId, userId]
  );
  if (!rows[0]) return err('not_found', 'no such contact');
  await audit.record(client, userId, 'contact.forgotten', {
    contactId: Number(contactId), name: rows[0].display_name,
  });
  return ok({ forgotten: true });
}

async function countContacts(client, userId) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM user_contacts WHERE user_id = $1`, [userId]
  );
  return rows[0].n;
}

module.exports = {
  saveContact, listContacts, resolveContact, forgetContact, countContacts,
  normalisePhone, KNOWN_SOURCES,
};
