-- Dated tasks on the user's own Google Calendar, opt-in per person.
--
-- Off by default and never inferred: writing to somebody's calendar is an
-- outward-facing act, and one they will see every day. It is turned on by
-- asking for it and can be turned off again.
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_sync_tasks boolean NOT NULL DEFAULT false;

-- The id of the event Olma put there for this task, or NULL for "not on the
-- calendar". It doubles as the fingerprint: calendar.createEvent derives the
-- id from userId|title|start, so an id that no longer matches the task's
-- CURRENT title and due_at is proof the task was edited since it synced —
-- which is what lets a rename or a reschedule be noticed without a second
-- column to keep in step.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS calendar_event_id text;

-- The sweep's own query: dated, open, unsynced tasks belonging to people who
-- asked for this. Partial, because the rows that matter are a thin slice.
CREATE INDEX IF NOT EXISTS tasks_calendar_pending_idx
  ON tasks (owner_id, due_at)
  WHERE due_at IS NOT NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS tasks_calendar_event_idx
  ON tasks (calendar_event_id)
  WHERE calendar_event_id IS NOT NULL;
