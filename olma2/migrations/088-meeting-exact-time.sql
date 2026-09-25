-- A coordination that settled on a whole day or a part of one (087) may be
-- given an exact hour afterwards, by anybody in it (owner, 2026-09-24).
-- `time_set_at` is when that happened, and `group_time_at` is when the ROOM
-- heard about it — the same pair of "happened / room told" the done and
-- calendar lines already keep, so a time set in a private chat reaches the
-- room once, and a time set in the room is stamped as heard at once.
--
-- 088: SELECT max(version) FROM schema_migrations on the box was 86 on
-- 2026-09-24, and 087 is this branch's parent (#496, not yet deployed).
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS time_set_at TIMESTAMPTZ;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS group_time_at TIMESTAMPTZ;
