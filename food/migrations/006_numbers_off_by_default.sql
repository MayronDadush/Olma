-- Numbers are something a person ASKS for (the owner, 2026-10-08): a new
-- person sees what was on the plate, and calories appear once they set a goal
-- (store.setGoal turns them on) or flip the switch. Only the default moves;
-- whoever is already here keeps what they see.
ALTER TABLE people ALTER COLUMN numbers SET DEFAULT false;
