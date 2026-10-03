-- A nudge ("נודניק") is one arrangement now, and it can say something a chase
-- could not: up to THREE messages on one day (owner, 2026-10-03).
--
-- Until today a repeating reminder never climbed — each occurrence of a chase
-- said its one sentence and retired — and a one-off with `nudge` climbed three
-- rungs, the third of them the NEXT day. So "remind me three times a day until
-- I do it" had no row that could hold it. The owner's table:
--
--   deadline within three days → up to three a day until it
--   deadline further away      → once a day, and three times on the last day
--   no deadline                → up to three a day, for three days, and then
--                                ONE question: go on, or stop
--
-- `rungs` is how many messages THIS occurrence may send on its own day. NULL is
-- every row written before this — a chase occurrence says one sentence, a
-- one-off climbs by the old ladder (reminders.RUNGS) — so nothing live changes
-- meaning. The sweep copies it onto the next occurrence, raising it to 3 on the
-- last day of a long series.
--
-- `nudge_capped` says the END is the three-day cap rather than a deadline they
-- named. Only the last message reads it: a deadline's last day says "this is
-- the last one", the cap asks whether to go on (template `reminder_nudge_end`).
--
-- Additive, nullable-or-defaulted: a code rollback leaves rows the old code
-- reads as an ordinary daily chase.
ALTER TABLE task_reminders ADD COLUMN IF NOT EXISTS rungs smallint;
ALTER TABLE task_reminders ADD COLUMN IF NOT EXISTS nudge_capped boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN task_reminders.rungs IS 'messages this occurrence may send on its own local day; NULL = the old rules (reminders.RUNGS / one per chase occurrence)';
COMMENT ON COLUMN task_reminders.nudge_capped IS 'the series ends at the three-day nudge cap, not at a deadline; its last message asks whether to go on';
