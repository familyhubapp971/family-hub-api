// k6 summary handler. Writes JSON summary into REPORTS_DIR (passed by
// the run-k6.sh wrapper as an absolute path so reports land reliably
// regardless of the caller's CWD). Falls back to a relative path if
// invoked directly.
//
// NOTE: textSummary is fetched from k6's jslib at run time. CI without
// egress to jslib.k6.io will fail this scenario — vendor this in a
// follow-up (FHS-183) if that becomes a constraint.

import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

export function handleSummary(data) {
  const reportsDir = __ENV.REPORTS_DIR || 'tests/performance/reports';
  // Namespace by scenario name so back-to-back runs (e.g. load → stress
  // in the FHS-185 pre-release job) don't clobber each other.
  // SCENARIO is set by run-k6.sh from the input filename.
  const scenario = __ENV.SCENARIO || 'unknown';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`${reportsDir}/summary-${scenario}.json`]: JSON.stringify(data, null, 2),
    [`${reportsDir}/summary-${scenario}-${ts}.json`]: JSON.stringify(data, null, 2),
  };
}
