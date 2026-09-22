-- A repeating reminder with an END is a different thing from one without, and
-- until now there was no column that could tell them apart.
--
-- חיים, 2026-09-22: "תזכיר לי מתי לקחת את המצלמה לתיקון... אני רוצה שעד שבוע
-- הבא היא תהיה מוכנה תעזור לי בתזכורת". He got ONE reminder, the evening before
-- the deadline, at an hour nobody had named. What he asked for was one a day,
-- from that day, until the deadline — unless he says it is done.
--
-- `repeat_rule = 'daily'` could already say "every day". What it could not say
-- is "and then stop", and four separate readers took a repeat rule to mean
-- "this task has a RHYTHM, not a deadline":
--   * tasks.completeTask refuses to close a task with a repeating reminder, so
--     "עשיתי" would have left the chase running — worse than the bug it fixes;
--   * sweeps' expired-event sweep and domain/task-suggestions both skip such a
--     task for the same stated reason;
--   * nothing ever ended the series, so a chase would outlive its own deadline.
--
-- So the end date is the discriminator, and it is EXPLICIT rather than read off
-- the task's due_at. Inferring it would have changed a live row's meaning: user
-- 16's monthly pill (task 121, `monthly:16`) carries a due_at of its first
-- occurrence, and bounding that series at the date would end a medication
-- reminder in silence. NULL therefore means exactly what every one of the eight
-- live repeating rows means today — a cadence, forever — and nothing about them
-- changes.
--
-- `repeat_seq` is which occurrence this is. The sweep writes each one as a new
-- row, so without it nothing at send time can tell the first message of a chase
-- from the fourth, and the three rung templates (plain / "בוצע?" / "זו התזכורת
-- האחרונה") are exactly that distinction. Defaulting to 1 leaves every existing
-- row reading as a first occurrence, which is true of a cadence and only ever
-- read for a chase.
--
-- Additive, both nullable-or-defaulted: a code rollback leaves rows the old
-- code simply does not read.
ALTER TABLE task_reminders ADD COLUMN IF NOT EXISTS repeat_until timestamptz;
ALTER TABLE task_reminders ADD COLUMN IF NOT EXISTS repeat_seq smallint NOT NULL DEFAULT 1;

COMMENT ON COLUMN task_reminders.repeat_until IS 'last instant an occurrence may fire; NULL = a cadence with no end (reminders.isChase)';
COMMENT ON COLUMN task_reminders.repeat_seq IS 'which occurrence of a repeating reminder this row is, 1-based';
