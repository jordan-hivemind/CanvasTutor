#!/usr/bin/env bash
# Build locally and deploy to the server. Usage: deploy/deploy.sh [user@host]
# Without an argument it uses DEPLOY_HOST from .env (e.g. DEPLOY_HOST=root@203.0.113.5).
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${1:-}"
if [ -z "$HOST" ] && [ -f .env ]; then
  HOST="$(grep -E '^DEPLOY_HOST=' .env | tail -1 | cut -d= -f2- | tr -d '\r" ' || true)"
fi
[ -n "$HOST" ] || { echo "Usage: deploy/deploy.sh user@host (or set DEPLOY_HOST in .env)" >&2; exit 1; }

npm run build
TGZ="$(mktemp -d)/ct.tgz"
tar -czf "$TGZ" package.json package-lock.json server-dist dist deploy
scp -q "$TGZ" "$HOST:/tmp/ct.tgz"
ssh "$HOST" 'set -e
cd /opt/canvas-tutor
rm -rf dist server server-dist deploy
tar -xzf /tmp/ct.tgz && rm /tmp/ct.tgz
chown -R tutor:tutor /opt/canvas-tutor
sudo -u tutor -H npm ci --omit=dev --no-audit --no-fund
install -m 644 deploy/canvas-tutor.service /etc/systemd/system/canvas-tutor.service
systemctl daemon-reload
systemctl reset-failed canvas-tutor 2>/dev/null || true
systemctl enable --now canvas-tutor
systemctl restart canvas-tutor
sleep 2 && systemctl is-active canvas-tutor'
echo "Deployed to $HOST"
