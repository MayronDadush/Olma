-- Who the assistant IS for this person — a persona they chose, not a system
-- setting. gender drives the Hebrew speech register in every reply (and picks
-- the phone-call voice); name replaces "עולמה" when set. A NULL name means
-- "the default name", so a rename is undone by clearing the column rather
-- than by anyone having to know what the default was.
ALTER TABLE users
  ADD COLUMN assistant_gender text NOT NULL DEFAULT 'female'
    CHECK (assistant_gender IN ('female', 'male')),
  ADD COLUMN assistant_name text;
