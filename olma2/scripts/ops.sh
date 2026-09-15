#!/usr/bin/env bash
# olma2 ops — a CLOSED menu of things to do on the box over SSH.
#
# Why this exists: the Claude Code session that opens PRs here runs in a
# sandbox with no ssh binary, no key and no route to the box, so every
# "restart the gateway and paste the output" round trip went through a person
# at a laptop (2026-09-15, three times in one evening). The `olma2 ops`
# workflow (.github/workflows/olma2-ops.yml) runs this script on a GitHub
# runner with the same deploy key deploy.sh uses; the session triggers it and
# reads the job log. Every run is audited on GitHub and the key never leaves
# the runner.
#
# The menu is closed on purpose. `op` is matched literally below, there is no
# free-text command input anywhere, and nothing here prints a person's
# message, name or number — release marker, pids, unit states, http codes.
#
#   bash olma2/scripts/ops.sh status            # read-only
#   bash olma2/scripts/ops.sh restart-gateway   # restart, wait for the plugin to register, then status
#
# SSH_KEY overrides the key path (defaults to ~/.ssh/id_ed25519), same as
# deploy.sh. Written without an exclamation mark anywhere, same reason as
# scripts/measure-reply-gate.js.
set -euo pipefail

SERVER="root@157.230.210.233"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH="ssh -i $SSH_KEY -o ServerAliveInterval=15 -o ServerAliveCountMax=6 -o ConnectTimeout=20"

op="${1:-}"

# What the box looks like right now. The plugin stamp is the one that says
# whether the RUNNING gateway carries the reply gate: its pid must equal the
# unit's MainPID (incidents.md, "The test suite stamped the gateway as live").
remote_status='
set -u
echo "== release (/opt/olma2/RELEASE) =="
cat /opt/olma2/RELEASE
echo
echo "== system units =="
for u in olma2-brokerd olma2-dashboard; do echo "$u: $(systemctl is-active "$u" || true)"; done
echo
echo "== gateway (user unit) =="
XDG_RUNTIME_DIR=/run/user/0 systemctl --user show openclaw-gateway -p ActiveState -p MainPID -p ActiveEnterTimestamp
echo
echo "== plugin registration stamp =="
tail -1 /opt/olma2/run/turn-context-plugin.registered 2>/dev/null || echo "(no stamp)"
pid=$(XDG_RUNTIME_DIR=/run/user/0 systemctl --user show openclaw-gateway -p MainPID --value)
if tail -1 /opt/olma2/run/turn-context-plugin.registered 2>/dev/null | grep -q "\"pid\":$pid,"; then
  echo "stamp pid matches MainPID $pid: the running gateway is the one that registered"
else
  echo "stamp pid does NOT match MainPID $pid: the gateway has not re-registered since this stamp"
fi
echo
echo "== dashboard =="
for r in ready health; do printf "%s: " "$r"; curl -s -o /dev/null -w "%{http_code}\n" -m 10 "http://127.0.0.1:8788/$r" || echo "unreachable"; done
'

# Restart the gateway and wait until the plugin has registered under the new
# pid — about a minute on this box (64 s measured on 2026-09-15). A tail taken
# in the same second as the restart still shows the previous record, which is
# exactly the mistake this waits out. Red if it never registers.
remote_restart='
set -u
before=$(XDG_RUNTIME_DIR=/run/user/0 systemctl --user show openclaw-gateway -p MainPID --value)
echo "gateway MainPID before: $before"
XDG_RUNTIME_DIR=/run/user/0 systemctl --user restart openclaw-gateway
sleep 3
pid=$(XDG_RUNTIME_DIR=/run/user/0 systemctl --user show openclaw-gateway -p MainPID --value)
echo "gateway MainPID after:  $pid"
if [ "$pid" = "$before" ] || [ "$pid" = "0" ]; then echo "restart did not produce a new MainPID"; exit 1; fi
registered=0
for i in $(seq 1 36); do
  if tail -1 /opt/olma2/run/turn-context-plugin.registered 2>/dev/null | grep -q "\"pid\":$pid,"; then
    echo "plugin registered under pid $pid after about $((i * 5))s"
    registered=1
    break
  fi
  sleep 5
done
if [ "$registered" = "0" ]; then echo "plugin did NOT register under pid $pid within 180s"; exit 1; fi
'

case "$op" in
  status)
    $SSH "$SERVER" bash -c "$remote_status"
    ;;
  restart-gateway)
    $SSH "$SERVER" bash -c "$remote_restart"
    echo
    $SSH "$SERVER" bash -c "$remote_status"
    ;;
  *)
    echo "usage: $0 status | restart-gateway" >&2
    exit 2
    ;;
esac
