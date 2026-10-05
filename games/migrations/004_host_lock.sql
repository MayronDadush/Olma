-- The host and the lock (owner, 2026-10-05). The host can lock a night so
-- that only they add or take back buy-ins and write other players' chips.
-- Everybody else still writes their own chips and adds food orders.
--
-- `host_player` is the seat of whoever opened the night: the person Olma
-- opened it for (players.linked_via = 'host'), or the phone that pressed
-- "ערב חדש" on the night before. A night opened from the box has none and
-- cannot be locked. The host is recognised the way every seat is: by the
-- phone holding it (players.device), or by their user id in the chat.
--
-- `host_key` lets the host move to a new phone while the night is locked,
-- when nobody else may sit in their seat. Olma hands it out only to the host,
-- only on request, and it works once and for ten minutes (`host_key_until`),
-- because the host forwards the night's link to the group and a lasting key
-- in a link would travel with it.
ALTER TABLE nights ADD COLUMN host_player text;
ALTER TABLE nights ADD COLUMN locked_at timestamptz;
ALTER TABLE nights ADD COLUMN host_key text CHECK (host_key ~ '^[A-Za-z0-9]{16,32}$');
ALTER TABLE nights ADD COLUMN host_key_until timestamptz;

UPDATE nights n SET host_player = p.id
  FROM players p
 WHERE p.night_id = n.id AND p.linked_via = 'host' AND n.host_player IS NULL;
