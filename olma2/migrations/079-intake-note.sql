-- What they told the greeter before their own line existed.
--
-- Provisioning already folds that text into USER.md (intake/provision.js,
-- seedWorkspace) and the doctrine already tells the agent to act on it. What
-- nothing held was the FACT that a note was written — so `turn.advise`, which
-- composes the one instruction a person's first turn actually reads, could
-- only have asked the model to go and look, and "an instruction handed to the
-- model may assert what its own columns hold, and not one word more"
-- (.claude/rules/doctrine.md). This is that column.
--
-- Read exactly once per person, on `firstTurn`, where "nobody has answered it
-- yet" is true by construction: there has been no earlier turn on their agent.
-- It is therefore never stale by the time anything reads it, and it is
-- deliberately not cleared when the agent removes the section from USER.md —
-- the stamp records what provisioning did, which stays true.
--
-- Additive and nullable: a code rollback leaves a column the old code never
-- reads.
ALTER TABLE users ADD COLUMN IF NOT EXISTS intake_note_at timestamptz;

COMMENT ON COLUMN users.intake_note_at IS 'provisioning wrote their words to the greeter into USER.md; read once, on their first turn';
