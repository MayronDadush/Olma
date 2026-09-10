---
paths:
  - "olma2/src/adapters/http/**"
  - "olma2/docs/design/**"
---

# The dashboard and the two hostnames

Moved verbatim out of `CLAUDE.md` on 2026-09-11. The root file keeps every
rule's headline and points here for the body; the story behind each one is in
`olma2/docs/incidents.md`. **If this file and the server disagree, the server
wins.**

Was `CLAUDE.md`, "Two hostnames: allma.world is public, duckdns is admin" — a comment anywhere in the repo citing that
title means this file. Grep the title, not the filename.

- **`allma.world` serves an ALLOWLIST, not the admin dashboard.** Caddy passes
  a named set of routes to `:8788` — `/pick/<48 hex>`, `/d/<64 hex>`, `/me`,
  `/me/data`, `/me/events`, `/me/act`, `/me/out`, `/oauth/google/callback`,
  `/health`, `/ready`, and the three stranger-readable pages `/`, `/privacy`
  and `/terms` — plus `/voice-bridge*` to `:8791`. Everything else 404s
  in Caddy and never reaches the app. **Read the Caddyfile for the current
  set** rather than this line: it said "exactly four" for a day and was wrong
  the moment the personal dashboard shipped. What does not change is the
  invariant — the list is exactly the routes the app serves ahead of its Basic
  Auth check, and **adding a public route to the app does not make it reachable
  — the Caddyfile has to say so too.** That cost the user dashboard its launch:
  the code deployed green, `/me` answered on `127.0.0.1:8788`, and every link
  sent to a person 404'd in Caddy (2026-09-04) — and it cost `/terms` the same
  way on 2026-09-06: PR #239 deployed green and the page 404'd until the
  Caddyfile learned about it.

- **The admin dashboard lives ONLY on `olmachat.duckdns.org`.** It is not
  exposed on `allma.world` at all, not even behind Basic Auth.

- **Match `/pick/` on the exact token shape, never `/pick/*`.** A prefix match
  lets a malformed token fall past `picker.TOKEN_RE` into the Basic Auth
  check, so a truncated WhatsApp link answers a user with the ADMIN password
  prompt on the public domain (`incidents.md`, "A truncated link asked a user
  for the admin password"). The dashboard link follows the same rule —
  `^/d/[a-f0-9]{64}$`, and the five `/me` routes named one by one rather than
  `/me*` — for exactly that reason.

- **Three places hold the domain and none of them are in the repo**:
  `/etc/caddy/Caddyfile`, `/opt/olma/google-oauth.json` (`public_base_url`,
  which builds the OAuth `redirect_uri`), and `/opt/olma2-voice-bridge/server.js`
  (the `<Stream>` TwiML URL). The fourth, the `public_base_url` **flag**, is DB
  state and drives `/pick/` links only — it is NOT the one OAuth reads. A
  deploy cannot touch any of the four, and a rollback cannot restore them.

- **`google-oauth.json` is cached at module level** (`clientConfig()`), so
  editing it does nothing until `olma2-dashboard` restarts.

- **A redirect URI must be registered at Google BEFORE the file points at it**,
  and both hostnames stay registered during any move. Verify against Google
  rather than the console UI: drive a consent URL and check whether it reaches
  the sign-in page or `redirect_uri_mismatch`, **with a known-bogus domain as a
  control** — without one the probe reads "accepted" for everything.

- **Changing the domain never invalidates an existing Google connection.**
  `redirect_uri` belongs to the authorization-code exchange only; the refresh
  grant sends `client_id`/`client_secret`/`refresh_token` and no URI. Re-consent
  is needed only if the **client_id** changes — which is why a second OAuth
  client is the dangerous mistake here, not a second redirect URI.

### Editing the dashboard or domain

- **Admin edits go through the domain functions, never raw SQL**, so an
  operator's change is validated and audited like the agent's own.
- **After any preference/fact edit, call `refreshUserCard(pool, userId)` —
  after the transaction commits, never inside it.** USER.md is what the agent
  reads every turn.
- **Validate any `back` parameter through `safeBack()`**, or the admin becomes
  an open redirect.

## The live dashboard is v2's (`olma2/src/adapters/http/dashboard.js`)

`olma2/docs/v1-reference.md` describes **v1's** dashboard, which is dead — its
"5 edits with a positional param on `renderPage(...)`" recipe does not apply
here and following it wastes a session. This is the one that serves both
https://allma.world and https://olmachat.duckdns.org.

Same house style — zero deps, Basic auth, server-rendered HTML + form POSTs,
no JS — but structured differently:

- **Since 2026-09-05 the file is split:** `dashboard.js` is the router (auth,
  CSRF, the OAuth callback, the GET/POST handlers, ~490 lines);
  `admin/sections/*.js` are the section renderers (one file per group of
  related sections), `admin/sections/index.js` holds `GROUPS` and `SECTIONS`,
  `admin/user-page.js` and `admin/contacts.js` are the two separate pages,
  `admin/posts.js` the per-user POST handlers and `safeBack`, `admin/html.js`
  the shell, `STYLE` and the formatting helpers. Exports are unchanged.
- **Since 2026-09-05 the page is six collapsible groups** (`GROUPS`, CSS-only
  `<details>`), only the first open on load, with an alerts strip inside it
  built from signals the sections already compute (`collectAlerts`, one
  extra query). Every `SECTIONS` entry names its `group`; a section with an
  unknown group falls off the page, and the suite checks the two agree. The
  old outbox and boost sections are blocks inside "מה מתוכנן להישלח" and
  "הגדרות מערכת"; the reaction vocabulary (`reaction_emoji`) is edited there
  too, one box per state via `POST /reactions` — never as a JSON flag row.
- **The personal dashboard (`docs/design/user-dashboard.html`, served as-is)
  creates coordinations and adds, answers, approves and swaps candidate times
  through `/me/act` actions that call the SAME domain functions as the chat
  tools** (`user-dashboard-write.js` → `meeting-options.js`). Picks arrive as
  `{day, part | time}` in the person's own terms and become an instant in
  their zone in `meeting-option-moment.js`; never convert in the browser. A section form may send `back=/#<id>`; `safeBack` accepts
  only ids the page renders.
- **Sections are a named array, not positional args.** `const SECTIONS = [{ id,
  title, hint, render }]`, rendered in order by the `GET /` handler. Adding one
  is a single entry plus its `render*(client, csrf)` function; the `hint` is
  required by convention, because this is a tool someone reads daily and an
  unlabelled table is a puzzle. **Read the array for what exists** — it was
  listed here once and was wrong within a fortnight (10 named, 15 live).
- **`/user?id=N` is a separate page**, not a section — the per-person
  drill-down (tasks, conversation, what is planned for them, preferences,
  facts, delete panel). `renderUserPage` builds it; sections are skipped
  entirely for that path.
- **Routing is `url.pathname`**, the opposite of v1's exact-`req.url` rule.
  Only `/health` (unauthenticated) still matches `req.url` exactly, and the
  Google OAuth callback matches on its own parsed pathname before auth.
- Every POST is CSRF-checked against a cookie, runs inside one `withTx`, and
  redirects 303. A per-user form carries a `back` field — validate it through
  `safeBack()`, never trust it, or the admin becomes an open redirect.
- **Admin edits go through the domain functions**, never raw SQL, so an
  operator's change is validated and audited exactly like the agent's own
  (`preferences.remember/forget`, `facts.rememberFact/forgetFact`). On top of
  the domain's own audit row, each writes an `admin.*` event so the trail shows
  where the change came from.
- **After any preference/fact edit, call `refreshUserCard(pool, userId)` —
  after the transaction commits, never inside it.** USER.md is what the agent
  reads every turn; skipping this puts the card out of sync with the DB, which
  is the exact bug fixed on 2026-08-19.
- **Every sentence Olma sends VERBATIM — reminders and their rungs, the first
  contact to a stranger, everything said in a group — has its default in
  `domain/message-templates.js` and is reworded from the admin page
  ("ניסוחים", the `message_templates` flag), never by editing the literal in
  code on the owner's behalf.** Senders pass the loaded overrides as the last
  argument of `proactive-text.render*` / `intake/messages.*`; an override
  that drops a required placeholder is refused by name on the page and
  ignored at render, so a hand-edited flag row cannot ship a nudge with no
  tags in it. **And a verbatim sentence has no model to read "their language"
  off USER.md, so the language is a TEMPLATE choice made at delivery** —
  `localizedKey` picks the `_en` twin of a rung for an `en` recipient, off the
  users row the worker joins, never off the payload. Sarah got a month of
  Hebrew reminders under an English conversation (`incidents.md`, "Her
  reminders arrived in Hebrew").
- **Cancelling a queued message is an UPDATE, never a DELETE**
  (`sent_at = now(), hold_reason = 'cancelled_by_admin'`). The row carries the
  `idempotency_key` that stops the sweep which produced it from producing it
  again — delete it and the message comes back on the next tick. Cancelled rows
  are excluded from the daily-budget count in `outbox/worker.js`, since nothing
  was ever delivered.
- Times shown and accepted per user are in **that person's** timezone; the
  conversion happens in Postgres (`AT TIME ZONE`) in both directions, so there
  is no offset arithmetic here to break at a DST boundary.
