import type { BrandedEmail } from './email-layout.js';

// FHS-703: the six emails the sign-in server (GoTrue) sends, as content for
// the shared branded layout. `pnpm email-templates:build` writes them to
// email-templates/<name>.html, which GoTrue reads by URL. The {{ .Field }}
// placeholders are filled in by GoTrue, not by us. Wording is unchanged from
// the plain versions (fixes tracked in FHS-702).

export interface AuthEmailTemplate {
  subject: string;
  email: BrandedEmail;
}

const LINK = '{{ .ConfirmationURL }}';

export const AUTH_EMAIL_TEMPLATES: Record<string, AuthEmailTemplate> = {
  magic_link: {
    subject: 'Your Family Hub sign-in link',
    email: {
      title: 'Sign in to Family Hub',
      blocks: [
        { kind: 'text', html: 'Hi there,' },
        { kind: 'text', html: 'Tap the link below to sign in. No password needed:' },
        { kind: 'button', label: 'Sign in to Family Hub', url: LINK },
        { kind: 'fallback', url: LINK },
        {
          kind: 'note',
          html: "This link works once and expires in 1 hour. If you didn't try to sign in, you can ignore this message; nobody can sign in without it.",
        },
      ],
    },
  },
  confirmation: {
    subject: 'Confirm your Family Hub email',
    email: {
      title: 'Welcome to Family Hub',
      blocks: [
        { kind: 'text', html: 'Hi there,' },
        {
          kind: 'text',
          html: "You're one click away from setting up your family's space. Confirm your email so we know it's really you:",
        },
        { kind: 'button', label: 'Confirm my email', url: LINK },
        { kind: 'fallback', url: LINK },
        {
          kind: 'note',
          html: "This link expires in 24 hours. If you didn't sign up for Family Hub, you can safely ignore this message; your address won't be added.",
        },
      ],
    },
  },
  invite: {
    subject: "You're invited to join a family on Family Hub",
    email: {
      title: "You're invited to Family Hub",
      blocks: [
        { kind: 'text', html: 'Hi there,' },
        {
          kind: 'text',
          html: 'Someone you know has invited you to share a family space on Family Hub, the place where calendars, tasks, and the small stuff of family life all live together.',
        },
        { kind: 'text', html: 'Accept your invite to get started:' },
        { kind: 'button', label: 'Accept invite', url: LINK },
        { kind: 'fallback', url: LINK },
        {
          kind: 'note',
          html: `You'll be taken to <a href="{{ .SiteURL }}" style="color:#6b21a8;">{{ .SiteURL }}</a> to set up your account. The invite expires in 7 days.`,
        },
        {
          kind: 'note',
          html: "If this came as a surprise, no harm done. Just ignore this message and you won't be added to anything.",
        },
      ],
    },
  },
  recovery: {
    subject: 'Reset your Family Hub password',
    email: {
      title: 'Reset your password',
      blocks: [
        { kind: 'text', html: 'Hi there,' },
        {
          kind: 'text',
          html: 'We got a request to reset the password on your Family Hub account. Click the link below to choose a new one:',
        },
        { kind: 'button', label: 'Reset my password', url: LINK },
        { kind: 'fallback', url: LINK },
        {
          kind: 'note',
          html: "This link expires in 1 hour and can only be used once. If you didn't request a reset, you can safely ignore this message; your password stays the same.",
        },
      ],
    },
  },
  email_change: {
    subject: 'Confirm your new Family Hub email',
    email: {
      title: 'Confirm your new email',
      blocks: [
        { kind: 'text', html: 'Hi there,' },
        {
          kind: 'text',
          html: 'You asked to change the email on your Family Hub account from <strong>{{ .Email }}</strong> to <strong>{{ .NewEmail }}</strong>. Confirm the change so we can update your account:',
        },
        { kind: 'button', label: 'Confirm new email', url: LINK },
        { kind: 'fallback', url: LINK },
        {
          kind: 'note',
          html: "If you didn't request this change, ignore this message and your email will stay the same. You may also want to reset your password as a precaution.",
        },
      ],
    },
  },
  reauthentication: {
    subject: 'Your Family Hub verification code',
    email: {
      title: "Verify it's you",
      blocks: [
        { kind: 'text', html: 'Hi there,' },
        {
          kind: 'text',
          html: 'Use this code to confirm a sensitive change on your Family Hub account:',
        },
        { kind: 'code', value: '{{ .Token }}' },
        { kind: 'note', html: 'This code expires in 1 hour and can only be used once.' },
        {
          kind: 'note',
          html: "If you didn't request this, ignore the message and consider resetting your password.",
        },
      ],
    },
  },
};
