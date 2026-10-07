'use strict';
// brokerd's `pack_card`: a pack's server (food/, the day card) hands us an
// SVG and gets back a PNG in the person's workspace and their invite link.
// And migration 114: 'food' is a pack the table accepts.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const { createBrokerServer } = require('../src/brokerd/server');
const toolPolicy = require('../src/intake/agent-tool-policy');

let db, broker, ws;
before(async () => {
  db = await freshDb();
  broker = createBrokerServer({ pool: db.pool, placeMark: () => ({ attempted: false }), now: () => Date.now() });
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-pack-card-'));
});
after(async () => { await db.teardown(); fs.rmSync(ws, { recursive: true, force: true }); });

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="#F0EDE5"/>'
  + '<text x="180" y="60" font-family="IBM Plex Sans Hebrew" font-size="30" text-anchor="end">‏שקשוקה</text></svg>';
const card = params => broker.dispatch({ id: 1, method: 'pack_card', params: { caller: 'food', svg: SVG, ...params } });

let seq = 0;
async function person({ pack = 'food', workspace = true } = {}) {
  seq += 1;
  const u = await makeUser(db.pool, `+9726432${String(seq).padStart(4, '0')}`, { firstName: 'נועה' });
  const dir = path.join(ws, `u-${seq}`);
  if (workspace) fs.mkdirSync(dir, { recursive: true });
  await db.pool.query('UPDATE users SET agent_id = $2, workspace_path = $3 WHERE id = $1', [u.id, `u-${seq}`, dir]);
  if (pack) await db.pool.query('INSERT INTO user_packs (user_id, pack, via) VALUES ($1, $2, \'owner\')', [u.id, pack]);
  return u;
}

test('migration 114: food is a pack, and the policy hides food__* from everyone without it', async () => {
  const u = await person();
  assert.deepEqual((await toolPolicy.packsByAgent(db.pool)).get(`u-${seq}`), ['food']);
  assert.ok(toolPolicy.agentToolPolicy('u-99', {}, { packs: [] }).deny.includes('food__*'));
  assert.ok(!toolPolicy.agentToolPolicy('u-99', {}, { packs: ['food'] }).deny.includes('food__*'));
  assert.ok(toolPolicy.agentToolPolicy('g-1', {}, { packs: ['food'] }).deny.includes('food__*'), 'a room never holds a pack');
  await assert.rejects(db.pool.query(`INSERT INTO user_packs (user_id, pack, via) VALUES ($1, 'poker', 'owner')`, [u.id]));
});

test('a holder gets a PNG in their own workspace and their invite link', async () => {
  const u = await person();
  const out = await card({ userId: Number(u.id) });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(out.path.startsWith(path.join(ws, `u-${seq}`, 'cards')));
  const png = fs.readFileSync(out.path);
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47], 'a PNG');
  assert.match(String(out.invite_link), /\/i\/[A-Za-z0-9]+$/);
  const { rows } = await db.pool.query(`SELECT detail FROM audit_log WHERE event = 'pack.card' AND actor_id = $1`, [u.id]);
  assert.equal(rows.length, 1);
});

// pack_media: the plate photo they just sent, for food/ to look at. Only from
// the gateway's inbound directory, only recent, only an image by its bytes.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
test('pack_media: a holder gets a recent picture from the inbound directory, and nothing else', async () => {
  const inbound = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-inbound-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-outside-'));
  const before = process.env.OLMA_INBOUND_MEDIA_DIR;
  process.env.OLMA_INBOUND_MEDIA_DIR = inbound;
  try {
    const media = params => broker.dispatch({ id: 1, method: 'pack_media', params: { caller: 'food', ...params } });
    const u = await person();
    const photo = path.join(inbound, 'a1b2.jpg');
    fs.writeFileSync(photo, JPEG);
    const got = await media({ userId: Number(u.id), path: photo });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.mime, 'image/jpeg');
    assert.deepEqual(Buffer.from(got.base64, 'base64'), JPEG);
    assert.ok(fs.existsSync(photo), 'not consumed: a correction may look again');
    const { rows } = await db.pool.query(`SELECT detail FROM audit_log WHERE event = 'pack.media' AND actor_id = $1`, [u.id]);
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows[0].detail).includes('a1b2'), 'the path is not audited');

    const away = path.join(outside, 'x.jpg'); fs.writeFileSync(away, JPEG);
    assert.equal((await media({ userId: Number(u.id), path: away })).code, 'forbidden');
    const link = path.join(inbound, 'link.jpg'); fs.symlinkSync(away, link);
    assert.equal((await media({ userId: Number(u.id), path: link })).code, 'forbidden', 'a symlink out is judged by where it leads');
    assert.equal((await media({ userId: Number(u.id), path: path.join(inbound, '..', path.basename(outside), 'x.jpg') })).code, 'forbidden');
    const text = path.join(inbound, 'note.jpg'); fs.writeFileSync(text, 'BEGIN:VCARD');
    assert.equal((await media({ userId: Number(u.id), path: text })).code, 'invalid');
    const old = path.join(inbound, 'old.jpg'); fs.writeFileSync(old, JPEG);
    const t = new Date(Date.now() - 3 * 3600 * 1000); fs.utimesSync(old, t, t);
    assert.equal((await media({ userId: Number(u.id), path: old })).code, 'too_old');
    assert.equal((await media({ userId: Number(u.id), path: path.join(inbound, 'none.jpg') })).code, 'not_found');

    const games = await person({ pack: 'games' });
    assert.match((await media({ userId: Number(games.id), path: photo })).error, /not a food user/);
    assert.equal((await media({ userId: Number(u.id), path: photo, caller: 'nope' })).error, 'unknown pack');
  } finally {
    if (before === undefined) delete process.env.OLMA_INBOUND_MEDIA_DIR; else process.env.OLMA_INBOUND_MEDIA_DIR = before;
    fs.rmSync(inbound, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
  }
});

// The path the model is actually SHOWN: the gateway stages the picture into
// the person's own workspace. The first real photo (2026-10-07) was refused
// twice on exactly this shape, and the meal was logged from a text description.
test('pack_media: the copy the gateway staged in their OWN workspace is theirs, and nobody else\'s', async () => {
  const inbound = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-inbound-'));
  const before = process.env.OLMA_INBOUND_MEDIA_DIR;
  process.env.OLMA_INBOUND_MEDIA_DIR = inbound;
  try {
    const media = params => broker.dispatch({ id: 1, method: 'pack_media', params: { caller: 'food', ...params } });
    const u = await person();
    const staged = path.join(ws, `u-${seq}`, 'media', 'inbound', 'openclaw-staged-8b44410d-6e57-4eba-98ba-083da423e419');
    fs.mkdirSync(staged, { recursive: true });
    const photo = path.join(staged, 'input-c9556d20-0851-498e-906d-91ad31c4d64a.jpg');
    fs.writeFileSync(photo, JPEG);
    const got = await media({ userId: Number(u.id), path: photo });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.deepEqual(Buffer.from(got.base64, 'base64'), JPEG);

    const other = await person();
    assert.equal((await media({ userId: Number(other.id), path: photo })).code, 'forbidden', 'another person\'s workspace is not theirs');
    const notInbound = path.join(ws, `u-${seq - 1}`, 'cards', 'x.jpg');
    fs.mkdirSync(path.dirname(notInbound), { recursive: true }); fs.writeFileSync(notInbound, JPEG);
    assert.equal((await media({ userId: Number(u.id), path: notInbound })).code, 'forbidden', 'only media/inbound, not the whole workspace');
  } finally {
    if (before === undefined) delete process.env.OLMA_INBOUND_MEDIA_DIR; else process.env.OLMA_INBOUND_MEDIA_DIR = before;
    fs.rmSync(inbound, { recursive: true, force: true });
  }
});

test('refused: no pack, another pack\'s caller, a stranger pack, a bad SVG, no workspace', async () => {
  const none = await person({ pack: null });
  assert.match((await card({ userId: Number(none.id) })).error, /not a food user/);
  const games = await person({ pack: 'games' });
  assert.match((await card({ userId: Number(games.id) })).error, /not a food user/);
  assert.equal((await card({ userId: Number(games.id), caller: 'nope' })).error, 'unknown pack');
  const u = await person();
  assert.equal((await card({ userId: Number(u.id), svg: '<html>' })).error, 'bad svg');
  assert.equal((await card({ userId: Number(u.id), svg: '<svg' + 'x'.repeat(300 * 1024) })).error, 'bad svg');
  assert.equal((await card({ userId: 0 })).error, 'bad userId');
  const homeless = await person({ workspace: false });
  assert.equal((await card({ userId: Number(homeless.id) })).ok, false);
});
