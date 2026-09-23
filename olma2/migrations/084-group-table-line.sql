-- The room hears its coordination change, not only that it started.
--
-- 2026-09-22: מירון opened a padel coordination at 16:11. The room was told she
-- had started (16:11) and, four minutes later, that there was a direction. Then
-- שבת 16:00 came off the table, three other times went on, two people turned
-- Wednesday down — and the room heard none of it, because the base line is said
-- ONCE per coordination and the only thing left after it is the mid-way chase,
-- which was scheduled for half past five the next morning (half the distance to
-- the earliest option, which was twenty-six hours out).
--
-- The owner's answer was both halves: chase an hour in rather than half way,
-- and say something when the table itself moves. This column is the second
-- half's watermark — the moment the room was last told what is on the table —
-- compared against the newest change to any option (`created_at` for one added,
-- `decided_at` for one taken off, which `meeting_options` has already). NULL
-- means never, and the base line's own stamp stands in for it, so a room that
-- has heard "יש כיוון" is not told the table moved by the very option that
-- line was about.
--
-- It is also the far end of the quarter of an hour the room waits before it
-- says anything about the table at all (`group-voice.TABLE_SETTLE_MS`, owner
-- 2026-09-22): this sweep runs every sixty seconds, and מירון's table moved
-- four times in eleven minutes, so a line with no settle on it is the private
-- complaint said out loud in the room.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS group_table_at timestamptz;
COMMENT ON COLUMN meetings.group_table_at IS
  'when the room was last told what is on the table (group-voice, kind: table)';
