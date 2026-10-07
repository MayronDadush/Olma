-- Food tracking is the second pack (food/, its own DB and service), beside
-- game nights. `user_packs.pack` was checked against ('games') alone; this
-- lets 'food' in too. Nobody holds it until a row is written (by the owner,
-- `via = 'owner'`), so until then every agent keeps `food__*` in its deny
-- list and foodd refuses every call.
--
-- Additive: widening a CHECK changes nothing a row already says, and code
-- from before this reads `food` rows as one more pack it does not serve.
ALTER TABLE user_packs DROP CONSTRAINT IF EXISTS user_packs_pack_check;
ALTER TABLE user_packs ADD CONSTRAINT user_packs_pack_check CHECK (pack IN ('games', 'food'));
