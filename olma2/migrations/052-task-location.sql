-- Where an event is. "פגישה עם תמר גבריאלי - ביהס קרית חינוך דרור" carried the
-- place in its title because there was nowhere else to put it; with a column
-- the title is the meeting, the place is data, the calendar event we write
-- out gets a real location, and a reminder can say where. Meaningful on an
-- event (tasks.kind = 'event'); a todo may carry one and nothing reads it.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS location text;
