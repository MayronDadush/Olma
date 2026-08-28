-- The availability picker: a short-lived, token-addressed web page where a
-- meeting participant taps dates and dayparts instead of typing them.
--
-- 019, not 018: production's schema_migrations already holds version 18
-- (018-image-jobs-async.sql, deployed from another branch). Same burned-number
-- rule migration 011's collision taught — the number comes from
-- SELECT max(version) on the box, never from ls on this tree.

-- One row per outstanding link. The token in the URL is the whole credential
-- (same trust model as oauth_states): random, bound to one user and one
-- meeting, time-limited. Unlike oauth_states it is deliberately MULTI-use
-- until expiry — a person opens the page from WhatsApp, closes it, reopens it
-- to change their mind; burning it on first GET would break the normal flow.
CREATE TABLE picker_links (
  id BIGSERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  meeting_id BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX picker_links_meeting_user ON picker_links (meeting_id, user_id);

-- What each participant submitted, one row per person per meeting — resubmit
-- replaces (the page is the editor for this row, not an append log). `options`
-- is the server-normalized array (validated dates, daypart vocabulary, the
-- owner's timezone, and a server-built Hebrew label); the raw form input never
-- lands here.
CREATE TABLE meeting_availability (
  id BIGSERIAL PRIMARY KEY,
  meeting_id BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  options JSONB NOT NULL DEFAULT '[]',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, user_id)
);
