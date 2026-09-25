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

// Asked on 2026-09-23, after the poker room spent an afternoon joking with
// her: what does a ROOM cost? Its agent's turns were already in the ledger,
// under `g-<id>` in usage_system_ledger, and the only place they showed was a
// bare "g-3 (מערכת)" on this page. Both pages are rendered for real here; the
// numbers are read back out of the HTML, not out of a copy of the query.
test('a room\'s own agent has a cost on the groups page, and a name on the cost page', async () => {
  const groups = require('../src/domain/groups');
  const { renderGroups } = require('../src/adapters/http/admin/sections/groups');
  const member = await makeUser(db.pool, '+972500000011', { firstName: 'Bar' });
  const g = await withTx(db.pool, async (client) => {
    const reg = await groups.registerGroup(client, {
      externalId: '120363999999999900@g.us', subject: 'פחם הסעות', members: [{ phone: member.phone }],
    });
    assert.ok(reg.ok);
    const { rows } = await client.query(
      `UPDATE chat_groups SET agent_id = 'g-' || id WHERE id = $1 RETURNING *`, [reg.data.group.id]);
    return rows[0];
  });
  // One row this month and one from a year ago: the column says both, and
  // only one of them is "this month". A model with a published rate, so the
  // figure is a price and not the ≈ fallback. 1M input + 1M output at
  // deepseek-v4-flash's rates, priced by the table rather than hard-coded here.
  const pricing = require('../src/domain/model-pricing');
  const model = 'deepseek/deepseek-v4-flash';
  const today = new Date().toISOString().slice(0, 10);
  const yearAgo = new Date(Date.now() - 366 * 86400e3).toISOString().slice(0, 10);
  const price = (day) => pricing.priceUsage({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, model, 0, day);
  assert.equal(price(today).estimated, false, 'the fixture model has a rate');
  for (const day of [today, yearAgo]) {
    await db.pool.query(
      `INSERT INTO usage_system_ledger (agent_id, date, model, input_tokens, output_tokens, cost_usd)
       VALUES ($1, $2, $3, 1000000, 1000000, 0)`, [g.agent_id, day, model]);
  }

  const html = await withTx(db.pool, (client) => renderGroups(client, 'csrf'));
  assert.match(html, /<th>עלות \(החודש \/ סה״כ\)<\/th>/);
  const usd = (n) => n.toFixed(3);
  const month = price(today).cost, total = month + price(yearAgo).cost;
  assert.ok(html.includes(usd(month)), `this month's ${usd(month)} is on the row`);
  assert.ok(html.includes(usd(total)), `and the all-time ${usd(total)} beside it`);
  assert.match(html, /לא כולל את השיחות הפרטיות/, 'and it says what it leaves out');

  const cost = await withTx(db.pool, (client) => renderCost(client));
  assert.match(cost, /קבוצה: פחם הסעות/);
  assert.ok(!cost.includes(`${g.agent_id} (מערכת)`), 'a room is not a system agent');
});
