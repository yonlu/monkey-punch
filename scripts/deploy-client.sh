#!/usr/bin/env bash
# Build and deploy the client static bundle to the lab DO box.
#
# Defaults match the current setup (Colyseus Cloud server + yufapatcher box).
# Override any of these via env if you need a different target:
#   VITE_SERVER_URL  — the wss:// URL the bundle dials. Baked in at build time.
#   DEPLOY_HOST      — SSH alias from ~/.ssh/config (or user@host).
#   DEPLOY_PATH      — absolute path on the remote to rsync into.
#   DEPLOY_BASE      — Vite --base value. Must match the URL subpath.
#
# Run from the repo root:  pnpm deploy:client

set -euo pipefail

VITE_SERVER_URL="${VITE_SERVER_URL:-ws://209.38.79.184:2567}"
DEPLOY_HOST="${DEPLOY_HOST:-yufapatcher}"
DEPLOY_PATH="${DEPLOY_PATH:-/var/www/html/monkey-punch}"
DEPLOY_BASE="${DEPLOY_BASE:-/monkey-punch/}"

# Resolve the public URL for the final log line. Strips trailing slash on the
# remote path and assumes plain HTTP on the SSH host's IP.
remote_ip="$(ssh -G "$DEPLOY_HOST" | awk '/^hostname / {print $2}')"
public_url="http://${remote_ip}${DEPLOY_BASE}"

echo ">> building client (server=$VITE_SERVER_URL, base=$DEPLOY_BASE)"
VITE_SERVER_URL="$VITE_SERVER_URL" \
  pnpm --filter @mp/client exec vite build --base="$DEPLOY_BASE"

echo ">> rsync -> ${DEPLOY_HOST}:${DEPLOY_PATH}"
ssh "$DEPLOY_HOST" "mkdir -p '$DEPLOY_PATH'"
rsync -av --delete packages/client/dist/ "${DEPLOY_HOST}:${DEPLOY_PATH}/"

echo ">> fixing ownership (www-data)"
ssh "$DEPLOY_HOST" "chown -R www-data:www-data '$DEPLOY_PATH'"

echo ">> verifying"
http_code="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$public_url")"
if [[ "$http_code" != "200" ]]; then
  echo "!! deploy verification failed: HTTP $http_code at $public_url" >&2
  exit 1
fi

echo
echo "OK — live at $public_url"
echo "   (hard-refresh: Cmd-Shift-R, since browsers may cache index.html)"
