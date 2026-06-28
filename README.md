# Olma

Operations notes for the self-hosted [OpenClaw](https://github.com/openclaw/openclaw)
assistant (a personal AI assistant that answers on WhatsApp).

This README is a runbook for connecting to the server and keeping OpenClaw
up to date. It is meant to give a future session enough context to pick up
where the last one left off.

## Server

| | |
|---|---|
| Provider | DigitalOcean droplet (`ubuntu-s-1vcpu-2gb-nyc1`) |
| Public IP | `157.230.210.233` |
| OS | Ubuntu 24.04 LTS |
| Resources | 1 vCPU, 2 GB RAM + 2 GB swap, 50 GB disk |
| Hardening | UFW firewall (SSH only), unattended security upgrades |
| Login | SSH key only, user `root` |

### Connect

```bash
ssh root@157.230.210.233
```

This uses the SSH key at `~/.ssh/id_ed25519` on the Mac (public key named
`openclaw` in the DigitalOcean account). No password is required.

If you get `Permission denied (publickey)`, the key on this machine is not the
one registered with the droplet — add the local public key
(`cat ~/.ssh/id_ed25519.pub`) under DigitalOcean → Settings → Security → SSH Keys,
then re-image or add it to `/root/.ssh/authorized_keys` on the server.

## OpenClaw stack

| Component | Detail |
|---|---|
| Runtime | Node 24 (`node -v`) |
| Sandboxing | Docker |
| Install | global npm package `openclaw` (`npm root -g` → `/usr/lib/node_modules`) |
| Service | systemd **user** service `openclaw-gateway` (auto-starts on boot via lingering) |
| Model provider | Anthropic (Claude) |
| Channel | WhatsApp — linked via WhatsApp Web, `selfChatMode` enabled |
| Config + state | `~/.openclaw/` (`openclaw.json`, `workspace/`, `agents/`, `extensions/`) |

> Secrets (the Anthropic API key, WhatsApp session creds) live under `~/.openclaw/`
> on the server. Never commit them to this repo.

## Common operations

All commands below are run **on the server** (after `ssh root@...`).

### Check status / health

```bash
openclaw channels status        # WhatsApp link + connection state
openclaw health                 # gateway health
systemctl --user status openclaw-gateway
```

### View logs

```bash
openclaw logs                   # tail gateway logs
journalctl --user -u openclaw-gateway -f
```

### Restart / start / stop the gateway

```bash
systemctl --user restart openclaw-gateway
systemctl --user stop openclaw-gateway
systemctl --user start openclaw-gateway
```

After a gateway restart the WhatsApp channel briefly shows
`disconnected / health:starting` while the web session reconnects — it returns
to `connected / health:healthy` within ~30s. Confirm with
`openclaw channels status`.

## Updating OpenClaw

OpenClaw is a global npm package, so updates are an npm install plus a gateway
restart:

```bash
# 1. See what is installed now
openclaw --version

# 2. Update to the latest published version
npm install -g openclaw@latest

# 3. Restart the gateway so the new version is running
systemctl --user restart openclaw-gateway

# 4. Verify
openclaw --version
openclaw channels status
```

If an update changes the systemd unit or config schema, run the guided repair:

```bash
openclaw doctor                 # diagnose + repair config / gateway / channels
```

To also update Node or Docker (rarely needed):

```bash
# Node — reinstall via NodeSource for the next major when required
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs
# System packages
apt-get update && apt-get upgrade -y
```

## Model & provider auth

The assistant replies using **`anthropic/claude-sonnet-4-6`** (fast and
cost-effective). The Anthropic API key is stored as auth profile
`anthropic:manual` in `~/.openclaw/agents/main/agent/openclaw-agent.sqlite`.

```bash
openclaw models status            # shows default model + auth profiles
openclaw models list --all | grep claude   # available Claude model ids
```

Change the default model (e.g. to Opus for higher quality, costs more):

```bash
openclaw models set anthropic/claude-opus-4-8
systemctl --user restart openclaw-gateway
```

Re-paste / rotate the Anthropic API key:

```bash
printf '%s' 'sk-ant-...' | openclaw models auth paste-api-key --provider anthropic
systemctl --user restart openclaw-gateway
```

> **Gotcha (fixed):** the non-interactive `openclaw onboard` run did **not**
> persist the API key and left the default model as `openai/gpt-5.5`. The symptom
> was WhatsApp showing "typing" but never replying, with
> `ProviderAuthError: No API key found for provider "openai"` in the logs. Fix is
> the two commands above (paste key + set model). Verify with:
> `openclaw agent --agent main -m "Reply with exactly: pong"`.

## WhatsApp

- The assistant runs on the linked WhatsApp account. With `selfChatMode` on, you
  test it by messaging **yourself** ("Note to Self") — Claude replies in that chat.
- Re-link if the session drops (e.g. logged out from the phone):

  ```bash
  openclaw channels login --channel whatsapp
  ```

  A QR code renders live in the terminal — open WhatsApp → Settings →
  Linked Devices → Link a device, and scan it. Make the terminal window large /
  font small so the QR is not wrapped, or it will not scan.

## Who can chat with the assistant (cost control)

`dmPolicy` controls who can DM the assistant. Each new conversation calls the
Anthropic API, so this is the main lever for controlling spend.

| Policy | Behaviour |
|---|---|
| `open` | **Current setting.** Anyone can chat; the assistant gives brief, friendly replies. |
| `pairing` | Unknown senders get a pairing code the owner approves, then they can chat. |
| `allowlist` | Only numbers in `allowFrom` can chat; everyone else is dropped (no API usage). |
| `disabled` | Ignore all DMs. |

**Current setup:** `dmPolicy: open`, `allowFrom: ["*"]` — anyone who has the number can message.
The assistant doesn't invent facts or expose the owner's private data to outsiders, and uses the
**Conversation Mediator** feature for curated chats between the owner and others.

Toggle scripts live in `/root` on the server (run after `ssh root@...`):

```bash
# Switch to allowlist (only owner can chat, no API usage from others)
./openclaw-dm-restrict.sh

# Switch back to open (anyone can chat, brief replies)
./openclaw-dm-open.sh

# Switch to pairing (unknown senders request approval)
# (manually: openclaw config set channels.whatsapp.accounts.default.dmPolicy pairing)
```

Each script applies the config and restarts the gateway. To do it by hand:

```bash
A=channels.whatsapp.accounts.default
openclaw config set $A.dmPolicy open
openclaw config set $A.allowFrom '["*"]'
systemctl --user restart openclaw-gateway
openclaw channels status        # expect: dm:open, allow:*
```

## Custom features (agent behaviour)

The assistant's persona and instructions live in `~/.openclaw/workspace/AGENTS.md`
on the server (loaded at session startup). Related state files:
- **`AGENTS.md`** — feature definitions and rules (restart gateway to reload)
- **`IDENTITY.md`** — who the owner/assistant are (phone numbers, policy)
- **`RELAYS.md`** — active conversation mediations (read-only, synced live)

### Rephrase & Send

Lets the owner send a rough draft + a recipient; the assistant rewrites it
nicely (tone tailored to the recipient, same language, meaning preserved) and
**sends it directly** to that person on WhatsApp, then reports back what it sent.

- Always active — inferred from context; keywords like `נסח ל…` / `rephrase for …`
  make it explicit. Needs BOTH a clear recipient and a draft.
- **Safety guard:** auto-sends only when the recipient resolves to exactly one
  contact. If the recipient is missing/ambiguous, it returns the polished text
  and asks instead of sending (wrong-recipient sends are not reversible).
- Defined in `AGENTS.md`.

### Conversation Mediator (relay)

The owner can ask the assistant to relay messages back-and-forth with another
person, rewriting each side to be **nice, light, short, friendly** (same language,
original meaning preserved). The assistant sits between them and:

1. When the owner starts a relay ("תתווך ביני לבין דני"), the assistant finds the
   contact and records it in `RELAYS.md` as active.
2. Each message from the partner is rewritten and forwarded to the owner (prefixed
   with who it's from).
3. Each message from the owner (to that partner) is rewritten and forwarded.
4. When the owner says "stop relay", it's marked ended in `RELAYS.md`.

- Outsiders who are NOT in an active relay get brief replies, no relay behavior.
- The owner always sees what was sent on their behalf (for transparency and
  correction if needed).
- Defined in `AGENTS.md` under `## Feature: Conversation Mediator`.

## Maintenance notes

- The droplet may report **"system restart required"** after kernel updates.
  Reboot with `reboot`; the gateway and WhatsApp reconnect automatically on boot
  (systemd lingering is enabled).
- Config and credentials are under `~/.openclaw/`. Back them up before major
  changes: `openclaw backup` creates a verified local archive.
