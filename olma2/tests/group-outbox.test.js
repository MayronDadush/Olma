'use strict';
// The queue between deciding and saying (migration 055).
//
// The founding case is real and dated. On 2026-09-07 at 21:00:10 UTC the group
// sweep spawned the CLI to tell a room "יש! כולם כאן"; systemd stopped brokerd
// in the same second for a deploy; the child was detached, so the message was
// delivered; and the stamp that records the sentence as said was never
// written, because the process holding the transaction was gone. Twenty-eight
// seconds later the new brokerd's sweep found the column still NULL and said
// it again. The room read it twice.
//
// Everything below is that failure, written down: the stamp and the row are
// one transaction, the key is unique, and a claim is never given back.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const { freshDb } = helpers;
const { withTx } = require('../src/db/pool');
const outbox = require('../src/domain/group-outbox');
const templates = require('../src/domain/message-templates');
const flags = require('../src/domain/flags');

let db;
let groupId;

before(async () => {
  db = await freshDb();
});
after(async () => { await db.teardown(); });

beforeEach(async () => {
  await db.pool.query(`DELETE FROM group_outbox`);
  const { rows } = await db.pool.query(
    `INSERT INTO chat_groups (channel, external_id, subject, state)
          VALUES ('whatsapp', 'g-' || gen_random_uuid()::text || '@g.us', 'פאדל', 'open')
       RETURNING id`);
  groupId = rows[0].id;
});

function recorder(answer = 'sent') {
  const sent = [];
  return {
    sent,
    deps: {
      send: async (jid, body, opts) => {
        sent.push({ jid, body, replyTo: opts && opts.replyTo });
        return typeof answer === 'function' ? answer() : answer;
      },
      // No WhatsApp channel restart in flight. Every test in this file is
      // about what the queue does with a ROW; the one about the restart
      // window supplies its own stamp ("the queue says nothing while the
      // channel it restarted is coming back").
      channelWrittenAt: () => null,
    },
  };
}

test('the same sentence cannot be queued twice, whatever the caller believes', async () => {
  const first = await withTx(db.pool, (c) => outbox.enqueue(c, {
    groupId, kind: 'opened', idempotencyKey: `g${groupId}:opened`,
  }));
  assert.equal(first.data.queued, true);

  // The exact production shape of the bug: the stamp was lost, so the sweep
  // decides all over again. The key refuses it, and the room hears it once.
  const second = await withTx(db.pool, (c) => outbox.enqueue(c, {
    groupId, kind: 'opened', idempotencyKey: `g${groupId}:opened`,
  }));
  assert.equal(second.data.queued, false, 'already said');

  const r = recorder();
  const out = await outbox.drainOnce(db.pool, r.deps);
  assert.equal(out.sent, 1);
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0].body, /כולם כאן/);
});

test('a sender that died with the message in flight does not hand the row back', async () => {
  await withTx(db.pool, (c) => outbox.enqueue(c, {
    groupId, kind: 'intro', idempotencyKey: `g${groupId}:intro`,
  }));
  const { rows: [row] } = await db.pool.query(`SELECT id FROM group_outbox`);

  // What brokerd does before it spawns anything: take the claim. Then it dies
  // — no markSent, no rollback of the claim, exactly as on 2026-09-07.
  const claimed = await outbox.claim(db.pool, row.id);
  assert.ok(claimed, 'the claim was taken');

  const r = recorder();
  const out = await outbox.drainOnce(db.pool, r.deps);
  assert.deepEqual(r.sent, [], 'nobody says it a second time');
  assert.equal(out.sent, 0);

  // And it does not sit unsent for ever either: once the claim is old enough
  // to be a dead process rather than a slow CLI, it is closed as unconfirmed.
  const later = new Date(Date.now() + outbox.STALE_CLAIM_MS + 1000);
  const swept = await outbox.drainOnce(db.pool, { ...r.deps, now: later });
  assert.equal(swept.stale, 1);
  const { rows: [after] } = await db.pool.query(`SELECT sent_at, hold_reason FROM group_outbox`);
  assert.ok(after.sent_at);
  assert.equal(after.hold_reason, 'unconfirmed');
  assert.deepEqual(r.sent, [], 'still nothing said twice');
});

test('a send that was refused is tried once more, and then let go', async () => {
  await withTx(db.pool, (c) => outbox.enqueue(c, {
    groupId, kind: 'intro', idempotencyKey: `g${groupId}:intro`,
  }));
  const r = recorder('failed');

  const first = await outbox.drainOnce(db.pool, r.deps);
  assert.equal(first.failed, 1);
  let { rows: [row] } = await db.pool.query(`SELECT attempts, claimed_at, sent_at FROM group_outbox`);
  assert.equal(row.claimed_at, null, 'back on the queue');
  assert.equal(row.attempts, 1, 'and the attempt is still counted');
  assert.equal(row.sent_at, null);

  const second = await outbox.drainOnce(db.pool, r.deps);
  assert.equal(second.abandoned, 1);
  ({ rows: [row] } = await db.pool.query(`SELECT sent_at, hold_reason, last_error FROM group_outbox`));
  assert.ok(row.sent_at, 'terminal, so nothing retries it next week');
  assert.equal(row.hold_reason, 'abandoned');
  assert.ok(row.last_error);
  assert.equal(r.sent.length, 2, 'two attempts, and no third');
});

test('a timeout counts as said, because the gateway already has it', async () => {
  await withTx(db.pool, (c) => outbox.enqueue(c, {
    groupId, kind: 'opened', idempotencyKey: `g${groupId}:opened`,
  }));
  const r = recorder('unknown');
  const out = await outbox.drainOnce(db.pool, r.deps);
  assert.equal(out.unconfirmed, 1);
  const { rows: [row] } = await db.pool.query(`SELECT sent_at, hold_reason FROM group_outbox`);
  assert.ok(row.sent_at, 'never said again');
  assert.equal(row.hold_reason, 'unconfirmed', 'and the doubt is on the record');
});

test('the words are the owner\'s at DELIVERY, not the ones loaded when it was decided', async () => {
  await withTx(db.pool, (c) => outbox.enqueue(c, {
    groupId, kind: 'opened', idempotencyKey: `g${groupId}:opened`,
  }));
  // He rewords it while the row is queued — a night hold is hours long.
  await withTx(db.pool, (c) => flags.setFlag(c, templates.FLAG, { group_opened: 'כולם פה, יאללה 🎉' }));
  const r = recorder();
  await outbox.drainOnce(db.pool, r.deps);
  assert.equal(r.sent[0].body, 'כולם פה, יאללה 🎉');
  await withTx(db.pool, (c) => flags.setFlag(c, templates.FLAG, {}));
});

test('a notice is quoted under the message that asked for it', async () => {
  await withTx(db.pool, (c) => outbox.enqueue(c, {
    groupId, kind: 'gate_notice',
    payload: { kind: 'explain', missing: ['+972603000101'] },
    replyTo: 'TAG-7', idempotencyKey: `g${groupId}:notice:1`,
  }));
  const r = recorder();
  await outbox.drainOnce(db.pool, r.deps);
  assert.equal(r.sent[0].replyTo, 'TAG-7');
  assert.match(r.sent[0].body, /@\+972603000101/);
});

// Nothing in this table may name a person. The whole argument for a second
// queue instead of a `group_id` column on `outbox` is that the user gate stays
// the only door to a human being, and a schema that cannot address one is what
// makes that true rather than merely intended.
test('the room queue has no way to address a person', async () => {
  const { rows } = await db.pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'group_outbox'`);
  const names = rows.map((r) => r.column_name);
  assert.equal(names.includes('user_id'), false);
  assert.deepEqual(names.filter((n) => /user|phone|recipient/.test(n)), []);
});
