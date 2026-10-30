import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// macOS ships Python 3.9, where an `A | B` type hint such as `dict | None`
// crashes the script on load (FHS-682). CI runs a newer Python, so running
// the scripts there would not catch it; instead every script using that hint
// must defer hints with `from __future__ import annotations`.
const root = fileURLToPath(new URL('../../../../', import.meta.url));

function pythonScripts(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? pythonScripts(join(dir, e.name))
      : e.name.endsWith('.py')
        ? [join(dir, e.name)]
        : [],
  );
}

describe('helper scripts run on the Mac default Python 3.9', () => {
  const scripts = pythonScripts(join(root, 'scripts'));

  it('finds the helper scripts', () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  it.each(scripts.map((f) => [relative(root, f), f]))(
    '%s defers type hints when it uses the A | B style',
    (_name, file) => {
      const src = readFileSync(file, 'utf8');
      // Any `A | B` type hint after a colon or arrow, None on either side.
      const usesUnionHint = /(:|->)\s*[\w[\], ]+\|\s*\w/.test(src);
      if (usesUnionHint) {
        expect(src).toMatch(/^from __future__ import annotations$/m);
      }
    },
  );
});
