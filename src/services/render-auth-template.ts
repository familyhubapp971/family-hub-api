import type { AuthEmailTemplate } from './auth-email-templates.js';
import { brandedEmail } from './email-layout.js';

/**
 * FHS-703: the exact text of email-templates/<name>.html. The first line keeps
 * the `<!-- subject: ... -->` comment that the Supabase template script reads.
 */
export function renderAuthTemplateFile(template: AuthEmailTemplate): string {
  return `<!-- subject: ${template.subject} -->\n${brandedEmail(template.email)}\n`;
}
