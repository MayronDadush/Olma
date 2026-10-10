-- The day their page link last rode a photo's result (the owner's call,
-- 2026-10-09: once a day, after a photo, a link to see their day). Their own
-- local day; NULL is never. Additive only.
ALTER TABLE people ADD COLUMN IF NOT EXISTS page_link_day date;
