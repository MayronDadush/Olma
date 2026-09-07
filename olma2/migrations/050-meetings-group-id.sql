-- A coordination that belongs to a ROOM rather than to a person.
--
-- The owner's decision (2026-09-07): when Olma is asked in a group to
-- coordinate something, the coordination is the GROUP's, not the private
-- errand of whoever happened to tag her. `initiator_id` still names that
-- person — somebody has to hold the powers only an initiator has (settle,
-- decide a fifth option) — but everything the participants are told names
-- the room, and this column is what makes the room findable from the
-- meeting and the meeting findable from the room.
--
-- NULL is every meeting that ever existed before this and every meeting
-- started in a private chat: a person-to-person coordination has no room.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS group_id BIGINT REFERENCES chat_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS meetings_group_open_idx ON meetings (group_id) WHERE group_id IS NOT NULL;
