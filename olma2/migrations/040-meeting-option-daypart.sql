-- A candidate time chosen on the dashboard is often a part of a day — "Tuesday
-- evening" — not a clock time. starts_at still carries a representative
-- instant (so "has it passed", clashes and sorting keep working), and this
-- column keeps the words the person actually chose so the page can draw them
-- back as a daypart rather than as 19:00.
-- 040: max(version) on the box was 39 after #200 (2026-09-05).
ALTER TABLE meeting_options ADD COLUMN IF NOT EXISTS daypart TEXT
  CHECK (daypart IS NULL OR daypart IN ('morning', 'noon', 'evening', 'night'));
