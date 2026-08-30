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
| Price (per Mtok, OpenRouter 2026-08-30) | $0.079 in / $0.157 out |
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

## The judge's truncated body (diagnosed 2026-08-30)

Not a model quality problem, and worth writing down because it looks like
one and cost a night of alerts. OpenRouter answers a slow non-streaming
request by sending **runs of whitespace as keep-alive padding** while the
model thinks, then the JSON. The failure is that body arriving as **padding
only**, which `res.json()` cannot parse — before the fix it surfaced as a
raw `Cannot read properties of null (reading 'choices')`.

Measured on the box, directly against the API:

| Probe | Result |
|---|---|
| 12 identical calls in isolation (6000 cap, with and without a reasoning cap) | **12/12 ok** |
| Two scenarios during a real suite run | **failed both attempts each** |
| `max_tokens: 2000`, long conversation | `finish_reason: length`, 7.5k chars of **reasoning leaked into `content`** |
| `reasoning: {max_tokens: 1200}` | **ignored** — 2644 reasoning tokens came back anyway |

So it is load-correlated, not random: it does not reproduce on a quiet box
and does reproduce under a suite. That is why the retry is **3 attempts with
a 2s gap** rather than two back-to-back — without the gap both attempts
sample the same bad moment, which is exactly what happened.

If it persists, the real fix is streaming (`stream: true`), which removes
the padding mechanism entirely rather than retrying around it.

## Candidates worth measuring

From OpenRouter's live catalog (2026-08-30), tool-capable, cheaper than the
current default on output. Cheap-and-Anglocentric is the trap to watch:
Hebrew grammatical gender is a hard requirement here, and
`gpt-oss-120b` was already set aside once on that basis.

| Model | in / out per Mtok | vs default (out) | note |
|---|---|---|---|
| `qwen/qwen3.7-flash` | $0.03 / $0.13 | ~1.2x cheaper | 1M ctx; Qwen3 was the original pilot candidate |
| `openai/gpt-oss-120b` | $0.037 / $0.17 | ~same | cheapest-ish, weakest Hebrew bet |
| `deepseek/deepseek-v4-flash-0731` | $0.065 / $0.18 | slightly dearer | pinned build of the incumbent |
| `qwen/qwen3-30b-a3b-instruct-2507` | $0.048 / $0.193 | dearer out | small MoE |

**Sizing, before anyone over-invests** (the same caution CLAUDE.md gives):
all of v2 has cost single-digit dollars in model spend. These experiments
are infrastructure for scale and for *quality* — the `stop-service` red is
worth more than the price difference.

## Results log

Newest first. One entry per pilot; record the run id so the per-scenario
detail stays recoverable from `eval_results`.

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

**Not yet measured:** the genuinely cheaper candidates
(`qwen3.7-flash`, `gpt-oss-120b`) need registering in
`scripts/register-openrouter-models.js` plus a gateway restart, which
briefly interrupts live users — deliberately deferred to a quiet window
rather than done mid-evening. Worth knowing before scheduling it: the
incumbent is already near the cheapest tier, so the prize there is ~$0.02
per Mtok of output, not a step change. The `stop-service` defect is worth
more than the price difference.
