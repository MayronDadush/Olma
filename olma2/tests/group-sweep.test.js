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
const groupOutbox = require('../src/domain/group-outbox');

// What brokerd does in two jobs, in the order it does it: `sweepGroups`
// decides and writes rows, `group_outbox` spawns the CLI. Every assertion
// below about what a room HEARD depends on both halves running, which is the
// point — deciding and sending are separate transactions now (migration 055).
async function pass(deps) {
  const decided = await withTx(db.pool, (c) => job.sweepGroups(c, deps));
  const drained = await groupOutbox.drainOnce(db.pool, deps);
  return { ...decided, ...drained };
}

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

beforeEach(async () => {
  // Each test is its own room and its own story. A line queued by an earlier
  // one and never drained would otherwise be delivered into this one's
  // recorder — the tests share a database, production does not share a past.
  await db.pool.query(`DELETE FROM group_outbox WHERE sent_at IS NULL`);
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
  const out = await pass(g.deps);

  assert.equal(out.strangers, 1);
  assert.deepEqual(g.sent, [], 'she has no business in a room where she knows nobody');
  const row = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', JID(1)));
  assert.equal(row, null);
});

test('one known member is enough: she registers, introduces herself, and locks', async () => {
  const a = await connectedUser('+972603000010');
  const g = gatewayWith({ jid: JID(2), roster: `מירון (${a.phone}), +972603000011` });
  const out = await pass(g.deps);

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

  // Registered, and the pipe was down. Since migration 055 the DECISION and
  // the send are different transactions: the sentence is written down and
  // stamped here, and the queue holds it until the pipe comes back. What is
  // being asserted is unchanged — the room does not stay ungreeted — but the
  // thing that guarantees it is now the row, not a second decision.
  let out = await pass(deps);
  assert.deepEqual(out.registered, [jid]);
  assert.equal(out.intros, 1, 'decided');
  assert.equal(out.sent, 0, 'and not delivered');
  assert.deepEqual(sent, []);
  let row = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', jid));
  assert.equal(row.notices_sent, 0, 'a room she has not greeted is not nudged');
  const { rows: queued } = await db.pool.query(
    `SELECT o.kind, o.attempts, o.claimed_at, o.sent_at FROM group_outbox o
       JOIN chat_groups g ON g.id = o.group_id WHERE g.external_id = $1`, [jid]);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, 'intro');
  assert.equal(queued[0].sent_at, null, 'still owed to the room');
  assert.equal(queued[0].claimed_at, null, 'a refused send is worth one more try');
  assert.equal(queued[0].attempts, 1, 'and the one that failed is counted');

  // the pipe comes back, and a tag arrives in the meantime: the opening comes
  // first and alone — never "nice to meet you" and "some of you are missing"
  // in one breath
  deliver = true;
  deps.listGroupSessions = () => [{
    key: `agent:ggreet:whatsapp:group:${jid}`, agentId: pg.GREETER_AGENT_ID,
    channel: 'whatsapp', chatType: 'group', peer: jid, lastInteractionAt: at + 60_000,
  }];
  out = await pass(deps);
  assert.deepEqual(out.registered, [], 'registered once, greeted later');
  assert.equal(out.intros, 0, 'the sentence was decided on last pass, not again');
  assert.equal(out.sent, 1, 'the queued one went out');
  assert.equal(out.notices, 0, 'the nudge waits for a tag she has been present for');
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /נעים מאוד/);

  // and it is never said twice
  deps.listGroupSessions = () => [{
    key: `agent:ggreet:whatsapp:group:${jid}`, agentId: pg.GREETER_AGENT_ID,
    channel: 'whatsapp', chatType: 'group', peer: jid, lastInteractionAt: at + 120_000,
  }];
  out = await pass(deps);
  assert.equal(out.intros, 0);
  assert.equal(out.notices, 1, 'now a tag gets the explanation');
  assert.match(sent.at(-1).body, /עוד לא שלחו לי/);
  assert.equal(sent.filter((m) => /נעים מאוד/.test(m.body)).length, 1, 'greeted exactly once');
});

// The other half of the same evening. The CLI hands the message to the gateway
// and THEN waits for the turn to finish, so a send that blows the 120s timeout
// has very probably been delivered — `runOpenclaw` says `timedOut` rather than
// failing outright, and everything she says once per room treats that as said.
// Read as a failure it costs the room a second "nice to meet you" and a second
// walk through the whole gate explanation, on exactly the busy box that made
// the timeout happen.
test('a send that timed out is treated as said, and is not said again', async () => {
  const a = await connectedUser('+972603000130');
  const missing = '+972603000131';
  const jid = JID(23);
  const roster = `${a.phone}, ${missing}`;
  const at = Date.now();
  const sent = [];
  let answer = 'unknown';
  const gateway = (activity) => ({
    configPath,
    listGroupSessions: () => [{
      key: `agent:${pg.GREETER_AGENT_ID}:whatsapp:group:${jid}`, agentId: pg.GREETER_AGENT_ID,
      channel: 'whatsapp', chatType: 'group', peer: jid, lastInteractionAt: activity,
    }],
    readGroupContext: () => ({ subject: 'פאדל', members: roster, wasMentioned: true, at: activity }),
    send: async (target, body) => { sent.push(body); return answer; },
  });

  // The introduction: we never learned whether it landed.
  let out = await pass(gateway(at));
  assert.deepEqual(out.registered, [jid]);
  assert.equal(out.intros, 1, 'the sentence was decided on and written down');
  assert.equal(out.sent, 0, 'but nothing came back to say it arrived');
  assert.equal(out.unconfirmed, 1, 'the doubt is on the heartbeat, not in the room');
  let row = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', jid));
  assert.ok(row.introduced_at, 'stamped, so the next pass does not greet them twice');

  // A tag, and the same silence from the pipe.
  out = await pass(gateway(at + 60_000));
  assert.equal(out.intros, 0, 'she does not introduce herself twice');
  assert.equal(out.notices, 1);
  assert.equal(out.unconfirmed, 1);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /עוד לא שלחו לי/, 'the long explanation, once');
  row = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', jid));
  assert.ok(row.gate_notice_at, 'a wait we probably announced is a wait we announced');

  // The pipe comes back. The next tag gets the SHORT answer: the explanation
  // has been spent.
  answer = 'sent';
  out = await pass(gateway(at + 120_000));
  assert.equal(out.notices, 1);
  assert.equal(out.sent, 1);
  assert.equal(out.unconfirmed, 0);
  assert.match(sent.at(-1), /עוד מחכה ל/);
  assert.equal(sent.filter((b) => /נעים מאוד/.test(b)).length, 1, 'greeted exactly once');
});

test('a tag in a locked group is answered, then answered shorter, every time', async () => {
  const a = await connectedUser('+972603000020');
  const missing = '+972603000021';
  const roster = `${a.phone}, ${missing}`;
  let at = Date.now();

  const first = gatewayWith({ jid: JID(3), roster, at });
  await pass(first.deps);   // registers + intro
  assert.equal(first.sent.length, 1);
  assert.equal(first.sent[0].replyTo, undefined, 'the intro is not a reply to anything');

  // A tag: new activity on the session.
  at += 60_000;
  const second = gatewayWith({ jid: JID(3), roster, at, messageId: 'MSG-2' });
  const out2 = await pass(second.deps);
  assert.equal(out2.notices, 1);
  assert.match(second.sent[0].body, /עוד לא שלחו לי/);
  assert.match(second.sent[0].body, new RegExp(`@\\${missing}`));
  assert.equal(second.sent[0].replyTo, 'MSG-2', 'the answer quotes the message that tagged her');

  // Another tag a minute later: answered again, shorter. There is no cooldown
  // — the owner's rule is that every tag is answered.
  at += 60_000;
  const third = gatewayWith({ jid: JID(3), roster, at, messageId: 'MSG-3' });
  const out3 = await pass(third.deps);
  assert.equal(out3.notices, 1);
  assert.match(third.sent[0].body, /עוד מחכה ל/);
  assert.equal(third.sent[0].replyTo, 'MSG-3');

  // A transcript with no message id still gets its answer, just not as a reply.
  at += 60_000;
  const fourth = gatewayWith({ jid: JID(3), roster, at, messageId: null });
  await pass(fourth.deps);
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
    await pass(first.deps);
    assert.equal(first.sent[0].body, `שלום, אני כאן. תתייגו @+${require('../src/domain/proactive-text').SELF_NUMBER} כשצריך.`);
    at += 60_000;
    const second = gatewayWith({ jid: JID(9), roster, at });
    await pass(second.deps);
    assert.equal(second.sent[0].body, `רגע — @${missing} עוד לא כתבו לי.`);
    at += 60_000;
    const third = gatewayWith({ jid: JID(9), roster, at });
    await pass(third.deps);
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
  await pass(first.deps);

  const again = gatewayWith({ jid: JID(4), roster, at });   // same timestamp
  const out = await pass(again.deps);
  assert.equal(out.notices, 0);
  assert.deepEqual(again.sent, []);
});

// The room never heard that anybody was missing, so there is nothing here to
// announce the end of. It opens, it gets its agent, and it says nothing — the
// introduction was the whole greeting this room needed.
test('the last person writes, and the group opens with an agent of its own', async () => {
  const a = await connectedUser('+972603000040');
  const b = await makeUser(db.pool, '+972603000041');
  const roster = `${a.phone}, ${b.phone}`;

  const first = gatewayWith({ jid: JID(5), roster, at: Date.now() });
  await pass(first.deps);

  // b finally writes to her privately.
  await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [b.id]);

  const second = gatewayWith({ jid: JID(5), roster, at: Date.now() + 60_000 });
  const out = await pass(second.deps);

  assert.deepEqual(out.opened, [JID(5)]);
  assert.equal(out.announced, 0, 'nobody was ever told to wait');
  assert.deepEqual(second.sent, [], 'the opening line answers a sentence she never said');

  const row = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', JID(5)));
  assert.equal(row.state, 'open');
  assert.ok(row.agent_id, 'an open group speaks through an agent of its own');
  const cfg = occ.loadConfig(configPath);
  assert.equal(occ.isGroupMuted(cfg, JID(5)), false, 'and the belt comes off');
  assert.ok(cfg.bindings.some((bd) => bd.match.peer.id === JID(5)));
});

// ...and the other half of the same rule. A room she DID make wait hears that
// the wait is over, because that sentence is an answer to her own
// "עוד לא שלחו לי".
test('a room that was told somebody was missing hears that everybody arrived', async () => {
  const a = await connectedUser('+972603000110');
  const b = await makeUser(db.pool, '+972603000111');
  const roster = `${a.phone}, ${b.phone}`;
  const at = Date.now();

  const first = gatewayWith({ jid: JID(21), roster, at });
  await pass(first.deps);   // registers + intro

  // Somebody tags her while b is still a stranger: now the room has been told.
  const tagged = gatewayWith({ jid: JID(21), roster, at: at + 60_000, messageId: 'MSG-9' });
  const out2 = await pass(tagged.deps);
  assert.equal(out2.notices, 1);
  const told = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', JID(21)));
  assert.ok(told.gate_notice_at, 'the wait is on the record, not just the notice count');

  await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [b.id]);
  const third = gatewayWith({ jid: JID(21), roster, at: at + 120_000 });
  const out3 = await pass({
    ...third.deps, now: helpers.daytime(),
  });
  assert.deepEqual(out3.opened, [JID(21)]);
  assert.equal(out3.announced, 1);
  assert.match(third.sent.at(-1).body, /כולם כאן/);
});

// A room told it was too big was never waiting on a PERSON, so trimming it
// down to size opens it without the fanfare. Same column, the other branch of
// `noteNoticeSent`.
test('a room that was only ever told it was too large opens quietly', async () => {
  const flags = require('../src/domain/flags');
  const a = await connectedUser('+972603000120');
  const b = await connectedUser('+972603000121');
  const roster = `${a.phone}, ${b.phone}`;
  const at = Date.now();

  await withTx(db.pool, (c) => flags.setFlag(c, 'group_max_members', 1));
  try {
    const first = gatewayWith({ jid: JID(22), roster, at });
    await pass(first.deps);   // registers + intro

    const tagged = gatewayWith({ jid: JID(22), roster, at: at + 60_000 });
    const out2 = await pass(tagged.deps);
    assert.equal(out2.notices, 1);
    assert.match(tagged.sent.at(-1).body, /מסתדרת טוב עד/);
    const told = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', JID(22)));
    assert.ok(told.last_notice_at, 'it was answered');
    assert.equal(told.gate_notice_at, null, 'but nobody was ever missing');
  } finally {
    await withTx(db.pool, (c) => flags.setFlag(c, 'group_max_members', 25));
  }

  const third = gatewayWith({ jid: JID(22), roster, at: at + 120_000 });
  const out3 = await pass({
    ...third.deps, now: helpers.daytime(),
  });
  assert.deepEqual(out3.opened, [JID(22)]);
  assert.equal(out3.announced, 0);
  assert.deepEqual(third.sent, []);
});

// 02:00 is not a reason to keep a group locked, and it is not a reason to
// wake fifteen people either.
test('a group that opens in the small hours opens quietly and announces later', async () => {
  const a = await connectedUser('+972603000050', { timezone: 'Asia/Jerusalem' });
  const b = await makeUser(db.pool, '+972603000051', { timezone: 'Asia/Jerusalem' });
  const roster = `${a.phone}, ${b.phone}`;
  // A time of DAY, on a date safely behind us. Pinned to an absolute date this
  // test was green for a day and red the next: `noteMention` stamps the real
  // clock, and once the wall clock passed the pinned timestamp the group read
  // as mid-conversation and announced at half past midnight.
  const day = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const night = new Date(`${day}T00:30:00+03:00`);   // 00:30 in Jerusalem
  const evening = night.getTime() - 3 * 3600_000;    // 21:30 the evening before

  // Registered and greeted, then tagged while b is still a stranger — which is
  // what earns the opening line at all. A reply to a live tag has no hours.
  const first = gatewayWith({ jid: JID(6), roster, at: evening });
  await pass({ ...first.deps, now: new Date(evening) });
  const tagged = gatewayWith({ jid: JID(6), roster, at: evening + 60_000 });
  const told = await pass({
    ...tagged.deps, now: new Date(evening + 60_000),
  });
  assert.equal(told.notices, 1);

  // b writes to her in the middle of the night. No live tag: the group opens
  // because of something that happened in a private chat.
  await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [b.id]);
  const g = gatewayWith({ jid: JID(6), roster, at: evening + 60_000 });
  const out = await pass({ ...g.deps, now: night });

  assert.deepEqual(out.opened, [JID(6)], 'it really is open');
  assert.equal(out.announced, 0, 'it just does not shout about it at half past midnight');
  assert.deepEqual(g.sent, []);
  const row = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', JID(6)));
  assert.ok(row.opened_at);
  assert.equal(row.opened_announced_at, null);

  // Morning.
  const morning = new Date(`${day}T09:30:00+03:00`);
  const g2 = gatewayWith({ jid: JID(6), roster, at: evening + 60_000 });
  const out2 = await pass({ ...g2.deps, now: morning });
  assert.equal(out2.announced, 1);
  assert.match(g2.sent[0].body, /כולם כאן/);
});

test('a newcomer who never wrote re-locks an open group', async () => {
  const a = await connectedUser('+972603000060');
  const first = gatewayWith({ jid: JID(7), roster: a.phone, at: Date.now() });
  await pass(first.deps);
  const opened = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', JID(7)));
  assert.equal(opened.state, 'open');

  const second = gatewayWith({
    jid: JID(7), roster: `${a.phone}, +972603000061`, at: Date.now() + 60_000,
  });
  const out = await pass(second.deps);

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
  const again = await pass({
    ...third.deps, now: helpers.daytime(),
  });
  assert.deepEqual(again.opened, [JID(7)]);
  assert.equal(again.announced, 1, 'a re-open is announced like a first open');
});

// The failure mode this guards is the quiet one: a roster line we cannot read
// a phone out of is a member we cannot check, and treating it as absent would
// open a group on a roster we know is incomplete.
test('an unreadable roster entry keeps the group where it is', async () => {
  const a = await connectedUser('+972603000070');
  const g = gatewayWith({ jid: JID(8), roster: `${a.phone}, ~Someone` });
  const out = await pass(g.deps);

  assert.equal(out.skipped, 1);
  assert.deepEqual(out.opened, []);
  const row = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', JID(8)));
  assert.equal(row.state, 'locked');
});

test('a transcript that cannot be read is no evidence, not an empty group', async () => {
  const a = await connectedUser('+972603000080');
  const first = gatewayWith({ jid: JID(9), roster: a.phone, at: Date.now() });
  await pass(first.deps);

  const blind = gatewayWith({ jid: JID(9), roster: a.phone, at: Date.now() + 60_000 });
  const out = await pass({
    ...blind.deps, readGroupContext: () => null,
  });
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

test('the announcement window follows the group, and a member writing overrides it', () => {
  const night = new Date('2026-09-06T02:00:00+03:00');
  const asleep = { timezone: 'Asia/Jerusalem', last_member_write_at: null };
  assert.equal(job.mayAnnounce(asleep, night), false);

  // Somebody wrote in the room a minute ago: they are plainly awake.
  const awake = { timezone: 'Asia/Jerusalem', last_member_write_at: new Date(night.getTime() - 60_000) };
  assert.equal(job.mayAnnounce(awake, night), true);

  assert.equal(job.mayAnnounce(asleep, new Date('2026-09-06T10:00:00+03:00')), true);
});

// The 01:12 line, as the row that produced it. Group "5 Percent (Maprinter)"
// on 2026-09-08: the newest member write was 19:11 local, six hours earlier,
// and `last_mention_at` was minutes old because the sweep rewrites it on every
// pass (see mayAnnounce for why). Reading the session stamp says yes; reading
// the room's own people says no, which is the answer.
test('a room nobody has written in since the evening is asleep, however busy her own sessions look', () => {
  const oneTwelveAm = new Date('2026-09-09T01:12:00+03:00');
  const room = {
    timezone: 'Asia/Jerusalem',
    last_mention_at: new Date(oneTwelveAm.getTime() - 60_000),
    last_member_write_at: new Date('2026-09-08T19:11:54+03:00'),
  };
  assert.equal(job.mayAnnounce(room, oneTwelveAm), false);
});

// A row assembled without the roster gets the hours, never the grace.
test('a row that never learned when anybody wrote is treated as asleep at night', () => {
  const night = new Date('2026-09-06T02:00:00+03:00');
  assert.equal(job.mayAnnounce({ timezone: 'Asia/Jerusalem' }, night), false);
  assert.equal(job.mayAnnounce({ timezone: 'Asia/Jerusalem' }, new Date('2026-09-06T10:00:00+03:00')), true);
});

// The clock disagreeing with itself is not evidence anybody is up.
test('a write stamped in the future buys no grace', () => {
  const night = new Date('2026-09-06T02:00:00+03:00');
  const ahead = { timezone: 'Asia/Jerusalem', last_member_write_at: new Date(night.getTime() + 60_000) };
  assert.equal(job.mayAnnounce(ahead, night), false);
});

// The hours are the group's own, and the group's own is the majority of its
// members (domain/groups.majorityTimezone) — so the same instant is night in
// one room and the working day in another.
test('two rooms in different zones answer differently at the same instant', () => {
  const instant = new Date('2026-09-09T01:12:00+03:00'); // 22:12 UTC
  assert.equal(job.mayAnnounce({ timezone: 'Asia/Jerusalem' }, instant), false);
  assert.equal(job.mayAnnounce({ timezone: 'America/New_York' }, instant), true); // 18:12 there
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
  const out = await pass(g.deps);
  assert.equal(out.senderGateOpen, false);
  const admitted = () => occ.groupAllowFrom(occ.loadConfig(configPath));
  assert.ok(admitted().includes(a.phone));
  assert.ok(admitted().includes('+972604000002'));

  // Pausing somebody takes them out: her answer lands in the whole room, so a
  // paused member's tag would walk straight around the pause.
  await db.pool.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [a.id]);
  await pass(g.deps);
  assert.ok(!admitted().includes(a.phone));
  assert.ok(admitted().includes('+972604000002'), 'and nobody else moved');

  // Deleting the row takes them out too, with no separate call site: one
  // declarative rule covers joining, pausing, blocking and deletion alike.
  await db.pool.query(`UPDATE users SET paused_at = NULL WHERE id = $1`, [a.id]);
  await pass(g.deps);
  assert.ok(admitted().includes(a.phone), 'un-pausing puts them back');
  await db.pool.query(`DELETE FROM users WHERE id = $1`, [a.id]);
  await pass(g.deps);
  assert.ok(!admitted().includes(a.phone));
});

// The one direction that must never happen quietly: emptying the list reads as
// "no list", which is the wide-open door again. Everyone in this file's
// database is blocked for the length of this test to reach that state.
test('a system with no eligible users never writes an empty sender list', async () => {
  await connectedUser('+972604000010');
  const g = gatewayWith({ jid: JID(2), roster: '+972604000010' });
  await pass(g.deps);
  const before = occ.groupAllowFrom(occ.loadConfig(configPath));
  assert.ok(before.length > 0);

  await db.pool.query(`UPDATE users SET status = 'blocked'`);
  try {
    const out = await pass(g.deps);
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
  await pass(g.deps);

  const admitted = occ.groupAllowFrom(occ.loadConfig(configPath));
  assert.ok(admitted.includes('+972604000020'));
  assert.ok(!admitted.includes(occ.SELF_PHONE),
    'her own tag comes back in her own outbound message — a loop with her at both ends');
});

// ---- one watermark per gateway session (migration 059) ----------------------
//
// Every fixture above hands the sweep ONE session per room, and production
// never does: a room has the muted greeter's session and, once it is open, its
// own `g-N` agent's. That is the whole reason this survived — the loop runs
// once per session, and against a single `chat_groups.last_seen_at` each
// iteration overwrote the previous one's mark, so on the next pass every
// session was comparing its own stamp against somebody else's.
//
// Measured live on 2026-09-09, two readings three minutes apart with nobody
// writing in any room: all three rooms carried the same `last_mention_at` to
// the microsecond, and it had advanced.
function twoSessions({ jid, roster, subject = 'פאדל שלישי', greeterAt, ownAgentId, ownAt, messageId = 'MSG-1' }) {
  const sent = [];
  const session = (agentId, at) => ({
    key: `agent:${agentId}:whatsapp:group:${jid}`,
    agentId, channel: 'whatsapp', chatType: 'group', peer: jid, lastInteractionAt: at,
  });
  return {
    sent,
    deps: {
      configPath,
      // Greeter first, exactly as `sweepGroups` builds `agentIds`:
      // `[GREETER, ...open agents]`.
      listGroupSessions: () => [session(pg.GREETER_AGENT_ID, greeterAt), session(ownAgentId, ownAt)],
      readGroupContext: () => ({ subject, members: roster, wasMentioned: true, at: ownAt, messageId }),
      send: async (target, body, opts) => { sent.push({ target, body, replyTo: opts && opts.replyTo }); return true; },
    },
  };
}

// The one that was firing every ten seconds in a shape production could reach.
// Nothing changes between the second pass and the third — same roster, same two
// stamps — and the room must hear nothing the second time. Against one column
// per room it heard a nudge on every pass for ever: the greeter's iteration
// wrote its older stamp back over the mark the `g-N` iteration had left, and
// the `g-N` iteration then read that regressed number and called its own
// unchanged turn a fresh tag.
test('two sessions and nothing new: the room is answered once, not on every pass', async () => {
  const a = await connectedUser('+972605000010');
  await makeUser(db.pool, '+972605000011');   // never wrote to her: the room stays locked
  const jid = JID(30);
  const roster = `${a.phone}, +972605000011`;
  const at = Date.now();

  await pass(gatewayWith({ jid, roster, at }).deps);   // registers + introduces
  const owner = 'g-99';

  // Something really did happen: the room's own session is a minute newer than
  // anything we have watermarked.
  const tagged = twoSessions({ jid, roster, greeterAt: at, ownAgentId: owner, ownAt: at + 60_000 });
  const second = await pass(tagged.deps);
  assert.equal(second.notices, 1, 'a turn newer than our mark in a locked room is a tag');

  // And now nothing happens at all. Same stamps, same roster, twice more.
  for (const n of [3, 4]) {
    const quiet = twoSessions({ jid, roster, greeterAt: at, ownAgentId: owner, ownAt: at + 60_000 });
    const out = await pass(quiet.deps);
    assert.equal(out.notices, 0, `pass ${n} answered a tag nobody sent`);
    assert.deepEqual(quiet.sent, [], `pass ${n} said something into a silent room`);
  }

  const row = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', jid));
  assert.equal(row.notices_sent, 1, 'and the notice count did not climb');
});

// The one place the old fault leaked into a room today. `agentIds` is built
// once at the top of the pass, so a room that re-locks on its GREETER's
// iteration still has its own `g-N` session iterated afterwards — and that
// iteration used to read the watermark the greeter had just overwritten, find
// itself newer, and answer a tag nobody had sent. The room is silent now, and
// hears the explanation the next time somebody actually asks her for
// something, which is what the notice is for.
test('a room that re-locks mid-pass does not answer a tag nobody sent', async () => {
  const a = await connectedUser('+972605000020');
  const b = await connectedUser('+972605000021');
  const jid = JID(31);
  const roster = `${a.phone}, ${b.phone}`;
  const at = Date.now();

  await pass({ ...gatewayWith({ jid, roster, at }).deps, now: helpers.daytime() });
  const open = await withTx(db.pool, (c) => groupsDomain.getByExternalId(c, 'whatsapp', jid));
  assert.equal(open.state, 'open');
  assert.ok(open.agent_id, 'the room has an agent of its own to be a second session');

  // A pass with both sessions, so each one carries a watermark of its own.
  const settled = twoSessions({ jid, roster, greeterAt: at, ownAgentId: open.agent_id, ownAt: at + 60_000 });
  await pass({ ...settled.deps, now: helpers.daytime() });

  // Now a stranger appears in the roster and NOTHING else moves — the same two
  // stamps, neither of them newer than its own mark. The gate closes again on
  // the greeter's iteration, while the room's own session is still in the list
  // behind it, and against one column per room that iteration would read the
  // stamp the greeter had just written back over it.
  const grown = twoSessions({
    jid, roster: `${roster}, +972605000022`,
    greeterAt: at, ownAgentId: open.agent_id, ownAt: at + 60_000,
  });
  const out = await pass({ ...grown.deps, now: helpers.daytime() });

  assert.deepEqual(out.relocked, [jid]);
  assert.equal(out.notices, 0, 'nobody tagged her — the roster changed under her');
  assert.deepEqual(grown.sent, []);
});
