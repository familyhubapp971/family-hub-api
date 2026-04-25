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

# Arg-count check FIRST — before unbound-var risk under set -u.
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

# Resolve report path relative to this script — not CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORTS_DIR="$SCRIPT_DIR/../reports"
mkdir -p "$REPORTS_DIR"

# Pass absolute reports dir into k6 so report.js writes there reliably.
exec k6 run -e REPORTS_DIR="$REPORTS_DIR" "$scenario" "$@"
