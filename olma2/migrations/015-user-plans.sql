-- The planning pass: once a day, in each person's own small hours, a direct
-- model call reads their open tasks, reminders, calendar and facts, and writes
-- a short forward plan. The plan is NOT a message and never becomes one on its
-- own — it is rendered into USER.md, so the agent that talks to them in the
-- morning (digest included) already knows what today is actually about.
-- One row per user, latest plan only; the run itself is audited (plan.updated).
CREATE TABLE user_plans (
  user_id   BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  headline  TEXT NOT NULL,
  bullets   JSONB NOT NULL DEFAULT '[]',
  built_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
