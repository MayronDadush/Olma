-- A reminder hung on the person's OWN calendar event, instead of a copy of it.
--
-- Until today the two directions both made a second entry: a task saved in
-- chat could be copied ONTO the calendar (`calendar_event_id`, migration 028),
-- and an event already on the calendar could only be reminded about by saving
-- it again as a task. מירון's calendar held the original, Olma's copy and a
-- task of each, and a monthly event was saved as a one-off that archived
-- itself after the first month (2026-09-30, `incidents.md`, "Two of
-- everything").
--
-- Now a task may STAND FOR an event on their calendar:
--   linked_event_id    the Google instance this row is about right now;
--   linked_series_id   the recurring series, when the link follows every
--                      occurrence (a monthly event is reminded every month);
--   linked_lead_minutes how long before the instance's start the reminder
--                      they NAMED goes (negative = after the start, "20:00 on
--                      the day" of an all-day event); NULL = the automatic one;
--   linked_checked_at  when the sweep last compared the row with Google.
-- The event stays the truth: moved, renamed, deleted or passed, the sweep in
-- `domain/calendar-links.js` brings the row after it. A linked row never
-- carries `calendar_event_id` — that column is only ever a COPY.
--
-- One open row per event (or series) per person, enforced here because two
-- rows for one event is exactly the bug this exists to end.
--
-- Also retires copying tasks onto the calendar ("5ב", owner 2026-09-30):
-- the standing switch and every per-task answer go back to "no". Nothing is
-- deleted here; the `task_calendar` sweep takes the copies already written
-- down, and only where the connection can edit.
--
-- Additive: nullable columns and an index. Old code reading the two cleared
-- switches simply stops adding copies, which is the point.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS linked_event_id TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS linked_series_id TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS linked_lead_minutes INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS linked_checked_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS tasks_linked_once
  ON tasks (owner_id, (COALESCE(linked_series_id, linked_event_id)))
  WHERE COALESCE(linked_series_id, linked_event_id) IS NOT NULL
    AND status = 'open' AND archived_at IS NULL;

UPDATE users SET calendar_sync_tasks = FALSE WHERE calendar_sync_tasks;
UPDATE tasks SET calendar_opt_in = NULL WHERE calendar_opt_in IS NOT NULL;
