'use strict';
// The sweep, end to end, with the gateway replaced by two injected functions:
// what its transcripts say, and what it was asked to send.
//
// The assertions worth reading are the ones about SILENCE. Everything else in
// this feature is a convenience; the promise is that a room where somebody has
// not signed up hears nothing from her, and that a room of strangers never
// hears from her at all.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const helpers = require('./helpers');
const { freshDb, makeUser } = helpers;
const { withTx } = require('../src/db/pool');
const occ = require('../src/intake/openclaw-config');
const groupsDomain = require('../src/domain/groups');
const pg = require('../src/intake/provision-group');
const job = require('../src/jobs/groups');

let db, tmp, configPath;

before(async () => {
  db = await freshDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-group-sweep-'));
  process.env.OLMA_OPENCLAW_HOME = tmp;
  configPath = path.join(tmp, 'openclaw.json');
});
after(async () => {
  delete process.env.OLMA_OPENCLAW_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  await db.teardown();
});

beforeEach(() => {
  fs.writeFileSync(configPath, JSON.stringify({
    agents: { entries: { main: { name: 'main' } } },
    channels: { whatsapp: { accounts: { default: { dmPolicy: 'open', allowFrom: ['*'] } } } },
    session: { dmScope: 'per-channel-peer' },
    bindings: [],
  }, null, 2));
  pg.installGreeter({ configPath });
});

async function connectedUser(phone, extra = {}) {
  const u = await makeUser(db.pool, phone, extra);
  await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
  return u;
}

// One group, as the gateway would present it: a greeter session whose
// transcript carries the roster the inbound envelope put there.
function gatewayWith({ jid, roster, subject = 'פאדל שלישי', at = Date.now(), agentId = pg.GREETER_AGENT_ID, messageId = 'MSG-1' }) {
  const sent = [];
  return {
    sent,
    deps: {
      configPath,
      listGroupSessions: () => [{
        key: `agent:${agentId}:whatsapp:group:${jid}`,
        agentId, channel: 'whatsapp', chatType: 'group', peer: jid,
        lastInteractionAt: at,
      }],
      readGroupContext: () => ({ subject, members: roster, wasMentioned: true, at, messageId }),
      send: async (target, body, opts) => { sent.push({ target, body, replyTo: opts && opts.replyTo }); return true; },
    },
  };
}

const JID = (n) => `12036300000000000${n}@g.us`;

test('a group of strangers gets nothing at all — no row, no introduction', async () => {
  const g = gatewayWith({ jid: JID(1), roster: '+972603000001, +972603000002' });
  const out = await withTx(db.pool, (c) => job.sweepGroups(c, g.deps));

  assert.equal(out.strangers, 1);
  assert.deepEqual(g.sent, [], 'she has no business in a room where she knows nobody');
  const row = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', JID(1)));
  assert.equal(row, null);
});

test('one known member is enough: she registers, introduces herself, and locks', async () => {
  const a = await connectedUser('+972603000010');
  const g = gatewayWith({ jid: JID(2), roster: `מירון (${a.phone}), +972603000011` });
  const out = await withTx(db.pool, (c) => job.sweepGroups(c, g.deps));

  assert.deepEqual(out.registered, [JID(2)]);
  assert.equal(out.intros, 1);
  assert.equal(g.sent.length, 1);
  assert.match(g.sent[0].body, /נעים מאוד/);
  assert.equal(g.sent[0].target, JID(2));

  const row = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', JID(2)));
  assert.equal(row.state, 'locked');
  assert.equal(row.agent_id, null, 'no agent is what makes a locked group silent');

  // Registered means tag-only from here, with the deny belt on.
  const cfg = occ.loadConfig(configPath);
  assert.deepEqual(cfg.channels.whatsapp.accounts.default.groups[JID(2)], { requireMention: true });
  assert.equal(occ.isGroupMuted(cfg, JID(2)), true);
});

// The first real group, 2026-09-06: registered, and then silent for ever.
// The intro lived inside the registration branch, its send blew the 120s CLI
// timeout on a box saturated by a deploy, and the next pass took the
// already-registered path. A room she has joined and never greeted is the one
// outcome this feature cannot have.
test('an introduction that did not go out is said again next pass, and no nudge jumps ahead of it', async () => {
  const a = await connectedUser('+972603000100');
  const jid = JID(20);
  const roster = `דני (${a.phone}), +972603000101`;
  let deliver = false;
  const sent = [];
  const at = Date.now();
  const deps = {
    configPath,
    listGroupSessions: () => [{
      key: `agent:ggreet:whatsapp:group:${jid}`, agentId: pg.GREETER_AGENT_ID,
      channel: 'whatsapp', chatType: 'group', peer: jid, lastInteractionAt: at,
    }],
    readGroupContext: () => ({ subject: 'פאדל', members: roster, wasMentioned: true, at, messageId: 'M-1' }),
    send: async (target, body) => { if (!deliver) return false; sent.push({ target, body }); return true; },
  };

  // registered, but the pipe was down: nothing said, nothing stamped
  let out = await withTx(db.pool, (c) => job.sweepGroups(c, deps));
  assert.deepEqual(out.registered, [jid]);
  assert.equal(out.intros, 0);
  assert.equal(out.introFailed, 1);
  assert.deepEqual(sent, []);
  let row = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', jid));
  assert.equal(row.introduced_at, null, 'nothing said, nothing stamped');
  assert.equal(row.notices_sent, 0, 'a room she has not greeted is not nudged');

  // the pipe comes back, and a tag arrives in the meantime: the opening comes
  // first and alone — never "nice to meet you" and "some of you are missing"
  // in one breath
  deliver = true;
  deps.listGroupSessions = () => [{
    key: `agent:ggreet:whatsapp:group:${jid}`, agentId: pg.GREETER_AGENT_ID,
    channel: 'whatsapp', chatType: 'group', peer: jid, lastInteractionAt: at + 60_000,
  }];
  out = await withTx(db.pool, (c) => job.sweepGroups(c, deps));
  assert.deepEqual(out.registered, [], 'registered once, greeted later');
  assert.equal(out.intros, 1);
  assert.equal(out.notices, 0, 'the nudge waits for a tag she has been present for');
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /נעים מאוד/);
  row = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', jid));
  assert.ok(row.introduced_at, 'stamped only once it landed');

  // and it is never said twice
  deps.listGroupSessions = () => [{
    key: `agent:ggreet:whatsapp:group:${jid}`, agentId: pg.GREETER_AGENT_ID,
    channel: 'whatsapp', chatType: 'group', peer: jid, lastInteractionAt: at + 120_000,
  }];
  out = await withTx(db.pool, (c) => job.sweepGroups(c, deps));
  assert.equal(out.intros, 0);
  assert.equal(out.notices, 1, 'now a tag gets the explanation');
  assert.match(sent.at(-1).body, /עוד לא שלחו לי/);
});

test('a tag in a locked group is answered, then answered shorter, every time', async () => {
  const a = await connectedUser('+972603000020');
  const missing = '+972603000021';
  const roster = `${a.phone}, ${missing}`;
  let at = Date.now();

  const first = gatewayWith({ jid: JID(3), roster, at });
  await withTx(db.pool, (c) => job.sweepGroups(c, first.deps));   // registers + intro
  assert.equal(first.sent.length, 1);
  assert.equal(first.sent[0].replyTo, undefined, 'the intro is not a reply to anything');

  // A tag: new activity on the session.
  at += 60_000;
  const second = gatewayWith({ jid: JID(3), roster, at, messageId: 'MSG-2' });
  const out2 = await withTx(db.pool, (c) => job.sweepGroups(c, second.deps));
  assert.equal(out2.notices, 1);
  assert.match(second.sent[0].body, /עוד לא שלחו לי/);
  assert.match(second.sent[0].body, new RegExp(`@\\${missing}`));
  assert.equal(second.sent[0].replyTo, 'MSG-2', 'the answer quotes the message that tagged her');

  // Another tag a minute later: answered again, shorter. There is no cooldown
  // — the owner's rule is that every tag is answered.
  at += 60_000;
  const third = gatewayWith({ jid: JID(3), roster, at, messageId: 'MSG-3' });
  const out3 = await withTx(db.pool, (c) => job.sweepGroups(c, third.deps));
  assert.equal(out3.notices, 1);
  assert.match(third.sent[0].body, /עוד מחכה ל/);
  assert.equal(third.sent[0].replyTo, 'MSG-3');

  // A transcript with no message id still gets its answer, just not as a reply.
  at += 60_000;
  const fourth = gatewayWith({ jid: JID(3), roster, at, messageId: null });
  await withTx(db.pool, (c) => job.sweepGroups(c, fourth.deps));
  assert.equal(fourth.sent.length, 1);
  assert.equal(fourth.sent[0].replyTo, undefined);
});

// The owner rewords her sentences from the admin page; the sweep reads that
// object every pass, so an edit is live on the next tag. A box that lost its
// tags is not an edit, and the default goes out instead.
test('a reworded notice reaches the group, and one without its tags does not', async () => {
  const a = await connectedUser('+972603000090');
  const missing = '+972603000091';
  const roster = `${a.phone}, ${missing}`;
  const flags = require('../src/domain/flags');
  const templates = require('../src/domain/message-templates');
  await withTx(db.pool, (c) => flags.setFlag(c, templates.FLAG, {
    group_intro: 'שלום, אני כאן. תתייגו {{me}} כשצריך.',
    group_gate_explain: 'רגע — {{missing}} עוד לא כתבו לי.',
    group_gate_nudge: 'בלי תיוגים בכלל',
  }));
  try {
    let at = Date.now();
    const first = gatewayWith({ jid: JID(9), roster, at });
    await withTx(db.pool, (c) => job.sweepGroups(c, first.deps));
    assert.equal(first.sent[0].body, `שלום, אני כאן. תתייגו @+${require('../src/domain/proactive-text').SELF_NUMBER} כשצריך.`);
    at += 60_000;
    const second = gatewayWith({ jid: JID(9), roster, at });
    await withTx(db.pool, (c) => job.sweepGroups(c, second.deps));
    assert.equal(second.sent[0].body, `רגע — @${missing} עוד לא כתבו לי.`);
    at += 60_000;
    const third = gatewayWith({ jid: JID(9), roster, at });
    await withTx(db.pool, (c) => job.sweepGroups(c, third.deps));
    assert.equal(third.sent[0].body, `עוד מחכה ל: @${missing}  🧐`, 'the tagless rewording is ignored');
  } finally {
    await withTx(db.pool, (c) => flags.setFlag(c, templates.FLAG, {}));
  }
});

// Nothing new happened, so there is nothing to say. A sweep that talks on its
// own schedule is a sweep that talks into an empty room every ten seconds.
test('a sweep with no new activity says nothing', async () => {
  const a = await connectedUser('+972603000030');
  const roster = `${a.phone}, +972603000031`;
  const at = Date.now();

  const first = gatewayWith({ jid: JID(4), roster, at });
  await withTx(db.pool, (c) => job.sweepGroups(c, first.deps));

  const again = gatewayWith({ jid: JID(4), roster, at });   // same timestamp
  const out = await withTx(db.pool, (c) => job.sweepGroups(c, again.deps));
  assert.equal(out.notices, 0);
  assert.deepEqual(again.sent, []);
});

test('the last person writes, and the group opens with an agent of its own', async () => {
  const a = await connectedUser('+972603000040');
  const b = await makeUser(db.pool, '+972603000041');
  const roster = `${a.phone}, ${b.phone}`;

  const first = gatewayWith({ jid: JID(5), roster, at: Date.now() });
  await withTx(db.pool, (c) => job.sweepGroups(c, first.deps));

  // b finally writes to her privately.
  await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [b.id]);

  const second = gatewayWith({ jid: JID(5), roster, at: Date.now() + 60_000 });
  const out = await withTx(db.pool, (c) => job.sweepGroups(c, second.deps));

  assert.deepEqual(out.opened, [JID(5)]);
  assert.equal(out.announced, 1);
  assert.match(second.sent.at(-1).body, /כולם כאן/);

  const row = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', JID(5)));
  assert.equal(row.state, 'open');
  assert.ok(row.agent_id, 'an open group speaks through an agent of its own');
  const cfg = occ.loadConfig(configPath);
  assert.equal(occ.isGroupMuted(cfg, JID(5)), false, 'and the belt comes off');
  assert.ok(cfg.bindings.some((bd) => bd.match.peer.id === JID(5)));
});

// 02:00 is not a reason to keep a group locked, and it is not a reason to
// wake fifteen people either.
test('a group that opens in the small hours opens quietly and announces later', async () => {
  const a = await connectedUser('+972603000050', { timezone: 'Asia/Jerusalem' });
  const roster = a.phone;
  // A time of DAY, on a date safely behind us. Pinned to an absolute date this
  // test was green for a day and red the next: `noteMention` stamps the real
  // clock, and once the wall clock passed the pinned timestamp the group read
  // as mid-conversation and announced at half past midnight.
  const day = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const night = new Date(`${day}T00:30:00+03:00`);   // 00:30 in Jerusalem

  const g = gatewayWith({ jid: JID(6), roster, at: night.getTime() });
  const out = await withTx(db.pool, (c) => job.sweepGroups(c, {
    ...g.deps,
    now: night,
    // No live tag: the group opened because somebody wrote to her in private.
    readGroupContext: () => ({ subject: 'לילה', members: roster, at: night.getTime() - 3 * 3600_000 }),
    listGroupSessions: () => [{
      key: `agent:${pg.GREETER_AGENT_ID}:whatsapp:group:${JID(6)}`,
      agentId: pg.GREETER_AGENT_ID, channel: 'whatsapp', chatType: 'group', peer: JID(6),
      lastInteractionAt: night.getTime() - 3 * 3600_000,
    }],
  }));

  assert.deepEqual(out.opened, [JID(6)], 'it really is open');
  assert.equal(out.announced, 0, 'it just does not shout about it at half past midnight');
  const row = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', JID(6)));
  assert.ok(row.opened_at);
  assert.equal(row.opened_announced_at, null);

  // Morning.
  const morning = new Date(`${day}T09:30:00+03:00`);
  const g2 = gatewayWith({ jid: JID(6), roster, at: night.getTime() });
  const out2 = await withTx(db.pool, (c) => job.sweepGroups(c, { ...g2.deps, now: morning }));
  assert.equal(out2.announced, 1);
  assert.match(g2.sent[0].body, /כולם כאן/);
});

test('a newcomer who never wrote re-locks an open group', async () => {
  const a = await connectedUser('+972603000060');
  const first = gatewayWith({ jid: JID(7), roster: a.phone, at: Date.now() });
  await withTx(db.pool, (c) => job.sweepGroups(c, first.deps));
  const opened = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', JID(7)));
  assert.equal(opened.state, 'open');

  const second = gatewayWith({
    jid: JID(7), roster: `${a.phone}, +972603000061`, at: Date.now() + 60_000,
  });
  const out = await withTx(db.pool, (c) => job.sweepGroups(c, second.deps));

  assert.deepEqual(out.relocked, [JID(7)]);
  const row = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', JID(7)));
  assert.equal(row.state, 'locked');
  assert.equal(row.agent_id, null);
  const cfg = occ.loadConfig(configPath);
  assert.equal(cfg.bindings.filter((b) => b.match.peer.id === JID(7)).length, 0);
  assert.equal(occ.isGroupMuted(cfg, JID(7)), true);

  // The newcomer writes to her. The room hears that it is back on — the
  // person who caused the lock is the one person nothing else would tell.
  await connectedUser('+972603000061');
  const third = gatewayWith({ jid: JID(7), roster: `${a.phone}, +972603000061`, at: Date.now() + 120_000 });
  const again = await withTx(db.pool, (c) => job.sweepGroups(c, {
    ...third.deps, now: helpers.daytime(),
  }));
  assert.deepEqual(again.opened, [JID(7)]);
  assert.equal(again.announced, 1, 'a re-open is announced like a first open');
});

// The failure mode this guards is the quiet one: a roster line we cannot read
// a phone out of is a member we cannot check, and treating it as absent would
// open a group on a roster we know is incomplete.
test('an unreadable roster entry keeps the group where it is', async () => {
  const a = await connectedUser('+972603000070');
  const g = gatewayWith({ jid: JID(8), roster: `${a.phone}, ~Someone` });
  const out = await withTx(db.pool, (c) => job.sweepGroups(c, g.deps));

  assert.equal(out.skipped, 1);
  assert.deepEqual(out.opened, []);
  const row = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', JID(8)));
  assert.equal(row.state, 'locked');
});

test('a transcript that cannot be read is no evidence, not an empty group', async () => {
  const a = await connectedUser('+972603000080');
  const first = gatewayWith({ jid: JID(9), roster: a.phone, at: Date.now() });
  await withTx(db.pool, (c) => job.sweepGroups(c, first.deps));

  const blind = gatewayWith({ jid: JID(9), roster: a.phone, at: Date.now() + 60_000 });
  const out = await withTx(db.pool, (c) => job.sweepGroups(c, {
    ...blind.deps, readGroupContext: () => null,
  }));
  assert.equal(out.unreadable, 1);
  const members = await withTx(db.pool, async (c) => {
    const row = await groupsDomain.getByExternalId(c, 'whatsapp', JID(9));
    return groupsDomain.listMembers(c, row.id);
  });
  assert.equal(members.length, 1, 'nobody was dropped because a file would not open');
});

// Arming the sweep before the feature is switched on must be free and silent.
test('with no greeter installed the sweep does nothing at all', async () => {
  fs.writeFileSync(configPath, JSON.stringify({ agents: { entries: {} }, bindings: [] }, null, 2));
  const g = gatewayWith({ jid: JID(0), roster: '+972603000090' });
  const out = await withTx(db.pool, (c) => job.sweepGroups(c, g.deps));
  assert.deepEqual(out, { skipped: 'no_greeter' });
  assert.deepEqual(g.sent, []);
});

test('the announcement window follows the group, and a live tag overrides it', () => {
  const night = new Date('2026-09-06T02:00:00+03:00');
  const asleep = { timezone: 'Asia/Jerusalem', last_mention_at: null };
  assert.equal(job.mayAnnounce(asleep, night), false);

  // Somebody tagged her a minute ago: they are plainly awake.
  const tagged = { timezone: 'Asia/Jerusalem', last_mention_at: new Date(night.getTime() - 60_000) };
  assert.equal(job.mayAnnounce(tagged, night), true);

  assert.equal(job.mayAnnounce(asleep, new Date('2026-09-06T10:00:00+03:00')), true);
});

// ---- the sender gate ---------------------------------------------------------
//
// The room admission decides which GROUPS she is in. This decides which people
// in them the gateway will wake her for at all — and with nothing written it
// admits everyone, because an absent `groupAllowFrom` falls back to
// `allowFrom`, which is `["*"]`. The sweep owns it so that one rule covers a
// user joining, pausing, being blocked and being deleted.

test('the sweep makes the sender list the current users, every pass', async () => {
  const a = await connectedUser('+972604000001');
  await connectedUser('+972604000002');
  const g = gatewayWith({ jid: JID(1), roster: '+972604000001, +972604000002' });

  assert.equal(occ.isGroupSenderGateOpen(occ.loadConfig(configPath)), true,
    'before the first pass nothing gates the senders');
  const out = await withTx(db.pool, (c) => job.sweepGroups(c, g.deps));
  assert.equal(out.senderGateOpen, false);
  const admitted = () => occ.groupAllowFrom(occ.loadConfig(configPath));
  assert.ok(admitted().includes(a.phone));
  assert.ok(admitted().includes('+972604000002'));

  // Pausing somebody takes them out: her answer lands in the whole room, so a
  // paused member's tag would walk straight around the pause.
  await db.pool.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [a.id]);
  await withTx(db.pool, (c) => job.sweepGroups(c, g.deps));
  assert.ok(!admitted().includes(a.phone));
  assert.ok(admitted().includes('+972604000002'), 'and nobody else moved');

  // Deleting the row takes them out too, with no separate call site: one
  // declarative rule covers joining, pausing, blocking and deletion alike.
  await db.pool.query(`UPDATE users SET paused_at = NULL WHERE id = $1`, [a.id]);
  await withTx(db.pool, (c) => job.sweepGroups(c, g.deps));
  assert.ok(admitted().includes(a.phone), 'un-pausing puts them back');
  await db.pool.query(`DELETE FROM users WHERE id = $1`, [a.id]);
  await withTx(db.pool, (c) => job.sweepGroups(c, g.deps));
  assert.ok(!admitted().includes(a.phone));
});

// The one direction that must never happen quietly: emptying the list reads as
// "no list", which is the wide-open door again. Everyone in this file's
// database is blocked for the length of this test to reach that state.
test('a system with no eligible users never writes an empty sender list', async () => {
  await connectedUser('+972604000010');
  const g = gatewayWith({ jid: JID(2), roster: '+972604000010' });
  await withTx(db.pool, (c) => job.sweepGroups(c, g.deps));
  const before = occ.groupAllowFrom(occ.loadConfig(configPath));
  assert.ok(before.length > 0);

  await db.pool.query(`UPDATE users SET status = 'blocked'`);
  try {
    const out = await withTx(db.pool, (c) => job.sweepGroups(c, g.deps));
    assert.deepEqual(occ.groupAllowFrom(occ.loadConfig(configPath)), before,
      'the last known-good list stays rather than becoming an open door');
    assert.equal(out.senderGateOpen, false);
  } finally {
    await db.pool.query(`UPDATE users SET status = 'active'`);
  }
});

test('her own number never reaches the sender list', async () => {
  await connectedUser(occ.SELF_PHONE);
  await connectedUser('+972604000020');
  const g = gatewayWith({ jid: JID(3), roster: '+972604000020' });
  await withTx(db.pool, (c) => job.sweepGroups(c, g.deps));

  const admitted = occ.groupAllowFrom(occ.loadConfig(configPath));
  assert.ok(admitted.includes('+972604000020'));
  assert.ok(!admitted.includes(occ.SELF_PHONE),
    'her own tag comes back in her own outbound message — a loop with her at both ends');
});
