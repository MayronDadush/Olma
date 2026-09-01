'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { freshDb, makeUser } = require('./helpers');
const { deliverableInfraSessions } = require('../src/domain/infra-agent');
const guard = require('../src/jobs/config-guard');
const { withTx } = require('../src/db/pool');

let db, miron, gali;

const key = (agent, channel, peer) => ({
  key: `agent:${agent}:${channel}:direct:${peer}`,
  agentId: agent, channel, chatType: 'direct', peer,
});

before(async () => {
  db = await freshDb();
  miron = await makeUser(db.pool, '+972526269826', { firstName: 'Miron' });
  gali = await makeUser(db.pool, '+972502205854', { firstName: 'Gali' });
  await db.pool.query(`UPDATE users SET agent_id = 'u-3' WHERE id = $1`, [miron.id]);
  await db.pool.query(`UPDATE users SET agent_id = 'u-8' WHERE id = $1`, [gali.id]);
});
after(async () => { await db.teardown(); });

// The live incident: main woke on a cron nobody asked for and its NO_REPLY
// landed in Miron's WhatsApp, because a v1-era session still pointed there.
test('a userless agent holding a session to a real person is reported', async () => {
  const list = () => [key('main', 'whatsapp', '+972526269826'), key('main', 'whatsapp', '+972502205854')];
  const found = await deliverableInfraSessions(db.pool, { list });

  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.userId).sort(), [Number(miron.id), Number(gali.id)].sort());
});

// Talking to peers who are not yet users is intake's entire job, and main's
// cron/ACP sessions address nobody. Both must stay silent here or the guard
// files noise every tick.
test('cron sessions, unknown peers and intake are all left alone', async () => {
  const list = (agentId) => (agentId !== 'main' ? [] : [
    { key: 'agent:main:cron:666e45b5', agentId: 'main', channel: 'cron', chatType: null, peer: null },
    key('main', 'whatsapp', '+972999888777'), // never became a user
  ]);
  assert.deepEqual(await deliverableInfraSessions(db.pool, { list }), []);

  // intake is never even ASKED: speaking to peers who are not yet users is
  // its whole job, so a direct session to a phone is correct for it.
  const asked = [];
  await deliverableInfraSessions(db.pool, { list: (id) => { asked.push(id); return []; } });
  assert.deepEqual(asked, ['main']);
});

// Archiving IS the remediation this whole file exists to prompt, so a guard
// that keeps reporting an archived session is reporting its own fix. Found by
// running the shipped script against the live box the hour after the six real
// sessions were archived: it read `already_archived` six times and reported
// them as violations anyway.
test('a session that was already archived is the fix, not the fault', async () => {
  const live = key('main', 'whatsapp', '+972526269826');
  const archived = { ...key('main', 'whatsapp', '+972502205854'), archivedAt: 1788253235072 };

  const found = await deliverableInfraSessions(db.pool, { list: () => [live, archived] });
  assert.equal(found.length, 1);
  assert.equal(found[0].peer, '+972526269826');

  // and with nothing live left, the violation clears rather than sticking
  assert.deepEqual(await guard.checkInfraAgentSessions(db.pool, { list: () => [archived] }), []);
});

// An unreadable store is "no evidence", never "no sessions" — a rotated or
// locked store must not read as a clean bill of health.
test('an unreadable session store is skipped, not reported as clean', async () => {
  const list = () => { throw new Error('store locked'); };
  assert.deepEqual(await deliverableInfraSessions(db.pool, { list }), []);
});

// The count belongs in the body, never the title: fileViolations dedupes on
// title, so a per-session title would file a brand-new issue every time
// somebody joins — checkStuckOutbox's lesson.
test('the violation is one stable row per agent+channel, whatever the count', async () => {
  const two = () => [key('main', 'whatsapp', '+972526269826'), key('main', 'whatsapp', '+972502205854')];
  const one = () => [key('main', 'whatsapp', '+972526269826')];

  const a = await guard.checkInfraAgentSessions(db.pool, { list: two });
  const b = await guard.checkInfraAgentSessions(db.pool, { list: one });
  assert.equal(a.length, 1);
  assert.deepEqual(a, b, 'the title does not move when the count does');
  assert.match(a[0], /agent main holds whatsapp sessions/);
});

// It is real damage a person sees, but it does not stop a tool call — and
// BREAKS_USERS means exactly that, per #97. Widening it here would put the
// alert list back to meaning two different things.
test('it is a dashboard row, not a phone alert', async () => {
  const [v] = await guard.checkInfraAgentSessions(db.pool, {
    list: () => [key('main', 'whatsapp', '+972526269826')],
  });
  assert.equal(guard.breaksUsers(v), false);

  const filed = await withTx(db.pool, (c) => guard.fileViolations(c, [v]));
  assert.equal(filed, 1, 'still filed where an operator can see it');
});
