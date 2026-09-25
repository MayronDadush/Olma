-- The character somebody picked on their profile page (owner, 2026-09-26:
-- "ברגע שמחליפים דמות ואז יוצאים מהתפריט וחוזרים זה לא שומר את הדמות").
-- "החלפת דמות" moved a variable in the browser and nothing else, and the next
-- read of /me/data put the character derived from the user id straight back.
--
--   avatar  — the animal's own id on the page ("fox", "cat"), never its index,
--             so reordering the page's list does not swap anybody's character.
--             NULL is "never chose", and every page falls back to the seed.
--             Everybody who is shown this person sees the same one (owner's
--             choice), so it travels in every place /me/data names a person.
--
-- 094: SELECT max(version) FROM schema_migrations on the box was 93 on
-- 2026-09-26 (never `ls migrations/`).
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT
  CHECK (avatar ~ '^[a-z][a-z0-9_-]{0,23}$');
