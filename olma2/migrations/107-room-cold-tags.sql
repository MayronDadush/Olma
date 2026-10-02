-- Every time a room line TAGGED somebody who has never written to Olma (owner,
-- 2026-10-02, the poker room). They are tagged at most once every three days
-- across every room, and after three tags with no word from them, not again
-- until they write — which makes them a member like any other and takes them
-- out of this rule altogether (domain/cold-tags.js). Keyed by the PHONE, not a
-- user: a LID never becomes a `users` row and can still be tagged.
--
-- Additive: one new table, read and written only by the group sweep.
CREATE TABLE IF NOT EXISTS room_cold_tags (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone TEXT NOT NULL,
  group_id BIGINT NOT NULL,
  meeting_id BIGINT,
  line_kind TEXT NOT NULL,
  tagged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_cold_tags_phone ON room_cold_tags (phone, tagged_at);

-- The tags already said, so the rule starts from the truth. Only lines that
-- actually reached the room, only numbers that still belong to somebody who has
-- never written, and never the opening line: every new room tags whoever has
-- not written, and that is not counted against them (owner, 2026-10-02).
INSERT INTO room_cold_tags (phone, group_id, meeting_id, line_kind, tagged_at)
SELECT DISTINCT t.phone, o.group_id, NULL::bigint,
       o.payload->'line'->>'kind', o.sent_at
  FROM group_outbox o
  CROSS JOIN LATERAL jsonb_array_elements_text(
    COALESCE(o.payload->'line'->'missing', '[]'::jsonb)) AS t(phone)
  JOIN chat_group_members m ON m.group_id = o.group_id AND m.phone = t.phone
  LEFT JOIN users u ON u.id = m.user_id
 WHERE o.kind = 'coordination'
   AND o.sent_at IS NOT NULL AND o.hold_reason IS NULL
   AND o.payload->'line'->>'kind' IN ('base', 'moved', 'almost', 'chase')
   AND (u.id IS NULL OR (u.last_inbound_at IS NULL AND u.opening_sent_at IS NULL))
   AND NOT EXISTS (SELECT 1 FROM room_cold_tags c WHERE c.phone = t.phone AND c.tagged_at = o.sent_at);
