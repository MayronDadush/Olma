-- tasks.category becomes the closed set the dashboard always documented it as
-- (src/domain/task-category.js). Nothing here rewrites a row: the column only
-- records WHO chose the value, so the page can say "עולמה בחרה" and a later
-- pass knows which values it is allowed to improve and which a person owns.
--
-- Additive and backward-compatible on purpose — a rollback restores code and
-- leaves this column in place, where a default of false reads correctly as
-- "nobody said otherwise" to code that has never heard of it.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS category_auto boolean NOT NULL DEFAULT false;
