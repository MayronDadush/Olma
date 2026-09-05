-- Several candidate times per meeting, each with its own answers.
--
-- Until now a meeting negotiated ONE slot at a time (meetings.proposed_slot /
-- proposed_start_at, and meeting_participants.state relative to it). A new
-- proposal replaced the slot and reset everyone. The owner's ask on
-- 2026-09-05: up to four candidates on the table at once, anyone in the
-- meeting may add one, a fifth from a non-initiator waits for the initiator's
-- approval, and the initiator may swap when it is full.
--
-- The single-slot columns stay and keep meaning "the newest active option";
-- everything that read them (check-in rung, digests, the dashboard until it
-- learns options, the chat tools until theirs) keeps working. The options
-- tables are the source of truth from here on, and the columns are mirrors.
--
-- 039: SELECT max(version) FROM schema_migrations on the box was 38 on
-- 2026-09-05 (never `ls migrations/`).
CREATE TABLE meeting_options (
  id          BIGSERIAL PRIMARY KEY,
  meeting_id  BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  slot_text   TEXT NOT NULL,
  starts_at   TIMESTAMPTZ,
  all_day     BOOLEAN NOT NULL DEFAULT false,
  added_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  -- active: on the table. pending: a fifth from a non-initiator, awaiting the
  -- initiator. replaced: swapped out by the initiator. rejected: the initiator
  -- said no to a pending one.
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'replaced', 'rejected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at  TIMESTAMPTZ
);
CREATE INDEX meeting_options_by_meeting ON meeting_options (meeting_id, status);

CREATE TABLE meeting_option_answers (
  option_id   BIGINT NOT NULL REFERENCES meeting_options(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answer      TEXT NOT NULL CHECK (answer IN ('y', 'n')),
  answered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (option_id, user_id)
);

-- Every negotiation in flight becomes a meeting with one option, and the
-- answers already given to that slot travel with it.
INSERT INTO meeting_options (meeting_id, slot_text, starts_at, added_by, created_at)
SELECT m.id, m.proposed_slot, m.proposed_start_at, m.initiator_id, m.updated_at
  FROM meetings m
 WHERE m.status = 'negotiating' AND m.proposed_slot IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM meeting_options o WHERE o.meeting_id = m.id);

INSERT INTO meeting_option_answers (option_id, user_id, answer, answered_at)
SELECT o.id, p.user_id,
       CASE WHEN p.state = 'confirmed_current' THEN 'y' ELSE 'n' END,
       coalesce(p.confirmed_at, now())
  FROM meeting_options o
  JOIN meeting_participants p ON p.meeting_id = o.meeting_id
 WHERE p.state IN ('confirmed_current', 'declined_current')
ON CONFLICT (option_id, user_id) DO NOTHING;
