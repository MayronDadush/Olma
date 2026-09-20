-- The room hears, once, that its coordination is in the calendar — and only
-- when a SHARED event really exists (owner, 2026-09-20). "הוספתי ליומן של
-- כולם" was never true: the private turn adds the event for whoever has a
-- calendar connected, and coordination 35 had exactly one such person. So
-- the line is keyed on `meetings.calendar_event_id`, which only
-- calendar.createSharedMeetingEvent ever writes, and this stamp says the
-- room was told. NULL means "not said yet", the same shape as the five
-- columns migration 053 added.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS group_calendar_at TIMESTAMPTZ;
COMMENT ON COLUMN meetings.group_calendar_at IS 'when the room was told the shared calendar event exists; NULL = not yet (only meaningful with calendar_event_id set)';
