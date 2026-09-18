-- Nudging is opt-in, and it is asked twice: once as a standing preference and
-- once for a single reminder ("תנדנדי לי עד שאעשה את זה").
--
-- Why the default is off: measured over 45 days on the box (2026-09-17), a
-- follow-up rung ended in "done" 22% of the time and in the person CANCELLING
-- the reminder 35% of the time, and the next-day rung converted for exactly
-- one user out of sixteen. מאיה asked for one reminder at 09:00 and got five
-- messages across two days (incidents.md, "התיק לבית חולים"). The ladder is
-- kept, because it does work — it stops being something everybody is opted
-- into by default.
--
-- Additive, both nullable-with-default, so a rollback of the code leaves rows
-- the old code simply does not read.
ALTER TABLE task_reminders ADD COLUMN IF NOT EXISTS nudge boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reminder_nudge boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN task_reminders.nudge IS 'they asked to be chased about THIS reminder: the full ladder (reminders.RUNGS.nudging)';
COMMENT ON COLUMN users.reminder_nudge IS 'standing preference: chase every reminder of theirs, dashboard-settable';
