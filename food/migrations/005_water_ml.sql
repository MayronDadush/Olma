-- Water in millilitres, so a person can count bottles as well as cups.
--
-- The owner's call (2026-10-08): a cup is 250 ml, and the page offers a cup
-- and bottles of 500 ml, 750 ml, 1 l and 1.5 l. `cups` stays and is still
-- written (the nearest whole cup), so a reader that knows only cups keeps
-- telling the truth; `ml` is what is counted from now on. Additive only.
ALTER TABLE water ADD COLUMN IF NOT EXISTS ml integer CHECK (ml BETWEEN 0 AND 10000);
UPDATE water SET ml = cups * 250 WHERE ml IS NULL;

ALTER TABLE people ADD COLUMN IF NOT EXISTS water_goal_ml integer CHECK (water_goal_ml BETWEEN 500 AND 6000);
UPDATE people SET water_goal_ml = water_goal * 250 WHERE water_goal_ml IS NULL;
ALTER TABLE people ALTER COLUMN water_goal_ml SET DEFAULT 2000;
ALTER TABLE people ALTER COLUMN water_goal_ml SET NOT NULL;

-- The cup or bottle they last chose on the page, so it opens on it.
ALTER TABLE people ADD COLUMN IF NOT EXISTS water_vessel integer NOT NULL DEFAULT 250 CHECK (water_vessel IN (250, 500, 750, 1000, 1500));
