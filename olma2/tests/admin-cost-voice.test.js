'use strict';
// The admin cost page's "שיחות קול" block grew two lifetime counts for the
// dashboard's 2-call quota (domain/voice.js) — how many people have ever
// tried the button, and how many hit both attempts and asked for more. This
// is a smoke test, not a query-replica test: it calls the real renderCost(),
// on real rows, and reads the numbers back out of the rendered HTML — so it
// fails if the query or the markup drifts, not just if a hand-copied WHERE
// clause does. No secrets are set, so every external cost source degrades to
// configured:false (see infra-cost.test.js) and nothing here touches the
// network.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { renderCost } = require('../src/adapters/http/admin/sections/cost');

let db;
before(async () => { db = await freshDb(); });
after(async () => { if (db) await db.teardown(); });

test('the voice block counts distinct users who tried a call and who asked for more', async () => {
  const tried = await makeUser(db.pool, '+972500000001', { firstName: 'Tried' });
  const askedMore = await makeUser(db.pool, '+972500000002', { firstName: 'AskedMore' });
  await makeUser(db.pool, '+972500000003', { firstName: 'Untouched' });

  await db.pool.query(`UPDATE users SET voice_call_attempts_used = 1 WHERE id = $1`, [tried.id]);
  await db.pool.query(
    `UPDATE users SET voice_call_attempts_used = 2, voice_more_requested_at = now() WHERE id = $1`,
    [askedMore.id]);

  const html = await withTx(db.pool, (client) => renderCost(client));
  assert.match(html, /<div class="num">2<\/div><div class="lbl">ניסו שיחה מהדשבורד<\/div>/,
    'both the 1-attempt and the 2-attempt user count as "tried"');
  assert.match(html, /<div class="num">1<\/div><div class="lbl">ביקשו עוד שיחות<\/div>/,
    'only the user who actually asked counts here');
});
