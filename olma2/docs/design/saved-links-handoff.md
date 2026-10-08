# Handoff: "שמורים" — saved links for everyone (core olma2, not a pack)

You are implementing a new core feature in `olma2/`. The owner approved the scope below on 2026-10-08. Read this whole brief, then CLAUDE.md's rule headlines for every file you touch (Read the file so its `.claude/rules/*` body loads). Ship as **two PRs**, in order. Merging is deploying.

Design references (untracked, in the worktree `brave-moore-b860ab`):
- `olma2/docs/design/saved-demo.js` — **the approved design (2026-10-08)**, a clickable layer over `user-dashboard.html` built with `build-saved-demo.sh` into `saved-demo.html`, published at https://claude.ai/artifact/FrwtACq9mExPfCZMj8ocyE. Its default view (`OPT.open = "task"`) is what was approved. It supersedes `saved-links-mockup.html` and the `saved-links-*.png` screenshots, which describe a separate "שמורים" view and a resurface card that were both dropped.
- Project doc `claude/olma-links-vision.md` — the extraction research (what each platform gives from a datacenter IP).

## What the person experiences

1. **A DM to Olma that is only one or more URLs** (whitespace allowed) is handled **by code in `before_dispatch`**, with no model turn. The code saves the link(s), picks a list, and replies with a template:
   `שמרתי ב*{list}* {emoji} — {title}` and on a second line `אפשר לענות "לחתונה" כדי להעביר`. If it created a list: `פתחתי רשימה חדשה: *{list}*`. If the link is already saved: `כבר שמור לך ב*{list}* מ{when}`. English `_en` variants too.
2. **URL plus a short list hint**, where what's left after removing URLs is at most 3 words: `לחתונה`, `מתכונים`, `ל-wedding`. Strip a leading ל/ל-, fuzzy-match an existing list name, or create that list. Also code, same template.
3. **Anything else containing a URL** goes to a normal model turn, which uses the `saved_links` tool.
4. **"לחתונה" / "לא, למתכונים" right after a save** goes to a model turn. The tool's `move` with no `link_id` moves the **most recent link saved by this person in the last 30 minutes**. That makes correction robust without asking first. **Never ask "which list?" before saving.** Always decide, save, and offer the correction.
5. **Retrieval** ("מה שמרתי לחתונה?", "המתכון של הפסטה"): the tool's `search` / `list` actions return rows whose URL is delivered verbatim (see doctrine below).
6. **/me — saved lists live INSIDE the tasks page** (owner's decisions, 2026-10-08):
   - a "שמורים" fold on the tasks page, drawn exactly like "אירועים קרובים" — since 2026-10-08 that is the CARD (owner's option F, PR #805: `.fcard`, `.ftile`, `.fsub`), with the chevron on the left after the number. Saved uses the mustard tile (`.fgold`), three thumbnails peeking under the name, the total as the number, and "N חדשים" as the `.fsub.fgold` pill beside it (hidden at 0). Each list is one row (emoji, name, "N שמורים · M חדשים", up to three thumbnails, a done/total pill).
   - the tasks page's search covers tasks, lists AND saved links.
   - a saved list opens a sheet that **looks exactly like a regular list**: a bookmark icon beside the title (not the pencil), "שמורים · עולמה ממיינת לכאן" as the category line, a "קישורים" row with "N מתוך M {verb}", a search box inside the list (the sheet's height is locked while searching so it does not jump), one `.litem` per link (tick, thumbnail, title, a meta line, ✕ to delete), "הדבקת קישור" to add one, and a **"פרטים" row that opens the same options a list has: מתי, תזכורת, חזרה, משותפת**.
   - the meta line under a link: the line that matters for that list (price · rooms · m² for a flat, prep time for a recipe), then the platform, then on a shared list who added it.
   - ticking a link strikes through **the title only**, as in a regular list. The verb is per list: ניסיתי (recipes), ראינו (flats), סגרנו (wedding), צפיתי otherwise.
   - selecting many ("בחירה" → הכל / נבחרו N / מחיקה), deleting a link, and deleting a whole list, each with a 5s "ביטול".
   - a link's own sheet: thumbnail, summary, facts, recipe ingredients with **"להוסיף לקניות"**, "לפתוח ב־{Platform}", the verb toggle, send to a friend, move to another list, delete, and **"להפוך למשימה"**. "בלי פירוט" while extraction is pending or failed.
7. **A link has NO date or reminder of its own** — the owner's words: "כמו שברשימת קניות אין תזכורת רק על ״בננה״". A date or a reminder lives on the LIST (its "פרטים"), or the link is turned into a task:
   - "להפוך למשימה" creates an ordinary task (title prefix per list: "לנסות: ", "לצפות: ", "לתאם צפייה: ") that carries the link (`tasks.saved_link_id`). From then on it is a regular task in every way.
   - such a task shows ONE extra thing on /me: a pill button **"לפתוח ב־{Platform} ↗"** under the title, and a small platform mark before its title in the task list. A task not made from a link shows nothing new.
   - the link in its list then reads "במשימות", and its sheet's row reads "לפתוח את המשימה".
8. **There is no resurfacing.** The weekly "עולמה מחזירה לחיים" digest item, the /me resurface card and the "להזכיר לי שמורים" switch were dropped on 2026-10-08: a saved list now reminds exactly like any list, through its own "פרטים", and nothing else about it is said unasked.

## Hard constraints from this repo (verify each, they are not optional)

- **Migration number:** ask the box for `SELECT max(version) FROM schema_migrations` (via the ops workflow or the owner). Local files end at 114. Additive only.
- **Doctrine is full** (`agents-template.md` sits at about 39,229 of 39,250 chars). Add **no doctrine prose**. Everything the model needs goes in the tool description (≤700 chars) and in result hints.
- **Tool schema budget:** `tests/tool-schema-budget.test.js` has `JSON_CEILING = 61_050`, and only about 53 chars are free.
  - Add exactly **ONE** tool, `saved_links`, with an `action` enum (`save | move | list | search | set_status | delete | lists | rename_list | delete_list | to_shopping | to_task`).
  - Raising the ceiling needs the owner's explicit approval in this session (the precedent is "מאשר את התקרה"). **Ask the owner before raising it**, and state the exact number.
- **Page ↔ chat parity:** every /me action above must be askable in WhatsApp, so the tool's enum covers delete, delete_list, to_task and the list's when/reminder/repeat/share as well (or routes them to the existing task/list tools — decide by reading how a regular list's reminder is written, and prefer the existing door).
- **URLs in replies:** the model never writes a URL. Results that carry a saved URL use `sendLinkVerbatim` (`domain/action-link.js`).
  - `tests/consent-link-reaches-the-person.test.js` scans `src/domain` for results that mint URLs, so register this one the way that test expects.
  - Check that `reply-leak.deadLink` does not strip an external saved URL.
  - Titles and captions come from the fetch, never from the model ("Olma never claims a lookup it did not perform").
- **The `before_dispatch` link shortcut** (`gateway-plugin/olma-turn/index.js` `buildLinkShortcutHandler`, about 712–745) bails at `LINK_SHORTCUT_MAX_CHARS = 80` with an 800ms broker timeout.
  - Add a **separate handler** `buildSaveLinkHandler`, registered after it, and add its tag to the `hooks` array for `stampRegistration`.
  - DM only (`event.isGroup !== true`, agent `u-N`, never `intake`).
  - Bound: body ≤ 2000 chars, at most 5 URLs.
  - **Measure** how long `before_dispatch` may block before the gateway gives up. Budget brokerd to finish inside it: fetch ≤3.5s, classify ≤2s.
  - If the budget runs out, **still save** with a fallback list (by platform/kind) and reply. The enrich job fills in the rest.
  - On any broker failure, fail open to the model turn. Dedupe by `canonical_url` makes a double save harmless.
  - Code-answered = `noteAnsweredByCode` + `eyesAnswered`. Text reply, not a 👍 ("a 👍 OR a message, never both").
- **Gateway restart:** a plugin change needs one. Use the ops workflow `restart-gateway` after deploy, and check that the plugin stamp registers the new hook.
- **Caddy:** a new route `/me/thumb/<id>` must be added to `/etc/caddy/Caddyfile` by the owner **before** code links to it. Until then the page must fall back to the gradient/emoji placeholder, so shipping first is safe. Add both prefix matches in `adapters/http/user-dashboard.js` (`OWN` set at about 350 and the guard at about 458).
- **/me writes:** add actions to `user-dashboard-write.js` `ACTIONS`. They stamp `last_dashboard_at` through `perform()` already.
  - Actions: `moveSaved, setSavedStatus, setSavedNote, deleteSaved (one or many), restoreSaved (the undo), createSavedList, renameSavedList, deleteSavedList, restoreSavedList, setSavedListSchedule, shareSavedList, savedToShopping, savedToTask`.
- **Shopping:** "להוסיף לקניות" goes through the existing list door. A list is ONE row with items, filed under `lists`, and the open list is found by TITLE (rules in `reminders-and-tasks.md`). Reuse `add_tasks_bulk`'s domain path, and don't duplicate open items.
- **Delivery:** nothing about saved links goes out unasked except a reminder the person set on a saved LIST, and that rides the existing reminder path (gate, quiet hours and days, pauses) — no new sender.
- **Tests:**
  - no live network: inject `fetchImpl` and use saved fixtures in `tests/fixtures/links/`
  - never depend on the hour or weekday
  - run `npm run lint && npm test` from `olma2/` before finishing each PR (the Stop hook enforces it)

## Data model (migration N = box max + 1)

```sql
CREATE TABLE saved_link_lists (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL, emoji text,
  created_auto boolean NOT NULL DEFAULT false,
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON saved_link_lists (user_id, lower(name));
CREATE TABLE saved_links (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id bigint REFERENCES saved_link_lists(id) ON DELETE SET NULL,
  list_auto boolean NOT NULL DEFAULT true,
  url text NOT NULL, canonical_url text NOT NULL,
  platform text NOT NULL,          -- instagram|tiktok|youtube|web|maps|...
  kind text,                       -- video|recipe|article|place|product
  title text, author text, caption text, summary text,
  line text, line_by bigint,       -- the one line; NULL line_by = Olma wrote it
  duration_s int, recipe jsonb,    -- {ingredients[], steps[], total_min, servings}
  status text NOT NULL DEFAULT 'new',  -- new|seen|done
  note text,
  extract_level text NOT NULL DEFAULT 'none', -- none|meta|full|failed
  extract_attempts int NOT NULL DEFAULT 0, extract_error text,
  next_try_at timestamptz,
  source_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  touched_at timestamptz,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX ON saved_links (user_id, canonical_url) WHERE deleted_at IS NULL;
CREATE TABLE saved_link_thumbs (link_id bigint PRIMARY KEY REFERENCES saved_links(id) ON DELETE CASCADE,
  mime text NOT NULL, bytes bytea NOT NULL, fetched_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE tasks ADD COLUMN saved_link_id bigint REFERENCES saved_links(id) ON DELETE SET NULL;
-- A saved list's when/reminder/repeat/share: decide in PR2 whether it reuses a
-- task row (tasks already carry due/remind/repeat/sharing) or gets columns here.
-- Deletes are soft (deleted_at) on both tables, so "ביטול" can restore.
```

Starter lists are created lazily on the first save: 🍝 מתכונים, 🎬 לצפות אחר כך, 🎓 ללמוד, ✨ השראה, 📍 מקומות (English equivalents by locale). Mark them `created_auto`.

## Modules

- **`src/domain/link-extract.js`** — pure, `fetchImpl` injected, never throws (returns `null` on failure, and `null` must not be confused with "found nothing").
  - `findUrls(text)` and `normalize(url)`:
    - follow redirects for `vt.tiktok.com`, `vm.tiktok.com`, `youtu.be`, `pin.it`, `maps.app.goo.gl`
    - strip `utm_*`, `igsh`, `si`, `feature`, `fbclid`
    - map `youtube.com/shorts/ID` to `watch?v=ID` for the canonical form
  - Per platform (measured 2026-10-08 from a datacenter IP):
    - **YouTube** → `https://www.youtube.com/oembed?url=…&format=json`: title, author_name, thumbnail_url. The page and yt-dlp are blocked from datacenters (429).
    - **TikTok** → `https://www.tiktok.com/oembed?url=…`: title = the full caption with hashtags, plus author_name and thumbnail_url. Page scraping returns generic meta.
    - **Instagram** → `https://www.instagram.com/p/<code>/embed/captioned/` (works for `/reel/` codes too). Parse `.Caption` (username + caption text) and `EmbeddedMediaImage` src. The og tags are empty from datacenters. Private posts return nothing, and that is a `failed` state, not an error to the person.
    - **Generic** → GET the page with a 2MB cap. Read og:title/description/image, then JSON-LD `@type: Recipe` (also inside `@graph`): name, recipeIngredient, recipeInstructions, totalTime, recipeYield, image. 10dakot.co.il gave 12 ingredients and 6 steps; allrecipes returns 402 to bots.
    - **Yad2** (measured 2026-10-08 from the box): a browser UA gets a Radware bot page, but a link-preview UA (`facebookexternalhit/1.1`, also WhatsApp/Twitterbot/Telegram) gets the real page. og:title is "דירה, <street>, <neighbourhood>, <city> | …" and `__NEXT_DATA__` carries `price`, `roomsCount`, `squareMeter`, `floor`, `entranceDate`, `parkingSpacesCount`. Fetch yad2 with that UA.
    - **Madlan** (same day): Cloudflare 403 "Just a moment..." for every UA tried. Treat as unreadable: save it, no line.
    - **Facebook groups:** not measured; assume nothing without a login.
  - **The one line** (`saved_links.line`, owner's decision 2026-10-08): ONE short free-text line per link, shown under the title on /me — never separate fields. Filled from what was actually read (yad2: "₪7,400 · 3 חד׳ · 75 מ״ר · קומה 3"; a recipe: "7 מצרכים · 15 דק׳"), or from the words the person sent WITH the link, which win over anything read. Anyone may change it, on the page or in chat; `line_by` (`olma` | a user id) says who wrote it and the page shows it ("עולמה קראה מ־יד2" / "כתבת" / "מאיה כתבה"). Empty when nothing was read — the row then shows the title alone. This replaces `summary` on the page; the separate "facts" chips in older drafts were dropped.
  - **SSRF guard:** http/https only; resolve DNS and refuse private, loopback and link-local ranges; refuse our own hosts (allma.world, olmachat.duckdns.org, localhost); at most 3 redirects, each re-checked; 5s timeout; image fetch ≤300KB and `image/*` only.
  - Instagram and TikTok thumbnail URLs are signed and expire, so store the bytes in `saved_link_thumbs` at save time.
  - **First thing to do:** run the five-line probe at the end of `claude/olma-links-vision.md` on the box (add it as a closed `ops.sh` op if needed). If Instagram's embed is blocked from the DigitalOcean IP, ship with the "בלי פירוט" fallback and tell the owner.
- **`src/domain/link-classify.js`** — `choose({meta, lists, examples, hint})` returns `{listId} | {newName, emoji} | {fallback}`.
  - One call through `src/adapters/llm.js` (the background-jobs model), JSON-only output, with a 2s timeout.
  - Input: title/caption (truncated to 600 chars), platform, kind, the person's lists, and 3 recent titles per list as examples. Include their manual moves as examples, since those are corrections.
  - Create a new list only when nothing fits AND (the hint named it OR this is the 2nd unmatched link of similar topic in 14 days). Otherwise use the closest list.
  - Deterministic fallback when the model fails: `kind=recipe` → מתכונים, `place` → מקומות, video → לצפות אחר כך, everything else → השראה.
- **`src/domain/saved-links.js`** — save (dedupe), move (default = last saved in 30 min), list, search, set_status, lists CRUD, `toShopping`, `toTask`, `forDashboard(userId)`.
  - Search: `ILIKE` over title, caption, summary, author and list name. Add pg_trgm only if it's already installed.
- **brokerd:** `case 'save_link_shortcut'` → `handleSaveLinkShortcut({agentId, body, messageId})`, mirroring `handleDashboardLinkShortcut` (server.js about 768–820) for user lookup, `withTx`, templates and audit (`saved_link.shortcut`).
- **Templates** in `src/domain/message-templates.js`: `saved_link`, `saved_link_new_list`, `saved_link_dup`, `saved_link_many`, and their `_en` variants.
- **Tool** `src/adapters/mcp/tools/saved-links.js`, registered in `registry.js`. Also add a `TOOL_MARKS` entry for `saved_links` save/move → `done`, so a plain save can end in a 👍 with `markPlaced`.
- **Job** `saved_links_enrich`, every 300s, in `src/jobs/registry.js` and `expectations.js`:
  - retry `extract_level in ('none','failed')` with backoff 1h → 6h → 24h, at most 3 attempts
  - write a one-line Hebrew/English `summary` from the caption or description (model, ≤90 chars; never invent beyond the text)
  - parse `recipe` from a caption via the model when kind=recipe and there is no JSON-LD
- **/me:** `user-dashboard.js load()` adds `saved: {lists:[{id,name,emoji,count,fresh,done,shared,schedule}], items:[…latest 200, no caption body over 300 chars]}`, and each task carries `link:{platform,url}|null`. The page ports `saved-demo.js`, and the i18n keys go in both the he and en dictionaries.

## PR plan

1. **PR1 — backend + WhatsApp:**
   - migration, link-extract (+ fixtures), link-classify, saved-links, the brokerd op, the plugin handler, templates, the `saved_links` tool (after the owner's budget answer), and the enrich job
   - after merge and deploy: restart the gateway through ops and send a test link from the owner's phone
2. **PR2 — /me:** data, actions, the fold in the tasks page, the list sheet with "פרטים", the task's open-link button, thumbnails (placeholder until Caddy names `/me/thumb/`). Write an eval scenario for "link → 'לחתונה' moves it", using the `eval-from-incident` skill pattern.

Before each PR: `npm run lint && npm test`. After each merge, use `/deploy-triage` and check `/opt/olma2/RELEASE` sha. Add the new rules (link-only shortcut, the SSRF guard, the "never ask before saving" decision) to the right `.claude/rules/*.md` with headlines in CLAUDE.md, per the file's own conventions.
