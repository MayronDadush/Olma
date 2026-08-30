-- A third eval trigger: 'pilot' — a run that deliberately drove a CANDIDATE
-- model (scripts/run-evals.js --model) instead of the live default, so a
-- cheaper open-weight model can be scored against the same nine real
-- incidents before anyone is routed onto it.
--
-- It has to be a distinct label rather than reusing 'manual', because two
-- readers must be able to tell it apart from a production result: the
-- two-consecutive-nights alert rule (a candidate's yellow must never make
-- tonight's real yellow the "second night in a row") and the dashboard
-- headline (a pilot's reds are not a production regression). Both key on
-- this exact value.
--
-- Number checked with SELECT max(version) FROM schema_migrations on the box
-- (23 applied), not against `ls migrations/` on main — the rule from
-- "Two branches, one migration number".
ALTER TABLE eval_runs DROP CONSTRAINT IF EXISTS eval_runs_trigger_check;
ALTER TABLE eval_runs ADD CONSTRAINT eval_runs_trigger_check
  CHECK (trigger IN ('nightly', 'manual', 'pilot'));
