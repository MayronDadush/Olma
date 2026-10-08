-- "שמורים" — links a person keeps for later, sorted into lists (owner,
-- 2026-10-08; docs/design/saved-links-handoff.md). A direct message that is
-- only a URL is saved by code before any turn (brokerd `save_link_shortcut`);
-- anything else with a URL in it reaches the model, which has the
-- `saved_links` tool.
--
-- A link has no date and no reminder of its own — the owner's words: "כמו
-- שברשימת קניות אין תזכורת רק על ״בננה״". Turning one into a task makes an
-- ordinary task that carries it (`tasks.saved_link_id`), and from then on it
-- is a task in every way.
--
-- Deletes are soft (`deleted_at`) on links and lists both, because the page
-- offers "ביטול" for five seconds after either.
--
-- Additive: three new tables and one nullable column nothing older reads.
CREATE TABLE IF NOT EXISTS saved_link_lists (
  id           bigserial PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  emoji        text,
  -- Made by the classifier rather than by them ("פתחתי רשימה חדשה").
  created_auto boolean NOT NULL DEFAULT false,
  position     int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS saved_link_lists_name_uq
  ON saved_link_lists (user_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS saved_links (
  id               bigserial PRIMARY KEY,
  user_id          bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id          bigint REFERENCES saved_link_lists(id) ON DELETE SET NULL,
  -- The classifier chose the list (the page says "עולמה בחרה"); false once
  -- they moved it, and their moves are what the classifier learns from.
  list_auto        boolean NOT NULL DEFAULT true,
  url              text NOT NULL,
  canonical_url    text NOT NULL,
  platform         text NOT NULL CHECK (platform IN ('instagram', 'tiktok', 'youtube', 'yad2', 'maps', 'web')),
  kind             text CHECK (kind IS NULL OR kind IN ('video', 'recipe', 'article', 'place', 'listing', 'product')),
  -- Only ever what the fetch returned — never the model's words
  -- (rules/doctrine.md, "Olma never claims a lookup it did not perform").
  title            text,
  author           text,
  caption          text,
  recipe           jsonb,           -- {ingredients[], steps[], total_min, servings}
  -- Where the picture is; the enrich job keeps its BYTES in saved_link_thumbs
  -- because Instagram's and TikTok's URLs expire within days.
  image_url        text,
  -- The ONE line under the title (owner, 2026-10-08): price · rooms, prep
  -- time, or whatever they wrote with the link. Never separate fields.
  -- `line_by` NULL means Olma wrote it from what was read; a user id means
  -- that person did, and their words are never overwritten by a re-read.
  line             text,
  line_by          bigint REFERENCES users(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'done')),
  extract_level    text NOT NULL DEFAULT 'none' CHECK (extract_level IN ('none', 'meta', 'full', 'failed')),
  extract_attempts int NOT NULL DEFAULT 0,
  extract_error    text,
  next_try_at      timestamptz,
  source_message_id text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  touched_at       timestamptz,
  deleted_at       timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS saved_links_canonical_uq
  ON saved_links (user_id, canonical_url) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS saved_links_user_idx ON saved_links (user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS saved_links_enrich_idx ON saved_links (next_try_at)
  WHERE deleted_at IS NULL AND extract_level IN ('none', 'failed');

-- Instagram's and TikTok's image URLs are signed and expire within days, so
-- the bytes are kept. ≤300KB each, image/* only (domain/link-extract.js).
CREATE TABLE IF NOT EXISTS saved_link_thumbs (
  link_id    bigint PRIMARY KEY REFERENCES saved_links(id) ON DELETE CASCADE,
  mime       text NOT NULL,
  bytes      bytea NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS saved_link_id bigint REFERENCES saved_links(id) ON DELETE SET NULL;
