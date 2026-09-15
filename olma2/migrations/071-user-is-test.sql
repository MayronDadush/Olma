-- `is_eval` (019) marks only the one automated nightly eval bot. It says
-- nothing about a real account opened by hand during development — the
-- owner's own number, a colleague's, a phone used to try a feature — and
-- those inflated every "how many real users" count on the admin home page
-- (2026-09-16). `is_test` is that second, manually-set flag: nobody infers
-- it, an operator marks it from the admin Users page, and every count that
-- already excludes `is_eval` excludes this too.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
