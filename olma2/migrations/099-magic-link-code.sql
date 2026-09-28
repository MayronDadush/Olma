-- A sign-in CODE, kept as one more kind of magic link.
--
-- An iPhone home-screen app has its own cookie jar, separate from Safari's,
-- and every /d/<token> link tapped in WhatsApp opens Safari, never the app. So
-- the installed app can only be signed into from INSIDE it: the person asks
-- Olma for a code, she answers with eight digits by code (no model turn;
-- domain/link-request.js), and they type it into the app
-- (dashboard-auth.createCode / redeemCode, POST /me/code).
--
-- A code is a link in every way that matters — one person, one use, spent by
-- an atomic UPDATE, stored only as sha256 — so it lives on the same table.
-- `target = 'code'` is what keeps the two apart: a code is never counted
-- against a person's live links, and a link query never finds a code.
--
-- Additive: the CHECK only gains a value, and no code before this writes it.
ALTER TABLE magic_links DROP CONSTRAINT IF EXISTS magic_links_target_check;
ALTER TABLE magic_links
  ADD CONSTRAINT magic_links_target_check CHECK (target IN ('home', 'tasks', 'meeting', 'code'));
