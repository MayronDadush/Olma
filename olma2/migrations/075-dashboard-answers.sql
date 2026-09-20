-- A write from the person's own page is the person answering. Kapish answered
-- every question about coordination 35 from the dashboard and never wrote a
-- word in the private chat, so to every reader of `last_inbound_at` and
-- `checkin_misses` he was somebody who had stopped answering: his invite was
-- dropped `quiet` twice, and his first message in the chat was answered with
-- the day-one opener (`incidents.md`, "The man who only ever answered from
-- the page", 2026-09-20).
--
-- Its own column, never `last_inbound_at` — that one is the first-turn signal
-- and the silence test of the name ladder, and faking it would make a page
-- tap look like a message that carried words.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_dashboard_at TIMESTAMPTZ;
COMMENT ON COLUMN users.last_dashboard_at IS 'last successful write from their own dashboard; presence, like a message, for the delivery gate and the check-in ladder';
