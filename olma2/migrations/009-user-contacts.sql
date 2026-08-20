-- The address book: people in a user's life, by name and real phone number.
--
-- Why this table exists at all, given `connections` already stores phones:
-- WhatsApp lets someone SHARE A CONTACT CARD, and that is by far the most
-- natural way to say "this person". Observed live 2026-08-20: Miron shared
-- עמית מור's card, Olma answered "קיבלתי את עמית מור 👍" — and one turn later,
-- asked to add him as a friend, replied "זה המספר שלך 😅" and asked for the
-- number it had just been handed.
--
-- The cause is a hard boundary in the gateway, not a model slip. The contact's
-- name and number reach the model ONLY on the turn the card arrives; what gets
-- persisted into session history is the placeholder `<contact>`, with the
-- payload stripped. So the data is real for exactly one turn and then gone
-- forever — no amount of prompting can recover it later.
--
-- Hence a row, written during that one turn. Same rule as user_facts and
-- USER.md: the system stores what it learned as a side effect of learning it,
-- instead of hoping a transcript still holds it. It also gives the standing
-- doctrine ("contact/phone facts never belong in memory prose — they are
-- structured and tool-backed") the storage it always implied.
--
-- Deliberately NOT the same thing as a connection: a contact is one person's
-- private note of who someone is, needs no consent, grants nothing, and is
-- never shown to the other side. It is the lookup that PRECEDES a connection
-- request — and the reason nobody should ever be asked to type a phone number
-- they already sent.
CREATE TABLE user_contacts (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  -- Always E.164, normalised on write against the OWNER's country code, so a
  -- card that arrives as "+972 54-261-3404" and a typed "054-261-3404" land on
  -- the same row instead of two.
  phone        TEXT NOT NULL,
  -- contact_card = shared as a WhatsApp card (trust it verbatim);
  -- user_stated = typed or dictated in conversation (may carry typos).
  source       TEXT NOT NULL DEFAULT 'contact_card',
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One row per person per owner: re-sharing the same card corrects the name
  -- rather than growing a duplicate.
  UNIQUE (user_id, phone)
);
CREATE INDEX user_contacts_owner ON user_contacts (user_id, display_name);
