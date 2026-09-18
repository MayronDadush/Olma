# Ambient motion, and the UX-psychology pass over `/me`

Design work from 2026-09-18/19, written down here because the last time a
dashboard redesign lived only in a transcript and an artifact, it was lost and
rebuilt from scratch (`incidents.md` has the shape; the memory entry is
"Design work can live only in transcripts"). **Nothing in this file ships.**
It is a catalogue of proposals plus the reasoning that picked them, and the
owner chooses what gets built, one PR at a time.

Two companion pieces:

- **`ambient-motion.html`** — this directory, openable in any browser. The 35
  live specimens, each with a «before» toggle that renders the dashboard as it
  is today, so a proposal can be compared against the real thing rather than
  imagined. Published for the owner as an Artifact at
  https://claude.ai/artifact/PtbVPk9dmzsRGiCQfrJPfz, where a `db` capability
  stores his picks and his per-specimen notes. **The file here is the copy of
  record**; the artifact is how he reads it.
- **`user-dashboard.html`** — the page all of this is about.

---

## 1. Ambient motion

The owner asked for animations that happen **without a press** — "אנימציות
מגניבות או שמניעות לפעולה גם כשלא לוחצים על כפתור שהם פשוט קורות" — after the
four improvements described in prose were unclear. Showing beat telling, which
is why this is a page of running specimens and not a list.

Three constraints hold all 35 together, and a new proposal that breaks one of
them does not belong here:

1. **It answers a question the person is already asking** — «מה עכשיו?», «כמה
   נשאר?», «מה השתנה?», «זה חי או תקוע?». Motion that answers nothing is
   decoration, and decoration is what makes a dashboard feel cheap on the
   fifth visit rather than the first.
2. **It never asks for a decision and never blocks a tap.**
3. **Anything that loops forever is off entirely under
   `prefers-reduced-motion`** — the global rule at the bottom of
   `user-dashboard.html`'s stylesheet already does this.

### The sections, and why the weighting

| section | n | note |
|---|---|---|
| משימות | 6 | **First on the page.** The owner: "דף המשימות זה הדף שהאנימציות בו הכי חשובות." |
| אייקונים שמציצים | 7 | Icons that do something short once every 6–8s and are idle the rest of the cycle. Asked for as "קופצות או צצות ואז נעלמות… שלא יקחו יותר מדי תשומת לב". |
| בכל עמוד | 4 | Not one screen's — the rules for how content arrives and leaves anywhere. |
| יומן | 5 | The only page where time actually moves, so the only one where motion is information. |
| חברים | 4 | Where other people act while you are not looking. |
| חיבורים | 4 | The most static page, so the one that most easily reads as broken. |
| פרופיל | 5 | About Olma herself; the only place motion is allowed to be a little personal. |

**The peeking icons are deliberately idle ~88% of their cycle.** That ratio is
the whole design: a keyframe list that is quiet from 0% to ~86% and does its
work in the remaining slice. Read `@keyframes wig`, `draw`, `sparkpop`, `lid`,
`peek`, `softpulse` in `ambient-motion.html` — they all have that shape, and a
new one that does not will read as a nag.

### What the owner has picked so far

- `fr-waiting` — "נשימה על מה שממתין לתשובה" (חברים).

That is the only pick recorded at the time of writing, and it may be
incomplete: the picker's first version dropped a second concurrent write and
then let the store's stale snapshot overwrite the screen, so **any pick made
before 2026-09-18 21:00 UTC may have been silently lost.** The fix is in the
page now (a coalescing write loop plus a snapshot guard — see `flush()` in
`ambient-motion.html`), but the picks predating it are not trustworthy. Ask
before building from this list.

---

## 2. The UX-psychology pass

The owner sent *"The UX Psychology Behind Apps People Can't Stop Using"* and
asked to work from it. Six principles; **three of them do not belong in this
product**, and saying so is part of the record:

- **Reciprocity** (give before asking) is already satisfied structurally.
  Nobody arrives at `/me` from a search result — they arrive from a link Olma
  sent in WhatsApp after she had already done something for them. There is no
  signup wall to soften.
- **Loss framing** (a countdown on your files, a dismiss button reading "I'll
  risk it") works on a stranger in a funnel. Pointed at a person's real tasks
  by an assistant they already trust, it is hostile, and it is the kind of
  thing that gets an assistant muted.
- **Contrast / anchoring** needs a price to anchor against, and the dashboard
  shows none.

The remaining three do apply. All three findings below were read out of the
code, with line numbers as of 2026-09-19 — re-check them before acting, since
this file cannot move when the code does.

### Finding 1 — every "new task" starts as a blank form

`$("#addTask")` calls `openSheet(null)` with no preset, and the object
`openSheet` builds for a new task is `{d:"", tm:"", all:false, rem:false,
rep:"none", remOff:0, cal:false, cat:"none"}` — no date, no time, no reminder,
no category. The date row renders the literal string `sheet.noDate`
("ללא תאריך"). That is five decisions before anything happens, which is the
decision-fatigue case the video opens with.

**The mechanism to fix it already exists**: `openSheet(id, preset)` takes a
preset and merges it over the blank object. It is used exactly once today —
for a shared task started from a friend's row.

### Finding 2 — the page only ever shows the debt

The tasks header is built in one call: the number of **open** tasks and the
number of pending reminders. What was closed today appears nowhere except the
archive counter. A person opening the page is told only how much is left,
never how far they have come — the video's "0% complete" framing, and the
reason its car-wash study is worth reading.

### Finding 3 — and the house already does both, one screen over

The coordination sheet has progress dots, and its button is labelled with what
is waiting behind it — «הבא · 3 אנשים», not «הבא». That is the same move as
the video's "Search · 12 results", already written in this codebase. So
fixing the task sheet is not an invention; it is making the two screens agree.

### Proposed, not built

1. **Smart defaults in the new-task sheet** — date = today, time = the hour
   this person most often picks, category = what the classifier already
   guesses, and a button that says what will happen ("שמור · תזכורת ב־17:00").
   Anyone who wants otherwise changes one row.
2. **A header that counts forwards too** — "3 נסגרו היום · 5 פתוחות". Not a
   fabricated head start: just no longer hiding the half that already happened.
3. **An empty state that says what did happen** — today it reads "אין משימות
   פתוחות. יום נקי."

---

## Standing rules this work runs under

- Findings are reported first and nothing is added unasked; the owner picks.
- One PR per fix group.
- Anything with a visible change is shown to him before it merges, because
  **merging `main` is deploying production.**
