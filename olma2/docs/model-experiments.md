# Model experiments — measured, dated, and never on a live user

A standing log of open-weight model comparisons for Olma's **agent turn**
(the expensive path: ~59 MCP tools, Hebrew, doctrine). Background cognition
is a separate, already-settled question — see CLAUDE.md, "Background
cognition runs on direct API calls".

**Why this file exists.** Prices are public and change weekly; what is
expensive to learn is whether a model still calls the right tools, holds
grammatical gender, and obeys doctrine under pressure. That answer has a
shelf life, so every entry here is dated and says what was actually run.
An undated claim about a model is worth nothing three weeks later.

## How to run one

```bash
node scripts/run-evals.js --model openrouter/qwen/qwen3.7-flash
```

Drives all nine behavioral scenarios on a candidate model instead of the
live default. Safety properties, none of them incidental:

- **Nothing is routed anywhere.** The override rides one disposable session
  per scenario (`--model`, the gateway's own per-call flag). `agents.defaults.model`
  is untouched; moving real users is a separate, deliberate act
  (`scripts/set-default-model.js`).
- **It runs on the sealed eval user** (`users.is_eval`, `+972599999001`),
  never on a real person. The outbox gate drops its rows, every sweep
  excludes it, and no turn uses `--deliver`.
- **The run is labelled `trigger='pilot'`** (migration 024), which keeps it
  out of the nightly two-consecutive-nights alert rule and off the
  dashboard's headline. A candidate's reds are not a production regression,
  and must never be able to read as one.
- The script prints the model the gateway **reports** and warns when that
  differs from the one asked for — an override that silently fell back
  would otherwise be recorded as a passing pilot for a model that never ran.

Judge the result on three axes, in this order: **hard checks** (tool
selection and DB state — a cheap model that saves the wrong thing is not
cheap), **judge verdicts** (Hebrew quality, gender, one-question), then
**wall time and price**. A model that is 10x cheaper and drops one tool call
in nine is not a saving; the tool call is the product.

## Baseline — the live default

| | |
|---|---|
| Model | `openrouter/deepseek/deepseek-v4-flash` |
| Price (per Mtok, read live off `/api/v1/models` 2026-08-31) | $0.089 in / $0.177 out |
| Fallbacks | `deepseek-v4-pro` → `anthropic/claude-haiku-4-5` |
| In production since | 2026-08-26 (see CLAUDE.md, "Model provider pilot") |

### Run #9 — 2026-08-30, full suite, live default

`5 green · 0 yellow · 1 red · 3 error` — and the reds and errors have
different owners, which is the whole point of scoring this way.

- **RED `stop-service` — the model, not the prompt.** On the confirmation
  turn ("זהו, תודה על הכל") v4-flash calls `pause_olma` and **skips
  `turn_start` entirely**. Confirmed in the transcript, not inferred:
  turn 1 opens `turn_start` correctly; turn 2 has exactly one tool call.
  Doctrine has now failed to move this **twice** — the original
  every-turn rule, and an explicit ordering line added to the stop section
  on 2026-08-30 that the model read and ignored (the run above is after
  that resync landed in `u-15`'s workspace). `turn_start` is not
  ceremonial: it stamps `last_inbound_at` (the delivery gate's
  mid-conversation grace), counts the message toward quota, nudges
  night-held rows, and carries `offerResume`. **This is the open question
  worth a model change**, and the reason a candidate is being measured at
  all.
- **3 ERROR — the judge's transport, not either model.** See below.

## The judge's failures — and the two things they were NOT (closed 2026-08-31)

Kept because the wrong diagnosis was written down here confidently, twice,
and reading how it was corrected is worth more than the conclusion.

**What was believed:** OpenRouter pads a slow non-streaming request with
whitespace, and the failure is that body arriving as padding ONLY, which
`res.json()` cannot parse. Load-correlated, so retry with a gap.

**Both halves were wrong.** Measured directly against the API, same prompt:

| max_tokens | wall | leading whitespace | parses |
|---|---|---|---|
| 12000 | 49.8s | 1287 bytes | ✅ |
| 24000 | 12.5s | 319 bytes | ✅ |

The padding is real (~a byte per 39ms of waiting) and **has never mattered**
— `JSON.parse` skips leading whitespace. What actually failed was our own
60s timeout: both providers send the 200 immediately and the body afterwards,
so an abort lands mid-body and comes back as a `res.json()` failure on a
response that looks perfectly healthy. `.catch(() => null)` then reported it
as the provider returning nothing. The "load correlation" was just the fact
that a busy box makes a slow call slower.

The second failure underneath it was truncation, and the cap had been raised
three times by guess (700 → 2500 → 6000, all failing). Measured instead:
`reasoning_tokens` **4568** for an answer that is **33 characters**. The
budget is essentially all thinking.

Fixed by naming the timeout as ours on both providers, raising the judge
deadline to 180s (latency is set by upstream load, not the cap — 49.8s and
12.5s for the same prompt minutes apart, so 60s was a coin toss), a 12000
base cap, and escalation to 24000 specifically on `finish_reason=length`,
since that is the one failure class where an identical retry provably cannot
differ. Streaming is **not** needed; it would have solved a problem that was
never there.

## Registering a candidate does NOT need a gateway restart (measured 2026-08-31)

`register-openrouter-models.js` told you to restart for months, and this file
used that to defer the cheap-tier pilot to "a quiet window". Probed straight
after a write that added two models: the `--model` override was accepted
immediately, `executionTrace.winnerModel` named the candidate, `fallbackUsed`
false. Registration applies hot.

This matters beyond one wrong line: the restart is the **only** part of a
model pilot that touches live users, so believing it was required is what
confined these experiments to off-hours. They can run any time. Verify rather
than assume, per model:

```bash
openclaw agent --agent u-15 --session-key "probe:$(date +%s)" \
  --message "test" --model <id> --json | grep winnerModel
```

## Candidates worth measuring

From OpenRouter's live catalog (2026-08-30), tool-capable, cheaper than the
current default on output. Cheap-and-Anglocentric is the trap to watch:
Hebrew grammatical gender is a hard requirement here, and
`gpt-oss-120b` was already set aside once on that basis.

| Model | in / out per Mtok | vs default (out) | status |
|---|---|---|---|
| `qwen/qwen3.7-flash` | $0.030 / $0.130 | ~1.4x cheaper | **measured 2026-08-31 — disqualified** |
| `openai/gpt-oss-120b` | $0.037 / $0.170 | ~same | **measured 2026-08-31 — disqualified** |
| `openai/gpt-oss-20b` | $0.030 / $0.130 | ~1.4x cheaper | unmeasured; same family as the above |
| `mistralai/ministral-3b-2512` | $0.100 / $0.100 | ~1.8x cheaper out | unmeasured; dearer input |
| `qwen/qwen3-30b-a3b-instruct-2507` | $0.048 / $0.193 | dearer out | unmeasured |

**The price argument is now essentially closed.** Read live off
`/api/v1/models` on 2026-08-31, the entire tool-capable floor sits at roughly
$0.03 / $0.13 against the incumbent's $0.089 / $0.177. On a system billing
~$18/month that is hundredths of a cent per Mtok — so a future swap needs a
**quality or speed** argument. Both candidates measured below lose on both.

**Sizing, before anyone over-invests** (the same caution CLAUDE.md gives):
all of v2 has cost single-digit dollars in model spend. These experiments
are infrastructure for scale and for *quality*.

## Results log

Newest first. One entry per pilot; record the run id so the per-scenario
detail stays recoverable from `eval_results`.

### Runs #17-19 — 2026-08-31 — the cheap tier, and it is not close

The first pilots of genuinely cheaper models. Both lose decisively, on hard
checks rather than on taste, and they lose in the **same** way.

| Model | G / Y / **R** / E | suite wall | $/Mtok out |
|---|---|---|---|
| `deepseek-v4-flash` (incumbent, nightly #16) | 6 / 2 / **1** / 0 | — | $0.177 |
| `qwen/qwen3.7-flash` (#17) | 2 / 0 / **4** / 3 | 321s | $0.130 |
| `openai/gpt-oss-120b` (#19) | 2 / 3 / **3** / 1 | 883s | $0.170 |

**The shared failure is tool discipline, and it is the whole product.** Both
candidates open turns with whatever tool comes to mind — `set_my_name`,
`list_my_contacts`, `add_tasks_bulk` — where the incumbent opens with
`turn_start`. That is not a style difference: `turn_start` stamps
`last_inbound_at`, counts the message toward quota, nudges night-held rows
and runs the flood check. DeepSeek's tool obedience is precisely what the
extra $0.04/Mtok is buying.

**`qwen3.7-flash` — disqualified three times over.**

- **It answers with no tool call at all.** Two scenarios recorded `turn opened
  with no tool at all`, and `stop-service` failed as `1 of 2 turns counted`
  — meaning a whole turn never reached brokerd. This also marks the boundary
  of the server-side recovery shipped the day before: it repairs a turn opened
  with the WRONG tool, and **cannot** repair one with no tools, because
  nothing server-side ever hears about that turn. That is a limit of the
  approach, not a defect in it — but it means tool-calling reliability is
  still a hard model requirement, not something the server can paper over.
- **It rate-limits on our OpenRouter tier**, reproducibly: 3 scenarios lost to
  `API rate limit reached`, and a targeted re-run of exactly those three lost
  2 of 3 again. A model we cannot reliably call is not a candidate at any
  price, independent of quality.
- 4 hard reds against the incumbent's 1.

**`gpt-oss-120b` — the Anglocentric assumption is now evidence.** CLAUDE.md
has carried "weakest Hebrew bet" since 2026-08-20 on no measurement at all.
It measured true, and worse than expected: the `stop-service` reply degenerated
into **"בשמת על ההפעלה מחדש של שם שם שם?"** — not awkward Hebrew, broken
Hebrew. It is also **1.6x slower over the suite** (883s vs 550s) and took
**285s** on `hebrew-gender-feminine` against the incumbent's 79s, which is
worth weighing against `stuckSessionAbortMs = 65s`.

**No message sent to Miron.** The standing instruction is to write when
something interesting might justify a change; the finding here is that no
change is warranted, and a "tested two, both worse" WhatsApp is the alert
fatigue this project keeps designing against. It belongs in this file.

**Noted separately, and not a model-choice question:** the incumbent's own
`bare-time-shift` is **intermittent** — green in run #14, red in the nightly
#16 hours later, and red on both candidates. That is a live production
scenario failing occasionally on the model in use, and it alerted overnight.
It is the next thing worth looking at, ahead of any further model shopping.

### Run #10 — 2026-08-30 — `deepseek-v4-pro`, 3 scenarios

`0 green · 1 yellow · 1 red · 1 error`, 360s for three scenarios.

Run to answer one question: **is the `stop-service` red a weak-model
problem?** v4-pro is the incumbent's own stronger sibling and already the
first fallback, so it needed no config change and no gateway restart.

**The answer is no, and it is the most useful result so far.** v4-pro fails
`stop-service` *identically* — `turn opened with pause_olma`, `turn_start`
skipped entirely on the confirmation turn. Two different models, two
doctrine versions (the second written specifically to name the ordering),
same failure.

That rules out the two easy explanations at once. It is not model capability,
and it is not wording. What is left is the **instruction design**: the stop
section is a vivid, numbered, three-step plan whose step 2 says to call
`pause_olma` "THAT TURN, before you write anything back", and it sits far
from the universal `turn_start` preamble it silently overrides. A specific
urgent instruction beats a general one, which is a property of models rather
than of any one model — so **no model swap fixes this**, and the fix has to
be structural.

Secondary findings, both real:

- **v4-pro is 1.4-3x slower** for no correctness gain here: 70s vs 49s on
  `stop-service`, and 222s on `hebrew-gender-feminine`. Against
  `stuckSessionAbortMs = 65s` (progress-staleness, not total duration) that
  is worth remembering before anyone reaches for it as a default.
- The judge's truncated-body failure hit again on the **longest** turn of
  the three (222s), which is more evidence for the load correlation above.
- `goal-capture` went yellow on formatting only — the judge wanted the
  three-vehicle split on one line and got three bullets. Cosmetic; one
  night, so no action (the two-night rule).

**Measured 2026-08-31 — see runs #17-19 above.** Both were deferred here to
"a quiet window" on the belief that registering a model needs a gateway
restart. It does not (see above), so the deferral was unnecessary; and the
`stop-service` defect this pilot was chasing was closed structurally instead,
which is what run #10 concluded it would take.

## Runs #27-#32 — 2026-09-02/03 — the GPT tier, for boost mode

Different question from every pilot above it. Those asked *"should this
replace the default?"*; this one asked **"what should the demo switch
switch TO?"** — a model that runs for ten to thirty minutes at a time
while the product is being shown to investors, where latency and a clean
board matter and the bill does not. Owner's steer was explicit: test the
GPT tier, pick one. That is why a 2.5x price finding below is a footnote
rather than a disqualification.

**The incumbent is not on trial here.** `deepseek-v4-flash` stays the
default; nothing in this section proposes moving real users. The output is
the `boost_model` flag's default value, and it is a flag precisely so this
choice can be revisited without a deploy.

### Two harness failures first, because both are worth a line

- **#27 — `0 green · 9 error`, every scenario identical:** *"Legacy
  workspace setup state requires migration for
  `/root/.openclaw/workspaces/u-15`; run `openclaw doctor --fix`."* The
  eval user's own workspace had been caught by the provisioning trap that
  PR #110 later closed. Fixed with `doctor --fix`; recorded here because
  **the eval harness was the thing that surfaced it** — a suite that runs
  a real agent in a real workspace fails the same way a real user does,
  which is the entire argument for it existing.
- **#28 — `0 green · 9 error`:** *"Model override ... is not allowed for
  agent u-15 by `agents.defaults.modelPolicy.allow`."* A model needs
  **three** lists, not the two CLAUDE.md documents: the
  `agents.defaults.models` allowlist, the
  `models.providers.openrouter.models` catalog entry, **and**
  `modelPolicy.allow`. Registering two of three fails at call time with a
  message that names the missing one — read it rather than re-deriving.

### #29 — `gpt-5.4-nano` — disqualified, 786s

`3 green · 2 yellow · 2 red · 2 error`. Both reds are **hard-check**
failures, which is the axis that ends a candidacy:

| scenario | what it did |
|---|---|
| `not-chatgpt-essay` | **wrote the essay** — 1425 chars on Herzl, when the whole scenario is that Olma is not ChatGPT |
| `general-knowledge` | **delivered the lecture** — 1002 chars |

Not a tone problem and not a judge opinion: the check is a length bound on
the reply, and it blew through both. A demo model that answers a general
knowledge question with a thousand-character essay is worse than the
incumbent in the exact moment someone is watching. The two errors were the
judge's own unparseable-reply wobble, and the `stop-service` yellow was
`רוצה שאני אחזור להיות איתך בקשר?` — a retention pitch the stop doctrine
forbids. Enough on its own.

### #30 and #31 — `gpt-5.6-luna` — the pick

| run | board | wall |
|---|---|---|
| #30 | `8 green · 0 yellow · 0 red · 1 error` | 560s |
| #31 | **`9 green · 0 yellow · 0 red · 0 error`** | 593s |

Run #31 is **the first perfect board in this project's history**. The
single error in #30 was `general-knowledge` returning *"judge reply
unparseable"* — the documented Kimi-k2.6 harness wobble, not the agent;
the same scenario went green on the rerun with no change to anything.

Run in the same window, for the comparison that matters:

### #32 — `deepseek-v4-flash`, nightly, same night

`6 green · 3 yellow · 0 red · 0 error`, 998s. The three yellows are all
the incumbent's familiar cosmetic set — `stop-service` not spelling out
that nothing was deleted, `goal-capture` splitting three vehicles across
three bullets instead of one line, `phone-number-contact` adding an
unnecessary offer. **No reds.** The incumbent is not broken; it is
scruffier.

### What the numbers actually support, and what they do not

**Correctness — strong.** 18 luna scenarios, zero reds, zero yellows,
against 9 incumbent scenarios with 3 yellows. Both the boundary scenarios
a demo would embarrass us on (`stranger-meeting-boundary`,
`not-chatgpt-essay`) were green on luna both times.

**Speed — real but noisier than it looks.** Suite wall time: luna 560s and
593s against the incumbent's three most recent full runs at 785s, 746s and
998s — about **1.4x faster** on average. But the tails overlap: luna's
`stop-service` took **262s** in run #31, the slowest single luna scenario
recorded, and the incumbent's `goal-capture` took 374s in #32. Median per
scenario tells the same story with less flattery — 37s (#31) and 67s (#30)
against 69s. **"Faster on average, not reliably faster on any one turn"**
is the honest claim, and it is the one the boost-mode PR makes.

**Price — 2.5x, and it does not matter at this duty cycle.** A real
seven-day token mix repriced at live rates comes to **$4.36 on the
incumbent against $10.70 on luna**, i.e. about **$0.038/hour** more while
engaged. A 30-minute demo costs under two cents extra; the flag's two-hour
expiry caps a forgotten switch at roughly eight. This is the cheapest line
item in the whole system and is not a reason to choose either way.

**Meeting coordination — partially answered, and stated as such.**
`stranger-meeting-boundary` (refusing to arrange with a non-connection) was
green on luna in both runs, and earlier tool-argument checks were correct.
But **there is no end-to-end negotiation scenario in the suite** — nothing
drives propose → counter → confirm across two users. So the evidence covers
the boundary and the argument shapes, not a full negotiation. Worth
building as scenario #10; until then, do not claim more than this.

**Not measured:** anything under concurrent load. Every pilot here is one
disposable session at a time, and a demo is one conversation at a time, so
the gap is acceptable for this decision and would not be for a default swap.
