#!/usr/bin/env node
// Go back for the rows the guards were built too late to stop.
//
// domain/facts refuses, at the one door every writer shares, a fact that is a
// bare name statement, Olma's own state, a phone number, or a moment with no
// expiry. Those guards only ever ran on new writes — the rows that motivated
// them were already sitting in live cards, and a Top-K card slot is a real
// cost: on user 3's card a third party's undated birthday, a duplicate of the
// card's own `Calendar: connected` line, and a duplicate of its own
// `First name:` line together held three of ten slots, and "עמית הוא חבר
// שמשחק איתו פוקר" had been pushed off the bottom to make room.
//
// Retiring is domain forgetFact — a SOFT delete. The row stays; it just stops
// being retrieved, which is what makes this safe to run and reversible by
// hand if a judgement here turns out to be wrong.
//
// Usage:
//   node scripts/retire-refused-facts.js                  # report what the guards would now refuse
//   node scripts/retire-refused-facts.js --apply
//   node scripts/retire-refused-facts.js --id 34 --apply  # a specific row, for the cases no guard can see
//
// Dry run by default. The --id form exists because not every bad fact is
// mechanically detectable: "גלי מעדיפה לא להיפגש בשבת" was one meeting's
// constraint generalised into a habit, and it reads exactly like a real one.
'use strict';
const { createPool, withTx } = require('../src/db/pool');
const facts = require('../src/domain/facts');
const audit = require('../src/domain/audit');
const { namesAMoment } = require('../src/domain/datetime');
const { refreshUserCard } = require('../src/intake/user-card');

const APPLY = process.argv.includes('--apply');
const idArg = (() => {
  const i = process.argv.indexOf('--id');
  return i > -1 ? String(process.argv[i + 1] || '').split(',').map(Number).filter(Boolean) : [];
})();

// Why each row fails, in the words of the guard that would now stop it.
function refusalReason(row) {
  if (facts.phoneLike(row.fact)) return 'phone number';
  if (facts.bareNameStatement(row.fact)) return 'bare name statement';
  if (facts.systemState(row.fact)) return "Olma's own state";
  if (!row.expires_at && namesAMoment(row.fact)) return 'names a moment, no expiry';
  return null;
}

(async () => {
  const pool = createPool();
  const { rows } = await pool.query(
    `SELECT f.id, f.user_id, f.fact, f.category, f.expires_at, u.first_name
       FROM user_facts f JOIN users u ON u.id = f.user_id
      WHERE f.active = true AND (f.expires_at IS NULL OR f.expires_at > now())
      ORDER BY f.id`
  );

  const targets = idArg.length
    ? rows.filter((r) => idArg.includes(Number(r.id)))
          .map((r) => ({ row: r, reason: refusalReason(r) || 'named explicitly by the operator' }))
    : rows.map((r) => ({ row: r, reason: refusalReason(r) })).filter((t) => t.reason);

  const missing = idArg.filter((id) => !targets.some((t) => Number(t.row.id) === id));
  if (missing.length) console.error(`not found or already inactive: ${missing.join(', ')}`);

  if (!targets.length) {
    console.log('nothing to retire.');
    await pool.end();
    return;
  }
  for (const { row, reason } of targets) {
    console.log(`${APPLY ? 'retiring' : 'would retire'} #${row.id} (${row.first_name || row.user_id}) `
      + `[${row.category}] ${row.fact}\n    → ${reason}`);
  }
  if (!APPLY) {
    console.log(`\n${targets.length} row(s). Re-run with --apply to write.`);
    await pool.end();
    return;
  }

  const touched = new Set();
  await withTx(pool, async (client) => {
    for (const { row, reason } of targets) {
      const res = await facts.forgetFact(client, row.user_id, row.id);
      if (!res.ok) { console.error(`  #${row.id}: ${res.error.message}`); continue; }
      // On top of the domain's own fact.forgotten row, so the trail says an
      // operator's cleanup did this and not the person correcting Olma.
      await audit.record(client, row.user_id, 'admin.fact.retired',
        { factId: Number(row.id), reason });
      touched.add(Number(row.user_id));
    }
  });
  // After the commit, never inside it — USER.md is what the agent reads.
  for (const userId of touched) await refreshUserCard(pool, userId);
  console.log(`\nretired ${targets.length}, refreshed ${touched.size} card(s).`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
