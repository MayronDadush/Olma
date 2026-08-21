'use strict';
// Registers the BIGINT (int8, OID 20) result parser. Required for its side
// effect by every module that opens a pg connection — pool.js, migrate.js's
// CLI path, and tests/helpers.js — because setTypeParser is global to the pg
// module, but only takes effect if something actually loads it first.
//
// WHY: node-pg returns int8 as a STRING by default, since a bigint does not
// fit a JS number in general. Every id in this schema is
// `BIGINT GENERATED ALWAYS AS IDENTITY`, so every id read from the DB was a
// string while every id arriving as an MCP tool argument was a JSON number.
// `===`/`!==` between the two is then silently false, with no error anywhere:
// a guard that compares them never fires and a filter that should drop a row
// never drops it. Two live bugs of exactly this shape (shares.js refusing
// every add_subtask_to_shared call, registry.js telling a meeting initiator
// they had declined their own slot) were fixed one site at a time; this
// closes the class instead.
//
// The safe-integer guard is not decoration: Number() past 2^53 rounds
// silently, which would trade a visible type mismatch for an invisible wrong
// answer. Above that bound the raw string is returned unchanged, so the
// caller gets the old behaviour back rather than a corrupted id. Nothing in
// this schema can reach it — identity columns start at 1, and the only other
// BIGINT columns are the token counters in usage_ledger and
// usage_session_snapshots, whose dashboard rollups go through sum(), which
// returns NUMERIC/OID 1700 and is not touched by this parser at all. The
// fallback is a correctness backstop, not a case the code expects to hit.
const pgTypes = require('pg').types;

const INT8_OID = 20;

pgTypes.setTypeParser(INT8_OID, (value) => {
  if (value === null) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : value;
});

module.exports = { INT8_OID };
