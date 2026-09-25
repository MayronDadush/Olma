-- A coordination can settle on a whole day or a part of one ("Tuesday
-- evening"). meeting_options has carried both since 039/040, but confirmOn
-- copied only slot_text and starts_at onto the meeting, so once it settled
-- nothing could tell "Tuesday, all day" from "Tuesday 09:00" — the calendar
-- got a 09:00 event and the room an hour-before line at 08:00. These two
-- columns carry the settled option's precision onto the meeting (owner,
-- 2026-09-24: all-day meetings, and one question about an exact time when a
-- coordination settles without one).
--
-- 087: SELECT max(version) FROM schema_migrations on the box was 86 on
-- 2026-09-24 (never `ls migrations/`).
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS confirmed_all_day BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS confirmed_daypart TEXT
  CHECK (confirmed_daypart IS NULL OR confirmed_daypart IN ('morning', 'noon', 'evening', 'night'));
