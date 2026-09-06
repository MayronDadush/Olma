-- When Olma actually said hello in a group.
--
-- The intro used to be sent on the one pass that REGISTERED the group, and a
-- send that failed was never retried: the next pass finds the row and takes
-- the "already registered" branch, so the room never hears from her at all.
-- That happened on the first real group (2026-09-06): the box was saturated
-- by a deploy's on-box suite, `openclaw message send` blew its 120s timeout,
-- and the group was left registered and silent for ever.
--
-- Same shape as `opened_announced_at` right beside it: the send is due while
-- the column is NULL and stamped only once it lands.
ALTER TABLE chat_groups ADD COLUMN IF NOT EXISTS introduced_at TIMESTAMPTZ;

-- Every group registered before this column existed has already been
-- introduced to, or is the one that never was. There is exactly one row on
-- the box and it is the one that never was, so NULL is right for all of them.
