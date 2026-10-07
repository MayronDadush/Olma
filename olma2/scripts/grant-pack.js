#!/usr/bin/env node
// Turn a pack on for named people, by hand: the owner's door to the same two
// steps brokerd takes when somebody asks for game nights (domain/packs.js) —
// the `user_packs` row, then that agent's `tools.deny` without the pack's glob.
//
// People are found by first name (Hebrew or English, as on their record), by
// phone, or by id. A name that matches nobody, or more than one active
// person, is refused and the matches are listed: the wrong person getting a
// pack is worse than a second run. Dry run unless --apply.
//
// Usage:
//   node scripts/grant-pack.js --pack food מירון מאיה
//   node scripts/grant-pack.js --pack food --apply 12 +972501234567
'use strict';
const { PACKS } = require('../src/intake/agent-tool-policy');
const packs = require('../src/domain/packs');

async function find(pool, who) {
  const s = String(who).trim();
  if (/^\d{1,9}$/.test(s)) {
    return (await pool.query(`SELECT id, first_name, last_name, phone, agent_id FROM users WHERE id = $1 AND status = 'active'`, [Number(s)])).rows;
  }
  if (/^\+?\d{9,15}$/.test(s)) {
    const digits = s.replace(/^\+/, '');
    return (await pool.query(`SELECT id, first_name, last_name, phone, agent_id FROM users WHERE regexp_replace(phone, '\\D', '', 'g') = $1 AND status = 'active'`, [digits])).rows;
  }
  return (await pool.query(
    `SELECT id, first_name, last_name, phone, agent_id FROM users
      WHERE status = 'active' AND (lower(first_name) = lower($1) OR lower(first_name || ' ' || COALESCE(last_name, '')) = lower($1))
      ORDER BY id`, [s])).rows;
}

const masked = phone => (phone ? `…${String(phone).slice(-4)}` : '—');

async function main(argv, { pool, configPath, log = console.log } = {}) {
  const apply = argv.includes('--apply');
  const i = argv.indexOf('--pack');
  const pack = i >= 0 ? argv[i + 1] : null;
  const people = argv.filter((a, k) => !a.startsWith('--') && !(i >= 0 && k === i + 1));
  if (!pack || !PACKS[pack]) throw new Error(`--pack is one of: ${Object.keys(PACKS).join(', ')}`);
  if (!people.length) throw new Error('name at least one person (first name, phone or id)');

  const found = [];
  let refused = 0;
  for (const who of people) {
    const rows = await find(pool, who);
    if (rows.length !== 1) {
      refused += 1;
      log(`REFUSED "${who}": ${rows.length ? `${rows.length} people match — use an id` : 'nobody active matches'}`);
      for (const r of rows) log(`   id ${r.id}  ${r.first_name || ''} ${r.last_name || ''}  ${masked(r.phone)}`);
      continue;
    }
    found.push(rows[0]);
    log(`"${who}" → id ${rows[0].id} ${rows[0].first_name || ''} ${rows[0].last_name || ''} (${masked(rows[0].phone)})`);
  }
  if (refused) { log('Nothing written: fix the names above and run again.'); return { written: 0, refused }; }
  if (!apply) { log(`Dry run. --apply turns on '${pack}' for these ${found.length}.`); return { written: 0, refused: 0, found: found.map(r => Number(r.id)) }; }

  let written = 0;
  for (const u of found) {
    const r = await packs.enable(pool, Number(u.id), pack, 'owner');
    written += r.enabled ? 1 : 0;
    let tools = 'no agent yet: the next deploy\'s sync shows them the tools';
    if (u.agent_id) {
      try { tools = packs.applyPolicy(u.agent_id, r.packs, { configPath }).changed ? 'tools shown now' : 'their tools were already right'; } catch (e) { tools = `tools NOT shown yet (${e.message}); run scripts/sync-agent-tool-policies.js --apply`; }
    }
    log(`id ${u.id}: ${r.enabled ? `'${pack}' on` : `already had '${pack}'`}; ${tools}`);
  }
  return { written, refused: 0 };
}

if (require.main === module) {
  const pool = require('../src/db/pool').createPool();
  main(process.argv.slice(2), { pool })
    .then(r => { process.exitCode = r.refused ? 1 : 0; })
    .catch(e => { console.error(e.message); process.exitCode = 2; })
    .finally(() => pool.end());
}

module.exports = { main };
