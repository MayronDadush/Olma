'use strict';
// The cost page reads its dollars out of ledgers that are append-only by
// design, so a row written under a wrong rate keeps that rate for ever. That
// is right for the record and wrong for the screen: on 2026-09-06 the owner
// looked at this page, saw the eval user at $5.76 for the month, and asked
// whether that was reasonable. It was not the number — $3.98 of it was four
// rows from one pilot day, priced by the blended fallback at up to 54x the
// models' real published prices, all of it measured and corrected in
// domain/model-pricing.js three days earlier and none of it reaching the page.
//
// The founding case is replayed first with the real row, real token counts and
// the real stored figure. The case that must NOT change matters as much: a
// model with no rate even today still has nothing better than the fallback,
// and must keep both its stored cost and its ≈.
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });
beforeEach(async () => { await db.pool.query('DELETE FROM usage_ledger'); });

const section = () => require('../src/adapters/http/dashboard')
  .SECTIONS.find((s) => s.id === 'cost');
const render = () => withTx(db.pool, (c) => section().render(c, 'csrf'));

// Every figure renders shekels-first with USD in a parenthesised span, so the
// assertions read the dollars: they are what the rate table is denominated in,
// and they do not move when the FX rate does.
function usdFor(html, label) {
  const row = new RegExp(`<td>${label}</td><td>(.*?)</td>`).exec(html);
  assert.ok(row, `no row for ${label} in the rendered page`);
  const usd = /\$([\d.]+)/.exec(row[1]);
  assert.ok(usd, `no USD figure in "${row[1]}"`);
  return Number(usd[1]);
}

async function ledger(userId, model, cols) {
  await db.pool.query(
    `INSERT INTO usage_ledger (user_id, date, model, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, estimated)
     VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [userId, model, cols.i, cols.o, cols.cr, cols.cw,
      cols.i + cols.o + cols.cr + cols.cw, cols.stored, cols.estimated !== false]);
}

test('the pilot row that cost $2.54 on the page and 16 cents in reality', async () => {
  const u = await makeUser(db.pool, '+972500001001', { firstName: 'בדיקה' });
  // The real 2026-09-02 row, as it sits in production: 1,691,980 total tokens
  // against 195 in / 7,843 out, so almost all of it is cache — which is what
  // makes the blended-per-token fallback so violently wrong for this model.
  await ledger(u.id, 'openai/gpt-5.6-luna',
    { i: 195, o: 7843, cr: 1_683_942, cw: 0, stored: 2.5380 });

  const usd = usdFor(await render(), 'בדיקה');
  assert.ok(usd < 0.5, `still showing the fallback price: $${usd}`);
  // 195*0.20 + 7843*1.20 + 1683942*0.02, all per Mtok.
  assert.ok(Math.abs(usd - 0.043) < 0.02, `expected ~$0.04 from the real rates, got $${usd}`);
});

test('a model with no rate keeps its stored cost, and keeps saying so', async () => {
  const u = await makeUser(db.pool, '+972500001002', { firstName: 'לא-ידוע' });
  await ledger(u.id, 'somebody/model-nobody-has-priced',
    { i: 1000, o: 1000, cr: 0, cw: 0, stored: 0.4242 });

  const html = await render();
  assert.ok(Math.abs(usdFor(html, 'לא-ידוע') - 0.4242) < 0.001,
    'with no better answer available, the stored fallback IS the best answer');
  assert.match(html, /≈/, 'and the page must still admit it is a guess');
});

test('the judge that was priced at zero now shows what it actually costs', async () => {
  // The other direction, and the reason this is not simply "the number was too
  // high": moonshotai/kimi-k2.6 judges every eval conversation and was written
  // to the ledger at $0.00 from 2026-08-28 to 2026-09-03. Understating is the
  // more dangerous error — nobody investigates a zero.
  const u = await makeUser(db.pool, '+972500001003', { firstName: 'שופט' });
  await ledger(u.id, 'moonshotai/kimi-k2.6',
    { i: 14954, o: 58905, cr: 0, cw: 0, stored: 0 });

  const usd = usdFor(await render(), 'שופט');
  assert.ok(usd > 0.2, `a judge that costs real money still reads as free: $${usd}`);
});

test('a correctly-priced row is left exactly where it was', async () => {
  // The regression that would matter most: re-pricing must be a no-op for the
  // model that serves every real user, or this "fix" silently restates the
  // entire bill.
  const u = await makeUser(db.pool, '+972500001004', { firstName: 'רגיל' });
  await ledger(u.id, 'deepseek/deepseek-v4-flash',
    { i: 1_126_555, o: 14_309, cr: 1_337_856, cw: 0, stored: 0.1153, estimated: false });

  const usd = usdFor(await render(), 'רגיל');
  assert.ok(Math.abs(usd - 0.1153) < 0.05,
    `a row that was already right moved to $${usd}`);
});

test('the totals and the per-user rows tell the same story', async () => {
  // The month total is summed separately from the rows; a fix that repriced
  // one and not the other would put a page-wide contradiction in front of the
  // person who reads this daily.
  const a = await makeUser(db.pool, '+972500001005', { firstName: 'אחת' });
  const b = await makeUser(db.pool, '+972500001006', { firstName: 'שתיים' });
  await ledger(a.id, 'openai/gpt-5.4-nano', { i: 79_290, o: 2_629, cr: 774_656, cw: 0, stored: 1.2849 });
  await ledger(b.id, 'deepseek/deepseek-v4-flash', { i: 100_000, o: 1_000, cr: 0, cw: 0, stored: 0.02, estimated: false });

  const html = await render();
  const rows = usdFor(html, 'אחת') + usdFor(html, 'שתיים');
  // "סה״כ החודש" labels three different blocks on this page (media, voice and
  // the model table), so the search starts at the model heading — matching the
  // first one silently compared the model rows against the image-generation
  // total, which is $0.00 and would have made this test pass for the wrong
  // reason on any month nobody generated an image.
  const modelBlock = html.slice(html.indexOf('עלות מודל לפי משתמש'));
  const total = /<div class="num">(.*?)<\/div><div class="lbl">סה״כ החודש/.exec(modelBlock);
  assert.ok(total, 'the month total is not on the page');
  const totalUsd = Number(/\$([\d.]+)/.exec(total[1])[1]);
  // The headline rounds to two places while the rows show three, so this is
  // "the same story", not "the same string".
  assert.ok(Math.abs(totalUsd - rows) < 0.011,
    `total $${totalUsd} does not match the rows' $${rows.toFixed(4)}`);
});
