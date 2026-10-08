# food: what a person ate, beside Olma

A person sends Olma a photo of their plate, a voice note, a nutrition label or
a line ("אכלתי פיתה עם חומוס"). The model breaks it into items with amounts
and values per 100 g, and `log_meal` records it. Their day lives on a page
Olma links them to, and **everything the page can do, they can also ask Olma
for** — the page's write and the matching tool call the same store function.

Its own service (`foodd`, 127.0.0.1:8795), its own database (`olma_food`, its
own role), its own deploy, on the same pattern as `games/`. foodd never reads
Olma's database: brokerd says who a token belongs to (`identity_resolve`) and
draws the day card into the person's workspace (`pack_card`).

| | |
|---|---|
| `src/store.js` | Every read and write: meals on the person's local day, items, water, portions, the usual, auto meals, goals, challenges, insights. One door per change. |
| `src/validate.js` | What a write may contain. Impossible values (kcal over 950 per 100 g, macros holding more energy than the kcal) are refused whole. |
| `src/nutrition.js` | The arithmetic: totals, the plate's balance, the goal formula (Mifflin-St Jeor), the three challenges. |
| `src/days.js` | A person's "today", from their own timezone, never the server's. |
| `src/tool-defs.js` | Olma's 15 tools as the model sees them. No requires, so the shim lists them without pg. |
| `src/tools.js` | What each tool does, through the store. In no-numbers mode a result carries no calorie or gram at all. |
| `src/vision.js` | A photo of a plate, read by a vision model: names and grams, never calories. |
| `src/foods.js` | Values per 100 g from a table (`data/`, USDA SR Legacy), by the English name the model wrote; a new name is matched once, by a cheap model choosing among table rows, and saved for everybody. |
| `src/llm.js` | foodd's only door to a model (OpenRouter), every call written to `model_calls` with its cost. |
| `bench/` | The vision bench that chose the model: 21 weighed plates and real photos, rerun with one command when a new model comes out. |
| `src/card.js` | The day card as SVG: meals and balance, never a calorie. brokerd renders it with Olma's fonts. |
| `src/server.js` | The page, its API (`state`, `write`, `card.svg`), and the box-only `/api/tool`. |
| `public/day.html` | The page. |
| `bin/food-mcp.js` | The MCP shim the gateway spawns (`mcp.servers.food`). A copy of games' shim. |
| `bin/foodd.js` | The service; also writes the meals people asked to log themselves, once a minute. |

## How a photo becomes a meal

1. The person sends a photo; the gateway saves it and shows the model its path.
2. `see_meal_photo` asks brokerd for it (`pack_media`: only from the gateway's
   inbound directory, under two hours old, an image by its bytes, only for a
   pack holder) and hands it to Gemini 3.5 Flash-Lite at temperature 0.
3. The model answers names (Hebrew and the English a food table would use)
   and grams, and at most one question: an amount it cannot judge, or oil and
   dressing it cannot see, which every model in the bench missed.
4. `foods.resolve` takes each item's values from the table by its English
   name (`table`); a label they sent keeps its own (`label`); an item no row
   fits keeps the values it was sent (`model`) or a typical value for its
   group, marked low and said out loud (`group`). `items.value_src` records
   which, and `items.food_id` the row, so a wrong row can be fixed everywhere.
5. The meal is logged at once and the question is asked after; the answer is
   an `edit_meal`.

Why this model and why the table: `bench/` and the decision page "בדיקת מודלי
ראייה". With values from one table, Flash-Lite put 55% of weighed plates
within 20% (the dearest models 36-40%), at about $0.90 per 1,000 photos.
Up to 60 photos a person a day.

## What it does

- **Log** from a photo, voice, label or words; a shared dish counts only their part (`shared_part`); a meal eaten earlier lands on its own day (`date`, up to 7 days back); a rough meal (Friday dinner) counts as a meal and nothing else.
- **Portions are learned.** A corrected amount, on the page or in the chat, becomes their portion for that item, and the next plate starts from it (the result says so). An amount they said themselves, or one off a label, is never overridden.
- **The usual.** "Like yesterday" and the meals they eat most (three times in four weeks) are one call away, and one they eat every day can log itself at an hour they choose (`auto_log_meal`).
- **A goal** from height, weight, age, sex, activity and aim, in two calls: a proposal, then their yes. Under 18 no calorie goal is set and numbers are hidden.
- **No-numbers mode** hides every calorie and gram, on the page and from the model's results, and keeps logging underneath.
- **A weekly challenge** (vegetables at dinner, protein at breakfast, 6 cups of water) counted from the meals themselves. 5 of 7 is a win.
- **Insights** computed from what they logged; an empty list for somebody who has logged little.
- **The day card**: one picture to share, with its caption and their invite link.
- **Care.** Three days running under 1,000 kcal brings a note on the next result, once a week: never praise it, ask gently, offer to hide the numbers.

## Not yet

- **Messages Olma starts** — an evening summary, the weekly one on Saturday night, the morning line for an auto meal — need brokerd's outbox, as game nights' settlement does. foodd has the data; nothing sends them yet.
- **Shabbat and chagim** are honoured only in what the tools say; there is no proactive message to hold.
- **Barcodes.** A label photo works; a barcode lookup needs a product database (Open Food Facts).
- **Tzameret.** The Health Ministry's table (Hebrew names, Israeli foods) fits `foods` as `source = 'tzameret'` (the CHECK already allows it), but its file is not downloaded and its loader is not written; the USDA table carries everything until then.
- **The photo path is assumed, not seen.** The gateway shows the model a path for a .vcf it receives (olma2's `import_contacts_file`); that it does the same for a photo is the assumption this rests on. Check one real photo's turn before turning the pack on for anybody.
- **Couples** (sharing with a partner, cheering each other on) is designed in the demo and waits.

## Run it locally

```
createdb food_dev
FOOD_DB_URL=postgres:///food_dev node bin/foodd.js
npm test          # makes and drops its own database per file; FOOD_TEST_ADMIN_URL overrides
```

## Putting it on the box (once, by a person)

0. Merge first. The same PR brings olma2 migration 114 (`user_packs` accepts
   `food`), brokerd's `pack_card` and `pack_media`, the `food__*` deny, and the `olma_food`
   backup; they reach the box with olma2's own deploy. **Check the migration
   number against `SELECT max(version) FROM schema_migrations` on the box
   before merging** — 114 was picked without that query.
1. `bash food/scripts/setup-box.sh`: database, role, `/opt/olma-food/.env`
   (password generated on the box, never printed), the unit, and the backups
   (a nightly dump at 02:25, the off-box copy at 02:50).
2. `bash food/deploy.sh`: sync, install, start, and prove `/health` answers.
3. The route in `/etc/caddy/Caddyfile`, inside the `allma.world` block, then
   `systemctl reload caddy`. Exactly the page and its three actions:

   ```
   @food path_regexp food ^/food/[A-Za-z0-9]{22}(/api/(state|write)|/card\.svg)?$
   handle @food {
       reverse_proxy 127.0.0.1:8795
   }
   ```

   `/health` and `/api/tool` are never routed, and foodd refuses both for
   anything that arrives with `X-Forwarded-For`.
4. In `/opt/olma2`: `node scripts/register-food-mcp.js` (dry run), then
   `--apply`. It refuses while `/opt/olma-food/bin/food-mcp.js` is missing,
   and writes the server and every agent's deny in one validated save.
5. Turn it on for a person: a `user_packs` row (`pack = 'food'`,
   `via = 'owner'`), then `scripts/sync-agent-tool-policies.js --apply` (or
   the next deploy). Nobody sees anything until then.
6. Paste the vision key into `/opt/olma-food/.env` as `FOOD_OPENROUTER_KEY=`
   (its own OpenRouter key with a spending limit, never Olma's), then
   `systemctl restart olma-food`. Without it everything works except photos
   and matching new food names. `FOOD_SEE_MODEL` / `FOOD_MATCH_MODEL` point
   elsewhere for a trial.
7. Set the repository variable `FOOD_DEPLOY_ENABLED` to `true`. From then on a
   merge touching `food/` deploys it (`.github/workflows/food.yml`).

Rollback: `bash food/deploy.sh --rollback`. Migrations are additive only.

## Two locks, each enough on its own

- **The gateway never shows the tools.** Every agent carries `food__*` in its
  `tools.deny` unless its person has a `user_packs` row for `food`.
- **foodd refuses them.** `/api/tool` answers only on 127.0.0.1 with no
  `X-Forwarded-For`, asks brokerd who the token belongs to, and refuses
  anybody whose packs do not include `food`.

The page's link is its own permission, like a game night's: whoever holds it
sees and changes that person's log. Olma gives it only to them.

## Limits

12 items a meal, 40 meals a day, 7 days back; 120 page writes a minute per
link and per client, 120 tool calls a minute per person. The unit is capped at
192 MB.
