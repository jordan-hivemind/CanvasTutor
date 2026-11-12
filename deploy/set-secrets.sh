#!/usr/bin/env bash
# Run on the server as root: sets the login password and the Claude subscription token.
# Input is hidden and written only to /opt/canvas-tutor/.env (readable by the tutor user only).
set -euo pipefail
ENV=/opt/canvas-tutor/.env
touch "$ENV"

read -rsp "New Canvas Tutor password (leave blank to keep current): " PW; echo
read -rsp "Claude token from 'claude setup-token' (leave blank to keep current): " TOKEN; echo
TOKEN="${TOKEN//[[:space:]]/}" # tokens often get split across lines when copied from a terminal
if [ -n "$TOKEN" ] && [[ "$TOKEN" != sk-ant-* ]]; then echo "That doesn't look like a Claude token (should start with sk-ant-)." >&2; exit 1; fi

update() { # key value
  grep -v "^$1=" "$ENV" > "$ENV.tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$ENV.tmp"
  mv "$ENV.tmp" "$ENV"
}
[ -n "$PW" ] && update TUTOR_PASSWORD "$PW"
[ -n "$TOKEN" ] && update CLAUDE_CODE_OAUTH_TOKEN "$TOKEN"

chown tutor:tutor "$ENV"
chmod 600 "$ENV"
systemctl restart canvas-tutor
echo "Saved. Canvas Tutor restarted."
