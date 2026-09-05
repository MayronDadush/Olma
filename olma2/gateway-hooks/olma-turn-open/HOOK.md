---
name: olma-turn-open
description: "Tell brokerd a person just wrote, before the model's first call"
metadata:
  { "openclaw": { "events": ["message:received"], "requires": { "bins": ["node"] } } }
---

# olma-turn-open

On every accepted inbound message this writes one JSON line to Olma's brokerd
socket: which agent, which message id, whether it was a voice note. brokerd
opens the turn from that — counts the message, marks the person awake, puts
the 👀 on their message — while the model is still reading the prompt. Nothing
about the message's text leaves the gateway.

Source of record: `olma2/gateway-hooks/olma-turn-open/` in the Olma repo;
`deploy.sh` syncs it here. Enable with `hooks.internal.entries.olma-turn-open.enabled`
(`scripts/enable-turn-open-hook.js --apply`), then restart the gateway once —
hooks load at startup.
