-- What KIND of room this is, and how many people the thing it arranges needs.
--
-- The owner's decision (2026-09-07): there are two kinds, and Olma has to know
-- which one she is in before she can say anything about "enough people".
--
--   'social' — friends, work, family. Everyone is invited, there is no
--              minimum, and the goal is a time that suits everybody. It may
--              still happen with some of them, if they agree to that.
--   'game'   — padel, poker. Everyone is invited too, but the thing needs a
--              MINIMUM to happen at all, and may have a maximum; at the
--              maximum it may be closed on the spot.
--
-- NULL is the honest third state: nobody has told her. It is not 'social' with
-- a different name — a guess never acts, so an unknown room is coordinated
-- exactly as before this column existed and no sentence about a quorum is
-- available to say.
--
-- quorum_min/quorum_max are about the PLAN (four for padel), and have nothing
-- to do with the `group_max_members` flag, which is about how large a ROOM may
-- be before she declines to work in it.
ALTER TABLE chat_groups
  ADD COLUMN IF NOT EXISTS kind TEXT,
  ADD COLUMN IF NOT EXISTS quorum_min INT,
  ADD COLUMN IF NOT EXISTS quorum_max INT,
  ADD COLUMN IF NOT EXISTS close_at_target BOOLEAN NOT NULL DEFAULT false,
  -- Asked once, ever, and stamped whether or not it was answered: a room that
  -- ignored the question is not asked it again on the next coordination.
  ADD COLUMN IF NOT EXISTS kind_asked_at TIMESTAMPTZ;
