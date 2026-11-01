import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AUTH_EMAIL_TEMPLATES } from '../../../../src/services/auth-email-templates.js';
import { renderAuthTemplateFile } from '../../../../src/services/render-auth-template.js';
import { EMAIL_TOKENS, brandedEmail } from '../../../../src/services/email-layout.js';

// FHS-703: every Family Hub email comes from one branded layout.

const fileFor = (name: string) =>
  readFileSync(new URL(`../../../../email-templates/${name}.html`, import.meta.url), 'utf8');

describe('FHS-703: sign-in email templates', () => {
  it('covers all six emails the sign-in server sends', () => {
    expect(Object.keys(AUTH_EMAIL_TEMPLATES).sort()).toEqual(
      [
        'confirmation',
        'email_change',
        'invite',
        'magic_link',
        'reauthentication',
        'recovery',
      ].sort(),
    );
  });

  for (const [name, template] of Object.entries(AUTH_EMAIL_TEMPLATES)) {
    it(`${name}.html matches the layout (run pnpm email-templates:build if not)`, () => {
      expect(fileFor(name)).toBe(renderAuthTemplateFile(template));
    });
  }

  it('keeps the subject comment first, for the Supabase template script', () => {
    for (const [name, template] of Object.entries(AUTH_EMAIL_TEMPLATES)) {
      expect(fileFor(name).split('\n')[0]).toBe(`<!-- subject: ${template.subject} -->`);
    }
  });

  it('keeps the sign-in server placeholders each email needs', () => {
    const needs: Record<string, string[]> = {
      magic_link: ['{{ .ConfirmationURL }}'],
      confirmation: ['{{ .ConfirmationURL }}'],
      invite: ['{{ .ConfirmationURL }}', '{{ .SiteURL }}'],
      recovery: ['{{ .ConfirmationURL }}'],
      email_change: ['{{ .ConfirmationURL }}', '{{ .Email }}', '{{ .NewEmail }}'],
      reauthentication: ['{{ .Token }}'],
    };
    for (const [name, fields] of Object.entries(needs)) {
      for (const field of fields) expect(fileFor(name), `${name} ${field}`).toContain(field);
    }
  });
});

describe('FHS-703: branded layout', () => {
  const html = brandedEmail({
    title: 'Hello',
    blocks: [
      { kind: 'text', html: 'Hi' },
      { kind: 'button', label: 'Go', url: 'https://x.example/go' },
    ],
  });

  it('uses the design system colours: purple header, yellow button', () => {
    expect(html).toContain(EMAIL_TOKENS.kingdom);
    expect(html).toContain(EMAIL_TOKENS.button);
  });

  it('works without fonts or shadows: solid button colour and a plain link', () => {
    expect(html).toContain(`bgcolor="${EMAIL_TOKENS.button}"`);
    expect(html).toContain('href="https://x.example/go"');
  });

  it('loads nothing remote: no stylesheet, font or image links', () => {
    expect(html).not.toMatch(/<link|<img|@import|<style/i);
  });
});
