-- How often people open their own page, when, and who (owner, 2026-10-06).
--
-- Nothing recorded it. `dashboard_sessions.last_seen_at` is overwritten on
-- every request, a session is purged after 30 idle days, and
-- `users.last_dashboard_at` moves only on a WRITE — so "how many times did
-- anybody look" had no answer at all.
--
-- And the owner opens people's pages himself, from the admin user page
-- (POST /users/dashboard): that mints an ordinary link for THEM, his browser
-- spends it, and the session it opens is indistinguishable from theirs. 37
-- such openings were on the audit log when this was written, against 67
-- sessions in total. So the link and the session it becomes both carry who
-- asked for them, and every open says so; the admin page counts only the
-- person's own and shows how many of the owner's it left out.
ALTER TABLE magic_links ADD COLUMN IF NOT EXISTS by_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE dashboard_sessions ADD COLUMN IF NOT EXISTS by_admin BOOLEAN NOT NULL DEFAULT false;

-- One row per time the page was loaded on a live session, folded to one per
-- half hour per person (domain/dashboard-opens.js). Append-only.
CREATE TABLE IF NOT EXISTS dashboard_opens (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opened_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  by_admin   BOOLEAN NOT NULL DEFAULT false,
  -- true = reconstructed below from a session's sign-in, before anything
  -- counted page loads; such a row is a sign-in, not every visit.
  backfilled BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS dashboard_opens_user ON dashboard_opens (user_id, opened_at);
CREATE INDEX IF NOT EXISTS dashboard_opens_at ON dashboard_opens (opened_at);

-- The owner's sessions so far. The admin route writes `admin.dashboard_opened`
-- in the same transaction that mints the link, and his browser lands on the
-- sign-in button and spends it within moments; a session the person opened
-- themselves inside the same ten minutes is the one this would misfile, and
-- it would be filed as his, which under-counts rather than inflates.
UPDATE magic_links m SET by_admin = true
 WHERE EXISTS (SELECT 1 FROM audit_log a
                WHERE a.event = 'admin.dashboard_opened' AND a.actor_id = m.user_id
                  AND m.created_at BETWEEN a.created_at - interval '5 seconds' AND a.created_at + interval '5 seconds');
UPDATE dashboard_sessions s SET by_admin = true
 WHERE EXISTS (SELECT 1 FROM audit_log a
                WHERE a.event = 'admin.dashboard_opened' AND a.actor_id = s.user_id
                  AND s.created_at BETWEEN a.created_at AND a.created_at + interval '10 minutes');

-- Every sign-in still on file, as one open each, so the page is not empty on
-- its first day. Only once: a re-run finds the backfilled rows already there.
INSERT INTO dashboard_opens (user_id, opened_at, by_admin, backfilled)
SELECT s.user_id, s.created_at, s.by_admin, true
  FROM dashboard_sessions s
 WHERE NOT EXISTS (SELECT 1 FROM dashboard_opens WHERE backfilled);

COMMENT ON TABLE dashboard_opens IS 'one row per load of /me on a live session, at most one per person per 30 minutes; by_admin = the owner opened it from the admin page';
COMMENT ON COLUMN dashboard_sessions.by_admin IS 'opened from the admin user page (POST /users/dashboard), not by the person';
COMMENT ON COLUMN magic_links.by_admin IS 'minted by the admin user page for the owner to open, not sent to the person';
