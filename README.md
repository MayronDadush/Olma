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

## WhatsApp

- The assistant runs on the linked WhatsApp account. With `selfChatMode` on, you
  test it by messaging **yourself** ("Note to Self") — Claude replies in that chat.
- `dmPolicy` is `pairing`: unknown senders get a pairing code that the owner
  approves before they can chat with the assistant.
- Re-link if the session drops (e.g. logged out from the phone):

  ```bash
  openclaw channels login --channel whatsapp
  ```

  A QR code renders live in the terminal — open WhatsApp → Settings →
  Linked Devices → Link a device, and scan it. Make the terminal window large /
  font small so the QR is not wrapped, or it will not scan.

## Maintenance notes

- The droplet may report **"system restart required"** after kernel updates.
  Reboot with `reboot`; the gateway and WhatsApp reconnect automatically on boot
  (systemd lingering is enabled).
- Config and credentials are under `~/.openclaw/`. Back them up before major
  changes: `openclaw backup` creates a verified local archive.
