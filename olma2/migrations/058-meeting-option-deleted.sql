-- Anyone in a coordination takes a time off the table.
--
-- The owner's rules on 2026-09-09 replaced the ones from 2026-09-05: five
-- candidate times instead of four, and EVERY person in the coordination may
-- add one or remove one — not only whoever opened it. A removal needs a state
-- of its own: 'replaced' means "swapped out for a new time in the same breath"
-- and reads that way everywhere, while this is somebody deciding the table is
-- better off without that time.
--
-- 'pending' stays in the list on purpose. Nothing writes it any more — the
-- fifth-option-waits-for-the-initiator rule is gone with the same decision —
-- but narrowing a CHECK is not an additive migration, and `deploy.sh` rolls
-- back code only. Measured on the box before this was written: 8 option rows
-- in the whole history of the feature, every one of them 'active', and not a
-- single meeting.option_approved / option_rejected row in the audit log. The
-- mechanism being deleted above never ran for a real person.
--
-- 058: SELECT max(version) FROM schema_migrations on the box was 56 on
-- 2026-09-09, and 057 is claimed by an unmerged branch (never `ls migrations/`).
ALTER TABLE meeting_options DROP CONSTRAINT meeting_options_status_check;
ALTER TABLE meeting_options ADD CONSTRAINT meeting_options_status_check
  CHECK (status IN ('active', 'pending', 'replaced', 'rejected', 'deleted'));
