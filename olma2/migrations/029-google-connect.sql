-- One consent link for calendar + contacts + Gmail together, instead of
-- three (domain/google-connect.js). Google shows one checkbox per scope on
-- its OWN consent screen, so the user still picks exactly what to grant —
-- this only saves them three separate links and three separate approvals.
--
-- requested_access described a SINGLE access level, which a combined
-- request does not have (calendar's level is independent of whether
-- contacts/mail were even asked for). requested_services carries the real
-- shape: {"calendar": "read_only"|"read_write"|null, "contacts": bool,
-- "mail": bool}. The single-purpose flows (calendar.js, google-contacts.js,
-- mail.js) are untouched and keep writing requested_access exactly as
-- before — this column is NULL for every row they insert.
ALTER TABLE oauth_states
  ALTER COLUMN requested_access DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS requested_services JSONB;
