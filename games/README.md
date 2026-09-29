# games: game nights beside Olma

Buy-ins, chips, food and the fewest transfers at the end of a poker night.
Its own service (`gamesd`, 127.0.0.1:8794), its own database (`olma_games`,
its own role), its own deploy. **Stage 1 touches nothing of Olma's**: a night
is played through its page alone. The plan and every decision behind it are
in the game-nights planning document.

| | |
|---|---|
| `src/money.js` | The arithmetic: nets in agorot, food splits, minimum transfers (exact up to 15 balances). |
| `src/store.js` | Every write, in one transaction per night with the night row locked; `game_results` kept true after each. |
| `src/validate.js` | What a write may contain. The page is not trusted: the link is the only permission. |
| `src/server.js` | The page, its API (`state`, `events` over SSE, `write`, `next`), and two box-only routes. |
| `public/night.html` | The page, ported from the prototype. It keeps its own copy of the math so it can redraw on every keystroke; `tests/page-parity.test.js` runs both copies on the same random nights. |
| `bin/new-night.js` | Stage 1's only way to open a night: `node bin/new-night.js "פוקר של חמישי" 50 1000 "מיכל,יוסי"` on the box. |

## Run it locally

```
createdb games_dev
GAMES_DB_URL=postgres:///games_dev GAMES_PUBLIC_BASE=http://127.0.0.1:8794 node bin/gamesd.js
node bin/new-night.js "ערב ניסיון" 50 1000 "מיכל,יוסי,דני"
npm test          # makes and drops its own database per file; GAMES_TEST_ADMIN_URL overrides
```

## Putting it on the box (once, by a person)

0. Merge first. The same PR teaches olma2's `scripts/backup-offbox.sh` a
   second database, and it reaches the box with olma2's own deploy.
1. `bash games/scripts/setup-box.sh`: database, role, `/opt/olma-games/.env`
   (password generated on the box, never printed), the unit, and the backups:
   a nightly `pg_dump olma_games` at 02:20 beside olma2's (14 days on the
   box), an off-box copy at 02:45 (30 days in the bucket), and one copy made
   right away so the dashboard's `backup_offbox_games` row exists from day
   one. Restore drill, same as olma2's: download, `gunzip`, `psql` into a
   throwaway database.
2. `bash games/deploy.sh`: sync, install, start, and prove `/health` answers.
3. The route in `/etc/caddy/Caddyfile`, inside the `allma.world` block, then
   `systemctl reload caddy`. Exactly the page and its four API actions,
   never `/night/*`:

   ```
   @night path_regexp night ^/night/[A-Za-z0-9]{22}(/api/(state|events|write|next))?$
   handle @night {
       reverse_proxy 127.0.0.1:8794 {
           flush_interval -1
       }
   }
   ```

   `/health` and `POST /api/nights` are never routed, and gamesd refuses both
   for anything that arrives with `X-Forwarded-For`, so a wider route by
   mistake still cannot open nights to the world.
4. Set the repository variable `GAMES_DEPLOY_ENABLED` to `true`. From then on
   a merge touching `games/` deploys it (`.github/workflows/games.yml`).

Rollback: `bash games/deploy.sh --rollback`. Migrations are additive only.

## Limits

Per night: 30 players, 400 buy-ins, 60 food orders, the newest 300 log lines,
5 follow-up nights; 120 writes a minute per night and per client; 60 open
event streams per night. The unit is capped at 192 MB.
