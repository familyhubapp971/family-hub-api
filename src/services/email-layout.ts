// FHS-703: one branded layout for every Family Hub email, built from the web
// design system's tokens (kingdom purple, yellow primary button, black
// borders, hard offset shadows, Fredoka One + Nunito). Interim: a Magic
// Patterns email design replaces it later.
//
// Email-safe on purpose: tables, inline styles only, no <style> block, no
// remote fonts or images. Clients that drop fonts or shadows still get
// readable text, a solid button and a plain link.
//
// Callers pass HTML that is already safe: escape user values with
// escapeHtml() first. Sign-in server placeholders such as {{ .ConfirmationURL }}
// pass through untouched.

export const EMAIL_TOKENS = {
  paper: '#f6f1fa',
  card: '#ffffff',
  ink: '#1f1630',
  muted: '#5b4b6e',
  border: '#000000',
  kingdom: '#3d1065',
  link: '#6b21a8',
  button: '#facc15',
  codeFill: '#fef9c3',
  heading: "'Fredoka One','Arial Rounded MT Bold',Arial,sans-serif",
  body: "Nunito,'Segoe UI',Helvetica,Arial,sans-serif",
} as const;

const t = EMAIL_TOKENS;

export type EmailBlock =
  | { kind: 'text'; html: string }
  | { kind: 'button'; label: string; url: string }
  | { kind: 'fallback'; url: string }
  | { kind: 'code'; value: string }
  | { kind: 'note'; html: string };

export interface BrandedEmail {
  /** Shown as the big heading and the page title. */
  title: string;
  /** Short preview text some inboxes show next to the subject. */
  preheader?: string;
  blocks: EmailBlock[];
}

function block(b: EmailBlock): string {
  switch (b.kind) {
    case 'text':
      return `<p style="margin:0 0 16px;">${b.html}</p>`;
    case 'note':
      return `<p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:${t.muted};">${b.html}</p>`;
    case 'button':
      return [
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">`,
        `<tr><td bgcolor="${t.button}" style="background:${t.button};border:2px solid ${t.border};border-radius:12px;box-shadow:3px 3px 0 ${t.border};">`,
        `<a href="${b.url}" style="display:inline-block;padding:14px 26px;font-family:${t.body};font-size:16px;font-weight:900;color:#000000;text-decoration:none;border-radius:12px;">${b.label}</a>`,
        `</td></tr></table>`,
      ].join('');
    case 'fallback':
      return (
        `<p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:${t.muted};">` +
        `If the button doesn't work, paste this link into your browser:<br>` +
        `<a href="${b.url}" style="color:${t.link};word-break:break-all;">${b.url}</a></p>`
      );
    case 'code':
      return (
        `<p style="margin:8px 0 24px;"><span style="display:inline-block;padding:12px 20px;` +
        `background:${t.codeFill};border:2px solid ${t.border};border-radius:12px;box-shadow:3px 3px 0 ${t.border};` +
        `font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:26px;font-weight:700;letter-spacing:6px;color:#000000;">` +
        `${b.value}</span></p>`
      );
  }
}

/** The full HTML document for one email. */
export function brandedEmail(email: BrandedEmail): string {
  const preheader = email.preheader
    ? `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${email.preheader}</div>`
    : '';
  return [
    `<!doctype html>`,
    `<html lang="en"><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">`,
    `<title>${email.title}</title></head>`,
    `<body style="margin:0;padding:0;background:${t.paper};">`,
    preheader,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${t.paper}" style="background:${t.paper};">`,
    `<tr><td align="center" style="padding:32px 16px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${t.card}" style="max-width:560px;background:${t.card};border:2px solid ${t.border};border-radius:16px;box-shadow:6px 6px 0 ${t.border};border-collapse:separate;">`,
    `<tr><td bgcolor="${t.kingdom}" style="background:${t.kingdom};border-radius:14px 14px 0 0;border-bottom:2px solid ${t.border};padding:18px 28px;">`,
    `<span style="font-family:${t.heading};font-size:22px;line-height:1.2;color:#ffffff;">Family Hub</span>`,
    `</td></tr>`,
    `<tr><td style="padding:28px 28px 12px;font-family:${t.body};font-size:16px;line-height:1.55;color:${t.ink};">`,
    `<h1 style="margin:0 0 18px;font-family:${t.heading};font-size:26px;line-height:1.2;font-weight:normal;color:${t.kingdom};">${email.title}</h1>`,
    ...email.blocks.map(block),
    `<p style="margin:0 0 16px;">The Family Hub team</p>`,
    `</td></tr></table>`,
    `<p style="margin:20px 0 0;font-family:${t.body};font-size:12px;color:${t.muted};">Family Hub</p>`,
    `</td></tr></table>`,
    `</body></html>`,
  ].join('\n');
}
