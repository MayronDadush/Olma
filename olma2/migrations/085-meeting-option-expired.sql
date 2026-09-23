-- A candidate time whose moment has passed comes off the table on its own
-- (domain/meetings.js, `dropPassedOptions`), and the status says which of the
-- two ways it left. 'deleted' is a PERSON taking a time off, and that fact is
-- carried to everybody else in the coordination the next time they hear about
-- it (meeting-options.removed, meeting-options.unheardRemovals). Nobody took
-- this one off — it simply happened, and "Tuesday came off the table" about a
-- Tuesday that has been and gone is noise. A separate status is what keeps
-- those two readers honest without a flag they have to remember to check.
--
-- Every other reader of this table starts from status = 'active' and is
-- untouched, here and on the dashboard, in turn.js and in the evals.
--
-- 085: SELECT max(version) FROM schema_migrations on the box was 84 on
-- 2026-09-23 (never `ls migrations/`).
ALTER TABLE meeting_options DROP CONSTRAINT meeting_options_status_check;
ALTER TABLE meeting_options ADD CONSTRAINT meeting_options_status_check
  CHECK (status IN ('active', 'pending', 'replaced', 'rejected', 'deleted', 'expired'));
