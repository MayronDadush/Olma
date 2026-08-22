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
// 'google' / 'vcard' are bulk import — see importContacts. Both are still
// second-class to a person's own word: importContacts never overwrites a row
// whose source is 'contact_card' or 'user_stated'.
const KNOWN_SOURCES = ['contact_card', 'user_stated', 'google', 'vcard'];
const IMPORT_SOURCES = ['google', 'vcard'];
// The single-contact tool only ever writes a person's own word — never let it
// claim an import source, or a hand-saved row becomes indistinguishable from
// a synced one and a later import silently overwrites it (importContacts'
// upsert guard only protects contact_card/user_stated rows).
const SAVE_SOURCES = ['contact_card', 'user_stated'];
const TYPE_LABEL = { work: 'עבודה', home: 'בית', other: 'נוסף' };
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
  const src = SAVE_SOURCES.includes(source) ? source : 'contact_card';
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

// Batch size for importContacts' upsert. A single INSERT statement cannot
// affect the same row twice, so within-batch phone dedupe (below) is
// mandatory regardless of size — this cap is purely about statement size on
// an address book that can run to several thousand rows.
const IMPORT_CHUNK = 500;

// Bulk-load a Google Contacts page or a parsed vCard file. entries is
// [{name, phones: [{value, type}]}] — value is whatever the source handed
// us (Google's canonicalForm, or raw vCard TEL text), unnormalised.
//
// Multi-number people become multiple ROWS, not a note: a number sitting in
// free text is unreachable — nothing parses notes, and resolveContact/
// request_connection can only ever dial a number that is itself a row. One
// primary row per person (the first mobile-typed number, else the first
// number at all) keeps the display name clean; every other number gets its
// own row with a type-suffixed name ("דנה כהן — עבודה"). Because
// resolveContact already prefers an EXACT name match over a substring match,
// this needs no change there — "דנה כהן" only ever exact-matches the primary
// row.
//
// A row a person wrote themselves (source contact_card / user_stated) is
// never overwritten by an import — see the upsert's WHERE guard — so a
// bulk sync can never quietly rename someone the user corrected by hand.
// Re-running this (re-sync, or a retried tool call after a shim timeout) is
// safe: same input produces the same rows, just counted as `updated`
// instead of `imported`.
async function importContacts(client, userId, entries, source) {
  if (!IMPORT_SOURCES.includes(source)) {
    return err('invalid', 'import source must be "google" or "vcard"');
  }
  const usersDomain = require('./users');
  const owner = await usersDomain.getById(client, userId);
  const ownerPhone = owner && owner.phone;
  const list = Array.isArray(entries) ? entries : [];

  const rowsToWrite = []; // { name, phone } — already normalised, deduped
  const seenPhones = new Set(); // in-batch dedupe: one INSERT can't touch a row twice
  const skippedNames = []; // names only, per the no-third-party-numbers audit rule
  let skippedBadNumber = 0, skippedNoName = 0, skippedSelf = 0, duplicates = 0;

  const addRow = (name, e164) => {
    if (ownerPhone && e164 === ownerPhone) { skippedSelf++; return; }
    if (seenPhones.has(e164)) { duplicates++; return; }
    seenPhones.add(e164);
    rowsToWrite.push({ name, phone: e164 });
  };

  for (const entry of list) {
    const displayName = cleanName(entry && entry.name);
    if (!displayName) { skippedNoName++; continue; }

    const normalized = [];
    for (const p of (entry && Array.isArray(entry.phones)) ? entry.phones : []) {
      const e164 = normalisePhone(p && p.value, ownerPhone);
      if (e164) normalized.push({ e164, type: (p && p.type) || 'other' });
    }
    if (!normalized.length) {
      skippedBadNumber++;
      if (skippedNames.length < 5) skippedNames.push(displayName);
      continue;
    }

    const primaryIdx = normalized.findIndex((p) => p.type === 'mobile');
    const chosen = primaryIdx >= 0 ? primaryIdx : 0;
    addRow(displayName, normalized[chosen].e164);

    const typeCounts = {};
    normalized.forEach((p, i) => {
      if (i === chosen) return;
      const base = TYPE_LABEL[p.type] || TYPE_LABEL.other;
      typeCounts[base] = (typeCounts[base] || 0) + 1;
      const label = typeCounts[base] > 1 ? `${base} ${typeCounts[base]}` : base;
      addRow(`${displayName} — ${label}`, p.e164);
    });
  }

  let imported = 0, updated = 0, kept = 0;
  for (let i = 0; i < rowsToWrite.length; i += IMPORT_CHUNK) {
    const chunk = rowsToWrite.slice(i, i + IMPORT_CHUNK);
    // A conflicting row whose source is 'user_stated'/'contact_card' fails the
    // WHERE guard, so DO UPDATE performs no write for it and RETURNING emits
    // no row — the gap between chunk.length and rows.length IS the kept count,
    // nothing extra to query for it.
    const { rows } = await client.query(
      `INSERT INTO user_contacts (user_id, display_name, phone, source)
       SELECT $1, t.n, t.p, $4
       FROM unnest($2::text[], $3::text[]) AS t(n, p)
       ON CONFLICT (user_id, phone) DO UPDATE SET
         display_name = excluded.display_name,
         source = excluded.source,
         updated_at = now()
         WHERE user_contacts.source NOT IN ('user_stated', 'contact_card')
       RETURNING (xmax = 0) AS inserted`,
      [userId, chunk.map((r) => r.name), chunk.map((r) => r.phone), source]
    );
    kept += chunk.length - rows.length;
    for (const r of rows) { if (r.inserted) imported++; else updated++; }
  }

  const skipped = skippedBadNumber + skippedNoName + skippedSelf;
  // Counts only, per the standing rule (:95 above) — a third party's number
  // never lands in an audit row an operator reads casually.
  await audit.record(client, userId, 'contacts.imported', {
    source, imported, updated, kept, skipped, duplicates,
  });

  return ok({
    imported, updated, kept, duplicates, skipped,
    skippedBadNumber, skippedNoName, skippedSelf,
    totalSeen: list.length, skippedNames,
  });
}

// Reverse lookup: everyone who has THIS phone number saved, and under what
// name. Internal helper, not an MCP tool — see intake/provision.js, which
// uses it to suggest a brand-new user's own name from what others already
// call them, and the dashboard's per-user page, which shows it to an
// operator. Deliberately never exposed to an agent: telling one user what
// name a DIFFERENT user gave them would leak who has whom in their address
// book, which is exactly the cross-user privacy line contacts.js exists to
// hold.
async function namesForPhone(client, phone) {
  const { rows } = await client.query(
    `SELECT user_id, display_name, source FROM user_contacts WHERE phone = $1 ORDER BY user_id`,
    [phone]
  );
  return rows.map((r) => ({ userId: Number(r.user_id), displayName: r.display_name, source: r.source }));
}

module.exports = {
  saveContact, listContacts, resolveContact, forgetContact, countContacts,
  importContacts, namesForPhone,
  normalisePhone, KNOWN_SOURCES, IMPORT_SOURCES,
};
