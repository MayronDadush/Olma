-- Where a dashboard sign-in link lands, kept on the link's own row.
--
-- The destination used to ride the URL as `?meeting=<id>`, which made every
-- link about ninety characters long in a WhatsApp message. The owner asked for
-- links that look like links (2026-09-15), so the URL is now only
-- `/d/<22 characters>` and the row says where it goes: the front page, the
-- task list, or one coordination.
--
-- `meeting_id` is SET NULL on delete rather than cascading: a link whose
-- meeting is gone still signs the person in, onto the front page — the same
-- rule the old query-string link followed for a number that named nothing.
ALTER TABLE magic_links
  ADD COLUMN target TEXT NOT NULL DEFAULT 'home'
    CHECK (target IN ('home', 'tasks', 'meeting')),
  ADD COLUMN meeting_id BIGINT REFERENCES meetings(id) ON DELETE SET NULL;

-- "No tasks link in the last seven days" is asked by the digest and by a bulk
-- add, per person.
CREATE INDEX magic_links_user_target_created ON magic_links (user_id, target, created_at);
