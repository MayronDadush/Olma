#!/usr/bin/env node
'use strict';
// One-off: resume user 23 (מעיין) and queue the one message the owner approved.
//
// She wrote on 2026-09-05 at 23:06 Israel time and the gateway discarded the
// message without a trace (see scripts/onboard-maayan.js for the evidence).
// She was provisioned paused so no sweep could reach her before the owner had
// read what she would be told; this lifts that and queues exactly that text.
//
// It goes through the outbox rather than the CLI so the send is gated,
// audited, counted against her budget and marked self-initiated — an unmarked
// proactive turn moves last_inbound_at and resets the check-in backoff, which
// is how one silent user got four good mornings (incidents.md).
//
// The wording is fixed, not generated: the owner approved these exact words,
// so the instruction pins them rather than describing them. Everything the
// agent says on a --deliver turn reaches her phone.
//
//   node scripts/send-maayan-apology.js            # rehearse (rolls back)
//   node scripts/send-maayan-apology.js --apply
const { createPool, withTx } = require('../src/db/pool');
const pause = require('../src/domain/pause');
const outbox = require('../src/outbox/enqueue');

const USER_ID = 23;

const MESSAGE = [
  'היי מעיין, כאן עולמה. ההודעה שלך מאתמול בערב נתקעה בדרך אליי ולא הגיעה — מצטערת, זו תקלה אצלי, לא משהו שעשית.',
  '',
  'סידרתי את שתי התזכורות:',
  '• כל יום ב-12:00 — לשלוח החזרים לקופה. אמשיך עד שתגידי לי שטופל.',
  '• מחר, יום שני, ב-11:00 — לקחת צ׳ק מבית ספר היובל.',
  '',
  'התזכורת על הצ׳ק הייתה אמורה לצאת היום ב-11:00 ולא יצאה, אז העברתי אותה למחר.',
].join('\n');

const INSTRUCTION = 'Say the following message to the user EXACTLY as written, '
  + 'character for character, including the line breaks and the bullet characters. '
  + 'Add nothing: no greeting of your own, no closing question, no emoji, no rephrasing, '
  + 'and no second message. Do not call any tool first — everything needed is here. '
  + `The message: <<<${MESSAGE}>>>`;

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = createPool();
  try {
    await withTx(pool, async (client) => {
      const resumed = await pause.resumeUser(client, USER_ID);
      if (!resumed.ok) throw new Error(`resume failed: ${resumed.error.message}`);
      console.log(`user ${USER_ID} resumed`);

      // Keyed so a re-run cannot queue it twice.
      const q = await outbox.enqueue(client, {
        userId: USER_ID,
        kind: 'intake_recovery_apology',
        urgency: 'normal',
        idempotencyKey: 'maayan-dropped-intake-20260905',
        payload: { instruction: INSTRUCTION },
      });
      if (!q.ok) throw new Error(`enqueue failed: ${q.error.message}`);
      console.log(`outbox row ${q.data.outboxId} (enqueued=${q.data.enqueued})`);

      if (!apply) {
        console.log('\nrehearsal — rolling back');
        throw new Error('__rollback__');
      }
    });
    console.log('\nCOMMITTED. She is un-paused and the message is queued for the next drain.');
  } catch (e) {
    if (e && e.message === '__rollback__') {
      console.log('rolled back cleanly. Re-run with --apply to commit.');
    } else {
      throw e;
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
