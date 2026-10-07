'use strict';
// scripts/grant-pack.js: the owner turning a pack on for named people. A name
// that is not exactly one active person writes nothing at all.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const { main } = require('../scripts/grant-pack');

let db, dir, configPath;
before(async () => {
  db = await freshDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-grant-pack-'));
  configPath = path.join(dir, 'openclaw.json');
});
after(async () => { await db.teardown(); fs.rmSync(dir, { recursive: true, force: true }); });

const packsOf = async id => (await db.pool.query('SELECT pack FROM user_packs WHERE user_id = $1 ORDER BY pack', [id])).rows.map(r => r.pack);

test('dry run by name, then --apply: the row and that agent\'s tools, nobody else\'s', async () => {
  const miron = await makeUser(db.pool, '+972500000801', { firstName: 'מירון' });
  const maya = await makeUser(db.pool, '+972500000802', { firstName: 'Maya' });
  const other = await makeUser(db.pool, '+972500000803', { firstName: 'דן' });
  for (const u of [miron, maya, other]) await db.pool.query('UPDATE users SET agent_id = $2 WHERE id = $1', [u.id, `u-${u.id}`]);
  fs.writeFileSync(configPath, JSON.stringify({ agents: { list: [miron, maya, other].map(u => ({ id: `u-${u.id}`, tools: { deny: ['games__*', 'food__*'] } })) } }));

  const lines = [];
  const dry = await main(['--pack', 'food', 'מירון', 'maya'], { pool: db.pool, configPath, log: l => lines.push(l) });
  assert.deepEqual(dry.found, [Number(miron.id), Number(maya.id)]);
  assert.deepEqual(await packsOf(miron.id), [], 'a dry run writes nothing');
  assert.ok(!lines.join('\n').includes('0000801'), 'a phone is never printed whole');

  const r = await main(['--pack', 'food', '--apply', 'מירון', 'maya'], { pool: db.pool, configPath, log: () => {} });
  assert.equal(r.written, 2);
  assert.deepEqual(await packsOf(miron.id), ['food']);
  assert.deepEqual(await packsOf(maya.id), ['food']);
  assert.deepEqual(await packsOf(other.id), []);
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const deny = id => cfg.agents.list.find(a => a.id === `u-${id}`).tools.deny;
  assert.ok(!deny(miron.id).includes('food__*'));
  assert.ok(deny(miron.id).includes('games__*'));
  assert.ok(deny(other.id).includes('food__*'));

  const again = await main(['--pack', 'food', '--apply', 'מירון'], { pool: db.pool, configPath, log: () => {} });
  assert.equal(again.written, 0, 'a second run changes nothing');
});

test('an ambiguous or unknown name refuses the whole run', async () => {
  const a = await makeUser(db.pool, '+972500000811', { firstName: 'נועה' });
  await makeUser(db.pool, '+972500000812', { firstName: 'נועה' });
  const lines = [];
  const r = await main(['--pack', 'food', '--apply', String(a.id), 'נועה', 'אף-אחד'], { pool: db.pool, configPath, log: l => lines.push(l) });
  assert.equal(r.refused, 2);
  assert.deepEqual(await packsOf(a.id), [], 'not even the one that matched');
  assert.match(lines.join('\n'), /2 people match — use an id/);
  await assert.rejects(main(['--pack', 'poker', 'x'], { pool: db.pool, configPath }), /--pack is one of/);
});
