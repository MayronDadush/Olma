-- What the owner asked Olma to say, by hand, from the admin page ("לכתוב
-- הודעה יזומה"), kept as a log the two of us read back together (owner,
-- 2026-09-24): each one is a moment Olma could have noticed on her own, and a
-- moment that keeps recurring is a feature to build. Nothing here reaches
-- Olma — it is read by people, not by the model.
--
-- Its own table because nothing else keeps it: a sent outbox row ages out
-- after audit_retention_days (jobs/retention.js), the admin.outbox.queued
-- audit row never held the instruction, and what Olma actually wrote exists
-- only in the gateway's transcript. outbox_id is deliberately not a foreign
-- key for the same reason — the row it names will be deleted.
--
-- sent_at, sent_text and replied_at are filled in later by
-- domain/owner-messages.fillOutcomes, and only with something it read: NULL
-- means "not known yet", never "nothing happened".
--
-- 089: SELECT max(version) FROM schema_migrations on the box was 86 on
-- 2026-09-24, and 087/088 are claimed by open PRs (coord-exact-time,
-- coord-all-day).
CREATE TABLE owner_messages (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  outbox_id   BIGINT,
  instruction TEXT NOT NULL,
  urgency     TEXT NOT NULL DEFAULT 'normal',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ,
  sent_text   TEXT,
  replied_at  TIMESTAMPTZ
);
CREATE INDEX owner_messages_created ON owner_messages (created_at DESC);

-- The ones written before this table existed, while their outbox rows last.
INSERT INTO owner_messages (user_id, outbox_id, instruction, urgency, created_at)
SELECT user_id, id, payload->>'checkinInstruction', urgency, created_at
  FROM outbox
 WHERE payload->>'rung' = 'admin' AND payload->>'checkinInstruction' IS NOT NULL
 ORDER BY created_at;
