-- The ad library (domain/brand-ads.js, owner 2026-10-01): short branded clips
-- the owner uploads from the admin page, watches there, and marks "in
-- rotation" — and only a clip in rotation is ever sent, by the `brand_ads`
-- sweep, through the outbox like everything else she decides to say.
--
-- Rendering never happens on the box (one render peaked at ~1.5GB of Chrome on
-- the Mac, the box has 2GB and the gateway already swaps); the files arrive
-- already made, one MP4 per language, and live OUTSIDE /opt/olma2 so a deploy's
-- rsync never removes them (domain/brand-ads.storeDir).
--
-- `format` is how WhatsApp shows it: 'gif' is the MP4 sent with
-- --gif-playback (loops, silent — a real .gif file arrives as a still, measured
-- 2026-09-26), 'mp4' is an ordinary video. Read at DELIVERY, so changing it
-- reaches rows already queued.
--
-- Additive: two new tables, nothing else touched. Nothing is in rotation and
-- the sender is off (the `brand_ads` flag) until the owner turns both on.
CREATE TABLE IF NOT EXISTS brand_ads (
  id              TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  title           TEXT NOT NULL,
  -- What the clip shows, in a sentence. Handed to the model on the person's
  -- next turn so a "מה זה?" right after it is answered by somebody who knows.
  about           TEXT NOT NULL DEFAULT '',
  in_rotation     BOOLEAN NOT NULL DEFAULT false,
  format          TEXT NOT NULL DEFAULT 'gif' CHECK (format IN ('gif', 'mp4')),
  -- The rebranded intro tells the same story as the intro video, so it is not
  -- sent to somebody who already got that one.
  skip_if_intro   BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brand_ad_files (
  ad_id        TEXT NOT NULL REFERENCES brand_ads(id) ON DELETE CASCADE,
  lang         TEXT NOT NULL CHECK (lang IN ('he', 'en')),
  -- The file's name inside the store directory. It carries a slice of the
  -- content hash, so a re-upload is a new name and a copy already staged into
  -- the gateway's workspace can never shadow it.
  file         TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ad_id, lang)
);
