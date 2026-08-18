-- Repeating reminders were silently one-shot.
--
-- jobs/sweeps.js compared repeat_rule against the literals 'daily'/'weekly',
-- while the agent — handed a freeform "Optional repeat rule" field — stored
-- RRULE-style 'FREQ=DAILY'. Nothing errored: the reminder fired once, no
-- successor row was ever written, and someone who asked for a daily
-- medication reminder received exactly one. Found live 2026-08-18 with four
-- of the five reminders in the table affected.
--
-- The code fix is reminders.normalizeRepeatRule/nextOccurrence (one
-- vocabulary, normalised on write). This migration does the data half:
-- canonicalise what is already stored, then revive the occurrences that were
-- dropped on the floor.

-- 1. Canonicalise existing rules to the stored vocabulary.
UPDATE task_reminders SET repeat_rule = 'daily'
 WHERE repeat_rule IS NOT NULL AND upper(repeat_rule) ~ 'FREQ=DAILY';

UPDATE task_reminders SET repeat_rule = 'weekly'
 WHERE repeat_rule IS NOT NULL AND upper(repeat_rule) ~ 'FREQ=WEEKLY'
   AND upper(repeat_rule) !~ 'BYDAY=';

UPDATE task_reminders
   SET repeat_rule = 'weekly:' || (regexp_match(upper(repeat_rule), 'BYDAY=([A-Z,]+)'))[1]
 WHERE repeat_rule IS NOT NULL AND upper(repeat_rule) ~ 'FREQ=WEEKLY'
   AND upper(repeat_rule) ~ 'BYDAY=';

-- Anything still unrecognised becomes a one-off rather than a wrong cadence.
UPDATE task_reminders SET repeat_rule = NULL
 WHERE repeat_rule IS NOT NULL
   AND repeat_rule <> 'daily' AND repeat_rule <> 'weekly'
   AND repeat_rule !~ '^weekly:[A-Z,]+$';

-- 2. Revive the dropped occurrences. For every repeating reminder that was
--    sent and never got a successor, insert the next one in the future. The
--    NOT EXISTS guard makes this safe to re-run and stops it duplicating a
--    successor the fixed sweep has already created.
INSERT INTO task_reminders (task_id, remind_at, repeat_rule)
SELECT r.task_id,
       -- keep the original time of day, move to the next future date
       r.remind_at + make_interval(days =>
         CASE WHEN r.repeat_rule = 'daily' THEN 1 ELSE 7 END *
         (floor(extract(epoch FROM now() - r.remind_at)
                / (CASE WHEN r.repeat_rule = 'daily' THEN 86400 ELSE 604800 END))::int + 1)),
       r.repeat_rule
  FROM task_reminders r
  JOIN tasks t ON t.id = r.task_id
 WHERE r.repeat_rule IN ('daily', 'weekly')
   AND r.sent_at IS NOT NULL
   AND r.cancelled_at IS NULL
   AND t.status = 'open'
   AND t.archived_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM task_reminders n
      WHERE n.task_id = r.task_id
        AND n.sent_at IS NULL
        AND n.cancelled_at IS NULL
        AND n.remind_at > r.remind_at
   );
