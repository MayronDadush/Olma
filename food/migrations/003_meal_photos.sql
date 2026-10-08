-- The photo a meal was read from, kept so the page can show it.
--
-- The owner's call (2026-10-08): kept for as long as the meal is, and gone
-- with it. The column holds a file name under FOOD_PHOTO_DIR, never a path a
-- person gave us: src/photos.js builds it from two integers and refuses any
-- other shape when it reads one back.
ALTER TABLE meals ADD COLUMN IF NOT EXISTS photo text;
