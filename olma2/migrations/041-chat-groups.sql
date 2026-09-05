-- Group mode (olma2/docs/group-mode.md). Olma sits in a WhatsApp group,
-- answers only when genuinely @-mentioned, and answers NOBODY there until
-- every member has written to her privately at least once.
--
-- `chat_groups`, not `groups`: `GROUPS` is a keyword in Postgres window
-- frames, and a table nobody can name without thinking about quoting is a
-- table that gets renamed later.
--
-- state:
--   locked    — the default and the resting state. Every member has NOT yet
--               written to her privately. The group agent is muted at the
--               GATEWAY (a sendPolicy deny rule on its session-key prefix);
--               the only thing the group hears is the gate notice, composed
--               server-side by brokerd and sent on the raw pipe.
--   open      — every current member is a user who has written to her.
--   too_large — over the member cap (`group_max_members`, a flag). She says so
--               once and stops. Kept distinct from `locked` because it is not
--               a state anyone can fix by sending a message.
--   retired   — she is no longer in the group.
--
-- A group is never created just because someone added her number: registration
-- requires at least one member who is already an Olma user (see
-- domain/groups.js), or anyone in the world could mint an agent and a
-- workspace on the box by adding a number to a group.
CREATE TABLE chat_groups (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel               TEXT NOT NULL DEFAULT 'whatsapp',
  external_id           TEXT NOT NULL,               -- group JID (…@g.us)
  subject               TEXT,
  agent_id              TEXT,                        -- g-<id>, NULL until provisioned
  state                 TEXT NOT NULL DEFAULT 'locked'
                          CHECK (state IN ('locked', 'open', 'too_large', 'retired')),
  -- The timezone the group's quiet hours run in: whichever timezone most
  -- members are in. Recomputed on every roster change, never NULL once a
  -- member resolves to a user (users.timezone is never NULL either — the
  -- delivery gate reads UTC out of a NULL and runs an Israeli window three
  -- hours off).
  timezone              TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
  registered_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  opened_at             TIMESTAMPTZ,
  -- The gate's `lastInboundAt` for this group: the last time somebody
  -- @-mentioned her here. outbox/gate.js turns it into the same 15-minute
  -- conversation grace a DM gets, so an answer to someone standing right
  -- there is never held for quiet hours.
  last_mention_at       TIMESTAMPTZ,
  -- Rate limit for the locked-state notice. First tag gets the explanation,
  -- later tags get the nudge that mentions who is missing — and a
  -- repeat-tagger cannot turn her into a spammer in someone else's group.
  last_notice_at        TIMESTAMPTZ,
  notices_sent          INT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);

-- One row per person ever seen in the roster. `left_at` rather than a delete:
-- who was in the room when something was said is history, and the gate must
-- not silently re-open because somebody walked out.
CREATE TABLE chat_group_members (
  group_id      BIGINT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  phone         TEXT NOT NULL,
  display_name  TEXT,
  user_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at       TIMESTAMPTZ,
  PRIMARY KEY (group_id, phone)
);

CREATE INDEX chat_group_members_user ON chat_group_members (user_id) WHERE left_at IS NULL;
