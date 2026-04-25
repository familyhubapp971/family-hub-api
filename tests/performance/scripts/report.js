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
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`${reportsDir}/summary.json`]: JSON.stringify(data, null, 2),
  };
}
