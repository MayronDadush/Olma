-- A confirmed meeting's shared calendar event was created and then forgotten:
-- nothing recorded WHICH Google event belongs to WHICH meeting, so when the
-- initiator asked to cancel a confirmed meeting (a live request, 2026-08-27)
-- there was no way to take the event back off anyone's calendar. The
-- organiser's copy is the master — deleting it with sendUpdates=all makes
-- Google mail a cancellation to every invitee — so the linkage is one event
-- id plus whose calendar hosts it.
ALTER TABLE meetings ADD COLUMN calendar_event_id     TEXT;
ALTER TABLE meetings ADD COLUMN calendar_organiser_id BIGINT REFERENCES users(id);
