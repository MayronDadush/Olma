# Google app verification — the sensitive-scope submission

Everything needed to get project **692111599145** through Google's OAuth
verification on the **free** (sensitive-scope) track, so
`google_connect_phones` can be opened without anybody meeting the
"Google hasn't verified this app" screen.

Started 2026-09-08. Update the status table as steps land.

> **The free track and the paid track are decided by ONE thing: whether the
> consent screen declares a RESTRICTED scope.** Calendar and contacts are
> *sensitive* — demo video, privacy policy, terms, and a review. `gmail.*` is
> *restricted* — the same review **plus** a third-party CASA security
> assessment, annually, paid. One restricted scope prices the whole app onto
> that track. See CLAUDE.md, "Rules that break production".

---

## Status

| | State | How it was checked |
|---|---|---|
| App home page | ✅ live | `https://allma.world/` → 200, links `/privacy` and `/terms` |
| Privacy policy | ✅ live, English first | `/privacy` → 200; names every scope the code requests, in both languages |
| Terms of service | ✅ live | `/terms` → 200 |
| Limited Use disclosure | ✅ present | verbatim clause + link to the User Data Policy, in `public-pages.js` |
| No restricted scope on any public page | ✅ guarded | `tests/public-pages.test.js` fails if one appears |
| Domain ownership | ✅ done | two `google-site-verification` TXT records on `allma.world` |
| Redirect URI | ✅ matches | `/opt/olma/google-oauth.json` → `https://allma.world/oauth/google/callback` |
| Agent cannot request Gmail | ✅ hardcoded | `tools/combined-connect.js` passes `wantMail: false`; no job or tool imports `mail` |
| `email_access_phones` flag | ⚠️ **`all`** — one field to close | see [Loose end](#loose-end-the-mail-flag-is-open) |
| Consent-screen scope list | ❓ **unknown — blocks everything** | see below |
| Publishing status | ❓ unknown | console only |
| Demo video | ⬜ not recorded | script below |
| Submitted | ⬜ | |

### Why the scope list could not be checked from here

The obvious probe does not work, and it is worth writing down so nobody
repeats it. Driving a consent URL per scope and reading the response tells you
nothing about what the app *declares*: a control with
`auth/drive` — a scope this app has never used — reaches the sign-in page
exactly like `gmail.readonly` does, while a nonsense scope returns
`invalid_scope`. Google validates that the scope **exists**, not that it is
registered to the client. (A bogus *redirect_uri* control does fire correctly —
that check works, this one does not.)

**The registered scope list is readable only in the console.** That is step 3.

---

## The one decision that has to be made first

**Is `gmail.readonly` still on the consent screen?**

Evidence that it was, at some point: two live `gmail` rows in `integrations`,
one for the admin (u-3, 2026-09-06) and one for a real user (u-12, 2026-09-04).

If it is still listed, the app is on the paid track today and the verification
will be quoted as such. Removing it costs:

- u-12's dormant Gmail grant stops being usable. **Nothing reads it** —
  `tools/email.js` was deleted on 2026-09-07 and no job or agent tool imports
  `mail`, so no user-facing behaviour changes.
- Reopening mail later is one small file plus a re-verification.
  `domain/mail.js` and its 32 tests are untouched by design.

**Recommendation: remove it.** Mail is already closed in every way that a user
can reach; leaving the scope declared buys nothing and costs the free track.

---

## Console checklist

Google Auth Platform, project **692111599145**. In order.

1. **Branding.**
   - App name: `Allma - Personal Assistant` — must match `BRAND` in
     `src/adapters/http/public-pages.js` exactly.
   - App home page: `https://allma.world`
   - Privacy policy: `https://allma.world/privacy`
   - Terms of service: `https://allma.world/terms`
   - Authorized domain: `allma.world`
   - App logo: optional, but a missing logo is a common round-trip. 120×120 PNG.
   - User support email + developer contact email.

2. **Audience.** External. Publishing status **In production** — an app left in
   *Testing* cannot be verified, and only listed test users can consent at all.

3. **Data access → scopes. This is the step that decides the track.**
   The list must be exactly:

   | Scope | Tier |
   |---|---|
   | `https://www.googleapis.com/auth/calendar.readonly` | sensitive |
   | `https://www.googleapis.com/auth/calendar.events` | sensitive |
   | `https://www.googleapis.com/auth/contacts.readonly` | sensitive |
   | `https://www.googleapis.com/auth/userinfo.email` | non-sensitive |

   Remove anything else — **`gmail.readonly` above all**. `openid` and
   `userinfo.profile` are non-sensitive and harmless if present.

4. **Clients.** Confirm the authorized redirect URI is exactly
   `https://allma.world/oauth/google/callback`, and that there is only **one**
   OAuth client. A second `client_id` forces every existing connection to
   re-consent — changing a redirect URI does not, changing the client does.

5. **Submit for verification** with the justifications and the video link below.

Expect days to a few weeks, and expect one round of questions.

---

## Scope justifications (paste as-is)

**`calendar.readonly`**
> Allma is a personal assistant that users talk to inside WhatsApp, in their own
> language. They ask questions about their own schedule — "what do I have
> tomorrow", "am I free on Thursday evening" — and the app reads the signed-in
> user's own calendar events to answer, and to propose times that are genuinely
> free when the user is arranging a meeting. Events are read on demand to answer
> a specific request; they are not bulk-copied into our storage. A narrower
> scope does not serve this: free/busy alone can say a slot is taken but cannot
> tell the user what the commitment is, which is the question they asked. Data
> from this scope is never sold, never used for advertising, and never used to
> train generalized models.

**`calendar.events`**
> Requested only when the user has explicitly chosen edit access on our own
> screen, before the consent link is generated — the assistant asks "view-only,
> or also add and edit?" and passes only what the user answered. It is used to
> create a single event the user asked for in words ("put the dentist in on
> Tuesday at 16:00"), to move an event when the user reschedules it, and to add
> participants to a meeting the user is coordinating. The app never creates or
> modifies events on its own initiative. `calendar.app.created` is not
> sufficient: users ask the assistant to move and edit events that already exist
> on their calendar and that the app did not create.

**`contacts.readonly`**
> Users refer to people by first name only ("remind me to call Dana"). The app
> imports names and phone numbers into a private address book belonging to that
> one user, so they do not have to dictate a number that is already in their
> phone. The import is read-only and one-directional. It notifies nobody, and
> discloses to no contact that the user uses this service. Contact data is never
> shared with other users of the app, never sold, never used for advertising,
> and never used to train generalized models.

**`userinfo.email`**
> Used to show the user which Google account is connected, so they can tell two
> accounts apart and disconnect the right one, and to set the organiser address
> when the user creates a calendar event with participants. The calendar scopes
> do not return the signed-in user's own address.

---

## Demo video — shot list

Unlisted YouTube is fine. **In English, or with English subtitles.** Google
rejects more videos than applications; the two things that get it bounced are a
consent screen that is not legible and a scope that is never shown being used.

Every requested scope must be shown being used, and the consent screen must be
shown in full with the app name readable.

1. Browser at `https://allma.world` — URL bar visible, app name on screen.
   This is what ties the video to the registered home page.
2. WhatsApp: user asks to connect their calendar. Show the assistant asking
   view-only or edit, and the user answering.
3. Open the link. **Hold on the Google consent screen for several seconds** —
   app name, the scope checkboxes, and the `allma.world` domain all legible.
   Do not crop it.
4. Grant consent, show the landing page it returns to.
5. `calendar.readonly` in use — back in WhatsApp, ask "what do I have
   tomorrow?" and show the answer that came from the calendar.
6. `calendar.events` in use — ask to add an event, then cut to Google Calendar
   in a browser showing that event now exists.
7. `contacts.readonly` in use — connect contacts, then show a request that
   resolves a first name to a number ("remind me to call Dana").
8. `userinfo.email` in use — show the screen where the connected account
   address is displayed.
9. Show disconnecting a connection.

---

## Loose end: the mail flag is open

`email_access_phones` is `"all"` on the box. `mail.requireMailAccess` therefore
returns ok for **everybody** — the only thing preventing a Gmail consent link is
the hardcoded `wantMail: false` in `tools/combined-connect.js`. One line of code
is the whole defence.

Set it to `''` so the data agrees with the intent. It can only refuse more, it
is reversible, and nothing reads mail today. Do this before submitting, not
after: the point of the exercise is that the app cannot ask for a restricted
scope.

**Where:** admin dashboard → **הגדרות מערכת** → *חיבור תיבת מייל — מי מורשה*.
Clear the field, save. That form already routes through `flags.setFlag` and
writes the `admin.*` audit row, which is why it is the way to do this and a
hand-run `UPDATE` on the box is not. Its own help text has said "leave closed
until the Gmail permission is approved in Google's console" since the field
was added — the value simply never followed the text.

The neighbouring field, *חיבור גוגל (יומן ואנשי קשר) — מי מורשה*, is the one to
set to `all` on the day Google approves. Leave it empty until then.

---

## After Google approves

1. Flip `google_connect_phones` to `all` (admin page).
2. The day-one 8h step and both `calendar:*` check-in rungs start offering
   again on their own — they decline while the door is shut, by design.
3. Existing connections are unaffected throughout. The gate has only ever
   governed **minting a new link**; nothing is disconnected or revoked.
