-- Voice calls cost real money on four meters at once (Twilio, Deepgram,
-- Cartesia, the LLM) and until now not one of them was recorded per call —
-- every number on the cost page came from provider balances, which say what
-- is LEFT, never who spent it or on what. One row per Twilio call, keyed by
-- the provider's own call sid; twilio_usd is Twilio's authoritative price,
-- which arrives minutes after the call ends, so rows are upserted until it
-- lands (NULL means "not priced yet", never "free" — same rule as the cost
-- page's remaining=null).
CREATE TABLE voice_usage_ledger (
  id BIGSERIAL PRIMARY KEY,
  call_sid TEXT NOT NULL UNIQUE,
  -- The person the call reached, when the number is a known user; a test
  -- call to an outside number keeps the row with user_id NULL.
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ,
  duration_sec INT NOT NULL DEFAULT 0,
  twilio_usd NUMERIC(10, 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX voice_usage_started_idx ON voice_usage_ledger (started_at);
CREATE INDEX voice_usage_user_idx ON voice_usage_ledger (user_id);
