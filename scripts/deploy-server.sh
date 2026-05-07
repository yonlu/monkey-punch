#!/usr/bin/env bash
# Build and deploy the Colyseus server to the lab DO box.
#
# Defaults match the current setup (yufapatcher, /opt/monkey-punch).
# Override via env if needed:
#   DEPLOY_HOST  — SSH alias from ~/.ssh/config (or user@host).
#   DEPLOY_PATH  — absolute path on the remote.
#   PM2_NAME     — pm2 app name (matches `name` in ecosystem.config.cjs).
#
# Run from the repo root:  pnpm deploy:server

set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-yufapatcher}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/monkey-punch}"
PM2_NAME="${PM2_NAME:-monkey-punch}"

remote_ip="$(ssh -G "$DEPLOY_HOST" | awk '/^hostname / {print $2}')"

# Multiplex every ssh/rsync over a single TCP connection. The lab box runs
# ufw with `22/tcp LIMIT` (6 conns / 30s); 7+ separate SSH sessions trip it.
# ControlMaster collapses all logical sessions onto one socket → one count.
SSH_CM_PATH="${TMPDIR:-/tmp}/mp-deploy-cm-$$"
SSH_OPTS="-o ControlMaster=auto -o ControlPath=$SSH_CM_PATH -o ControlPersist=120"
trap 'ssh $SSH_OPTS -O exit "$DEPLOY_HOST" 2>/dev/null || true' EXIT

# Bootstrap the master connection (count: 1 against ufw's limit).
ssh $SSH_OPTS "$DEPLOY_HOST" true

echo ">> building shared + server (locally, with dev tsc)"
pnpm --filter @mp/shared --filter @mp/server build

echo ">> rsync -> ${DEPLOY_HOST}:${DEPLOY_PATH}"
# Workspace-shape skeleton on the remote; pnpm install needs all four
# package.jsons + lockfile + pnpm-workspace.yaml to resolve @mp/shared.
ssh $SSH_OPTS "$DEPLOY_HOST" "mkdir -p '$DEPLOY_PATH/packages/shared' '$DEPLOY_PATH/packages/server' '$DEPLOY_PATH/packages/client'"

# Root manifests + ecosystem config
rsync -a --no-perms --omit-dir-times -e "ssh $SSH_OPTS" \
  package.json pnpm-lock.yaml pnpm-workspace.yaml ecosystem.config.cjs \
  "${DEPLOY_HOST}:${DEPLOY_PATH}/"

# shared: manifest + built dist (--delete cleans stale .js after rename/remove)
rsync -a --no-perms --omit-dir-times --delete -e "ssh $SSH_OPTS" \
  packages/shared/package.json packages/shared/dist \
  "${DEPLOY_HOST}:${DEPLOY_PATH}/packages/shared/"

# server: manifest + built dist
rsync -a --no-perms --omit-dir-times --delete -e "ssh $SSH_OPTS" \
  packages/server/package.json packages/server/dist \
  "${DEPLOY_HOST}:${DEPLOY_PATH}/packages/server/"

# client manifest only — pnpm needs it present to satisfy the workspace.
rsync -a --no-perms --omit-dir-times -e "ssh $SSH_OPTS" \
  packages/client/package.json \
  "${DEPLOY_HOST}:${DEPLOY_PATH}/packages/client/"

echo ">> pnpm install --prod (no-op if lockfile unchanged)"
ssh $SSH_OPTS "$DEPLOY_HOST" "cd '$DEPLOY_PATH' && pnpm install --prod --frozen-lockfile --config.confirmModulesPurge=false 2>&1 | tail -3"

echo ">> pm2 restart $PM2_NAME"
ssh $SSH_OPTS "$DEPLOY_HOST" "pm2 restart '$PM2_NAME' --update-env 2>&1 | tail -3"

echo ">> verifying matchmaker"
http_code="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' \
  -X POST "http://${remote_ip}:2567/matchmake/joinOrCreate/game" \
  -H 'Content-Type: application/json' -d '{}')"
if [[ "$http_code" != "200" ]]; then
  echo "!! deploy verification failed: matchmake returned HTTP $http_code" >&2
  echo "   check 'ssh ${DEPLOY_HOST} pm2 logs ${PM2_NAME} --lines 50 --nostream'" >&2
  exit 1
fi

echo
echo "OK — server reloaded at ws://${remote_ip}:2567"
