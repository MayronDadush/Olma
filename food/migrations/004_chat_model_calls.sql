-- The page's chat reads a sentence with the same small model the photo uses:
-- a third purpose for model_calls (src/chat.js).
ALTER TABLE model_calls DROP CONSTRAINT IF EXISTS model_calls_purpose_check;
ALTER TABLE model_calls ADD CONSTRAINT model_calls_purpose_check CHECK (purpose IN ('see', 'match', 'say'));
