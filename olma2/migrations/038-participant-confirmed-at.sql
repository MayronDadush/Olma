-- When each participant said yes. Until now meeting_participants carried no
-- time and no surrogate id at all — its primary key is (meeting_id, user_id) —
-- so "the first person who confirmed" was not derivable from anything in the
-- row. Ownership transfer needs a real total order: re-deriving one at read
-- time from whatever a query happens to return lets two departures a month
-- apart pick different successors from identical data, and writes an audit row
-- naming an owner nobody can reproduce later.
ALTER TABLE meeting_participants ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

-- Deliberately NOT backfilled. Six rows on production confirmed before this
-- column existed, and any timestamp invented for them would be a fabricated
-- fact in an audit trail. They stay NULL, and every ordering sorts
-- `confirmed_at ASC NULLS LAST, user_id ASC` — NULL is "we do not know when",
-- never "confirmed at the epoch", and user_id is a stable total order so the
-- same set always yields the same successor.
