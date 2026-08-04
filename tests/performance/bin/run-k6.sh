#!/usr/bin/env bash
# Wrapper around the k6 binary that gives a clear install hint when the
# binary isn't on PATH and resolves report paths relative to THIS
# script (not the caller's CWD), so it works whether invoked from repo
# root, apps/, or anywhere else.
#
# Install:
#   macOS:    brew install k6
#   Linux:    https://k6.io/docs/get-started/installation/
#   Docker:   docker run --rm -i grafana/k6 run - < <scenario>

set -euo pipefail

# Arg-count check FIRST: before unbound-var risk under set -u.
if [ "$#" -lt 1 ]; then
  echo "usage: $0 <scenario.js> [extra k6 args...]" >&2
  exit 64
fi

if ! command -v k6 >/dev/null 2>&1; then
  echo "✗ k6 binary not found on PATH." >&2
  echo "  macOS:  brew install k6" >&2
  echo "  Linux:  see https://k6.io/docs/get-started/installation/" >&2
  echo "  Docker: docker run --rm -i grafana/k6 run - < $1" >&2
  exit 127
fi

scenario="$1"
shift

# Resolve report path relative to this script, not CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORTS_DIR="$SCRIPT_DIR/../reports"
mkdir -p "$REPORTS_DIR"

# Pass absolute reports dir + scenario name into k6 so report.js can
# namespace its output (back-to-back runs don't clobber each other).
SCENARIO_NAME="$(basename "$scenario" .js)"

# k6's built-in web dashboard: export a self-contained HTML report per run
# (open it with `pnpm report`). Defaults on; override with K6_WEB_DASHBOARD=false
# to skip, or set K6_WEB_DASHBOARD_EXPORT to change the path. A live dashboard
# also serves on 127.0.0.1:5665 while the run is in progress.
: "${K6_WEB_DASHBOARD:=true}"
: "${K6_WEB_DASHBOARD_EXPORT:=$REPORTS_DIR/report-$SCENARIO_NAME.html}"
# 5s aggregation buckets so even the 30s smoke has enough periods to render a
# report (k6 skips report generation with too few data points at the 10s default).
: "${K6_WEB_DASHBOARD_PERIOD:=5s}"
export K6_WEB_DASHBOARD K6_WEB_DASHBOARD_EXPORT K6_WEB_DASHBOARD_PERIOD

exec k6 run -e REPORTS_DIR="$REPORTS_DIR" -e SCENARIO="$SCENARIO_NAME" "$scenario" "$@"
