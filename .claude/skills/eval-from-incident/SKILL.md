---
name: eval-from-incident
description: Draft a behavioural eval scenario from an incident that already happened, so a doctrine change stops being a bet. Use after fixing a model-behaviour bug, when adding a rule to CLAUDE.md or a rules file, or when asked to turn a week's incidents into evals.
---

<!--
Frontmatter is `name` + `description` only, deliberately. Those two are the
pair verified to work on this machine (the live ~/.claude/skills/graphify one
uses exactly them); every other key documented elsewhere was dropped rather
than shipped untested. Same argument as everything else here: a field a
document describes and a field the tool reads are two different claims.
-->

# Draft an eval scenario from a real incident

`src/evals/scenarios.js` opens with the standard this skill serves:

> every one is a real incident that already happened to a real user, re-run
> nightly so it can never quietly come back. 467 unit tests were green the
> night "אני רוצה להפסיק את השירות" was answered with a goodbye and no tool
> call: unit tests check code, these check the model's judgment. **Add a
> scenario when an incident teaches a new rule; a doctrine change with no
> scenario behind it is a bet, not a fix.**

There are 14 scenarios and 146 incident entries. Most of that gap is correct —
most incidents are infrastructure — but not all of it, and nothing was
measuring which. This skill closes one at a time, and **the owner picks what
stays**: you draft, you show, he chooses. Never append a scenario he has not
read.

## 1. Find the material

```bash
node .claude/scripts/eval-candidates.js --days=7
```

It prints every incident dated in the window, the two entries that carry no
date at all (they fall in no window — read them by hand), and the existing
scenario ids a draft may not reuse. Add `--since=2026-09-01` for an explicit
date instead of a window.

The `rows:` section at the bottom is the other half of the ask — this week's
`onboarding_reviews`, `hebrew_flaws` and reply-leak rows. **It answers only
where the live database is**, so from a laptop it says `NOT ASKED` rather than
printing an empty list; those are different answers and the empty list is the
lie. Two of those three sources also say plainly that they cannot be drafted
from, and that is a property of the writers, not of the week:

| source | what it keeps | draftable |
|---|---|---|
| `onboarding_reviews` | findings + evidence per person per stage | yes |
| `hebrew_flaws` | a count per day; the message is never stored | no — names a day, never a sentence |
| reply-leak audit | the kind + a redacted 40-char fragment | no — the text is deliberately never stored, a frame marker can BE a live credential |

For the bottom two, the day and the kind are a pointer into the transcript, not
a draft. Read the transcript on the box before writing turns from them, or say
you could not.

## 2. Read the incident, not its headline

Open the entry in `olma2/docs/incidents.md` and find three things:

- **what the person actually sent** — verbatim, in their words, including the
  typos. The scenario's `turns` are those messages and nothing tidier.
- **what went wrong** — a tool that was not called, one called with the wrong
  argument, a sentence that should not have been said.
- **which of those is checkable in the DATABASE.** That is the difference
  between a `hard` check and a `rubric` line, and it decides whether the
  scenario can go red on its own.

If the failure was not the model's judgment — a wedged CI run, a sweep that
raced a greeter, a detector that read the wrong column — **stop and say so**.
That incident does not become an eval, and proposing one anyway is the 60%
false-positive list the candidate script threw away.

## 3. Write it in the shape the file already uses

```js
{
  id: 'kebab-case-slug',        // stable; the two-nights-yellow rule keys on it
  title: 'כותרת בעברית',        // what the scenario proves
  seed: async (client, userId) => { /* through the domain, never raw SQL */ },
  turns: ['ההודעה הראשונה', 'ההודעה השנייה'],   // one conversation, in order
  hard: async (client, ctx) => [ ...await turnOpening(client, ctx), /* … */ ],
  rubric: 'מה השופט בודק בטקסט',
}
```

Five things the existing scenarios do that a draft must copy:

1. **`hard` is the point.** A scenario whose only check is a rubric is a
   yellow that nobody acts on. Assert the row: the task exists, the hour is
   the hour they said, `paused_at` is set, nothing was written without consent.
2. **A seed writes through the domain functions**, never raw SQL — a seed that
   bypasses a guard is testing a state production cannot reach.
3. **`turnOpening(client, ctx)` goes in every `hard`**, and it follows the
   `turn_context_phones` flag on its own. Do not hand-roll `turn_start` checks.
4. **The rubric checks the TEXT and nothing else** — Hebrew quality, one
   question at most, no lecture, no apology paragraph. Anything a query can
   answer belongs in `hard`.
5. **A negative check beside the positive one.** `bare-time-shift` asserts a
   task exists at 15:00 *and* that nothing landed at 18:00 — the mistranslation
   it was written for. A scenario that only checks the happy path cannot fail
   for the reason it exists.

## 4. Show it, then land it

Show the owner the full scenario — `turns` verbatim, every `hard` check named,
the rubric — and say **which incident it replays** and **what would have gone
red on the day**. Wait for his pick. Then:

```bash
cd olma2 && npm run lint && npm test
```

The suite is what proves the scenario parses and the seed runs; it does not
run the model. Say that plainly rather than implying a green suite means the
scenario passes — the first real verdict comes from the nightly eval run, and
a brand-new scenario going red on its first night is the expected outcome when
the fix has not shipped yet.
