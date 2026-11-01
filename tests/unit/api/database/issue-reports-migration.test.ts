// FHS-717: staging and production never run 0049 itself. They get the family
// lock and the founder functions from two boot-applied copies, so those copies
// must say exactly what 0049 says (0049 is what the integration tests prove).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('../../../../src/database/migrations/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), 'utf8');

// Drops comment lines and the statement-breakpoint markers, then squashes
// spacing, so only the SQL itself is compared.
function sqlOnly(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('0049_issue_reports boot copies', () => {
  const migration = sqlOnly(read('0049_issue_reports.sql'));

  it.each(['apply-issue-reports-rls.sql', 'apply-issue-reports-functions.sql'])(
    '%s matches the migration',
    (file) => {
      expect(migration).toContain(sqlOnly(read(file)));
    },
  );

  it('is in the journal the test database is built from', () => {
    const journal = JSON.parse(read('meta/_journal.json')) as { entries: Array<{ tag: string }> };
    expect(journal.entries.map((e) => e.tag)).toContain('0049_issue_reports');
  });

  it('is applied on every boot', () => {
    const scripts = new URL('../../../../scripts/server/', import.meta.url);
    expect(readFileSync(new URL('apply-rls.mjs', scripts), 'utf8')).toContain(
      "'apply-issue-reports-rls.sql'",
    );
    expect(readFileSync(new URL('apply-functions.mjs', scripts), 'utf8')).toContain(
      "'apply-issue-reports-functions.sql'",
    );
  });
});
