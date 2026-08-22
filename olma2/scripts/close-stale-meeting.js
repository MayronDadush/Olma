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
//   node scripts/close-stale-meeting.js                        # list ALL open
//   node scripts/close-stale-meeting.js --phone 0505404255      # list one person's
//   node scripts/close-stale-meeting.js --id 4 --apply           # close one
//
// --phone narrows the listing; it is never required. Finding the meeting to
// close should never depend on already knowing whose phone number it is — a
// wrong guess at a number closes a stranger's meeting and messages them about
// it, which is exactly the kind of mistake this script exists to avoid.
//
// Closing tells EVERY participant once — not just the initiator — through the
// normal outbox, held by each person's own quiet hours like any other
// proactive message. The person most likely to be waiting on this is often
// the one who was asked, not the one who asked.
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

(async () => {
  const pool = createPool();

  if (!id) {
    let userId = null;
    if (phone) {
      const found = await withTx(pool, (c) => repair.findUserByPhoneFragment(c, phone));
      if (!found.ok) {
        console.error(`${found.error.code}: ${found.error.message}`);
        if (found.error.candidates) console.error('  candidates:', found.error.candidates.join(', '));
        await pool.end();
        process.exit(1);
      }
      const u = found.data.user;
      console.log(`user ${u.id} ${u.phone} (${u.first_name || 'no name'}) — open negotiations:\n`);
      userId = u.id;
    } else {
      console.log('All open negotiations, every user:\n');
    }

    const list = await withTx(pool, (c) => meetings.listNegotiating(c, userId));
    if (!list.data.meetings.length) console.log('  (none)');
    for (const m of list.data.meetings) {
      console.log(`  #${m.id} "${m.title || 'meeting'}"`);
      console.log(`     participants: ${m.participants || '(none?)'}`);
      console.log(`     slot text   : ${m.proposed_slot || '(none proposed)'}`);
      console.log(`     slot time   : ${m.proposed_start_at || 'NULL — proposed before slots carried one'}`);
      console.log(`     untouched   : ${Number(m.days_since_update).toFixed(1)} days\n`);
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
    // expireOne only succeeds once — the UPDATE is gated on status =
    // 'negotiating', so if the automatic sweep got here first this call
    // already returned not_found above and nothing below ever runs. Nothing
    // can be told about this meeting twice.
    for (const uid of closed.data.participantIds) {
      await enqueue(c, {
        userId: uid, kind: 'meeting_expired',
        payload: { meetingId: Number(m.id), title: m.title || 'meeting', slot: m.proposed_slot },
        urgency: 'normal',
        idempotencyKey: `mexpired:${m.id}:${uid}`,
      });
    }
    return closed;
  });

  if (!res.ok) {
    console.error(`${res.error.code}: ${res.error.message}`);
    await pool.end();
    process.exit(1);
  }
  console.log(`closed meeting #${res.data.meeting.id} ("${res.data.meeting.title || 'meeting'}") as expired;`);
  console.log(`${res.data.participantIds.length} participant(s) will be told once, each when their own window is open.`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
