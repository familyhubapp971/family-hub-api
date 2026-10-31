// FHS-703: writes email-templates/<name>.html from the shared branded layout.
// GoTrue reads those files by URL, so commit the result after any change.
// Run: pnpm email-templates:build

import { writeFileSync } from 'node:fs';
import { AUTH_EMAIL_TEMPLATES } from '../../src/services/auth-email-templates.js';
import { renderAuthTemplateFile } from '../../src/services/render-auth-template.js';

for (const [name, template] of Object.entries(AUTH_EMAIL_TEMPLATES)) {
  const out = new URL(`../../email-templates/${name}.html`, import.meta.url);
  writeFileSync(out, renderAuthTemplateFile(template));
  console.warn(`wrote email-templates/${name}.html`);
}
