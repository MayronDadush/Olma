-- A coordination's category, when a PERSON chose it (owner, 2026-10-04).
--
-- A coordination is sorted into a category automatically, off its name and
-- then its place (domain/meeting-category.js), at read time — so a
-- rename re-sorts it and nothing stored goes stale. This column holds only an
-- override: somebody in it picked one, on the page or in the chat. NULL is
-- every row before this and every row nobody touched, and means "automatic".
-- 'none' is a real choice ("no category"), not a NULL.
--
-- The vocabulary is its own, not the tasks' — topics people meet about:
-- work, family, social, sport, games (owner, 2026-10-05). Validated in code
-- (meeting-category.CATEGORIES), like tasks.category, rather than by a CHECK a
-- later key would have to migrate.
--
-- Additive and nullable: a code rollback ignores it and every coordination
-- falls back to the automatic one.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS category text;

COMMENT ON COLUMN meetings.category IS 'category a person chose (meeting-category.CATEGORIES, or none); NULL = automatic, read off title then location';
