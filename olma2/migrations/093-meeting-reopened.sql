-- A settled coordination can be opened again and carried on from where it
-- stopped (owner, 2026-09-25, פנתרה: the time was set, and the room then
-- wanted other dates that suit Australia, New York and Israel). Nothing could
-- move a `confirmed` meeting back to the table; cancelling and starting over
-- told everybody twice and lost every answer already given.
--
--   reopened_at       — when it last went back to the table. The room's line
--                       keys carry it, so the next "סגור" is not taken for the
--                       one already said.
--   reopened_from     — the time that had been set, in its own words, which is
--                       what the room and each person are told is no longer set.
--   group_reopened_at — the room heard it (group-voice `reopened`), stamped
--                       like every other room line.
--
-- 093: SELECT max(version) FROM schema_migrations on the box was 92 on
-- 2026-09-25 (never `ls migrations/`).
ALTER TABLE meetings ADD COLUMN reopened_at TIMESTAMPTZ;
ALTER TABLE meetings ADD COLUMN reopened_from TEXT;
ALTER TABLE meetings ADD COLUMN group_reopened_at TIMESTAMPTZ;
