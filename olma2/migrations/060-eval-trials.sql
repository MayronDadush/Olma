-- Repeat runs of one scenario, so "it passed" can mean "it passed every time".
--
-- A scenario is a conversation with a model: the same input can go green once
-- and yellow the next time, and the log already carries two entries admitting
-- exactly that ("the same scenario went green on the rerun with no change to
-- anything"). A single run therefore says very little about a product where
-- Hebrew gender and tool choice have to be right EVERY time, which is what
-- pass^k measures: green on all k trials, not green on the luckiest one.
--
-- One row per scenario per run is kept, deliberately: `previousStatus`, the
-- dashboard board and the two-consecutive-nights alert rule all read "the
-- scenario's result in that run", and k rows would quietly mean something
-- different to each of them. The row's status is the WORST of the trials, and
-- the per-trial detail rides this column.
--
-- NULL means one trial, which is every nightly run and every existing row —
-- so nothing that reads eval_results today changes shape.
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS trials JSONB;

COMMENT ON COLUMN eval_results.trials IS
  'NULL for a single-trial run. Otherwise [{trial, status, durationMs}, ...] and the row status is the worst of them.';
