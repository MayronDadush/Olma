#!/usr/bin/env node
// Write down the names we already had.
//
// A WhatsApp display name arrives with every inbound turn, in the gateway's
// "Conversation info" block. Until turn_start started passing it through,
// nothing ever recorded it — so people sat with first_name NULL while their
// name was in front of the agent on every single message, and in one case in
// their fact card as prose ("שמו חיים.") with the card's own header still
// reading "First name: unknown" two lines above it.
//
// This reads that display name back out of the gateway's own trajectory files
// and stores it as what it is: a GUESS. name_confirmed stays false, so the
// agent still checks it in conversation. Nothing is sent to anyone.
//
// Usage:
//   node scripts/repair-missing-name.js                       # everyone missing a name
//   node scripts/repair-missing-name.js --phone 0505404255    # just this person
//   node scripts/repair-missing-name.js --phone 0505404255 --name "חיים"
//   ... plus --apply to write, --keep-facts to leave name-facts alone
//
// Dry run by default. Re-running is a no-op: a user who now has a name is no
// longer missing one, and a name they have since confirmed is never overwritten.
'use strict';
const { createPool, withTx } = require('../src/db/pool');
const repair = require('../src/domain/repair');
const sessions = require('../src/channels/sessions');
const { refreshUserCard } = require('../src/intake/user-card');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}

const phone = arg('phone');
const nameOverride = arg('name');
const APPLY = process.argv.includes('--apply');
const DROP_FACTS = !process.argv.includes('--keep-facts');

if (nameOverride && !phone) {
  console.error('--name applies to one person: pass --phone too');
  process.exit(1);
}

(async () => {
  const pool = createPool();

  let targets = await withTx(pool, (c) => repair.usersMissingName(c));
  if (phone) {
    const found = await withTx(pool, (c) => repair.findUserByPhoneFragment(c, phone));
    if (!found.ok) {
      console.error(`${found.error.code}: ${found.error.message}`);
      if (found.error.candidates) console.error('  candidates:', found.error.candidates.join(', '));
      await pool.end();
      process.exit(1);
    }
    targets = targets.filter((u) => String(u.id) === String(found.data.user.id));
    if (!targets.length) {
      console.log(`user ${found.data.user.id} ${found.data.user.phone} already has a name (${found.data.user.first_name}) — nothing to repair`);
      await pool.end();
      return;
    }
  }

  if (!targets.length) {
    console.log('no active user is missing a name');
    await pool.end();
    return;
  }

  const plan = [];
  for (const u of targets) {
    // The override is for the case this script cannot solve on its own: a peer
    // who never set a display name at all. It is still stored unconfirmed —
    // an operator typing a name in is no more certain than the gateway's.
    const name = nameOverride || sessions.readPeerDisplayName(u.agent_id, u.phone);
    const facts = name
      ? await withTx(pool, (c) => repair.nameFactCandidates(c, u.id, name.split(' ')[0]))
      : [];
    plan.push({ user: u, name, facts });
  }

  for (const { user, name, facts } of plan) {
    console.log(`user ${user.id} ${user.phone} (agent ${user.agent_id})`);
    if (!name) {
      console.log('  no display name anywhere in their sessions — pass --name "X" if you know it\n');
      continue;
    }
    const [first, ...rest] = name.split(' ');
    console.log(`  would set first_name=${first}${rest.length ? ` last_name=${rest.join(' ')}` : ''}, name_confirmed=FALSE`);
    console.log(`  source: ${nameOverride ? 'operator' : "the gateway's own Conversation info"}`);
    for (const f of facts) {
      console.log(`  would forget fact #${f.id} [${f.category}] "${f.fact}"${DROP_FACTS ? '' : ' (kept: --keep-facts)'}`);
    }
    console.log('');
  }

  if (!APPLY) {
    console.log('dry run — pass --apply to write');
    await pool.end();
    return;
  }

  for (const { user, name } of plan) {
    if (!name) continue;
    const res = await withTx(pool, (c) => repair.repairMissingName(c, user.id, {
      name, dropFacts: DROP_FACTS,
      source: nameOverride ? 'operator' : 'whatsapp_display_name',
    }));
    if (!res.ok) {
      console.error(`user ${user.id}: ${res.error.code}: ${res.error.message}`);
      continue;
    }
    // USER.md is what the agent actually reads. After the commit, never inside
    // it — the same rule the dashboard's own edits follow.
    await refreshUserCard(pool, user.id);
    const { first_name: f, last_name: l } = res.data.user;
    console.log(`user ${user.id}: ${[f, l].filter(Boolean).join(' ')} (unconfirmed)`
      + `${res.data.forgotten.length ? `, forgot ${res.data.forgotten.length} name-fact(s)` : ''}, card refreshed`);
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
