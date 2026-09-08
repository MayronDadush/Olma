-- Two things the personal dashboard has always asked for and never kept.
--
-- The "פרטים אישיים" card on /me offers four fields — first name, last name,
-- date of birth, form of address — and until now not one of them was saved:
-- the inputs repainted the page and nothing was ever sent to the server. So
-- the one obvious repair for a wrong name (type the right one) silently did
-- nothing, and the date of birth every person saw was `1994-03-16`, hard-coded
-- into the markup of the design file the live page is served from.
--
-- first_name and last_name already had columns. These two did not.
--
-- birthday is a DATE and nullable, and NULL is the default on purpose: nobody
-- has ever told us theirs, so every existing row starts empty rather than
-- inheriting the fixture's. It is a full date rather than a month-day because
-- the owner asked for the year too — "זה תמיד טוב לדעת עוד מידע על משתמשים
-- שאפשר לעזור להם איתו" — and a year cannot be recovered later from a stored
-- month-day.
--
-- address_gender is how Olma speaks TO them, which Hebrew inflects on almost
-- every verb. It is NOT assistant_gender, which is the opposite direction:
-- that one is the persona speaking about ITSELF ("אני בודק" vs "אני בודקת").
-- The two have been confused once already in this file's history, so they are
-- named apart. NULL means nobody has said, which is a real third state and not
-- the same as masculine: the doctrine's documented default for address is
-- masculine, so a NULL renders no line at all on the user card and costs
-- nothing per turn, exactly as assistant_gender does.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS birthday DATE,
  ADD COLUMN IF NOT EXISTS address_gender TEXT
    CONSTRAINT users_address_gender_check CHECK (address_gender IN ('male', 'female'));
