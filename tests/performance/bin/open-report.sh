#!/usr/bin/env bash
# Opens the most recent k6 HTML report dashboard in the default browser.
# run-k6.sh exports one HTML report per run to ../reports/report-<scenario>.html
# (via k6's built-in web dashboard). This picks the newest and opens it.
#
#   pnpm report            # open the latest report of any scenario
#   pnpm report smoke      # open the latest 'smoke' report specifically

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORTS_DIR="$SCRIPT_DIR/../reports"

pattern="report-*.html"
if [ "$#" -ge 1 ]; then
  pattern="report-$1.html"
fi

# shellcheck disable=SC2012 — ls -t is fine here (report names have no newlines).
latest="$(ls -t "$REPORTS_DIR"/$pattern 2>/dev/null | head -1 || true)"

if [ -z "${latest:-}" ]; then
  echo "No HTML report found in $REPORTS_DIR." >&2
  echo "Run a scenario first, e.g.:  pnpm smoke" >&2
  exit 1
fi

echo "Opening $latest"
case "$(uname)" in
  Darwin) open "$latest" ;;
  Linux) xdg-open "$latest" >/dev/null 2>&1 || echo "Open it manually: $latest" ;;
  *) echo "Open it manually: $latest" ;;
esac
