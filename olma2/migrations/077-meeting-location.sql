-- Where the meeting is. "פוקר אצל יוסי" carries its place in the title and
-- nothing could read it back out; a room whose plan closed was never asked
-- where, and the calendar event went in without one (owner, 2026-09-20).
-- Free text in the room's own words, written by start_group_coordination
-- when the room said a place and by set_group_coordination_place when it is
-- said later; NULL is "nobody said", which is what the room's done line
-- asks about.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS location TEXT;
COMMENT ON COLUMN meetings.location IS 'where, in the room''s own words; NULL = not said, and the done line asks';
