-- Where an open of somebody's own page came from (owner, 2026-10-06): some
-- people keep the page as an app on their phone's home screen, and some open
-- it from a link Olma sent in WhatsApp.
--
--   app     — the installed app: its start address, `/me?hl=…` (pwa.js
--             start_url). Nothing else on the site links there: a sign-in
--             link lands on `/me` plus a fragment, and allma.world's `/`
--             redirects to a bare `/me`. A code sign-in is app too: a
--             code is typed inside the installed app.
--   link    — a `/d/<token>` link, spent or (already signed in) gone
--             straight through.
--   browser — `/me` with neither: a bookmark, a tab left open, allma.world.
--
-- NULL is every row before this: the backfilled sign-ins are set below, and
-- the hour or so of loads counted between 112 and this are left unknown.
ALTER TABLE dashboard_opens ADD COLUMN IF NOT EXISTS source TEXT
  CHECK (source IS NULL OR source IN ('app', 'link', 'browser'));

-- Every SIGN-IN on file was a link: the other way to start a session, an
-- eight-digit code (migration 099), has never been asked for — there is no
-- `dashboard.code_shortcut` row on the audit log, and that row is written on
-- every code sent. Checked here rather than assumed, so a box where one was
-- sent leaves its sign-ins unknown instead of misfiled.
--
-- That says nothing about who uses the APP. An iPhone that adds the page to
-- its home screen can carry Safari's session into it, so the app is used
-- without a code (the owner's own, full screen, 2026-10-08) — and an app open
-- on a session already held created no row before 112. Who used the app
-- before this migration is not on file anywhere.
UPDATE dashboard_opens SET source = 'link'
 WHERE backfilled AND source IS NULL
   AND NOT EXISTS (SELECT 1 FROM audit_log WHERE event = 'dashboard.code_shortcut');

COMMENT ON COLUMN dashboard_opens.source IS 'app (installed, /me?hl=) | link (/d/<token>) | browser (bare /me); NULL = before migration 116';
