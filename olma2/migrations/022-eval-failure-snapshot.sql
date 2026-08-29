-- What the eval user's record looked like when a hard check failed.
--
-- The first nightly run (2026-08-29) recorded `bare-time-shift: a task exists
-- at 15:00 in HER timezone — failed` and nothing else. By morning the next
-- scenario's reset had wiped the eval user clean, so there was no way to tell
-- "saved nothing at all" from "saved the wrong hour" — and re-running did not
-- reproduce it (the model got it right the second time). A red nobody can
-- diagnose the next morning is the same dead end as an issue list nobody
-- reads: the signal fires and teaches nothing.
--
-- Written only for a failing scenario, bounded to a handful of rows per table
-- (see evals/harness.stateSnapshot), and read on the same connection as the
-- checks themselves — before the next scenario's reset can erase it.

ALTER TABLE eval_results ADD COLUMN snapshot JSONB;
