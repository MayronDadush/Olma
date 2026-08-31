'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { sweepVoiceUsage } = require('../src/jobs/voice-usage');

let db, user;

// A canned Twilio Calls response. Prices are negative strings and arrive
// LATE (null for minutes after a call ends) — both are Twilio's real shapes,
// taken from a live response on 2026-08-31.
function twilioFetch(calls) {
  return async () => ({ ok: true, json: async () => ({ calls }) });
}

before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972526000111');
});
after(async () => { await db.teardown(); });

test('voice sweep records calls, attributes known numbers, and back-fills late prices', async () => {
  const calls = [
    { sid: 'CA1', to: '+972526000111', status: 'completed', start_time: 'Mon, 31 Aug 2026 12:00:00 +0000', duration: '75', price: '-0.12920', price_unit: 'USD' },
    // Fresh call: Twilio has not priced it yet. null must stay null — a 0
    // here would read as "this call was free".
    { sid: 'CA2', to: '+972526000111', status: 'completed', start_time: 'Mon, 31 Aug 2026 12:05:00 +0000', duration: '42', price: null },
    // Number that is nobody's user — the row is kept, unattributed.
    { sid: 'CA3', to: '+15550001111', status: 'completed', start_time: 'Mon, 31 Aug 2026 12:10:00 +0000', duration: '30', price: '-0.06460' },
  ];
  const c = await db.pool.connect();
  try {
    const out = await sweepVoiceUsage(c, { sid: 'AC_test', token: 'tok', fetch: twilioFetch(calls) });
    assert.equal(out.seen, 3);
    assert.equal(out.priced, 2);

    const { rows } = await c.query(`SELECT * FROM voice_usage_ledger ORDER BY call_sid`);
    assert.equal(rows.length, 3);
    assert.equal(Number(rows[0].twilio_usd), 0.1292, 'negative string stored as positive spend');
    assert.equal(Number(rows[0].user_id), Number(user.id));
    assert.equal(rows[1].twilio_usd, null, 'unsettled price stays null, never 0');
    assert.equal(rows[2].user_id, null, 'unknown number keeps the row, unattributed');

    // Next tick: Twilio settled CA2's price. The upsert back-fills it.
    calls[1].price = '-0.06460';
    await sweepVoiceUsage(c, { sid: 'AC_test', token: 'tok', fetch: twilioFetch(calls) });
    const { rows: after2 } = await c.query(`SELECT twilio_usd FROM voice_usage_ledger WHERE call_sid = 'CA2'`);
    assert.equal(Number(after2[0].twilio_usd), 0.0646);

    // And a tick with nothing new changes nothing (rowCount discipline).
    const idle = await sweepVoiceUsage(c, { sid: 'AC_test', token: 'tok', fetch: twilioFetch(calls) });
    assert.equal(idle.upserted, 0, 'unchanged calls are not rewritten every tick');
  } finally { c.release(); }
});

test('voice sweep without Twilio credentials skips instead of throwing', async () => {
  const c = await db.pool.connect();
  try {
    const out = await sweepVoiceUsage(c, { sid: '', token: '' });
    assert.equal(out.skipped, 'twilio not configured');
  } finally { c.release(); }
});
