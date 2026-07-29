#!/usr/bin/env bash
#
# Deploy the BandCue coordinator to the Raspberry Pi.
#
# The Pi (a Raspberry Pi 3B+ on an OctoPi/Raspbian Buster image) can only run
# Node 18, and building there would pull Playwright's browser download onto a
# 1 GB box. So the model is build-on-your-machine, ship-the-artifacts: this
# script compiles locally and copies only the runtime output plus the web
# assets, then installs runtime-only dependencies on the Pi.
#
# Usage, from the repo root, in Git Bash:
#     bash scripts/deploy-pi.sh
#
# To update the Pi after pulling new changes:
#     git pull
#     bash scripts/deploy-pi.sh
#
# Overridable via environment:
#     PI       SSH host/alias of the Pi        (default: bandcue-pi-mdns)
#     APP_DIR  install dir in the Pi's home    (default: bandcue)
#     NODE_BIN Node bin dir on the Pi          (default: ~/.local/node/bin)
#
# The room token and code live in ~/APP_DIR/.bandcue-room.json on the Pi. That
# file is NOT shipped by this script, so redeploys keep the same host URL and QR
# code. Delete it on the Pi to rotate the token.
set -euo pipefail

PI="${PI:-bandcue-pi-mdns}"
APP_DIR="${APP_DIR:-bandcue}"
NODE_BIN="${NODE_BIN:-\$HOME/.local/node/bin}"

# Run from the repo root regardless of where the script was invoked from.
cd "$(dirname "$0")/.."

echo "==> Building locally"
npm run build
test -f dist/server/index.js || { echo "build produced no dist/server/index.js" >&2; exit 1; }

echo "==> Shipping build output, web assets, and manifests to $PI"
# Only runtime code and assets. dist/release and dist/packages are
# release-packaging leftovers; .bandcue-room.json is deliberately excluded so
# the token/room code survive the deploy.
tar -czf - dist/server dist/shared web package.json package-lock.json \
  | ssh "$PI" "mkdir -p ~/$APP_DIR && tar -xzf - -C ~/$APP_DIR"

echo "==> Installing runtime dependencies only"
ssh "$PI" "cd ~/$APP_DIR && PATH=$NODE_BIN:\$PATH npm ci --omit=dev --no-audit --no-fund"

echo "==> Restarting the service"
# Restarting a system unit needs root, and plain 'sudo systemctl' asks this Pi
# for a password. Its sudoers does carry a NOPASSWD rule for /usr/sbin/service,
# which systemd's compat wrapper turns back into a systemctl restart -- so the
# deploy stays non-interactive. If the rule is ever dropped, fall back to
# 'ssh -t "$PI" "sudo systemctl restart bandcue"' and type the password.
ssh "$PI" "sudo -n service bandcue restart"

echo "==> Waiting for the coordinator to answer (checked on the Pi itself)"
for i in $(seq 1 30); do
  if ssh "$PI" "curl -fsS --max-time 3 http://127.0.0.1:4173/api/room" >/dev/null 2>&1; then
    echo "Up. Room state:"
    ssh "$PI" "curl -fsS http://127.0.0.1:4173/api/room"; echo
    exit 0
  fi
  sleep 1
done

echo "Coordinator did not answer within 30s" >&2
ssh "$PI" "sudo -n journalctl -u bandcue -n 40 --no-pager 2>/dev/null || journalctl -u bandcue -n 40 --no-pager"
exit 1
