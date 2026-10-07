-- A repeating EVENT (owner, 2026-10-05). Dov: "יש לי קורס שעתיד להפתח ב-12.10
-- ימי שני וחמישי בין השעות 17:30-21:30 תוסיף שיהיה קבוע". There was no way to
-- say that: an event was one moment, so Olma saved ONE event on 12.10 and hung
-- a weekly:MO,TH reminder off it — the reminder came back every week and the
-- course itself was on his list once, on a Monday that would be over in a week.
--
-- `repeat_rule` is the cadence of the THING, in the reminders' own grammar
-- (reminders.normalizeRepeatRule): 'daily', 'weekly:MO' (one weekday — two days
-- a week is two events, one per day), 'monthly:N'. When an occurrence ends the
-- finished-tasks sweep moves the row on to the next one (tasks.advanceRecurring)
-- instead of archiving it; past `repeat_until` it closes like any event.
--
-- Additive and nullable: NULL is every row before this and means "one moment",
-- and a code rollback simply stops advancing — the row then closes after its
-- current occurrence, exactly as an event always did.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repeat_rule text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repeat_until timestamptz;

-- What the Google series behind a repeating row was written for (task-calendar.seriesKey):
-- the row moves on every occurrence and the series does not, so a change is
-- told apart from the row simply moving on by this, not by the event id.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS calendar_series_key text;

COMMENT ON COLUMN tasks.repeat_rule IS 'cadence of a repeating EVENT (daily | weekly:XX | monthly:N); NULL = one moment. Advanced by tasks.advanceRecurring';
COMMENT ON COLUMN tasks.repeat_until IS 'last moment a repeating event may occur; NULL = until archived';
