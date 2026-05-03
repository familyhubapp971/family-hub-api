#!/usr/bin/env sh
set -e

# FHS-bootstrap — Railway boot wrapper for the api service.
#
# Why this script exists:
#   The Railway api container starts before its private-network link
#   to the postgres service is fully ready, so the first
#   `drizzle-kit push` attempt can hit ETIMEDOUT and silently leave
#   the schema stale. We retry the push a few times with a short
#   back-off so the schema actually lands before the api accepts
#   traffic. If every attempt fails the deploy is marked failed
#   (loudly) instead of silently booting against the wrong schema.

PUSH_CMD="node node_modules/drizzle-kit/bin.cjs push --force"
MAX_ATTEMPTS=6
SLEEP_BETWEEN=5

i=1
while [ "$i" -le "$MAX_ATTEMPTS" ]; do
  echo "[boot] migrate attempt $i/$MAX_ATTEMPTS — running drizzle-kit push --force"
  if $PUSH_CMD; then
    echo "[boot] migrate succeeded on attempt $i"
    break
  fi
  if [ "$i" -eq "$MAX_ATTEMPTS" ]; then
    echo "[boot] migrate failed $MAX_ATTEMPTS times — refusing to start the api"
    exit 1
  fi
  echo "[boot] migrate attempt $i failed; sleeping ${SLEEP_BETWEEN}s before retry"
  sleep "$SLEEP_BETWEEN"
  i=$((i + 1))
done

# Local dev convenience: pick up .env.local at the repo root if present
# so a developer can `pnpm -F api start` without exporting env vars.
if [ -f ../../.env.local ]; then
  exec node --env-file=../../.env.local dist/index.js
else
  exec node dist/index.js
fi
