---
paths:
  - "olma2/src/intake/openclaw-config.js"
  - "olma2/src/intake/provision.js"
  - "olma2/src/channels/**"
  - "olma2/gateway-plugin/**"
  - "olma2/gateway-hooks/**"
  - "olma2/scripts/pin-openrouter-provider.js"
  - "olma2/scripts/set-session-reset.js"
  - "olma2/scripts/disable-heartbeats.js"
  - "olma2/scripts/set-queue-mode.js"
  - "olma2/scripts/set-cache-retention.js"
  - "olma2/scripts/enable-turn-context.js"
  - "olma2/scripts/register-openrouter-models.js"
  - "olma2/scripts/cache-probe.js"
---

# Talking to the gateway

Moved verbatim out of `CLAUDE.md` on 2026-09-11. The root file keeps every
rule's headline and points here for the body; the story behind each one is in
`olma2/docs/incidents.md`. **If this file and the server disagree, the server
wins.**

Was `CLAUDE.md`, "Talking to the gateway" — a comment anywhere in the repo citing that
title means this file. Grep the title, not the filename.

- **Never shell out to `openclaw config set`** — it can hang forever *after* a
  successful write. Read → modify → `JSON.stringify(cfg, null, 2)` → write.

- **An invalid config is IGNORED, not rejected.** The gateway logs one line and
  keeps serving the last valid config, so everything looks healthy while your
  change was never loaded. **After any config write, verify the gateway applied
  it** — not that the file says what you meant.

- **A bindings-ONLY write is silently dropped.** Bundle it with another hot
  change (provisioning writes agent + binding in one `saveConfig`).

- **After a gateway version bump, diff `openclaw.json` against what
  `src/intake/openclaw-config.js` expects.** Diffing catches a key that changed
  shape; it does not catch a NEW key that quietly became load-bearing. Only
  exercising the capability end-to-end catches that.

- **Permission to use a model lives in THREE lists** — `agents.defaults.models`,
  `models.providers.openrouter.models[]`, and
  `agents.defaults.modelPolicy.allow`. Two of three is registered-and-unusable,
  and invisible until an override is tried.

- **The live OpenRouter model names its providers in order**
  (`agents.defaults.models["openrouter/deepseek/deepseek-v4-flash"].params
  .provider.order`, `scripts/pin-openrouter-provider.js --apply`, restart the
  gateway). Unpinned, OpenRouter picked a different provider per request —
  three in six hours on 2026-09-09 — and a prompt cache is per provider, so
  the first call of nearly every message paid the whole prompt: 0–9% cached
  for any gap over two minutes, ~90% for the second call of the same turn
  (`incidents.md`, "The conversation that never ended"). DigitalOcean first
  for the price ($0.068/M against $0.089–0.091), the two it was already using
  behind it, `allow_fallbacks: true` so an outage costs the cache and never a
  reply. `register-openrouter-models.js` writes `{}` per model and would wipe
  this; `config_guard` goes red when the order is gone. `model-pricing.js`
  prices flash at the pinned provider's rates — new rows only, the ledger is
  append-only.

- **The `Conversation info` block is prompt-only: the transcript keeps the
  bare text.** On 2026.8.1 the roster, the tag and the message id of a group
  message exist in one place code can reach — the `llm_input` plugin hook,
  which hands over the model's input verbatim (`gateway-plugin/olma-turn`
  → brokerd `group_context` → `group_inbound_context`). Group mode was
  designed to read them off the store, went live, and registered nothing
  (`incidents.md`, "The roster was never in the transcript"). A store
  that our own probes wrote into is not evidence of what the gateway writes.

- **Never poll `openclaw sessions list` on a timer** — 2.9s of CPU per call,
  measured when the box had one core and still most of a core now that it has
  two. It directly slows every user's reply.

- **The gateway heartbeat stays OFF: `agents.defaults.heartbeat.every: "0m"`.**
  `target: "none"` only suppresses delivery; the 30-minute NO_REPLY turn
  still runs for every agent, and it was 82% of the model bill (2026-09-05,
  `incidents.md`, "The heartbeat was the bill"). Nothing of ours rides on it.
  `config_guard` goes red if it comes back; `scripts/disable-heartbeats.js
  --apply` turns it off again.

- **Every session resets daily: `session.reset: { mode: "daily", atHour: 2 }`**
  (UTC on the box — 05:00 in Israel, before anybody writes). The gateway
  default is "none", and a session that never ends carries the whole
  conversation into every call: on 2026-09-09 u-3's one session, open since
  08-27, was 205k tokens a call — $0.018 of history per message before the
  first word, 8–23 s to the first token, 52% of the real-user bill across
  four people (`incidents.md`, "The conversation that never ended"). What
  the conversation knows lives in the DB and USER.md, not in the window.
  **`readRecentMessages` follows `session_windows.previous_session_id`** so
  the watchers (promise_watch, the onboarding review, fact extraction,
  unanswered) still see yesterday on the morning after — a reader of the
  live session id alone is blind once a day. `config_guard` goes red if the
  mode comes back off; `scripts/set-session-reset.js --apply` sets it.

### systemd scope

- **Only `openclaw-gateway` is a user-level unit** (`systemctl --user`, needs
  `XDG_RUNTIME_DIR=/run/user/0`). `olma2-brokerd`, `olma2-dashboard` and
  `olma-voice-bridge` are **system-scope** — plain `systemctl`. Checking the
  wrong scope reads as a false "service is down".

---
