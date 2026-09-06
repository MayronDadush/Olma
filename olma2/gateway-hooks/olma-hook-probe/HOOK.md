---
name: olma-hook-probe
description: "Diagnostic: one line per internal hook event the gateway hands us"
metadata:
  { "openclaw": { "events": ["message:received", "message:preprocessed", "message:sent", "agent:bootstrap", "command:new"], "requires": { "bins": ["node"] } } }
---

# olma-hook-probe

Diagnostic only, off by default. When `hooks.internal.entries.olma-hook-probe.enabled`
is true it appends one JSON line per event to `/opt/olma2/run/hook-probe.log`
(`OLMA_HOOK_PROBE_LOG`): event type and action, the first 40 characters of the
session key, and which context keys were present. Never the message text.

Built 2026-09-06 to answer one question — does `message:received` reach a
managed hook at all on this gateway — after `olma-turn-open` loaded cleanly
and still never ran for fifteen real messages. Disable and remove the config
entry once that is known.
