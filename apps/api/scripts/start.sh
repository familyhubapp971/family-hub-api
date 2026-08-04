#!/usr/bin/env sh
set -e

# FHS-bootstrap + FHS-351: Railway boot wrapper for the api service.
#
# Why this script exists:
#   The Railway api container starts before its private-network link
#   to the postgres service is fully ready, so the first
#   `drizzle-kit push` attempt can hit ETIMEDOUT and silently leave
#   the schema stale. We retry the push a few times with a short
#   back-off so the schema actually lands before the api accepts
#   traffic. If every attempt fails the deploy is marked failed
#   (loudly) instead of silently booting against the wrong schema.
#
# FHS-351: schema (drizzle-kit push) and RLS (apply-rls) are DDL/GRANT, so they
# must run as the OWNER/migrate role, NOT the app_runtime role the app serves
# traffic as (app_runtime deliberately cannot run DDL). MIGRATE_DATABASE_URL
# holds the owner connection; it falls back to DATABASE_URL pre-flip (when the
# app still connects as the owner). The app itself always execs with the ambient
# DATABASE_URL: which becomes app_runtime after the flip.

MIGRATE_URL="${MIGRATE_DATABASE_URL:-$DATABASE_URL}"
MAX_ATTEMPTS=6
SLEEP_BETWEEN=5

i=1
while [ "$i" -le "$MAX_ATTEMPTS" ]; do
  echo "[boot] migrate attempt $i/$MAX_ATTEMPTS: running drizzle-kit push --force (migrate role)"
  if DATABASE_URL="$MIGRATE_URL" node node_modules/drizzle-kit/bin.cjs push --force; then
    echo "[boot] migrate succeeded on attempt $i"
    break
  fi
  if [ "$i" -eq "$MAX_ATTEMPTS" ]; then
    echo "[boot] migrate failed $MAX_ATTEMPTS times: refusing to start the api"
    exit 1
  fi
  echo "[boot] migrate attempt $i failed; sleeping ${SLEEP_BETWEEN}s before retry"
  sleep "$SLEEP_BETWEEN"
  i=$((i + 1))
done

# FHS-357: create the SECURITY DEFINER reader functions (0030) on every boot,
# UNGATED. `drizzle-kit push` never creates functions, but the app calls them
# (GET /api/me, invite-claim) regardless of the RLS flip: so a missing function
# 500s /api/me and strands a user with a family on the onboarding screen. The
# statements are idempotent and harmless pre-flip, so they always run.
echo "[boot] applying reader functions (migrate role)"
DATABASE_URL="$MIGRATE_URL" node scripts/apply-functions.mjs

# FHS-351: re-assert the RLS role, policies, and grants as the migrate role.
# `push --force` never touches RLS and can drop a table's grants when it
# recreates it, so we re-apply (idempotently) on every deploy. Gated by
# APPLY_RLS so pre-flip deploys are byte-for-byte unchanged; the founder sets
# APPLY_RLS=true in the same deploy that points DATABASE_URL at app_runtime.
if [ "${APPLY_RLS:-false}" = "true" ]; then
  echo "[boot] APPLY_RLS=true: applying RLS role, policies, and grants (migrate role)"
  DATABASE_URL="$MIGRATE_URL" node scripts/apply-rls.mjs
fi

# Local dev convenience: pick up .env.local at the repo root if present
# so a developer can `pnpm -F api start` without exporting env vars.
if [ -f ../../.env.local ]; then
  exec node --env-file=../../.env.local dist/index.js
else
  exec node dist/index.js
fi
