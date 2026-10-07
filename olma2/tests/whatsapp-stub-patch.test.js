'use strict';
// 2026-10-07: a CIPHERTEXT stub was admitted under the real message's id, and
// the real message that followed it under the same id was dropped as a
// duplicate. The patch is a text edit to a file we do not own, so the tests
// prove three things: it edits exactly the lines it was written against and
// nothing it does not recognise, the patched loop really gives the stub and the
// resend different keys, and config_guard notices when an update took it out.
// Every file lives in a temp home of this test's own — never the shared
// OLMA_OPENCLAW_HOME, and never the gateway's.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stubPatch = require('../src/intake/whatsapp-stub-patch');
const guard = require('../src/jobs/config-guard');

// The handler as the plugin writes it, cut down to what the patch touches:
// the anchor verbatim, and the line after it that builds the durable key.
const handlerSource = (anchor = stubPatch.ANCHOR) => 'function make(admit) {\n'
  + '\tconst handleMessagesUpsert = async (upsert) => {\n'
  + anchor
  + '\t\t\tadmit(`${msg.key?.remoteJid}\\n${msg.key?.id}`, msg);\n'
  + '\t\t}\n'
  + '\t};\n'
  + '\treturn handleMessagesUpsert;\n'
  + '}\n';

const build = (src) => {
  const keys = [];
  const handler = new Function(`${src}; return make;`)()((key, msg) => keys.push({ key, msg }));
  return { handler, keys };
};

const JID = '972500000000@s.whatsapp.net';
const stub = { key: { remoteJid: JID, id: 'ABC123' }, messageStubType: 2, messageStubParameters: ['Message absent from node'] };
const real = { key: { remoteJid: JID, id: 'ABC123' }, message: { conversation: 'היי' } };

const homes = [];
after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });

function homeWith(files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-stub-patch-'));
  homes.push(home);
  const dist = path.join(home, 'npm', 'projects', 'openclaw-whatsapp-0123456789', 'node_modules', '@openclaw', 'whatsapp', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dist, name), body);
  return { home, dist };
}

test('unpatched, the stub and the real message share one durable key — the fault', async () => {
  const { handler, keys } = build(handlerSource());
  await handler({ type: 'notify', messages: [stub] });
  await handler({ type: 'notify', messages: [real] });
  assert.equal(keys[0].key, keys[1].key);
});

test('patched, the stub gets its own key and the real message keeps the real one', async () => {
  const res = stubPatch.patchSource(handlerSource());
  assert.equal(res.state, 'unpatched');
  const { handler, keys } = build(res.source);
  const warn = console.warn;
  const warned = [];
  console.warn = (m) => warned.push(m);
  try {
    await handler({ type: 'notify', messages: [stub] });
    await handler({ type: 'notify', messages: [real] });
  } finally { console.warn = warn; }
  assert.equal(keys[0].key, `${JID}\nABC123:olma-stub`);
  assert.equal(keys[1].key, `${JID}\nABC123`);
  assert.notEqual(keys[0].key, keys[1].key);
  // The lane is unchanged, so stranger_greet still sees somebody wrote.
  assert.equal(keys[0].msg.key.remoteJid, JID);
  // The real message object is passed through untouched.
  assert.strictEqual(keys[1].msg, real);
  // The stub is logged with its id and Baileys' reason, and none of the person's.
  assert.equal(warned.length, 1);
  assert.match(warned[0], /ABC123 \(Message absent from node\)/);
  assert.doesNotMatch(warned[0], /972500000000/);
});

test('only a stub with no content is re-keyed', async () => {
  const { source } = stubPatch.patchSource(handlerSource());
  const { handler, keys } = build(source);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await handler({ type: 'notify', messages: [
      { key: { remoteJid: JID, id: 'R1' }, messageStubType: 2, message: { conversation: 'x' } }, // carries content
      { key: { remoteJid: JID, id: 'R2' }, messageStubType: 1 },                                // another stub type
      { key: { remoteJid: JID }, messageStubType: 2 },                                          // no id to key on
    ] });
  } finally { console.warn = warn; }
  assert.deepEqual(keys.map((k) => k.key), [`${JID}\nR1`, `${JID}\nR2`, `${JID}\nundefined`]);
});

test('patching is idempotent, and a bundle it was not written against is never touched', () => {
  const once = stubPatch.patchSource(handlerSource()).source;
  assert.deepEqual(stubPatch.patchSource(once), { state: 'patched', source: once });
  // The anchor moved (a rebuilt bundle): refused, no source handed back.
  assert.deepEqual(stubPatch.patchSource(handlerSource('\t\tfor (const m of upsert.messages ?? []) {\n')), { state: 'unknown' });
  // The anchor twice: refused rather than guessing which.
  assert.deepEqual(stubPatch.patchSource(handlerSource() + handlerSource()), { state: 'unknown' });
});

test('findMonitorFiles finds the handler by content, and null means it could not look', () => {
  const { home, dist } = homeWith({
    'monitor-AAA.js': handlerSource(),
    'monitor-BBB.js': '// a monitor chunk without the handler\n',
    'channel-CCC.js': handlerSource(), // the handler, but not a monitor chunk
  });
  assert.deepEqual(stubPatch.findMonitorFiles(home), [path.join(dist, 'monitor-AAA.js')]);
  assert.equal(stubPatch.findMonitorFiles(path.join(home, 'nowhere')), null);
});

test('config_guard: unpatched is a row, patched is quiet, and what it cannot read is said on the heartbeat', () => {
  const { home, dist } = homeWith({ 'monitor-AAA.js': handlerSource() });
  const red = guard.checkWhatsAppStubPatch({ openclawHome: home });
  assert.equal(red.violations.length, 1);
  assert.match(red.violations[0], /not patched.*monitor-AAA\.js.*patch-whatsapp-stub\.js --apply/);
  assert.equal(red.skipped, null);
  // The title is the dedup key: the same condition files the same string.
  assert.deepEqual(guard.checkWhatsAppStubPatch({ openclawHome: home }), red);

  fs.writeFileSync(path.join(dist, 'monitor-AAA.js'), stubPatch.patchSource(handlerSource()).source);
  assert.deepEqual(guard.checkWhatsAppStubPatch({ openclawHome: home }), { violations: [], skipped: null });

  fs.writeFileSync(path.join(dist, 'monitor-AAA.js'), handlerSource('\t\tfor (const m of upsert.messages ?? []) {\n'));
  assert.deepEqual(guard.checkWhatsAppStubPatch({ openclawHome: home }),
    { violations: [], skipped: 'whatsapp plugin bundle not recognised: monitor-AAA.js' });

  assert.deepEqual(guard.checkWhatsAppStubPatch({ openclawHome: path.join(home, 'nowhere') }),
    { violations: [], skipped: 'whatsapp plugin directory unreadable' });
});
