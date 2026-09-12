# The meeting row, as it was designed

These five files were made in a design session and then **never committed**.
They survived only in a session transcript and in a temp directory macOS was
going to clear; `fd3ae25`'s own commit message deferred the row redesign to
"its own PR", and that PR was never opened. Recovered and committed on
2026-09-12, before the next `/private/tmp` sweep took them.

They are the specification the shipped row in `../user-dashboard.html` now
implements, and `tests/meeting-quorum.test.js` ("the row draws the rules the
design decided") pins each rule below against that file. Read these when you
are about to change the row — a look can be argued with, a rule cannot.

| file | what it decides |
|---|---|
| `meeting-row-final.html` | the row itself: the swipe shell, the ring, the formula line, the minimum chip |
| `icon-language.html` | every mark and what it is allowed to mean |
| `meeting-list-spec.html` | the list around the row; line 320 is where the minimum became a copy on `meetings`, not a read-through to `chat_groups` |
| `meeting-row-actions.html` | the two-press delete, on the phone and on a desktop |
| `meeting-screen-options.html` | the full-screen view behind a row |

The rules they settled, all of which the page now enforces:

- **Gold — the ring and the crown — is unanimity**, and it is the only state
  that arms anything: a minute starts and the coordination settles itself.
- **Green — the ring and the cards — is the coordination's own minimum**, and
  it settles *nothing*. Enough is a judgement and somebody still presses ✓.
- The two are exclusive and gold outranks green; everybody is also above any
  minimum, and two marks on one row would say nothing.
- **Silence is the gap in the ring, never an arc.** An arc for it would draw
  "has not got round to it" as a third opinion.
- **A settled time is not deletable** on either surface — ending something
  everybody has been told about is cancelling the coordination, which is a
  different act with a different word.
- **Deleting takes two presses everywhere**: the swipe is the first of them on
  a phone, the trash arms before it acts on a desktop.
- **The minimum cycles all the way back to unset.** A number copied in from a
  room is exactly the one somebody needs to be able to clear.
