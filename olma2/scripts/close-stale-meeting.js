#!/usr/bin/env node
// Close a negotiation that died without anyone closing it.
//
// The sweep in jobs/sweeps.js does this on its own for anything whose slot has
// a start time. Rows proposed before slots carried one can only be dated by a
// person reading the text ("יום שישי 20:00" — which Friday?), and the sweep
// falls back to an abandonment window for those. This is the manual door, for
// when someone is visibly stuck behind a dead meeting right now.
//
// Usage:
//   node scripts/close-stale-meeting.js --phone 0505404255            # list
//   node scripts/close-stale-meeting.js --id 4 --apply                # close
//
// Closing tells the initiator once, through the normal outbox — held by their
// own quiet hours like any other proactive message.
'use strict';
const { createPool, withTx } = require('../src/db/pool');
const meetings = require('../src/domain/meetings');
const repair = require('../src/domain/repair');
const { enqueue } = require('../src/outbox/enqueue');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}
const phone = arg('phone');
const id = arg('id');
const APPLY = process.argv.includes('--apply');

if (!phone && !id) {
  console.error('usage: close-stale-meeting.js --phone <number> | --id <meetingId> [--apply]');
  process.exit(1);
}

(async () => {
  const pool = createPool();

  if (phone) {
    const found = await withTx(pool, (c) => repair.findUserByPhoneFragment(c, phone));
    if (!found.ok) {
      console.error(`${found.error.code}: ${found.error.message}`);
      if (found.error.candidates) console.error('  candidates:', found.error.candidates.join(', '));
      await pool.end();
      process.exit(1);
    }
    const u = found.data.user;
    const list = await withTx(pool, (c) => meetings.listNegotiating(c, u.id));
    console.log(`user ${u.id} ${u.phone} (${u.first_name || 'no name'}) — open negotiations:\n`);
    if (!list.data.meetings.length) console.log('  (none)');
    for (const m of list.data.meetings) {
      console.log(`  #${m.id} "${m.title || 'meeting'}"  your state: ${m.your_state}`);
      console.log(`     slot text : ${m.proposed_slot || '(none proposed)'}`);
      console.log(`     slot time : ${m.proposed_start_at || 'NULL — proposed before slots carried one'}`);
      console.log(`     untouched : ${Number(m.days_since_update).toFixed(1)} days\n`);
    }
    console.log('close one with:  --id <n> --apply');
    await pool.end();
    return;
  }

  if (!APPLY) {
    console.log(`would close meeting #${id} as expired and tell its initiator once.`);
    console.log('dry run — pass --apply to write');
    await pool.end();
    return;
  }

  const res = await withTx(pool, async (c) => {
    const closed = await meetings.expireOne(c, Number(id));
    if (!closed.ok) return closed;
    const m = closed.data.meeting;
    // Same message the sweep sends, same idempotency key — so if the sweep had
    // already queued one, this cannot produce a second.
    await enqueue(c, {
      userId: Number(m.initiator_id), kind: 'meeting_expired',
      payload: { meetingId: Number(m.id), title: m.title || 'meeting', slot: m.proposed_slot },
      urgency: 'normal',
      idempotencyKey: `mexpired:${m.id}`,
    });
    return closed;
  });

  if (!res.ok) {
    console.error(`${res.error.code}: ${res.error.message}`);
    await pool.end();
    process.exit(1);
  }
  console.log(`closed meeting #${res.data.meeting.id} ("${res.data.meeting.title || 'meeting'}") as expired;`);
  console.log('its initiator will be told once, when their own window is open.');
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
