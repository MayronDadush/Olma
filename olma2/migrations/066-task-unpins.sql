-- A shared task sits pinned at the top of the personal dashboard's list, and
-- one tap puts it back where its date or category would have put it. That tap
-- is the only thing stored: pinned is the default for every shared task, so a
-- row here means "this person took the pin off this task", and deleting it
-- pins the task again.
--
-- Per PERSON, not per task. A task shared between two people is the same row
-- on both lists (domain/user-dashboard.js, loadTasks), and one of them
-- un-pinning it says nothing about where the other wants it. That is also why
-- it cannot be a column on `shares`: the owner has no share row of their own.
--
-- Nothing reads it except the dashboard, and nothing about delivery, reminders
-- or sharing depends on it. A row that outlives the share (they left the task,
-- or it stopped being shared) is inert — the pin is only drawn on a task that
-- is shared right now — and it keeps their choice if they are added back.
--
-- 066: SELECT max(version) FROM schema_migrations on the box was 64 on
-- 2026-09-14, and open PR #365 already claims 065 (never `ls migrations/`).
CREATE TABLE IF NOT EXISTS task_unpins (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id     BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  unpinned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, task_id)
);
