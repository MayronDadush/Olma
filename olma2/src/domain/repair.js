'use strict';
// Operator helpers for the scripts that repair one person by hand
// (scripts/rotate-identity-token.js, scripts/close-stale-meeting.js).
//
// This file used to also hold the goal and display-name repairs of 2026-08-21
// and 08-22 (incidents.md, "A goal said out loud left no trace anywhere").
// Their scripts ran once and were removed on 2026-10-03; git has both.
const { ok, err } = require('./results');

// Operators have the number in whatever form it reaches them — "0505404255",
// "050-540-4255", "+972505404255". Rather than guess a country for a national
// number (the mistake domain/contacts.js documents at length), match on the
// trailing digits and refuse anything ambiguous: a repair aimed at the wrong
// person messages a stranger about a goal they never had.
async function findUserByPhoneFragment(client, raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length < 6) return err('invalid', 'give at least 6 digits of their number');
  const { rows } = await client.query(
    `SELECT id, phone, first_name, agent_id, timezone, checkin_misses,
            last_inbound_at, last_fact_extraction_at, status
       FROM users
      WHERE regexp_replace(phone, '\\D', '', 'g') LIKE '%' || $1
      ORDER BY id`,
    [digits]
  );
  if (!rows.length) return err('not_found', `no user whose number ends with ${digits}`);
  if (rows.length > 1) {
    return err('invalid', 'that fragment matches more than one person', {
      candidates: rows.map((u) => `${u.id} ${u.phone}`),
    });
  }
  return ok({ user: rows[0] });
}

module.exports = { findUserByPhoneFragment };
