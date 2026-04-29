# Supabase email templates

Branded HTML for the Supabase-managed auth emails (FHS-188). One file per
mailer type. The Supabase **subject** lives at the top of each file as an
HTML comment of the form `<!-- subject: ... -->`; the rest of the file is
the email body.

## Files

| File                    | Mailer type                                 | Variables                                                   |
| ----------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| `confirmation.html`     | `mailer_templates_confirmation_content`     | `{{ .ConfirmationURL }}`, `{{ .Email }}`                    |
| `magic_link.html`       | `mailer_templates_magic_link_content`       | `{{ .ConfirmationURL }}`                                    |
| `invite.html`           | `mailer_templates_invite_content`           | `{{ .ConfirmationURL }}`, `{{ .SiteURL }}`                  |
| `recovery.html`         | `mailer_templates_recovery_content`         | `{{ .ConfirmationURL }}`                                    |
| `email_change.html`     | `mailer_templates_email_change_content`     | `{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .NewEmail }}` |
| `reauthentication.html` | `mailer_templates_reauthentication_content` | `{{ .Token }}`                                              |

## Editing

1. Edit the HTML file. Keep it simple: a single `h1`, short paragraphs,
   one primary `a` link styled as a button, plus a plain-text fallback
   URL on its own line. Templates render across many email clients —
   inline styles only, no `<style>` blocks, no remote assets.
2. Keep `{{ .SiteURL }}` rather than hardcoded URLs so the same template
   serves staging and production (see [ADR 0008](../../../../docs/decisions/0008-supabase-environments.md)).
3. Re-apply to both Supabase projects:

   ```bash
   set -a; source .env.local; set +a
   python3 scripts/apply-supabase-email-templates.py
   ```

   The script is idempotent — re-running it patches the same fields.

## Why files instead of inlined strings in the script

Reviewable diffs. A copy change shows up as a few-line HTML diff in the
PR; the applier script stays stable. Future maintainers (or Supabase
SMTP migration) can re-use these without grepping Python.

## Note on Prettier

The repo's `lint-staged` config runs Prettier on `*.html` at commit
time, which will rewrap long lines in these templates. That's fine —
re-run the applier after committing to push the reformatted HTML to
Supabase, and the next `--check` will report 0 diffs. Don't try to
escape Prettier; just accept its formatting as the source of truth.
