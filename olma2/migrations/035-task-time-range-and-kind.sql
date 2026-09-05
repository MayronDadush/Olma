-- Two columns a task has always needed and never had.
--
-- `ends_at`: a task could say when it started and never when it finished, so a
-- shift had to be written into its own title — `משמרת - ראשון 12:00-19:00` —
-- where nothing can read it. With a real end the title is just `משמרת` and the
-- hours are data: the day view can draw the block, and the calendar event we
-- write out stops being a fixed half-hour guess.
--
-- `kind`: 'event' | 'todo', decided in code (src/domain/task-kind.js). "תור
-- רופא" and "לקבוע תור לרופא" behave in opposite ways once their time passes,
-- and nothing in this table could tell them apart — so the overdue list held
-- both, and the ones that were genuinely over stayed there arguing for
-- attention. Nullable: an existing row has no answer until something decides
-- one, and NULL must not read as 'event' — nothing is ever auto-archived on a
-- guess this column did not actually make.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ends_at timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS kind text;
