-- Notifications to the installed app (owner, 2026-10-08): for somebody who
-- turned them on from INSIDE the home-screen app, a coordination message the
-- page can answer arrives as a notification instead of a WhatsApp message
-- (domain/push.js, outbox/worker.js). Most people have no app, so the one
-- thing this must never do is take a message away from somebody who will not
-- see it: a subscription carries a message only while `last_seen_at` says the
-- app itself confirmed it recently, and only until a push service says it is
-- gone (`revoked_at`). Anything else goes to WhatsApp exactly as before.
--
-- One row per device. `endpoint` is the push service's address for that one
-- install, and it is the key: a re-subscribe from the same phone updates the
-- row in place. `p256dh`/`auth` are the browser's public key and secret for
-- encrypting to it (RFC 8291) — not ours, and useless without the endpoint.
--
-- Additive: two new tables nothing older reads.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            bigserial PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint      text NOT NULL UNIQUE,
  p256dh        text NOT NULL,
  auth          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Stamped by the app on every open while notifications are on. Never by a
  -- send: a push service accepting a message proves the address exists, not
  -- that anybody still has the app.
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_sent_at  timestamptz,
  -- Turned off by the person (the switch), or by a push service answering
  -- 404/410. A revoked row is never sent to again; a new subscribe from the
  -- same device clears it.
  revoked_at    timestamptz,
  revoked_reason text CHECK (revoked_reason IS NULL OR revoked_reason IN ('user', 'gone', 'permission'))
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id) WHERE revoked_at IS NULL;

-- The server's own signing key for VAPID (RFC 8292), made on first use by
-- whichever process asks first and never rotated by code: every subscription
-- on file was made against its public half, so a new key silently strands all
-- of them. The private half is encrypted with the same key file as the Google
-- credentials (domain/crypto-store.js).
CREATE TABLE IF NOT EXISTS push_vapid (
  id          smallint PRIMARY KEY CHECK (id = 1),
  public_key  text NOT NULL,
  private_enc text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
