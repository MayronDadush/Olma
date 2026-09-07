'use strict';
// A link is the one kind of tool result that is worthless unless the model
// copies it out character for character. Nothing else delivers it — no outbox
// row, no template, no follow-up sweep — so a result that hands over a `url`
// and does not say "put this in the reply" is a result that can be described
// instead of sent.
//
// The founding case, 2026-09-07, עידן's first morning:
//
//   he    05:43:19  את יכולה לקרוא מהיומן שלי?
//   tool  05:43:52  { url: "https://accounts.google.com/o/oauth2/…", tellTheUser: … }
//   Olma  05:43:57  שלחתי לך קישור 🫡 תפתח אותו…            ← no link in the message
//   he    05:44:21  איפה שלחת לי את הקישור? אני לא רואה אותו
//
// The result was complete and correct and the person still ended up chasing
// Olma for something she believed she had sent. That is the same class as
// claiming a lookup that never happened (CLAUDE.md, "Olma never claims a
// lookup she did not perform") — she asserted an action nothing performed.
//
// So these tests are about a FIELD, not about wording: every flow that mints
// a URL must carry the instruction, and the last test refuses to let a sixth
// one be added without it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Resolved at require time by google-oauth.js, so it has to be set first.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-link-'));
process.env.OLMA_ENC_KEY_PATH = path.join(TMP, 'enc-key');
process.env.OLMA_GOOGLE_OAUTH_PATH = path.join(TMP, 'google-oauth.json');
fs.writeFileSync(process.env.OLMA_GOOGLE_OAUTH_PATH, JSON.stringify({
  client_id: 'test-client-id',
  client_secret: 'test-client-secret',
  public_base_url: 'https://olmachat.example',
}));

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const actionLink = require('../src/domain/action-link');
const calendar = require('../src/domain/calendar');
const googleConnect = require('../src/domain/google-connect');
const googleContacts = require('../src/domain/google-contacts');
const mail = require('../src/domain/mail');
const dashboardAuth = require('../src/domain/dashboard-auth');
const flags = require('../src/domain/flags');

let db, user;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972611009001', { firstName: 'עידן' });
});
after(async () => { await db.teardown(); });

// What every one of these results owes the person: the url itself, and a
// sentence telling the model the url is the deliverable.
function assertCarriesTheLink(res, what) {
  assert.ok(res.ok, `${what}: ${JSON.stringify(res.error || res)}`);
  const d = res.data;
  assert.match(String(d.url), /^https:\/\//, `${what}: no url to send`);
  assert.equal(d.sendLinkVerbatim, actionLink.INSTRUCTION,
    `${what}: hands over a url with nothing saying it must be in the reply`);
}

test('the calendar link he actually asked for', async () => {
  const res = await withTx(db.pool, (c) => calendar.beginConnection(c, user.id, 'read_only'));
  assertCarriesTheLink(res, 'start_calendar_connection');
});

test('the combined link — the exact call that went out with no link under it', async () => {
  const res = await withTx(db.pool, (c) => googleConnect.beginConnection(c, user, {
    calendarAccess: 'read_only', wantContacts: false, wantMail: false,
  }));
  assertCarriesTheLink(res, 'start_google_connection');
  // The wording about what is being approved stays where the owner can read
  // and reword it; the instruction is a separate field on purpose, so a
  // 300-character Google URL is never spliced into copy nobody can proof-read.
  assert.match(res.data.tellTheUser, /יומן \(צפייה בלבד\)/);
  assert.doesNotMatch(res.data.tellTheUser, /https:/, 'the url does not belong inside the owner-editable sentence');
});

test('the contacts link', async () => {
  const res = await withTx(db.pool, (c) => googleContacts.beginConnection(c, user.id));
  assertCarriesTheLink(res, 'start_contacts_import');
});

test('the mailbox link', async () => {
  await withTx(db.pool, (c) => flags.setFlag(c, 'email_access_phones', 'all'));
  const res = await withTx(db.pool, (c) => mail.beginConnection(c, user, 'gmail'));
  assertCarriesTheLink(res, 'start_email_connection');
});

test('the personal dashboard link', async () => {
  const res = await withTx(db.pool, (c) => dashboardAuth.createLinkUrl(c, user.id));
  assertCarriesTheLink(res, 'dashboard deep link');
});

test('the instruction forbids the sentence that actually got sent', () => {
  // Not a wording preference: "שלחתי לך קישור" is the specific output that
  // left him with nothing, so the instruction names it rather than gesturing
  // at "be clear". A future reword may say it differently and must still say
  // it — hence the two halves below rather than a fixed string match.
  assert.match(actionLink.INSTRUCTION, /שלחתי לך קישור/,
    'the instruction must name the sentence that failed, in the language it failed in');
  assert.match(actionLink.INSTRUCTION, /exactly as it is|every character/i,
    'and must ask for the url verbatim, not for a description of it');
});

test('the search link, the one link that is not a consent link', async () => {
  // Same shape, same failure mode: the model supplies words, the domain builds
  // the URL, and the person gets nothing unless it is pasted. Included here
  // rather than exempted because "it is only a search" describes what the link
  // POINTS at, not whether it arrives.
  const res = await withTx(db.pool, (c) =>
    require('../src/domain/search-link').buildSearchLink(c, user.id, 'שעות פתיחה דואר ישראל'));
  assertCarriesTheLink(res, 'search_link');
});

test('a seventh link cannot be added without the instruction', () => {
  // The durable half. Every previous "remember to also…" rule in this repo
  // decayed the moment someone added the next case; a scan does not.
  //
  // Both result shapes count, and the second one is why: dashboard-auth.js
  // returns `ok({ url, expiresInMinutes })` on ONE line, so a scan looking
  // only for a `url:` at the start of a line would have passed it silently —
  // which it did, on the first draft of this test.
  //
  // availability.js is exempt BY NAME and for one reason: /pick/ is retired
  // (410 since 2026-09-06, code kept deliberately), no tool reaches it, and
  // wiring an instruction into a dead path would be pretending it is alive.
  // If it is ever revived, this list is where that decision surfaces.
  const MINTS_A_LINK = /\n\s*url[,:]|ok\(\{\s*url[,:]/;
  const EXEMPT = new Set(['availability.js']);
  const dir = path.join(__dirname, '..', 'src', 'domain');
  const offenders = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    if (EXEMPT.has(file)) continue;
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    if (!MINTS_A_LINK.test(src)) continue;
    if (!src.includes("require('./action-link')")) offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    'these mint a url for the model and never tell it the url is the deliverable');

  // A guard that cannot fail is not a guard (CLAUDE.md, "The detection layer
  // nobody trusts"). Checked against the tree as it stood before this fix:
  // the same scan named all six, so an empty list above means they were
  // fixed, not that the scan stopped looking.
  const beforeTheFix = 'const { ok, err } = require(\'./results\');\n'
    + 'return ok({\n  url: consentUrl(state),\n  tellTheUser: "…",\n});';
  assert.ok(MINTS_A_LINK.test(beforeTheFix)
    && !beforeTheFix.includes("require('./action-link')"),
  'the scan no longer recognises the shape it was written to catch');
});
