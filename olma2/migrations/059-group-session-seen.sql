-- One watermark per (group, gateway session), replacing the single
-- `chat_groups.last_seen_at`.
--
-- A room has SEVERAL gateway sessions — the muted greeter's, and, once it is
-- open, its own `g-N` agent's. The sweep's loop runs once per session while
-- `last_seen_at` was one column, written at the end of each iteration with
-- that session's stamp. So the last session in the list overwrote whatever the
-- earlier ones had put there, the earlier one read a number belonging to
-- somebody else on the next pass, and "is this turn newer than our watermark"
-- answered yes for ever.
--
-- Measured live on 2026-09-09, two readings three minutes apart with nobody
-- writing in any room:
--
--   20:43:10.113694   groups 1, 2 and 3 — identical to the microsecond
--   20:46:17.003274   groups 1, 2 and 3 — identical to the microsecond
--
-- Three `UPDATE … now()` in one transaction, every ten seconds, for ever,
-- while `last_seen_at` sat two days stale at exactly the `g-N` stamp. What it
-- fed — `chat_groups.last_mention_at` — loses its last writer here and its
-- last reader with it (the admin table's "תיוג אחרון", which read "seconds
-- ago" for every room for ever). What the watermark GATES, the "tagged while
-- locked" notice, was one accident of coupling away from firing every ten
-- seconds — see `jobs/groups.js`. Neither column is dropped: migrations here
-- are additive.
--
-- Keyed by the gateway's own session KEY rather than by agent id. It is what
-- `listSessionsForAgent` hands us and what the loop is actually iterating, so
-- the row and the thing it is a watermark FOR cannot drift apart. A session
-- that goes away leaves its row behind, which costs one dead row per retired
-- group agent and is the reason there is no cleanup here: a stale watermark is
-- read by nothing, and deleting rows on a guess about which sessions still
-- exist is how a room gets told something twice.
--
-- `chat_groups.last_seen_at` is left in place and stops being written.
-- Additive, like every migration here: `deploy.sh --restart` rolls back code
-- only, so the old code must still find its column if this ships and the
-- release behind it comes back.
CREATE TABLE IF NOT EXISTS chat_group_session_seen (
  group_id     BIGINT      NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  session_key  TEXT        NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (group_id, session_key)
);

-- Seed, under a session key no real session can ever have.
--
-- A session with no watermark of its own must not start at zero: the sweep
-- would read the room's whole history as one fresh turn and answer a message
-- nobody sent. So the LOOKUP falls back to the newest watermark the room has
-- (`max` over this table), and this row is what that `max` finds on the first
-- pass after the deploy — the value the single column already held, which is
-- the newest stamp any of the room's sessions had reached.
--
-- Wrong for all but one session per room, and wrong in the safe direction:
-- too NEW means "nothing has happened since", which is silence. Too old means
-- answering the past. Each session stamps its own truth on the pass after.
--
-- '*' is not a session key the gateway can produce (they are all
-- `agent:<id>:whatsapp:group:<jid>`), so nothing ever matches it directly and
-- it survives only inside that `max`. It goes stale the moment any real
-- session writes a newer row, and is left behind rather than cleaned up: a row
-- read by nothing costs nothing, and a DELETE here would be guessing.
INSERT INTO chat_group_session_seen (group_id, session_key, last_seen_at)
     SELECT id, '*', last_seen_at FROM chat_groups WHERE last_seen_at IS NOT NULL
ON CONFLICT DO NOTHING;
