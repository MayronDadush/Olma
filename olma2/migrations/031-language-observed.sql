-- The language we SPEAK to somebody is decided once, at intake, from their
-- first message and their dialling code (domain/language.js). Nothing has
-- ever revisited it, and nothing could: there is no messages table, and
-- turn_start records `message.received` with no text at all — deliberately,
-- because we do not keep people's words in Postgres.
--
-- So on 2026-09-04 a user wrote four messages in English and got four Hebrew
-- replies. The agent was following the template, which says in as many words
-- not to switch because one message arrived in another language. It was right
-- about one message and had no way to see four.
--
-- These three columns are the smallest thing that closes that. The model
-- reports the LANGUAGE CODE of each message it receives — never the text —
-- and the domain counts how many in a row disagree with what we have stored.
-- Two witnesses, the same rule the travel detector uses, and then Olma ASKS
-- rather than switching underneath them.
ALTER TABLE users
  -- The language we keep seeing that is NOT users.locale. NULL means the last
  -- message agreed with what we store, so there is no streak to speak of.
  ADD COLUMN IF NOT EXISTS locale_observed       TEXT,
  -- How many messages IN A ROW arrived in locale_observed. Reset to 0 by any
  -- message in their stored language: a streak that has been interrupted is
  -- not a streak, and a person who genuinely mixes languages should never be
  -- nagged about it.
  ADD COLUMN IF NOT EXISTS locale_observed_count INT NOT NULL DEFAULT 0,
  -- When we last asked "would you like me to switch?". Asking is cheap once
  -- and insufferable twice, so a declined offer buys a long silence.
  ADD COLUMN IF NOT EXISTS locale_asked_at       TIMESTAMPTZ;
