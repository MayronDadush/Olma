# olma-voice-bridge

Puts the **real** Olma on a phone call. Not a second assistant with a copied
prompt — the same DeepSeek that runs Olma's background cognition, reading the
caller's real `USER.md` and calling the real `olma2` domain functions.

```
caller ──phone──► Twilio ──Media Streams (mulaw 8k)──► Caddy /voice-bridge
                                                            │
                                                     127.0.0.1:8791
                                                            │
                      Deepgram Nova-3 (Hebrew STT) ◄────────┤
                      DeepSeek via OpenRouter (brain) ◄─────┤
                      ElevenLabs / Cartesia (TTS) ◄─────────┤
                      olma2 domain fns: tasks, calendar, users
```

Audio is **mulaw-8k end to end** — Twilio speaks it natively and the TTS
providers emit it natively, so the bridge never transcodes a sample.

## Why this lives outside `olma2/`

Its own systemd unit, its own port, fronted by Caddy at `/voice-bridge`.
**A crash here drops a call and touches nothing else.** It is not part of the
`olma2` deploy: `deploy.sh` does not rsync it and `rollback.sh` cannot restore
it. It reaches into `/opt/olma2` at runtime for `node_modules`, the domain
functions and `/opt/olma2/.env`.

## This directory is NOT the deploy target

The bridge runs from `/opt/olma2-voice-bridge/` and **every path inside
`server.js` is absolute to that location** (`OLMA_ROOT` overrides the
`/opt/olma2` half so a checkout can run the tests). This directory is the
source of record; deploying is `deploy.sh`, which snapshots the running tree
to `/opt/olma2-voice-bridge-previous`, rsyncs, installs, restarts the unit and
proves the dial API answers — restoring the snapshot if it does not:

```bash
bash voice-bridge/deploy.sh              # deploy this checkout
bash voice-bridge/deploy.sh --rollback   # put the previous tree back
```

CI does the same on every merge to `main` that touches `voice-bridge/`
(`.github/workflows/voice-bridge.yml`), after `npm run check` and `npm test`
— the pure half of the bridge (`lib/persona.js`, `lib/env.js`) has tests; the
call path itself is proven by a real call.

`olma-voice-bridge.service` is the unit, kept here so it is not one more thing
that exists only on the droplet. It is **system-scope** (`systemctl restart`,
not `systemctl --user`) — see CLAUDE.md, "systemd scope".

## Multi-user, and why it is fail-closed

It used to resolve ONE user by phone at startup and hold them in a global.
Adding a second person to the allowlist under that design would have rung the
first person's phone and handed the second person's caller the first person's
private card. So the user is resolved **per call**:

```
dial → placeCall(user) embeds <Parameter name="userId"> in the TwiML
     → Twilio echoes it back on the stream's `start` event
     → the bridge loads THAT user and threads them through the Call
```

A stream arriving without a valid, active `userId` is hung up rather than
served, and there is no default user to fall back to.

This holds for the allowlist too. `VOICE_ENABLED_PHONES` has **no default**:
if it is unset or empty the bridge refuses to start, rather than falling back
to a number baked into the source. It used to have one, for continuity when
the variable was absent — which meant a bridge that lost its `.env`, or was
deployed to a new box before the file was copied across, would place real
calls to that number instead of going quiet. Missing config now means nobody
is callable, never somebody.

## What is deliberately not committed

| | |
|---|---|
| `.env`, `twilio.env` | secrets — see `.env.example` |
| `transcripts/` | one JSON per call: user speech and Olma's replies |
| `clips/`, `phrase-candidates/`, `voice-tour.wav` | generated audio, reproducible from the scripts here |

`phrases/` **is** committed (56K). Unlike the rest of the audio it is not
reproducible: each take was chosen by ear from many candidates
(`freeze-greeting.js`), and re-rendering gives a different take. It is loaded
at startup; if absent the bridge logs `phrases: none installed` and speaks
every sentence live, so it degrades rather than breaks.

## Scripts

| | |
|---|---|
| `find-voice.js` | list provider voices matching a name fragment |
| `make-voice-clips.js` | one clip per candidate voice, for the audition page |
| `freeze-greeting.js` | pick by ear the ONE take every call opens with |
| `make-tour-audio.js` | regenerate the voice tour as a single WAV |

The Hebrew sample line in the audition scripts was a real user's real
schedule; the third party's name in it was replaced with a placeholder when
this was imported. It is arbitrary text whose only job is to exercise Hebrew
prosody, numbers and a name.
