-- Where a task sits on one person's dashboard list, when they have dragged it
-- there, and whether they have been told once what dropping one task onto
-- another does.
--
-- `task_order` is per PERSON, not per task, for the same reason `task_unpins`
-- (066) is: a shared task is the same row on two lists, and where one of them
-- drags it says nothing about where the other wants it. One global rank per
-- person rather than one per group, so the category view and the time view
-- read the same order and never disagree about which of two rows comes first.
-- A task nobody has dragged has no row and falls back to its date.
--
-- Nothing reads it except the dashboard. Delivery, reminders, the digest and
-- the agent never look at it, and a row left behind by a task that became a
-- checklist item is inert — which is exactly what lets undoing that put the
-- task back at the rank it had.
--
-- `users.nest_tip_seen_at` is a once-ever notice stamped on the PERSON, the
-- same shape as `timezone_asked_at` (045): the explanation appears the first
-- time they nest a task, on whichever device, and never again.
--
-- 068: SELECT max(version) FROM schema_migrations on the box was 67 on
-- 2026-09-14 (never `ls migrations/`).
CREATE TABLE IF NOT EXISTS task_order (
  user_id  BIGINT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id  BIGINT  NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (user_id, task_id)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS nest_tip_seen_at TIMESTAMPTZ;
