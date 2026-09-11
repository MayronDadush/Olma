---
paths:
  - "olma2/src/intake/agents-template.md"
  - "olma2/src/intake/provision.js"
  - "olma2/src/adapters/mcp/**"
  - "olma2/src/domain/reactions.js"
  - "olma2/src/domain/action-link.js"
  - "olma2/src/domain/search-link.js"
  - "olma2/src/domain/google-connect-gate.js"
  - "olma2/src/domain/voice.js"
  - "olma2/src/domain/mail.js"
  - "olma2/scripts/resync-agent-templates.js"
  - "olma2/src/adapters/http/public-pages.js"
---

# Doctrine, tools and reactions

Moved verbatim out of `CLAUDE.md` on 2026-09-11. The root file keeps every
rule's headline and points here for the body; the story behind each one is in
`olma2/docs/incidents.md`. **If this file and the server disagree, the server
wins.**

Was `CLAUDE.md`, "Doctrine" — a comment anywhere in the repo citing that
title means this file. Grep the title, not the filename.

- **`agents-template.md` reaches existing users only via
  `scripts/resync-agent-templates.js`.** `deploy.sh --restart` now runs it
  automatically after the health check passes — a manual local deploy does not.

- **The doctrine is FULL: 39,229 of the 39,250 chars the gateway will inject
  (2026-09-05; it was 39,249 the day before).**
  Over the line nothing is announced — `trimAgentsBootstrapContent` keeps a
  head and a tail and deletes the middle of whichever section sits at the cut.
  So a paragraph added there must be paid for by deleting one, and the default
  answer is to put the instruction in the TOOL RESULT instead, where it costs
  tokens only on the turns it applies to (`turn_start`'s `onboarding` string,
  2026-09-04). `tests/intake.test.js` fails before anything is lost.
  The health board shows the rendered size against the gateway's ceiling
  (`doctrineMeter` in `dashboard.js`) — an unreadable config reads as an
  unknown ceiling, never as the gateway's 20k default.

- **The tool schemas have a ceiling too: 55k chars of JSON, 700 per
  description, the identity line under 40** (`tests/tool-schema-budget.test.js`).
  They are injected on every turn for every user, so guidance about what to
  do with a RESULT rides the result (`turnHints`, `set_my_timezone`'s `hints`),
  where it costs tokens only on the turns it applies to — never the
  description. Adding a tool means paying for it by trimming another.

- **When brokerd has put a 👍 on their message, the result says so
  (`hints.markPlaced`) and the model answers `NO_REPLY` unless words add
  something** — a question, a caveat, an error. A sentence after the mark is
  a second notification for the same fact (Miron, 2026-09-05: "deleted ✅"
  under a 👍). **A tool ABSENT from `reactions.TOOL_MARKS` produces a sentence
  that looks exactly like the model ignoring the doctrine**: no row → no 👍 →
  no `markPlaced` → nothing ever told it the fact was already carried. That is
  what answered Miron's "בימי שבת אל תשלח לי תזכורות ולא כלום" in words while
  the row was already saved (2026-09-10) — from the outside, indistinguishable
  from "The hint that outvoted the mark".

- **The owner's rule is that anything which CAN end in a like should**
  (2026-09-10), so the table covers every capture, every undo, everything Olma
  HOLDS (facts, contacts), every SETTING — preferences, timezone, name,
  language, persona, digest, calendar sync, connection grants, disconnects —
  and every side of a share/meeting the ACTOR alone closes (revoke, respond,
  opt out, cancel, the shared calendar event). `subscribe_live_updates` and
  `request_connection` are ⏰ beside `set_task_reminder`: the generalised
  definition is "this row will proactively speak to them later", which a
  connection request genuinely does (the other side's answer fans back out to
  the requester) and a relayed message genuinely does NOT — nothing ever
  notifies the sender once it lands, so `send_message_to_connection` stays
  unmarked rather than borrowing a mark that would be a claim nothing backs.
  **Three families stay out and each is a different reason** (the list is
  above the table in `reactions.js`): a result that must be SPOKEN — a link, a
  media path, the digest block, an import's counts, because a URL nothing says
  reaches nobody; one still WAITING on somebody else — a relayed message,
  every step of a meeting NEGOTIATION (not its exit), where 👍 says "done"
  about something that is not; one whose own hint UNCONDITIONALLY asks for
  words the mark cannot carry — `pause_olma` (silence is the one answer "stop"
  must never get), `resume_olma`, `snooze_task`, so moving one there means
  rewriting its hint first, never just adding a row; and reading.
  `tests/reactions.test.js` fails if a guarded name leaves every list, and the
  cost is bounded — `markFor` dedupes on message AND state, so a turn calling
  three marked tools still spawns ONE closing mark.

- **The hint follows the MARK, not the spawn.** `markFor`'s dedup above is
  right and untouched, but the SECOND done-tool of a turn still gets `null`
  from it, and the `markPlaced` hint used to be hung off that same answer.
  Gali answered a repeating reminder, the model correctly called
  `cancel_reminder` then `complete_task`, and the LAST result it read before
  writing carried nothing at all: 👍 on her message and "בוצע 👍 שמתי שברכת"
  under it (2026-09-10). `reactions.doneMarkStands` answers the other
  question — is a 👍 standing on this message NOW — off the last state
  ATTEMPTED per message, so a mark that could not be spawned is never claimed
  and a later ⏰ means the answer is no. Third variant of one family: the mark
  absent (the preference tools), the mark outvoted (an unconditional hint
  beside it), the mark present and unannounced.

- **A message that is only thanks is answered by a 🙏 and by nothing else.**
  Sixth reaction state; the hint (`turnHints.thanksOnly`) asks for `NO_REPLY`
  on the same argument as `markPlaced`. **The classification runs in the
  turn-open hook and only the boolean reaches brokerd** — the text still never
  leaves the gateway. Strict on purpose: a miss costs one "בשמחה", a false
  positive means Olma ignores a real request, so an explicit thanks is
  required, a question mark disqualifies, and every other word must be on a
  short filler list. **Needs a gateway restart to take effect** — the hook is
  read at startup, and until then the code is live and inert
  (`incidents.md`, "בשמחה יהב, שיהיה ערב טוב").

- **`markPlaced` is CONDITIONAL, so nothing else on the same result may be an
  unconditional instruction to write.** It lost to one for two days: the tool
  result said "say when you will remind them" beside it, and Miron got
  "הוספתי ✅ … לתזכורת עוד שעתיים" under a live 👍 (2026-09-06). The hint was
  neither missing nor ignored — it was outvoted. **Every hint and every line of
  doctrine about what to SAY must answer the same question `markPlaced` asks:
  is there anything here the mark cannot carry.** For a reminder, the hour Olma
  CHOSE is; the hour they NAMED is not, and the save never is.

- **One in-flight reaction per message.** A mark is a whole `openclaw` CLI
  start-up (15s wall on the box, measured again at 14.5s on two cores), so a
  short turn has the 👀 and the 👍 alive at once and the LAST to finish wins.
  `placeMark` kills an older child still starting up when a newer mark arrives
  for the same message; one that already exited is simply replaced on the phone.

- **The shim's connection outlives the turn, so nothing per-turn may be latched
  to it.** `bin/olma-mcp.js` caches ONE socket for the life of its process and
  that process runs for hours, so the same `turn` object serves every turn it
  handles. Adoption of a gateway open was behind a `!turn.opened` latch that
  clears only on a change of user — never — and the first message the process
  ever saw froze into `turn.messageId`: Miron got an ⏰ on a message from five
  minutes earlier, and once the id aged out nothing was marked at all for six
  hours (`incidents.md`, "The mark that never moved"). `takePending` now runs
  on EVERY call and removes what it takes, which is what keeps a count spent
  once; only the implicit recovery stays latched, because with no opening on
  file nothing can tell one turn from the next on that socket. **A test that
  passes a fresh `newTurn()` per turn is not testing the connection we have.**

- **A model with nothing to relay passes something, not nothing.** `turn_start`
  takes `message_id` from the model, and on turns Olma started — where there is
  no inbound message — it sent `manual` and `auto-3` to WhatsApp, overwriting
  the real id the gateway had put on the turn (`incidents.md`, "The message id
  the model made up"). `cleanMessageId` bounds the SHAPE and an invented id is
  well-formed, so **no regex can settle this** — provenance can: never take it
  on `ourTurn`, never over an id the gateway already supplied.

- **The 👀 on a person's message is the GATEWAY's** (`ackReaction` in
  `openclaw.json`), placed on receipt from its own config, and ours is a second
  one behind it. So a working 👀 is no evidence that `placeMark` works at all —
  read the gateway journal for what it actually SENT, per emoji, before
  concluding the mark path is alive.

- **`placeMark` claims nothing and therefore must SAY something.** It is
  fire-and-forget by design — no exit code may reach the caller, and nothing
  user-visible may depend on a mark landing — but it logs the attempt and logs a
  non-zero exit, because without that "the reaction failed" and "no reaction was
  ever attempted" are the same observation from the box.

- **Olma never offers a capability without asking the thing that owns it.**
  Phone calls live behind the bridge's own allowlist, in another process on
  another deploy workflow; `domain/voice.callAvailable` asks `POST /probe`
  (which rings nothing) and the card states the answer. **Three values, never
  two** — `null` is "could not ask" and prints no line at all. **The probe is
  a PATH and not a flag on `/dial`**: the two ship separately, so a probe can
  reach a bridge that predates it, and a field an old `/dial` ignores would
  ring somebody's phone to render a card. Its 404 is the harmless answer, and
  `voice-bridge/deploy.sh` asserts `/probe` still exists, because
  `null` is silent by design (`incidents.md`, "An offer to call a number the
  bridge has never served").

- **A carryover leak is repaired on a schedule, because nothing can name the
  writer.** Another user's intake text appeared in u-17's card twice in four
  days; the agent turned the second one into a task with a reminder. The
  `carryover_repair` job applies `repairCarryovers` every ten minutes and
  refreshes the cards it touched. `admin.carryover_leak_repaired` is in
  `PERMANENT_PREFIXES` — a self-healing exposure with a prunable audit trail
  is one nobody can ever count (`incidents.md`, "The carryover leak came
  back").

- **An instruction handed to the model may assert what its own columns hold,
  and not one word more.** A sweep sees `users.first_name`; it does not see
  where that name came from, and it has never read the person's message. The
  60-second name rung said "they have not replied" (the state it fires on is
  reached BY their writing) and "most likely from their WhatsApp profile"
  (עידן's came from someone else's Google contacts), so Olma asked him to
  confirm the name he had typed ninety seconds earlier. What the code cannot
  know, it sends the model to READ — the transcript is right there and the
  sweep is not (`incidents.md`, "קוראים לי עידן").

- **Telling the model to call a tool is not telling it what the reader of that
  tool's write actually checks.** The model DID call `set_my_name` for עידן —
  with `confirmed` omitted, so it landed as an observation and the rung, which
  keys on `name_confirmed`, fired anyway. Name the FLAG, not just the tool.

- **A fixture that writes the state by hand cannot notice the state is only
  ever reached the other way.** Ten passing tests described a nudge for
  someone who had gone silent; production only ever fires it at someone who
  wrote once. Hold the founding case open where the state is PRODUCED.

- **The owner's opening copy is said ONCE, by whichever voice reaches the
  person first.** An organic joiner meets the intake greeter, so the greeter
  sends it verbatim and provisioning stamps `users.opening_sent_at`;
  `turn_start` reads that column and, on the same `firstTurn`, tells the model
  the introduction is done instead of handing out `sendVerbatim`. A NULL means
  nobody has greeted them (testbed reset, hand-provisioned) and their own agent
  still opens. **A prompt that DESCRIBES brand copy instead of quoting it is a
  second copy of it** — the greeter was told to "say who you are and name one
  or two things you help with", so it wrote its own version and עידן read two
  introductions ninety seconds apart (`incidents.md`, "Two introductions").
  **`greetedByIntake` is READ off the greeter's actual reply, never assumed
  from the session list.** The sweep ticks every five seconds and the greeter
  answers in twenty to forty, so for one evening it stamped everybody as
  greeted before the greeter had said a word — 32 seconds early for u-29, 19
  for u-28 — and `turn_start` then told both agents the introduction was done.
  Two people met Olma with nobody ever saying what she was. Waiting is also
  what makes the CARRYOVER readable: provisioning 0.36s after the message read
  a store the gateway had not finished writing, so בר's first words reached
  nobody while the greeter told him they had been noted. The wait is bounded —
  past `GREETER_GRACE_MS` a silent greeter provisions anyway, unstamped, and
  their own agent opens (`incidents.md`, "Two people, no introduction").

- **A first message is not a hello, and the newest arrivals prove it.** People
  now reach Olma from a WhatsApp group she already sits in: they are asked when
  they are free and they DM the ANSWER — בר's first ever word to her was "אני
  יכול מחר". The greeter is told to open with the copy and does not, because a
  real question in front of it gets a real answer. Any code that treats the
  first inbound as a greeting to be replaced, deduped or discarded is throwing
  away the only thing the person came to say.

- **`gmail.readonly` is a RESTRICTED scope and everything else Olma asks for
  is merely SENSITIVE — the two words are different verification tracks, and
  one restricted scope prices the whole app onto the paid one** (an annual
  third-party CASA assessment, on top of the free demo-video/privacy-policy
  track calendar and contacts need). Mail is closed for that reason
  (2026-09-07): `tools/email.js` is deleted, `start_google_connection` has no
  `mail` parameter, and `tests/mail.test.js` fails if either returns.
  `domain/mail.js` and its 32 tests are untouched — reopening is one small
  file plus a re-verification. **Never add a scope without checking which list
  it is on**; an unverified app asking for a restricted one is blocked
  outright rather than warned, which is what עידן's "This app is blocked" was.
  **The track follows what the app DECLARES, and the declaration lives in
  three places, only one of them in this repo**: the consent screen's scope
  list (Google Auth Platform, project `692111599145`), `/privacy` and `/terms`
  (`adapters/http/public-pages.js` — the pages the reviewer actually reads),
  and the code that mints the consent URL. Deleting the tools moved only the
  third: the pages went on offering Gmail for a day afterwards, and עידן's own
  request was `calendar: read_only, mail: false` — his block came from the
  app's configuration, never from his URL. `tests/public-pages.test.js` fails
  on any restricted scope named on any public page.

- **Every NEW Google consent link goes through one door, and it is CLOSED**
  (`domain/google-connect-gate.js`, flag `google_connect_phones`: '' = nobody
  but an admin, 'all' = everybody, or an E.164 list). While the app is
  unverified its link lands on Google's "not verified" screen, and the owner's
  rule is that nobody meets that screen (2026-09-08). One flag for calendar
  AND contacts because `start_google_connection` mints ONE link covering both
  — gating only the calendar would send the same person to the same screen
  through the contacts half. It gates MINTING: an existing connection keeps
  syncing, nothing is disconnected, and mail keeps its own separate gate for
  the narrower restricted-scope reason above. **A closed door also silences
  the OFFER** — the day-one 8h step and both `calendar:*` check-in rungs
  decline while it is shut, because an offer the tool then refuses is the
  worst kind: they say yes first. The proactive rungs were never the main
  path anyway — u-30 started a calendar auth two minutes after joining, from
  the conversation, and has no connection to show for it.

- **A display name is not a word to be translated.** It arrives in whatever
  script its owner chose; `Idan T` became "היי אידן!" in the first sentence
  that person ever read, while the right spelling sat in a database the
  greeter cannot see. Use it only when it is already in the language they
  wrote in, exactly as spelled — otherwise greet them with no name.

- **Olma never claims a lookup it did not perform.** No price, no stock level,
  no "מצאתי לך", no link to a RESULT — all of it asserts a fetch that never
  happened. `search_link` is the one exception and only because a link to a
  *search* claims nothing: the model supplies WORDS, `domain/search-link.js`
  builds the URL. A model that writes URLs eventually writes a fabricated one.

- **A `url` in a tool result is delivered by the MODEL or not at all** — no
  outbox row, no template, no follow-up sweep sends it. So every result that
  mints one carries `sendLinkVerbatim` (`domain/action-link.js`), which says
  the characters must be in THIS reply and names the sentence that broke it:
  Olma wrote "שלחתי לך קישור 🫡" with no link under it and עידן answered "איפה
  שלחת לי את הקישור?" (2026-09-07). Same class as claiming a lookup — an
  action asserted that nothing performed. `tests/consent-link-reaches-the-
  person.test.js` scans `src/domain` for a seventh one; `availability.js` is
  exempt by name because `/pick/` is retired.
