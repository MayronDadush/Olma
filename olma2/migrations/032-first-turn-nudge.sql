-- The moment the opening message was actually handed to the model, distinct
-- from `last_inbound_at` (which moves on every message, including their
-- next one) and from `onboarded_at` (set at provisioning, before they have
-- necessarily written a word). Stamped exactly once, only in the branch of
-- turn_start that actually included onboarding.sendVerbatim in its result —
-- never in the recovery path (domain/turn.js), which never delivers that
-- text at all. It is what a 60-second "did they answer the welcome" sweep
-- has to anchor on, and nothing else in the schema names that moment.
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_turn_at timestamptz;
