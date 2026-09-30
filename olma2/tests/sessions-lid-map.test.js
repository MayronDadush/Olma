'use strict';
// `lidPhoneNumbers` reads the gateway's own reverse-mapping files, which are the
// only way back from a LID to a phone number. The live shape was read off the
// box on 2026-09-22: `credentials/whatsapp/<account>/lid-mapping-<digits>_reverse.json`
// holding a bare JSON string of digits — Gal's was
// `lid-mapping-69320805752936_reverse.json` → `"972509412015"`, written at the
// exact second of his first message (`incidents.md`, "The room that could never
// open").
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sessions = require('../src/channels/sessions');

let HOME_DIR, PREV_HOME;

function creds(account, file, body) {
  const dir = path.join(HOME_DIR, 'credentials', 'whatsapp', account);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
}

before(() => {
  PREV_HOME = process.env.OLMA_OPENCLAW_HOME;
  HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-lid-map-'));
  process.env.OLMA_OPENCLAW_HOME = HOME_DIR;
});
after(() => {
  if (PREV_HOME === undefined) delete process.env.OLMA_OPENCLAW_HOME;
  else process.env.OLMA_OPENCLAW_HOME = PREV_HOME;
  fs.rmSync(HOME_DIR, { recursive: true, force: true });
});

test('a credentials directory with nothing in it is an empty map, never a throw', () => {
  assert.deepEqual(sessions.lidPhoneNumbers(), {});
});

test('the live file shape resolves, in E.164, across accounts', () => {
  creds('default', 'lid-mapping-69320805752936_reverse.json', '"972509412015"');
  creds('second', 'lid-mapping-259201444126724_reverse.json', '"972500000001"');
  // Everything else in that directory is somebody else's business and is not a
  // mapping: the forward file, a session, and the account's own credentials.
  creds('default', 'lid-mapping-69320805752936.json', '"69320805752936@lid"');
  creds('default', 'session-69320805752936_1.0.json', '{"whatever":1}');
  creds('default', 'creds.json', '{"me":{"id":"972559347282:1@s.whatsapp.net"}}');

  assert.deepEqual(sessions.lidPhoneNumbers(), {
    69320805752936: '+972509412015',
    259201444126724: '+972500000001',
  });
});

test('a half-written or implausible mapping is simply not a mapping', () => {
  creds('default', 'lid-mapping-111111111111_reverse.json', '{"phone":');   // truncated
  creds('default', 'lid-mapping-222222222222_reverse.json', '"12345"');      // too short to be a phone
  creds('default', 'lid-mapping-333333333333_reverse.json', '"97250abc123"'); // not digits
  const map = sessions.lidPhoneNumbers();
  for (const lid of ['111111111111', '222222222222', '333333333333']) {
    assert.equal(Object.hasOwn(map, lid), false, `${lid} must not resolve`);
  }
  // and the good ones from the test above are still there
  assert.equal(map['69320805752936'], '+972509412015');
});

// The map is read from disk again only when a directory changed (2,678 files,
// 83-95ms on the box, every ten seconds). A NEW mapping must still show up on
// the very next call — that is the whole of what the cache may never cost.
test('a new mapping is seen on the next call; an unchanged directory is not re-read', () => {
  const first = sessions.lidPhoneNumbers();
  creds('default', 'lid-mapping-444444444444_reverse.json', '"972500000044"');
  assert.equal(sessions.lidPhoneNumbers()['444444444444'], '+972500000044');

  // A file rewritten IN PLACE moves nothing the signature reads, so it waits
  // out the cache's age — never longer.
  const dir = path.join(HOME_DIR, 'credentials', 'whatsapp', 'default');
  const now = Date.now();
  sessions.lidPhoneNumbers({ now });
  // (No utimes to "restore" the directory: an in-place write never moved it,
  // and a Date round-trip would truncate its sub-millisecond mtime.)
  fs.writeFileSync(path.join(dir, 'lid-mapping-444444444444_reverse.json'), '"972500000045"');
  assert.equal(sessions.lidPhoneNumbers({ now })['444444444444'], '+972500000044', 'served from the cache');
  assert.equal(sessions.lidPhoneNumbers({ now: now + 5 * 60 * 1000 })['444444444444'], '+972500000045',
    'the cache outlived its age');

  // A caller mutating what it was handed cannot poison the next caller.
  const handed = sessions.lidPhoneNumbers({ now: now + 5 * 60 * 1000 });
  handed['444444444444'] = 'poison';
  assert.equal(sessions.lidPhoneNumbers({ now: now + 5 * 60 * 1000 })['444444444444'], '+972500000045');
  assert.ok(Object.keys(first).length > 0);
});

test('a lock FILE beside the accounts does not stop the cache from working', () => {
  fs.writeFileSync(path.join(HOME_DIR, 'credentials', 'whatsapp', 'default.lock'), '');
  creds('default', 'lid-mapping-555555555555_reverse.json', '"972500000055"');
  assert.equal(sessions.lidPhoneNumbers()['555555555555'], '+972500000055');
});
