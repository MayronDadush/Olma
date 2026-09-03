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

---

## 2026-09-01 — NousResearch Hermes: refused before a run, and the check that should have come first

**No pilot happened, and none can.** All four Hermes models on OpenRouter —
`hermes-4-70b`, `hermes-4-405b`, `hermes-3-llama-3.1-70b`, `hermes-3-llama-3.1-405b`
— report `tools: false` and `tool_choice: false` in their own
`/api/v1/models` `supported_parameters`. The capability is absent, not weak.
The gateway refuses the override before a turn starts:

> No callable tools remain after resolving explicit tool allowlist
> (tools.allow: *, read, write, edit); **the selected model does not support
> tools.**

An Olma turn is mostly tool selection across ~59 MCP tools, so this is
disqualifying at any price. Prices, recorded only so the question is not
re-opened hoping the answer moved: 70b $0.13/$0.40 per Mtok, 4-405b
$1.00/$3.00, 3-405b $1.00/$1.00 — against the incumbent v4-flash's
$0.089/$0.177. None of them undercuts what we already run even setting tools
aside. hermes-3 is both older *and* dearer than hermes-4-70b.

**The cheap check that was skipped, and is now the first step for every
future candidate:** read `supported_parameters` off `/api/v1/models` and
confirm it contains `tools` BEFORE registering anything. One curl, no key
needed. Here it would have replaced a registration, two config writes and two
failed probes. `register-openrouter-models.js` carries the rule in a comment
at the `MODELS` array.

### The registration script was writing two of three gates

Found by the probe the script's own footer recommends — which is the entire
reason that footer exists, and the second time it has earned its keep.

The 2026.8.1 gateway upgrade introduced **`agents.defaults.modelPolicy.allow`**
and seeded it from the then-current allowlist. The script writes
`agents.defaults.models` and `models.providers.openrouter.models[]`; a model
absent from this third key is refused at override time:

> Model override "..." is not allowed for agent "u-15" by
> `agents.defaults.modelPolicy.allow`.

This is the `agents.list` → `agents.entries` incident repeating exactly: the
vendor's migration moved the goalposts while OUR writer kept the old schema
in its head, and the failure is silent until something tries to use the
result. The script now extends `modelPolicy.allow` too.

**It deliberately does NOT create the key when absent.** The gateway's own
error text says "remove/empty the list to allow any model" — so an absent or
empty allow list means *no restriction*, and manufacturing one would silently
narrow a permissive gateway down to exactly our six ids. Only a list that
already exists and already restricts gets extended.

Live config was restored from `openclaw.json.pre-hermes-20260901`; zero
Hermes references remain, the default model is untouched, both services are
`active` and the dashboard `/health` returns 200.

### Unrelated but worth not confusing

The name arrived via `github.com/NousResearch/hermes-agent`, which is **not** a
model — it is a full agent framework competing with OpenClaw, evaluated
separately the same day and rejected (no filesystem isolation between
profiles, which is what Olma's `.olma-identity` auth depends on).

## 2026-09-03 — `toolSearch`: measured, and it is worth under a dollar a month

Prompted by a video claiming a competing harness (TrueForge, TrueFoundry,
MIT) "saves 75% of tokens". Traced before spending anything: their own
wording is *"with the same model 30%, and switching to an open model up to
75%"* — and the open-model switch is what Olma did on 2026-08-26. Their
baseline is Claude Managed Agents, not OpenClaw. So the headline was already
banked and the residual was ~30% of a ~$18/month bill.

The one transferable idea was deferred tool loading — and **OpenClaw 2026.8.1
already ships it**, unused: `tools.toolSearch`, `mode: "directory"`, which the
gateway's own types describe as "keeps a bounded directory plus selected
schemas visible while deferring the rest behind search/describe/call". Our
`tools.deny` is the hand-rolled partial version.

**It cannot be scoped to the eval user, and that is a schema fact.**
`toolSearch` lives in `ToolsConfig`; the per-agent `AgentToolsConfig` accepts
only `profile / allow / alsoAllow / deny / byProvider / toolsBySender /
codeMode`. Proven at zero risk with `openclaw config validate` against a
sandbox `OPENCLAW_HOME` copy:

    tools.toolSearch                      → Config valid
    agents.entries.u-15.tools.toolSearch  → × Unrecognized key: "toolSearch"

**The measurement that settles it, taken on the live config:**

| | |
|---|---|
| prompt per turn (3 cold sessions, u-15) | **32,369** tokens (32369 / 32372 / 32366) |
| tools shipped every turn | **77**, 48,927 schema chars ≈ **14,000** tokens |
| tool schemas as a share of the prompt | **~43%** |
| realistic `directory`-mode ceiling | ~20-28% of prompt tokens |

And the reason that ceiling is not the saving: the prefix is already served
as **cache reads**, priced far below input. Verified live off
`/api/v1/models` the same day — `deepseek-v4-flash` $0.0886 input vs $0.0177
cacheRead (**1/5**); `gpt-5.6-luna` and `gpt-5.4-nano` $0.2000 vs $0.0200 and
`gemini-3.8-flash` $0.7500 vs $0.0750 (**1/10** each). Observed on the probes:
`cacheRead` 32k-45k with `input` falling to ~19k by the second turn.

So the honest figure is **$0.30-0.55/month realistic, $0.87/month absolute
ceiling** — the ceiling being every one of those 14k tokens removed AND
charged at full input rate, which is not what happens. **Recommendation: do
not enable it.** Not because it fails, but because the upside is under a
dollar against a GLOBAL change to every real user's turn, and because
`turn_start` — the tool the whole turn contract depends on, and literally
first in the registry — would move behind a search wrapper. If the wrapper
changes the names in the transcript, the eval hard checks go red on an agent
that is working perfectly: exactly run #24.

**Note the direction for boost mode:** on a 1/10 cache-read model the cached
prefix is cheaper still, so switching to luna makes the case for `toolSearch`
*weaker*, not stronger. This does not need re-asking per candidate model.

### The finding that outlived the experiment

Writing the per-agent block produced this, which is the valuable part:

    [reload] config reload skipped (invalid config):
    agents.entries.u-15.tools: Unrecognized keys: "sessions", "media", "toolSearch"

**An invalid `openclaw.json` makes the gateway skip EVERY reload, silently**,
and keep serving the last valid config. Nothing errors, nothing retries.
Provisioning writes a new user's agent + binding into that same file — so
while the config is invalid, a joiner's agent never goes live and their
binding routes nowhere, with no symptom anywhere. Same silent shape as
`intakeConfigured` reading only `.list`. `openclaw config validate` exits
non-zero in about a second and is a better detector than anything that only
reads the file's contents.

Method note, recorded because the numbers looked like a result: measurements
taken AFTER a rejected write are worthless — the reload never applied, so
both sides measure the same config and it reads as a confident "no change".
Always confirm the reload was accepted before believing a before/after.
