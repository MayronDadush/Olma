-- New people start on the full list (owner, 2026-10-06).
--
-- Every digest scope carries the list now (#767), and a scheduled digest asks
-- for `full` whatever the column says (jobs/sweeps.scopeForDigest), so `summary`
-- as the default only ever meant a count nobody can draw. Additive: existing
-- rows keep what they have.
ALTER TABLE users ALTER COLUMN digest_scope SET DEFAULT 'full';
