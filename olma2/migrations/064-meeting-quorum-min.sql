-- The minimum sits on the COORDINATION, not on the group it came from.
--
-- `chat_groups.quorum_min` (migration 051) answers "how many people make this
-- room's thing happen at all". Read through at render time it would answer a
-- question nobody asked: a poker group with a minimum of 4 could not then open
-- an ordinary two-person coffee out of the same room without inheriting a
-- minimum that has nothing to do with it.
--
-- So this is a COPY taken the moment a coordination opens, never a lookup. The
-- meeting is born with the group's value as its default and from that instant
-- the value is its own — including being set back to NULL, which the group's
-- column cannot express for one meeting. Changing the room's minimum two
-- months later does not reach into a live coordination, which is the whole
-- point: a number somebody is voting against should not move under them.
--
-- NULL is "no minimum", and it is the only state production has ever been in:
-- measured on the box on 2026-09-12, all three chat_groups rows have
-- quorum_min NULL, so nothing here changes what any existing coordination
-- shows. It is the default for a meeting with no group at all.
--
-- 064: SELECT max(version) FROM schema_migrations on the box was 62 on
-- 2026-09-12, and 063 is this branch's parent (never `ls migrations/`).
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS quorum_min INT;

-- A minimum below two is not a minimum — one person is whoever proposed it —
-- and one above the table's own cap could never be met. The upper bound is
-- deliberately absent: participants can be added after the fact, so a value
-- larger than today's count is a statement about the meeting, not an error.
ALTER TABLE meetings ADD CONSTRAINT meetings_quorum_min_check
  CHECK (quorum_min IS NULL OR quorum_min >= 2);
